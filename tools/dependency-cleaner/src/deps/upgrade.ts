/**
 * Upgrade blockers, docs/UPGRADE-BLOCKERS-PLAN.md. Before a managed upgrade of solution S:
 * what the upgrade deletes in the target, which dependents block each delete ("cannot be deleted, referenced by…"),
 * and where each blocker is fixed: in Dev (S still references it), by releasing another solution first, or in the
 * target's unmanaged layer. Dev = primary connection (unmanaged S), target = secondary (managed S).
 * Guid function parameters go through queryData (docs/PPTB-NOTES.md §12).
 */
import { Cancelled } from "./diagnose";
import {
  assertGuid,
  fetchComponents,
  fetchOwningSolutions,
  lid,
  onTarget,
  pool,
  queryAll,
  queryByIds,
  resolveNames,
  retrieveDependenciesForDelete,
  retrieveRequired,
  type DataverseLike,
  type DependentRow,
  type MetaCache,
  type NameRequest,
} from "./fetch";
import { CT, typeName, type Component, type NamedComponent, type Row, type SolutionInfo } from "./types";
import { isAppComponentType, type Op } from "./write";

export const UPGRADE_CONCURRENCY = 4;
/** JavaScript web resources read per request in the runtime-break scan */
const WR_CHUNK = 5;

/** A component as shown: `kind` refines the type (custom page, component library), `uniqueName` for apps. */
export interface UComponent extends NamedComponent {
  kind?: string;
  uniqueName?: string;
}

export type BlockerLocation = "dev" | "release" | "target";

export type BlockerFix =
  | { kind: "remove-app-component"; label: string; app: UComponent; component: UComponent }
  | { kind: "remove-dependent"; label: string; component: UComponent }
  | { kind: "report"; label: string };

export interface Blocker {
  /** dependent type:id > required type:id */
  key: string;
  required: UComponent;
  dependent: UComponent;
  location: BlockerLocation;
  /** the solution whose layer of the dependent decides: S, T, or "Active" (unmanaged) */
  owner: string;
  /** dependent's layers in the target, top first */
  layers: string[];
  /** "layers": msdyn_componentlayers; "membership": solution rows only, order and unmanaged layers unknown */
  layerSource: "layers" | "membership";
  note: string;
  fixes: BlockerFix[];
}

export interface UpgradeAnalysis {
  solution: SolutionInfo;
  environment: { name: string; url: string };
  target: { name: string; url: string; solution: string; version: string };
  /** Dev membership of S at analysis time (backup) */
  devComponents: Component[];
  removed: number;
  deleted: UComponent[];
  survivors: { component: UComponent; holders: string[] }[];
  blockers: Blocker[];
  /** references the new version of S drops itself: no action */
  resolved: { required: UComponent; dependent: UComponent }[];
  runtime: { component: UComponent; where: string; whereType: string }[];
  errors: { component: string; error: string }[];
  warnings: string[];
  takenAt: string;
}

export interface UpgradeOptions {
  /** host api: primary = Dev, secondary = target */
  api: DataverseLike;
  devMeta: MetaCache;
  targetMeta: MetaCache;
  solution: SolutionInfo;
  /** solutions in the target (fetchSolutions on secondary) */
  targetSolutions: SolutionInfo[];
  environment: { name: string; url: string };
  target: { name: string; url: string };
  scanRuntime: boolean;
  onProgress?: (phase: string, done: number, total: number) => void;
  cancelled?: () => boolean;
}

const key = (type: number, id: string): string => `${type}:${id}`;
const msg = (e: unknown): string => (e as Error)?.message ?? String(e);
export const odataString = (v: string): string => `'${v.replace(/'/g, "''")}'`;

/** msdyn_componentlayers.msdyn_solutioncomponentname per component type. Dynamic types come from solutioncomponentdefinitions. */
export const LAYER_NAMES: Record<number, string> = {
  [CT.Entity]: "Entity",
  [CT.Attribute]: "Attribute",
  [CT.EntityRelationship]: "EntityRelationship",
  [CT.OptionSet]: "OptionSet",
  [CT.View]: "SavedQuery",
  [CT.Workflow]: "Workflow",
  [CT.Chart]: "SavedQueryVisualization",
  [CT.Form]: "SystemForm",
  [CT.WebResource]: "WebResource",
  [CT.SiteMap]: "SiteMap",
  [CT.AppModule]: "AppModule",
  [CT.PluginStep]: "SdkMessageProcessingStep",
  300: "CanvasApp",
  20: "Role",
  70: "FieldSecurityProfile",
  380: "EnvironmentVariableDefinition",
  381: "EnvironmentVariableValue",
  91: "PluginAssembly",
  90: "PluginType",
  66: "CustomControl",
};

/** types whose unique name is stable across environments: matched by name when the ids differ */
const NAME_MATCHED = new Set<number>([CT.AppModule, 300, CT.WebResource]);

const CANVAS_KIND: Record<number, string> = { 0: "Canvas app", 1: "Component library", 2: "Custom page" };

export async function componentDefinitions(api: DataverseLike): Promise<Map<number, string>> {
  try {
    const rows = await queryAll(api, "solutioncomponentdefinitions?$select=solutioncomponenttype,name");
    return new Map(rows.filter((r) => r.name).map((r) => [Number(r.solutioncomponenttype), String(r.name)]));
  } catch {
    return new Map();
  }
}

/** Solution layers of a component, top first (`msdyn_componentlayers`, highest `msdyn_order` on top); null when no row comes back. */
export async function componentLayers(api: DataverseLike, id: string, layerName: string): Promise<string[] | null> {
  const rows = await queryAll(api, `msdyn_componentlayers?$select=msdyn_solutionname,msdyn_order&$filter=msdyn_componentid eq ${odataString(assertGuid(id))} and msdyn_solutioncomponentname eq ${odataString(layerName)}`);
  if (!rows.length) return null;
  return rows
    .map((r) => ({ s: String(r.msdyn_solutionname ?? ""), o: Number(r.msdyn_order ?? 0) }))
    .sort((a, b) => b.o - a.o)
    .map((x) => x.s);
}

/** Canvas app kind (page, library) and app module unique names, for display and for matching across environments. */
async function enrich(api: DataverseLike, comps: UComponent[]): Promise<void> {
  const canvas = comps.filter((c) => c.type === 300);
  const apps = comps.filter((c) => c.type === CT.AppModule);
  const [cRows, aRows] = await Promise.all([
    canvas.length ? queryByIds(api, canvas.map((c) => c.id), "canvasappid", (f) => `canvasapps?$select=canvasappid,name,displayname,canvasapptype&$filter=${f}`).catch(() => [] as Row[]) : Promise.resolve([] as Row[]),
    apps.length ? queryByIds(api, apps.map((c) => c.id), "appmoduleid", (f) => `appmodules?$select=appmoduleid,uniquename,name&$filter=${f}`).catch(() => [] as Row[]) : Promise.resolve([] as Row[]),
  ]);
  for (const r of cRows)
    for (const c of canvas.filter((x) => x.id === lid(r.canvasappid))) {
      c.kind = CANVAS_KIND[Number(r.canvasapptype)] ?? "Canvas app";
      if (r.name) c.uniqueName = String(r.name);
      if (r.displayname) c.name = `${String(r.displayname)} (${String(r.name ?? c.name)})`;
    }
  for (const r of aRows)
    for (const c of apps.filter((x) => x.id === lid(r.appmoduleid))) {
      if (r.uniquename) c.uniqueName = String(r.uniquename);
      if (r.name) c.name = String(r.name);
    }
}

export async function named(api: DataverseLike, meta: MetaCache, reqs: NameRequest[]): Promise<Map<string, UComponent>> {
  const out = await resolveNames(api, meta, reqs);
  const copy = new Map<string, UComponent>();
  for (const [k, v] of out) copy.set(k, { ...v });
  await enrich(api, [...copy.values()]);
  return copy;
}

/** base64 (web resource content) → text */
export function decodeBase64(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

export async function analyzeUpgrade(o: UpgradeOptions): Promise<UpgradeAnalysis> {
  const dev = onTarget(o.api, "primary");
  const tgt = onTarget(o.api, "secondary");
  const S = o.solution;
  const sLower = S.uniqueName.toLowerCase();
  const cancelled = () => !!o.cancelled?.();
  const step = (phase: string, done: number, total: number) => o.onProgress?.(phase, done, total);
  const errors: UpgradeAnalysis["errors"] = [];
  const warnings: string[] = [];

  const tSol = o.targetSolutions.find((x) => x.uniqueName.toLowerCase() === sLower);
  if (!tSol) throw new Error(`${S.uniqueName} is not installed in ${o.target.name}: a first import deletes nothing.`);
  if (!tSol.isManaged) throw new Error(`${S.uniqueName} is unmanaged in ${o.target.name}: unmanaged imports never delete components.`);

  // 1. removed set: in the target's S, not in Dev's S
  step("Reading solution membership", 0, 2);
  const [devComps, tComps] = await Promise.all([fetchComponents(dev, S.id), fetchComponents(tgt, tSol.id)]);
  if (cancelled()) throw new Cancelled();
  const devKeys = new Set(devComps.map((c) => key(c.type, c.objectId)));
  const allAssets = new Set(devComps.filter((c) => c.type === CT.Entity && c.behavior === 0).map((c) => c.objectId));
  const tByRow = new Map(tComps.map((c) => [c.rowId, c]));
  const seen = new Set<string>();
  let candidates = tComps.filter((c) => {
    const k = key(c.type, c.objectId);
    if (devKeys.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // a table Dev S includes with all assets keeps every subcomponent that still exists in Dev
  const underAllAssets = candidates.filter((c) => {
    const root = c.rootRowId ? tByRow.get(c.rootRowId) : undefined;
    return !!root && root.type === CT.Entity && allAssets.has(root.objectId);
  });
  if (underAllAssets.length) {
    const exists = await fetchOwningSolutions(dev, underAllAssets.map((c) => c.objectId));
    const kept = new Set(underAllAssets.filter((c) => exists.has(c.objectId)).map((c) => c.rowId));
    candidates = candidates.filter((c) => !kept.has(c.rowId));
  }
  // apps, canvas apps and web resources may carry other ids in Dev: the same unique name in Dev's S is the same component
  const devNamed = new Map<string, UComponent>();
  const devByName = new Map<string, Component>();
  const devNamedTypes = devComps.filter((c) => NAME_MATCHED.has(c.type));
  if (devNamedTypes.length) {
    const dn = await named(dev, o.devMeta, devNamedTypes.map((c) => ({ type: c.type, id: c.objectId })));
    for (const c of devNamedTypes) {
      const n = dn.get(key(c.type, c.objectId));
      if (n) devNamed.set(key(c.type, c.objectId), n);
      const u = (n?.uniqueName ?? n?.name ?? "").toLowerCase();
      if (u) devByName.set(`${c.type}:${u}`, c);
    }
  }
  const nameMatchedCandidates = candidates.filter((c) => NAME_MATCHED.has(c.type));
  if (nameMatchedCandidates.length && devByName.size) {
    const tn = await named(tgt, o.targetMeta, nameMatchedCandidates.map((c) => ({ type: c.type, id: c.objectId })));
    const same = new Set(
      nameMatchedCandidates
        .filter((c) => {
          const n = tn.get(key(c.type, c.objectId));
          const u = (n?.uniqueName ?? n?.name ?? "").toLowerCase();
          return !!u && u !== c.objectId && devByName.has(`${c.type}:${u}`);
        })
        .map((c) => c.rowId),
    );
    candidates = candidates.filter((c) => !same.has(c.rowId));
  }
  const removed = candidates.length;

  // 2. deleted = no other managed solution in the target holds it
  step("Checking other solutions", 1, 2);
  const holderIds = candidates.length ? await fetchOwningSolutions(tgt, candidates.map((c) => c.objectId)) : new Map<string, string[]>();
  const solIds = [...new Set([...holderIds.values()].flat())];
  const solRows = solIds.length ? await queryByIds(tgt, solIds, "solutionid", (f) => `solutions?$select=solutionid,uniquename,ismanaged&$filter=${f}`) : [];
  const solById = new Map(solRows.map((r) => [lid(r.solutionid), { uniqueName: String(r.uniquename ?? ""), isManaged: !!r.ismanaged }]));
  const upgradeName = `${sLower}_upgrade`;
  const otherHolders = (id: string): string[] =>
    (holderIds.get(id) ?? [])
      .filter((sid) => sid !== tSol.id)
      .map((sid) => solById.get(sid))
      .filter((x): x is { uniqueName: string; isManaged: boolean } => !!x && x.isManaged && x.uniqueName.toLowerCase() !== upgradeName && x.uniqueName.toLowerCase() !== sLower)
      .map((x) => x.uniqueName);
  const deletedComps: Component[] = [];
  const survivorComps: { c: Component; holders: string[] }[] = [];
  for (const c of candidates) {
    const h = otherHolders(c.objectId);
    if (h.length) survivorComps.push({ c, holders: h });
    else deletedComps.push(c);
  }
  const parentOf = (c: Component): string | null => {
    const root = c.rootRowId ? tByRow.get(c.rootRowId) : undefined;
    return root?.type === CT.Entity ? root.objectId : null;
  };

  // 3. what blocks each delete
  const deletedKeys = new Set(deletedComps.map((c) => key(c.type, c.objectId)));
  const deletedIds = new Set(deletedComps.map((c) => c.objectId));
  const pairs: { req: Component; dep: DependentRow }[] = [];
  let done = 0;
  step("RetrieveDependenciesForDelete", 0, deletedComps.length);
  await pool(
    deletedComps,
    UPGRADE_CONCURRENCY,
    async (c) => {
      try {
        const rows = await retrieveDependenciesForDelete(tgt, c.objectId, c.type);
        for (const d of rows) {
          if (!d.dependentId || d.dependentId === c.objectId) continue;
          if (deletedKeys.has(key(d.dependentType, d.dependentId))) continue; // deleted by the same upgrade
          if (d.dependentParentId && deletedIds.has(d.dependentParentId)) continue; // part of a table the upgrade deletes
          pairs.push({ req: c, dep: d });
        }
      } catch (e) {
        errors.push({ component: `${typeName(c.type)} ${c.objectId}`, error: msg(e) });
      }
      step("RetrieveDependenciesForDelete", ++done, deletedComps.length);
    },
    cancelled,
  );
  if (cancelled()) throw new Cancelled();

  // names (target)
  const nameReqs: NameRequest[] = [
    ...deletedComps.map((c) => ({ type: c.type, id: c.objectId, parentId: parentOf(c) })),
    ...survivorComps.map(({ c }) => ({ type: c.type, id: c.objectId, parentId: parentOf(c) })),
    ...pairs.map((p) => ({ type: p.dep.dependentType, id: p.dep.dependentId, parentId: p.dep.dependentParentId })),
  ];
  const names = await named(tgt, o.targetMeta, nameReqs);
  const nm = (type: number, id: string): UComponent => names.get(key(type, id)) ?? { type, id, name: id };

  // 4. layers of each dependent
  const dependents = [...new Map(pairs.map((p) => [key(p.dep.dependentType, p.dep.dependentId), p.dep])).values()];
  const defs = dependents.length ? await componentDefinitions(tgt) : new Map<number, string>();
  const layerName = (t: number): string | undefined => LAYER_NAMES[t] ?? defs.get(t);
  const layers = new Map<string, { list: string[]; source: "layers" | "membership" }>();
  let layerFailures = 0;
  await pool(
    dependents,
    UPGRADE_CONCURRENCY,
    async (d) => {
      const ln = layerName(d.dependentType);
      if (!ln) return;
      try {
        const list = await componentLayers(tgt, d.dependentId, ln);
        if (list) layers.set(key(d.dependentType, d.dependentId), { list, source: "layers" });
      } catch {
        layerFailures++;
      }
    },
    cancelled,
  );
  if (cancelled()) throw new Cancelled();
  // fallback: solution membership in the target (no order, no unmanaged layer)
  const noLayers = dependents.filter((d) => !layers.has(key(d.dependentType, d.dependentId)));
  if (noLayers.length) {
    const held = await fetchOwningSolutions(tgt, noLayers.map((d) => d.dependentId)).catch(() => new Map<string, string[]>());
    const extra = [...new Set([...held.values()].flat())].filter((sid) => !solById.has(sid));
    if (extra.length) for (const r of await queryByIds(tgt, extra, "solutionid", (f) => `solutions?$select=solutionid,uniquename,ismanaged&$filter=${f}`).catch(() => [] as Row[])) solById.set(lid(r.solutionid), { uniqueName: String(r.uniquename ?? ""), isManaged: !!r.ismanaged });
    for (const d of noLayers) {
      const managed = (held.get(d.dependentId) ?? []).map((sid) => solById.get(sid)).filter((x) => x?.isManaged && x.uniqueName.toLowerCase() !== upgradeName).map((x) => x!.uniqueName);
      // S last: another solution holding it outranks S for the purposes of the fix
      managed.sort((a, b) => Number(a.toLowerCase() === sLower) - Number(b.toLowerCase() === sLower));
      layers.set(key(d.dependentType, d.dependentId), { list: managed.length ? managed : ["Active"], source: "membership" });
    }
    if (layerFailures || noLayers.length) warnings.push(`Solution layers unavailable for ${noLayers.length} dependent(s): placed by solution membership. An unmanaged layer on top of a managed component would not show; check “See solution layers” in the target.`);
  }

  // 5. Dev side: does S's own copy of the dependent still reference the removed component?
  const devMatch = (u: UComponent): Component | undefined => {
    const byId = devComps.find((c) => c.type === u.type && c.objectId === u.id);
    if (byId) return byId;
    const n = (u.uniqueName ?? u.name ?? "").toLowerCase();
    return NAME_MATCHED.has(u.type) && n ? devByName.get(`${u.type}:${n}`) : undefined;
  };
  const devRequired = new Map<string, Promise<{ ids: Set<string>; names: Set<string> } | null>>();
  const devRequiredOf = (c: Component, reqType: number): Promise<{ ids: Set<string>; names: Set<string> } | null> => {
    const k = `${key(c.type, c.objectId)}>${reqType}`;
    let p = devRequired.get(k);
    if (!p) {
      p = (async () => {
        try {
          const rows = await retrieveRequired(dev, c.objectId, c.type);
          const ids = new Set(rows.map((r) => r.requiredId));
          const names = new Set<string>();
          if (NAME_MATCHED.has(reqType)) {
            const same = rows.filter((r) => r.requiredType === reqType);
            if (same.length) for (const v of (await named(dev, o.devMeta, same.map((r) => ({ type: r.requiredType, id: r.requiredId })))).values()) names.add((v.uniqueName ?? v.name).toLowerCase());
          }
          return { ids, names };
        } catch {
          return null;
        }
      })();
      devRequired.set(k, p);
    }
    return p;
  };

  const blockers: Blocker[] = [];
  const resolved: UpgradeAnalysis["resolved"] = [];
  done = 0;
  step("Classifying blockers", 0, pairs.length);
  for (const p of pairs) {
    if (cancelled()) throw new Cancelled();
    const required = nm(p.req.type, p.req.objectId);
    const dependent = nm(p.dep.dependentType, p.dep.dependentId);
    const lay = layers.get(key(dependent.type, dependent.id)) ?? { list: ["Active"], source: "membership" as const };
    let owner = lay.list[0] ?? "Active";
    let location: BlockerLocation;
    let note: string;
    if (owner.toLowerCase() === sLower) {
      const devDep = devMatch(dependent);
      if (devDep) {
        const req = await devRequiredOf(devDep, required.type);
        const reqName = (required.uniqueName ?? required.name).toLowerCase();
        if (req && !req.ids.has(required.id) && !(NAME_MATCHED.has(required.type) && req.names.has(reqName))) {
          resolved.push({ required, dependent });
          step("Classifying blockers", ++done, pairs.length);
          continue;
        }
        location = "dev";
        note = req
          ? `${S.uniqueName}'s ${typeName(dependent.type).toLowerCase()} in Dev still references it. Fix it in Dev, then export again.`
          : `${S.uniqueName}'s ${typeName(dependent.type).toLowerCase()} is in Dev, but its references could not be read: check it in Dev.`;
      } else {
        // S's layer leaves with the upgrade: the layer below decides
        const next = lay.list.slice(1).find((x) => x.toLowerCase() !== sLower);
        owner = next ?? "Active";
        if (!next || next.toLowerCase() === "active") {
          location = "target";
          note = "After the upgrade the unmanaged layer still references it.";
        } else {
          location = "release";
          note = `${next} also has a layer that references it.`;
        }
      }
    } else if (owner.toLowerCase() === "active") {
      location = "target";
      const managedBelow = lay.list.slice(1).filter((x) => x.toLowerCase() !== "active");
      note = managedBelow.length
        ? `Unmanaged customization in ${o.target.name} on top of ${managedBelow.join(", ")}. Remove active customizations (See solution layers) or edit it there to drop the reference.`
        : `Unmanaged component in ${o.target.name}. Edit it to drop the reference, or delete it.`;
    } else {
      location = "release";
      note = `${owner} references it. Ship a new version of ${owner} without the reference and upgrade it before ${S.uniqueName}.`;
    }
    const fixes: BlockerFix[] = [];
    if (location === "dev") {
      if (dependent.type === CT.AppModule && isAppComponentType(required.type))
        fixes.push({ kind: "remove-app-component", label: `Remove ${(required.kind ?? typeName(required.type)).toLowerCase()} from the app (Dev)`, app: dependent, component: required });
      if (dependent.type !== CT.SiteMap && dependent.type !== CT.AppModule)
        fixes.push({ kind: "remove-dependent", label: `Remove ${typeName(dependent.type).toLowerCase()} from ${S.uniqueName} too (deleted in target as well)`, component: dependent });
    }
    fixes.push({ kind: "report", label: location === "dev" ? "Fix by hand in Dev" : "Report only" });
    blockers.push({ key: `${key(dependent.type, dependent.id)}>${key(required.type, required.id)}`, required, dependent, location, owner, layers: lay.list, layerSource: lay.source, note, fixes });
    step("Classifying blockers", ++done, pairs.length);
  }

  // 6. runtime breaks: names of deleted pages / canvas apps in JS web resources and site maps of the target
  const runtime: UpgradeAnalysis["runtime"] = [];
  const deleted = deletedComps.map((c) => nm(c.type, c.objectId));
  const canvasGone = deleted.filter((c) => c.type === 300 && c.uniqueName);
  if (o.scanRuntime && canvasGone.length) {
    step("Scanning web resources and site maps", 0, 2);
    const blocked = new Set(blockers.map((b) => key(b.dependent.type, b.dependent.id)));
    try {
      // ids and names first, then the content a few files at a time: one response with every JS file's content is
      // too large for the host to parse ("Parse Error: JS Exception" on a real tenant)
      const list = await queryAll(tgt, "webresourceset?$select=webresourceid,name&$filter=webresourcetype eq 3");
      const ids = list.map((w) => lid(w.webresourceid)).filter(Boolean);
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += WR_CHUNK) chunks.push(ids.slice(i, i + WR_CHUNK));
      let failed = 0;
      await pool(
        chunks,
        UPGRADE_CONCURRENCY,
        async (chunk) => {
          try {
            const rows = await queryAll(tgt, `webresourceset?$select=webresourceid,name,content&$filter=${chunk.map((id) => `webresourceid eq ${id}`).join(" or ")}`);
            for (const w of rows) {
              const text = typeof w.content === "string" ? decodeBase64(w.content) : "";
              for (const c of canvasGone) if (text.includes(c.uniqueName!)) runtime.push({ component: c, where: String(w.name ?? w.webresourceid), whereType: "JavaScript web resource" });
            }
          } catch {
            failed += chunk.length;
          }
        },
        cancelled,
      );
      if (failed) warnings.push(`Web resource scan: ${failed} of ${ids.length} JavaScript files could not be read.`);
    } catch (e) {
      warnings.push(`Web resource scan failed: ${msg(e)}`);
    }
    step("Scanning web resources and site maps", 1, 2);
    try {
      const maps = await queryAll(tgt, "sitemaps?$select=sitemapid,sitemapname,sitemapxml");
      for (const m of maps) {
        if (blocked.has(key(CT.SiteMap, lid(m.sitemapid)))) continue;
        const xml = String(m.sitemapxml ?? "");
        for (const c of canvasGone) if (xml.includes(c.uniqueName!) || xml.toLowerCase().includes(c.id)) runtime.push({ component: c, where: String(m.sitemapname ?? m.sitemapid), whereType: "Site map" });
      }
    } catch (e) {
      warnings.push(`Site map scan failed: ${msg(e)}`);
    }
    step("Scanning web resources and site maps", 2, 2);
  }

  const order: Record<BlockerLocation, number> = { dev: 0, release: 1, target: 2 };
  blockers.sort((a, b) => order[a.location] - order[b.location] || a.owner.localeCompare(b.owner) || a.dependent.name.localeCompare(b.dependent.name));
  return {
    solution: S,
    environment: o.environment,
    target: { name: o.target.name, url: o.target.url, solution: tSol.uniqueName, version: tSol.version },
    devComponents: devComps.map((c) => ({ ...c, name: devNamed.get(key(c.type, c.objectId))?.name ?? c.name })),
    removed,
    deleted,
    survivors: survivorComps.map(({ c, holders }) => ({ component: nm(c.type, c.objectId), holders })),
    blockers,
    resolved,
    runtime,
    errors,
    warnings,
    takenAt: new Date().toISOString(),
  };
}

// ---------- Dev fixes ----------


export interface UpgradeSelection {
  blocker: Blocker;
  fix: BlockerFix["kind"];
}

export interface UpgradePlan {
  ops: Op[];
  skipped: { name: string; reason: string }[];
  /** app components the plan removes, by Dev app: the backup re-adds them */
  apps: { id: string; name: string; components: NamedComponent[] }[];
}

/**
 * Selected fixes → Dev operations. Apps and canvas apps are looked up in Dev by unique name (their ids may differ from
 * the target's); other components by id. Order: app component removals → membership removals → PublishXml for the apps.
 */
export async function planUpgradeFixes(api: DataverseLike, a: UpgradeAnalysis, selections: UpgradeSelection[]): Promise<UpgradePlan> {
  const dev = onTarget(api, "primary");
  const skipped: UpgradePlan["skipped"] = [];
  const byApp = new Map<string, { app: NamedComponent; components: NamedComponent[] }>();
  const removes: NamedComponent[] = [];

  const devId = async (c: UComponent): Promise<string | null> => {
    if (c.type === CT.AppModule && c.uniqueName) {
      const r = await queryAll(dev, `appmodules?$select=appmoduleid&$filter=uniquename eq ${odataString(c.uniqueName)}`);
      return r[0] ? lid(r[0].appmoduleid) : null;
    }
    if (c.type === 300 && c.uniqueName) {
      const r = await queryAll(dev, `canvasapps?$select=canvasappid&$filter=name eq ${odataString(c.uniqueName)}`);
      return r[0] ? lid(r[0].canvasappid) : null;
    }
    // an app without a unique name: only when Dev's S has it under the same id
    if (c.type === CT.AppModule) return a.devComponents.some((x) => x.objectId === c.id) ? c.id : null;
    return c.id;
  };

  for (const s of selections) {
    const fix = s.blocker.fixes.find((f) => f.kind === s.fix);
    if (!fix || fix.kind === "report") {
      skipped.push({ name: s.blocker.dependent.name, reason: "report only" });
      continue;
    }
    if (fix.kind === "remove-app-component") {
      const [appId, compId] = await Promise.all([devId(fix.app), devId(fix.component)]);
      if (!appId) {
        skipped.push({ name: fix.app.name, reason: "app not found in Dev" });
        continue;
      }
      if (!compId) {
        skipped.push({ name: fix.component.name, reason: "component not found in Dev" });
        continue;
      }
      const entry = byApp.get(appId) ?? { app: { type: CT.AppModule, id: appId, name: fix.app.name }, components: [] };
      if (!entry.components.some((c) => c.id === compId)) entry.components.push({ type: fix.component.type, id: compId, name: fix.component.name });
      byApp.set(appId, entry);
    } else {
      const id = await devId(fix.component);
      const member = id ? a.devComponents.find((c) => c.objectId === id && c.type === fix.component.type) : undefined;
      if (!member) {
        skipped.push({ name: fix.component.name, reason: `not in ${a.solution.uniqueName} in Dev` });
        continue;
      }
      if (!removes.some((r) => r.id === member.objectId)) removes.push({ type: member.type, id: member.objectId, name: fix.component.name });
    }
  }
  const ops: Op[] = [];
  for (const { app, components } of byApp.values()) ops.push({ kind: "remove-app-components", app, components, reason: "drop the reference the upgrade blocks on" });
  for (const r of removes) ops.push({ kind: "remove", component: r, reason: "deleted in target together with the component it references" });
  if (byApp.size) ops.push({ kind: "publish-apps", apps: [...byApp.values()].map((x) => x.app) });
  return { ops, skipped, apps: [...byApp.values()].map((x) => ({ id: x.app.id, name: x.app.name, components: x.components })) };
}

// ---------- export ----------

const LOCATION_LABEL: Record<BlockerLocation, string> = { dev: "Fix in Dev", release: "Release first", target: "Target unmanaged" };
export const locationLabel = (l: BlockerLocation): string => LOCATION_LABEL[l];
const label = (c: UComponent): string => `${c.kind ?? typeName(c.type)} ${c.name}`;

export function upgradeMarkdown(a: UpgradeAnalysis): string {
  const out: string[] = [];
  out.push(`# Upgrade pre-flight: ${a.solution.uniqueName} ${a.solution.version} → ${a.target.name}`);
  out.push("");
  out.push(`Dev: ${a.environment.name} · Target: ${a.target.name} (${a.target.solution} ${a.target.version}) · ${a.takenAt}`);
  out.push("");
  out.push(`- Removed from the solution: ${a.removed}`);
  out.push(`- Deleted by the upgrade: ${a.deleted.length}`);
  out.push(`- Survive (held by another solution): ${a.survivors.length}`);
  out.push(`- Blockers: ${a.blockers.length}`);
  out.push("");
  for (const loc of ["dev", "release", "target"] as BlockerLocation[]) {
    const list = a.blockers.filter((b) => b.location === loc);
    if (!list.length) continue;
    out.push(`## ${LOCATION_LABEL[loc]} (${list.length})`);
    out.push("");
    for (const b of list) out.push(`- [ ] ${label(b.dependent)} → ${label(b.required)} · ${b.owner} · ${b.note}`);
    out.push("");
  }
  const releases = [...new Set(a.blockers.filter((b) => b.location === "release").map((b) => b.owner))];
  if (releases.length) {
    out.push(`Release order: ${[...releases, a.solution.uniqueName].join(" → ")}`);
    out.push("");
  }
  if (a.runtime.length) {
    out.push(`## Runtime breaks (${a.runtime.length})`);
    out.push("");
    for (const r of a.runtime) out.push(`- ${r.whereType} ${r.where} references ${label(r.component)}`);
    out.push("");
  }
  if (a.survivors.length) {
    out.push(`## Survives (${a.survivors.length})`);
    out.push("");
    for (const s of a.survivors) out.push(`- ${label(s.component)}: held by ${s.holders.join(", ")}`);
    out.push("");
  }
  if (a.deleted.length) {
    out.push(`## Deleted (${a.deleted.length})`);
    out.push("");
    for (const d of a.deleted) out.push(`- ${label(d)}`);
    out.push("");
  }
  return out.join("\n");
}

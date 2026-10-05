/**
 * Slim, docs/SOLUTION-SLIMMER-PLAN.md: which components of an unmanaged solution do not belong there.
 * Keep = yours (custom, unmanaged) or customized (an unmanaged "Active" layer in msdyn_componentlayers that changes
 * something real). Everything else, managed or platform (System), is removed from the solution (membership only:
 * RemoveSolutionComponent never touches the environment). A table not yours included with all assets becomes a shell
 * and gets its kept subcomponents re-added (D3). Anything whose state cannot be read is kept and flagged (D7).
 *
 * Facts from the first real run (docs/SOLUTION-SLIMMER-PLAN.md §4): platform components (account, its system columns,
 * System forms) report ismanaged = false, so "unmanaged" alone does not mean "yours"; and nearly every managed
 * component carries an "Active" layer whose msdyn_changes lists no attribute, or only bookkeeping ones (modifiedon,
 * overwritetime), so a layer counts as a customization only when it changes something else.
 */
import { Cancelled } from "./diagnose";
import { assertGuid, fetchComponents, fetchOwningSolutions, lid, pool, queryAll, queryByIds, RECORD_TYPES, resolveNames, type DataverseLike, type EntityMeta, type MetaCache } from "./fetch";
import { CT, typeName, type Component, type NamedComponent, type Row, type SolutionInfo } from "./types";
import { componentDefinitions, LAYER_NAMES } from "./upgrade";
import { addRequest, removeComponent } from "./write";

export const SLIM_CONCURRENCY = 4;
const SYSTEM_SOLUTIONS = new Set(["default", "active", "basic"]);
const ENV_VAR_VALUE = 381;
const ENV_VAR_DEF = 380;
/**
 * Attributes an Active layer may list without being a customization: bookkeeping the platform writes on its own.
 * Anything else (formxml, xaml, displayname, iscustomizable…) is a change the export would carry.
 */
export const LAYER_NOISE = new Set([
  "",
  "modifiedon",
  "modifiedby",
  "modifiedonbehalfby",
  "overwritetime",
  "solutionid",
  "supportingsolutionid",
  "componentstate",
  "publishedon",
  "versionnumber",
  "importsequencenumber",
  "statecode",
  "statuscode",
  "workflowidunique",
  "ismanaged",
]);

export type SlimVerdict = "unmanaged" | "customized" | "included" | "parent" | "shell" | "remove" | "unknown";
/** custom = created here (yours); platform = System's (ismanaged false, not custom); managed = from a managed solution */
export type Origin = "custom" | "platform" | "managed";

export interface SlimRow {
  /** type:objectId */
  key: string;
  component: Component;
  name: NamedComponent;
  verdict: SlimVerdict;
  /** why, in one line */
  reason: string;
  /** null = unknown */
  origin: Origin | null;
  /** layers, top first; empty when none / unavailable */
  layers: string[];
  /** attributes the Active layer changes, bookkeeping excluded (empty: no Active layer, or a phantom one) */
  changes: string[];
  /** owning managed solution (base layer) for managed components, "System" for platform ones */
  owner: string | null;
  /** other unmanaged solutions (not this one, not Default) that also contain a customized component */
  alsoIn: string[];
  /** the shell plan this row belongs to, for subcomponents of an all-assets table that is not yours */
  shellOf?: string;
  error?: string;
}

export interface ShellTable {
  /** table row key */
  key: string;
  table: NamedComponent;
  /** the table row itself stays (customized or kept children) */
  keepTable: boolean;
  kept: SlimRow[];
  leaving: SlimRow[];
}

export interface SlimAnalysis {
  solution: SolutionInfo;
  environment: { name: string; url: string };
  components: Component[];
  rows: SlimRow[];
  shells: ShellTable[];
  counts: Record<SlimVerdict, number> & { total: number };
  errors: { component: string; error: string }[];
  warnings: string[];
  takenAt: string;
}

export interface SlimOptions {
  api: DataverseLike;
  meta: MetaCache;
  solution: SolutionInfo;
  /** D5: keep a pristine parent (table, env var definition) whose child stays */
  keepParents: boolean;
  environment: { name: string; url: string };
  onProgress?: (phase: string, done: number, total: number) => void;
  cancelled?: () => boolean;
}

const key = (type: number, id: string): string => `${type}:${id}`;
const msg = (e: unknown): string => (e as Error)?.message ?? String(e);
const odataString = (v: string): string => `'${v.replace(/'/g, "''")}'`;
const named = (c: Component, n?: NamedComponent): NamedComponent => ({ ...(n ?? { type: c.type, id: c.objectId, name: c.name ?? c.objectId, table: c.table }), rowId: c.rowId });

// ---------- origin ----------

interface Flags {
  origin: Map<string, Origin>;
  names: Map<string, NamedComponent>;
  failed: Map<string, string>;
}

type Defs = Map<number, { name: string; entity: string | null }>;
const META_TYPES = new Set<number>([CT.Entity, CT.Attribute, CT.EntityRelationship, CT.Relationship, CT.OptionSet]);

/** entity set, id column, name column for a record-backed type: the static map, else solutioncomponentdefinitions.primaryentityname → metadata. */
async function recordSource(api: DataverseLike, meta: MetaCache, type: number, defs: Defs): Promise<[string, string, string] | null> {
  const fixed = RECORD_TYPES[type];
  if (fixed) return [fixed[0], fixed[1], fixed[2]];
  const entity = defs.get(type)?.entity;
  if (!entity) return null;
  const e = await meta.entityByName(api, entity.toLowerCase()).catch(() => undefined);
  if (!e?.entitySetName || !e.primaryId) return null;
  return [e.entitySetName, e.primaryId, e.primaryName ?? e.primaryId];
}

const originOf = (managed: boolean | null, custom: boolean | null): Origin | null => (managed === true ? "managed" : managed === false && custom === true ? "custom" : managed === false && custom === false ? "platform" : null);

/**
 * Origin per component. Metadata types from metadata (IsManaged + IsCustomEntity / IsCustomAttribute / IsCustomRelationship /
 * IsCustomOptionSet); record types from their table's ismanaged, and when unmanaged, from membership in the System solution
 * (platform forms, views and processes are unmanaged too). Names come along.
 */
async function origins(api: DataverseLike, meta: MetaCache, comps: Component[], defs: Defs): Promise<Flags> {
  const origin = new Map<string, Origin>();
  const failed = new Map<string, string>();
  const names = new Map<string, NamedComponent>();
  const byRow = new Map(comps.map((c) => [c.rowId, c]));
  const parentOf = (c: Component): string | null => (c.rootRowId ? (byRow.get(c.rootRowId)?.objectId ?? null) : null);
  const put = (c: Component, managed: boolean | null, custom: boolean | null, why: string) => {
    const o = originOf(managed, custom);
    if (o) origin.set(key(c.type, c.objectId), o);
    else failed.set(key(c.type, c.objectId), why);
  };

  // names for the types resolveNames knows, except relationships and choices (read below with their flags)
  const resolved = await resolveNames(
    api,
    meta,
    comps.filter((c) => c.type !== CT.EntityRelationship && c.type !== CT.Relationship && c.type !== CT.OptionSet).map((c) => ({ type: c.type, id: c.objectId, parentId: parentOf(c) })),
    failed,
  );
  for (const [k, v] of resolved) names.set(k, v);

  const entities = await meta.entitiesById(api).catch((e) => {
    for (const c of comps) if (c.type === CT.Entity || c.type === CT.Attribute) failed.set(key(c.type, c.objectId), msg(e));
    return new Map<string, EntityMeta>();
  });
  for (const c of comps.filter((x) => x.type === CT.Entity)) {
    const e = entities.get(c.objectId);
    if (!e) failed.set(key(c.type, c.objectId), failed.get(key(c.type, c.objectId)) ?? "table not found in metadata");
    else put(c, e.isManaged, e.isCustom, "IsManaged / IsCustomEntity not returned by the host");
  }
  const byParent = new Map<string, Component[]>();
  for (const c of comps.filter((x) => x.type === CT.Attribute)) {
    const p = parentOf(c) ?? "";
    byParent.set(p, [...(byParent.get(p) ?? []), c]);
  }
  for (const [parent, list] of byParent) {
    const table = entities.get(parent)?.logicalName;
    if (!table) {
      for (const c of list) failed.set(key(c.type, c.objectId), "column without a table row in the solution");
      continue;
    }
    const attrs = await meta.attributesOf(api, table).catch((e) => {
      for (const c of list) failed.set(key(c.type, c.objectId), msg(e));
      return null;
    });
    if (!attrs) continue;
    for (const c of list) {
      const a = attrs.find((x) => x.id === c.objectId);
      if (!a) failed.set(key(c.type, c.objectId), "column not found in metadata");
      else put(c, a.isManaged, a.isCustom, "IsManaged / IsCustomAttribute not returned by the host");
    }
  }
  // relationships and global choices: one metadata read each
  const single: [number, (id: string) => string, string, string][] = [
    [CT.EntityRelationship, (id) => `RelationshipDefinitions(${id})?$select=SchemaName,IsManaged,IsCustomRelationship`, "SchemaName", "IsCustomRelationship"],
    [CT.Relationship, (id) => `RelationshipDefinitions(${id})?$select=SchemaName,IsManaged,IsCustomRelationship`, "SchemaName", "IsCustomRelationship"],
    [CT.OptionSet, (id) => `GlobalOptionSetDefinitions(${id})?$select=Name,IsManaged,IsCustomOptionSet`, "Name", "IsCustomOptionSet"],
  ];
  for (const [type, build, nameCol, customCol] of single) {
    await pool(
      comps.filter((c) => c.type === type),
      SLIM_CONCURRENCY,
      async (c) => {
        try {
          const row = (await api.queryData(build(assertGuid(c.objectId)))) as unknown as Row;
          const flag = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
          put(c, flag(row?.IsManaged), flag(row?.[customCol]), `IsManaged / ${customCol} not returned by the host`);
          if (row?.[nameCol]) names.set(key(c.type, c.objectId), { type: c.type, id: c.objectId, name: String(row[nameCol]) });
        } catch (e) {
          failed.set(key(c.type, c.objectId), msg(e));
        }
      },
    );
  }
  // record-backed: by entity set, 40 ids per call; unmanaged ones are platform when the System solution contains them
  const byType = new Map<number, Component[]>();
  for (const c of comps) if (!META_TYPES.has(c.type)) byType.set(c.type, [...(byType.get(c.type) ?? []), c]);
  const unmanagedRecords: Component[] = [];
  await Promise.all(
    [...byType].map(async ([type, list]) => {
      const src = await recordSource(api, meta, type, defs);
      if (!src) {
        for (const c of list) failed.set(key(c.type, c.objectId), `no table known for ${typeName(type)} (${type})`);
        return;
      }
      const [set, idCol, nameCol] = src;
      const ids = list.map((c) => c.objectId);
      let rows: Row[];
      try {
        rows = await queryByIds(api, ids, idCol, (f) => `${set}?$select=${[...new Set([idCol, nameCol, "ismanaged"])].join(",")}&$filter=${f}`);
      } catch (e) {
        // a table without ismanaged: names still help the listing, the origin stays unknown
        const err = msg(e);
        rows = await queryByIds(api, ids, idCol, (f) => `${set}?$select=${[...new Set([idCol, nameCol])].join(",")}&$filter=${f}`).catch(() => [] as Row[]);
        for (const c of list) failed.set(key(c.type, c.objectId), err);
        for (const r of rows) {
          const id = lid(r[idCol]);
          if (r[nameCol] != null) names.set(key(type, id), { type, id, name: String(r[nameCol]) });
        }
        return;
      }
      const seen = new Map<string, Row>();
      for (const r of rows) seen.set(lid(r[idCol]), r);
      for (const c of list) {
        const r = seen.get(c.objectId);
        if (!r) {
          failed.set(key(c.type, c.objectId), `${typeName(type)} not found in ${set}`);
          continue;
        }
        if (r[nameCol] != null) names.set(key(type, c.objectId), { type, id: c.objectId, name: String(r[nameCol]) });
        if (typeof r.ismanaged !== "boolean") failed.set(key(c.type, c.objectId), "ismanaged not returned by the host");
        else if (r.ismanaged) origin.set(key(c.type, c.objectId), "managed");
        else unmanagedRecords.push(c);
      }
    }),
  );
  if (unmanagedRecords.length) {
    try {
      const held = await fetchOwningSolutions(api, unmanagedRecords.map((c) => c.objectId));
      const sids = [...new Set([...held.values()].flat())];
      const sols = sids.length ? await queryByIds(api, sids, "solutionid", (f) => `solutions?$select=solutionid,uniquename&$filter=${f}`) : [];
      const system = new Set(sols.filter((s) => String(s.uniquename ?? "").toLowerCase() === "system").map((s) => lid(s.solutionid)));
      for (const c of unmanagedRecords) origin.set(key(c.type, c.objectId), (held.get(c.objectId) ?? []).some((sid) => system.has(sid)) ? "platform" : "custom");
    } catch (e) {
      for (const c of unmanagedRecords) failed.set(key(c.type, c.objectId), `System membership could not be read: ${msg(e)}`);
    }
  }
  return { origin, names, failed };
}

// ---------- layers ----------

interface LayerInfo {
  /** top first */
  layers: string[];
  /** attributes the Active layer changes, bookkeeping excluded */
  changes: string[];
  /** an Active layer exists (with or without changes) */
  hasActive: boolean;
  owner: string | null;
}

/** Attribute keys an Active layer's msdyn_changes lists, bookkeeping excluded. Unparseable → null (treated as a real change). */
export function layerChanges(changesJson: unknown): string[] | null {
  if (typeof changesJson !== "string" || !changesJson) return null;
  try {
    const o = JSON.parse(changesJson) as { Attributes?: { Key?: unknown }[] };
    if (!Array.isArray(o?.Attributes)) return null;
    return [...new Set(o.Attributes.map((a) => String(a?.Key ?? "").toLowerCase()))].filter((k) => !LAYER_NOISE.has(k)).sort();
  } catch {
    return null;
  }
}

/** Layers of every component that is not yours: one msdyn_componentlayers read each (plan §1). Unavailable layers → `failed`. */
async function readLayers(api: DataverseLike, comps: Component[], layerName: (t: number) => string | undefined, o: SlimOptions): Promise<{ layers: Map<string, LayerInfo>; failed: Map<string, string> }> {
  const layers = new Map<string, LayerInfo>();
  const failed = new Map<string, string>();
  let done = 0;
  o.onProgress?.("Reading solution layers", 0, comps.length);
  await pool(
    comps,
    SLIM_CONCURRENCY,
    async (c) => {
      const k = key(c.type, c.objectId);
      const ln = layerName(c.type);
      if (!ln) failed.set(k, `no layer component name known for ${typeName(c.type)} (${c.type})`);
      else {
        try {
          const rows = await queryAll(api, `msdyn_componentlayers?$select=msdyn_solutionname,msdyn_order&$filter=msdyn_componentid eq ${odataString(assertGuid(c.objectId))} and msdyn_solutioncomponentname eq ${odataString(ln)}`);
          const sorted = rows.map((r) => ({ s: String(r.msdyn_solutionname ?? ""), o: Number(r.msdyn_order ?? 0), changes: r.msdyn_changes })).sort((a, b) => b.o - a.o);
          const list = sorted.map((x) => x.s);
          const base = [...sorted].reverse().find((x) => x.s.toLowerCase() !== "active")?.s ?? null;
          const changes = new Set<string>();
          for (const x of sorted.filter((x) => x.s.toLowerCase() === "active")) for (const k2 of layerChanges(x.changes) ?? ["(unreadable changes)"]) changes.add(k2);
          layers.set(k, { layers: list, changes: [...changes].sort(), hasActive: sorted.some((x) => x.s.toLowerCase() === "active"), owner: base });
        } catch (e) {
          failed.set(k, msg(e));
        }
      }
      o.onProgress?.("Reading solution layers", ++done, comps.length);
    },
    () => !!o.cancelled?.(),
  );
  return { layers, failed };
}

// ---------- analysis ----------

export async function analyzeSlim(o: SlimOptions): Promise<SlimAnalysis> {
  const { api, meta, solution } = o;
  const cancelled = () => !!o.cancelled?.();
  const warnings: string[] = [];
  if (solution.isManaged) throw new Error(`${solution.uniqueName} is managed: nothing can be removed from it.`);

  o.onProgress?.("Reading solution membership", 0, 1);
  const components = await fetchComponents(api, solution.id);
  if (cancelled()) throw new Cancelled();
  const byRow = new Map(components.map((c) => [c.rowId, c]));
  const rootOf = (c: Component): Component | undefined => (c.rootRowId ? byRow.get(c.rootRowId) : undefined);

  // component types: layer names and backing tables
  const defs: Defs = new Map();
  try {
    const rows = await queryAll(api, "solutioncomponentdefinitions?$select=solutioncomponenttype,name,primaryentityname");
    for (const r of rows) if (r.name) defs.set(Number(r.solutioncomponenttype), { name: String(r.name), entity: r.primaryentityname ? String(r.primaryentityname) : null });
  } catch {
    const basic = await componentDefinitions(api);
    for (const [t, n] of basic) defs.set(t, { name: n, entity: null });
    if (!basic.size) warnings.push("solutioncomponentdefinitions could not be read: only the built-in component types are classified; the rest is kept as unknown.");
  }
  const layerName = (t: number): string | undefined => defs.get(t)?.name ?? LAYER_NAMES[t];

  o.onProgress?.("Reading managed flags", 0, 1);
  const flags = await origins(api, meta, components, defs);
  if (cancelled()) throw new Cancelled();
  for (const c of components) {
    c.name = flags.names.get(key(c.type, c.objectId))?.name ?? c.objectId;
    c.table = flags.names.get(key(c.type, c.objectId))?.table;
  }
  const originOfC = (c: Component): Origin | null => flags.origin.get(key(c.type, c.objectId)) ?? null;

  const notYours = components.filter((c) => originOfC(c) === "managed" || originOfC(c) === "platform");
  const { layers, failed: layerFailed } = await readLayers(api, notYours, layerName, o);
  if (cancelled()) throw new Cancelled();

  // other unmanaged solutions holding the customized components (D2 flag)
  const customizedIds = notYours.filter((c) => layers.get(key(c.type, c.objectId))?.changes.length).map((c) => c.objectId);
  const alsoIn = new Map<string, string[]>();
  if (customizedIds.length) {
    try {
      const held = await fetchOwningSolutions(api, customizedIds);
      const sids = [...new Set([...held.values()].flat())].filter((sid) => sid !== solution.id);
      const sols = sids.length ? await queryByIds(api, sids, "solutionid", (f) => `solutions?$select=solutionid,uniquename,ismanaged&$filter=${f}`) : [];
      const unmanaged = new Map(sols.filter((s) => !s.ismanaged && !SYSTEM_SOLUTIONS.has(String(s.uniquename ?? "").toLowerCase())).map((s) => [lid(s.solutionid), String(s.uniquename ?? "")]));
      for (const [id, list] of held) alsoIn.set(id, list.map((sid) => unmanaged.get(sid)).filter((x): x is string => !!x).sort());
    } catch (e) {
      warnings.push(`Other unmanaged solutions could not be read (${msg(e)}): customized components are not flagged as shared.`);
    }
  }

  // environment variable values → definitions (D5)
  const valueDef = new Map<string, string>();
  const values = components.filter((c) => c.type === ENV_VAR_VALUE);
  if (o.keepParents && values.length && components.some((c) => c.type === ENV_VAR_DEF)) {
    try {
      const rows = await queryByIds(api, values.map((c) => c.objectId), "environmentvariablevalueid", (f) => `environmentvariablevalues?$select=environmentvariablevalueid,_environmentvariabledefinitionid_value&$filter=${f}`);
      for (const r of rows) if (r._environmentvariabledefinitionid_value) valueDef.set(lid(r.environmentvariablevalueid), lid(r._environmentvariabledefinitionid_value));
    } catch (e) {
      warnings.push(`Environment variable values could not be linked to their definitions (${msg(e)}).`);
    }
  }

  // ---- classify (plan §2) ----
  const rows = new Map<string, SlimRow>();
  const errors: SlimAnalysis["errors"] = [];
  const base = (c: Component): SlimRow => {
    const k = key(c.type, c.objectId);
    const li = layers.get(k);
    const origin = originOfC(c);
    return {
      key: k,
      component: c,
      name: named(c, flags.names.get(k)),
      verdict: "unknown",
      reason: "",
      origin,
      layers: li?.layers ?? [],
      changes: li?.changes ?? [],
      owner: li?.owner ?? (origin === "platform" ? "System" : null),
      alsoIn: alsoIn.get(c.objectId) ?? [],
    };
  };
  const isKeep = (r: SlimRow): boolean => r.verdict !== "remove" && r.verdict !== "shell";
  const originLabel = (r: SlimRow): string => (r.origin === "platform" ? "platform (System)" : `managed${r.owner ? `: ${r.owner}'s` : ""}`);
  // rules 1–4 for every row
  for (const c of components) {
    const r = base(c);
    const k = r.key;
    const root = rootOf(c);
    const err = flags.failed.get(k) ?? (r.origin && r.origin !== "custom" ? layerFailed.get(k) : undefined);
    const li = layers.get(k);
    if (r.origin === "custom") {
      r.verdict = "unmanaged";
      r.reason = "yours: created in this environment, unmanaged";
    } else if (root && root.type === CT.Entity && root.behavior === 0 && originOfC(root) === "custom") {
      r.verdict = "included";
      r.reason = `included by ${root.name ?? "its table"} (all assets)`;
    } else if (r.origin === null || err) {
      r.verdict = "unknown";
      r.error = err ?? "state could not be read";
      r.reason = `kept: ${r.error}`;
      errors.push({ component: `${typeName(c.type)} ${r.name.name}`, error: r.error });
    } else if (li?.changes.length) {
      r.verdict = "customized";
      r.reason = `customized (Active layer changes ${li.changes.join(", ")})${r.alsoIn.length ? `; also in ${r.alsoIn.join(", ")}` : ""}`;
    } else {
      r.verdict = "remove";
      r.reason = `${originLabel(r)}, ${li?.hasActive ? "Active layer without changes" : "no customization"}`;
    }
    rows.set(k, r);
  }
  // rule 5: all-assets tables that are not yours → shells; rule 6: parents of kept children
  const shells: ShellTable[] = [];
  const childrenOf = new Map<string, SlimRow[]>();
  for (const r of rows.values()) {
    const root = rootOf(r.component);
    if (root && root.rowId !== r.component.rowId) childrenOf.set(root.rowId, [...(childrenOf.get(root.rowId) ?? []), r]);
  }
  for (const r of rows.values()) {
    const c = r.component;
    if (c.type !== CT.Entity || c.rootRowId) continue;
    const children = childrenOf.get(c.rowId) ?? [];
    const keptChildren = children.filter(isKeep);
    if (r.origin && r.origin !== "custom" && c.behavior === 0 && r.verdict !== "unknown") {
      const keepTable = r.verdict === "customized" || keptChildren.length > 0;
      r.verdict = "shell";
      r.reason = keepTable
        ? `${originLabel(r)} table with all assets → shell, ${keptChildren.length} of ${children.length} subcomponents re-added`
        : `${originLabel(r)} table with all assets, nothing of yours in it → removed with its ${children.length} subcomponents`;
      const sh: ShellTable = { key: r.key, table: r.name, keepTable, kept: keptChildren, leaving: children.filter((x) => !isKeep(x)) };
      shells.push(sh);
      for (const ch of children) ch.shellOf = r.key;
      continue;
    }
    if (r.verdict === "remove" && o.keepParents && keptChildren.length) {
      r.verdict = "parent";
      r.reason = `parent of ${keptChildren.length} kept subcomponent${keptChildren.length === 1 ? "" : "s"}`;
    }
  }
  if (o.keepParents)
    for (const r of rows.values()) {
      if (r.verdict !== "remove" || r.component.type !== ENV_VAR_DEF) continue;
      const kept = [...rows.values()].filter((v) => v.component.type === ENV_VAR_VALUE && isKeep(v) && valueDef.get(v.component.objectId) === r.component.objectId);
      if (kept.length) {
        r.verdict = "parent";
        r.reason = `definition of ${kept.length} kept value${kept.length === 1 ? "" : "s"}`;
      }
    }

  const list = [...rows.values()].sort((a, b) => a.component.type - b.component.type || a.name.name.localeCompare(b.name.name));
  const counts = { total: list.length, unmanaged: 0, customized: 0, included: 0, parent: 0, shell: 0, remove: 0, unknown: 0 };
  for (const r of list) counts[r.verdict]++;
  if (counts.unknown) warnings.push(`${counts.unknown} component(s) could not be classified and are kept. Open Unknown for the errors.`);
  const phantom = list.filter((r) => r.verdict === "remove" && layers.get(r.key)?.hasActive).length;
  if (phantom) warnings.push(`${phantom} component(s) carry an Active layer that changes nothing (or only bookkeeping such as modifiedon): counted as not customized.`);
  return { solution, environment: o.environment, components, rows: list, shells, counts, errors, warnings, takenAt: new Date().toISOString() };
}

// ---------- plan ----------

export type SlimOp = { kind: "remove"; component: NamedComponent; reason: string; group: string } | { kind: "add"; component: NamedComponent; doNotIncludeSubcomponents: boolean; reason: string; group: string };

export interface SlimPlan {
  ops: SlimOp[];
  /** rows the plan removes (overrides applied) */
  removing: SlimRow[];
  shells: number;
}

/**
 * Operations for the analysis with the user's overrides: `overrides` maps a row key to true (remove) or false (keep).
 * A default comes from the verdict: remove / shell rows are removed, every other row stays.
 */
export function planSlim(a: SlimAnalysis, overrides: Map<string, boolean>): SlimPlan {
  const remove = (r: SlimRow): boolean => overrides.get(r.key) ?? (r.verdict === "remove" || r.verdict === "shell");
  const ops: SlimOp[] = [];
  const removing: SlimRow[] = [];
  const done = new Set<string>();
  let shells = 0;
  for (const sh of a.shells) {
    const tableRow = a.rows.find((r) => r.key === sh.key)!;
    if (!remove(tableRow)) continue; // kept as all assets by override
    const children = a.rows.filter((r) => r.shellOf === sh.key);
    const kept = children.filter((r) => !remove(r));
    const leaving = children.filter(remove);
    const keepTable = sh.keepTable || kept.length > 0 || overrides.get(sh.key) === false;
    if (!leaving.length) continue; // nothing leaves: converting changes nothing
    const g = `shell:${sh.key}`;
    ops.push({ kind: "remove", component: sh.table, reason: keepTable ? `convert ${sh.table.name} to a shell` : `remove ${sh.table.name} with all its subcomponents`, group: g });
    if (keepTable) {
      ops.push({ kind: "add", component: sh.table, doNotIncludeSubcomponents: true, reason: "re-add as shell (no subcomponents)", group: g });
      for (const r of kept) ops.push({ kind: "add", component: r.name, doNotIncludeSubcomponents: false, reason: `keep: ${r.reason}`, group: g });
    }
    shells++;
    removing.push(...leaving, ...(keepTable ? [] : [tableRow]));
    done.add(sh.key);
    for (const r of children) done.add(r.key);
  }
  // plain removals: subcomponent rows first, then roots
  const plain = a.rows.filter((r) => !done.has(r.key) && remove(r)).sort((x, y) => Number(!x.component.rootRowId) - Number(!y.component.rootRowId));
  for (const r of plain) {
    ops.push({ kind: "remove", component: r.name, reason: r.reason, group: `remove:${r.key}` });
    removing.push(r);
  }
  const seen = new Set<string>();
  return {
    ops: ops.filter((op) => {
      const k = `${op.kind}:${op.component.type}:${op.component.id}:${op.kind === "add" ? op.doNotIncludeSubcomponents : ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
    removing,
    shells,
  };
}

export interface SlimOpResult {
  op: SlimOp;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

/** D9: a failure skips the rest of its group (a shell conversion); every other group still runs. */
export async function executeSlim(api: DataverseLike, ops: SlimOp[], solution: string, onStep?: (i: number, n: number) => void): Promise<SlimOpResult[]> {
  const out: SlimOpResult[] = [];
  const failedGroups = new Set<string>();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    onStep?.(i, ops.length);
    if (failedGroups.has(op.group)) {
      out.push({ op, ok: false, skipped: true, error: "not run: an earlier step of this table failed" });
      continue;
    }
    try {
      if (op.kind === "remove") await removeComponent(api, op.component, solution);
      else await api.execute(addRequest(op.component, solution, op.doNotIncludeSubcomponents));
      out.push({ op, ok: true });
    } catch (e) {
      failedGroups.add(op.group);
      out.push({ op, ok: false, error: msg(e) });
    }
  }
  onStep?.(ops.length, ops.length);
  return out;
}

export function slimOpLabel(op: SlimOp): string {
  return op.kind === "remove"
    ? `RemoveSolutionComponent ${typeName(op.component.type)} ${op.component.name}`
    : `AddSolutionComponent ${typeName(op.component.type)} ${op.component.name}${op.doNotIncludeSubcomponents ? " (DoNotIncludeSubcomponents)" : ""}`;
}

// ---------- export ----------

export const VERDICT_LABEL: Record<SlimVerdict, string> = {
  remove: "Remove",
  shell: "Convert to shell",
  customized: "Keep: customized",
  unmanaged: "Keep: yours",
  included: "Keep: included by your table",
  parent: "Keep: parent of a kept component",
  unknown: "Unknown: kept",
};

export const ORIGIN_LABEL: Record<Origin, string> = { custom: "yours", platform: "platform", managed: "managed" };

export function slimCsv(a: SlimAnalysis, csvCell: (v: string) => string): string {
  const rows = [["verdict", "type", "name", "table", "origin", "layers", "changes", "owner", "also in", "reason"]];
  for (const r of a.rows) rows.push([VERDICT_LABEL[r.verdict], typeName(r.component.type), r.name.name, r.name.table ?? "", r.origin ? ORIGIN_LABEL[r.origin] : "unknown", r.layers.join(" > "), r.changes.join("; "), r.owner ?? "", r.alsoIn.join("; "), r.reason]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

export function slimMarkdown(a: SlimAnalysis): string {
  const c = a.counts;
  const out = [
    `# Slim ${a.solution.uniqueName} ${a.solution.version} (${a.environment.name})`,
    "",
    `${c.total} components: ${c.remove} to remove, ${c.shell} table(s) to convert to a shell, ${c.customized} customized kept, ${c.unmanaged} yours, ${c.parent} parent(s) kept, ${c.included} included by your tables, ${c.unknown} unknown (kept).`,
    "",
  ];
  const section = (title: string, verdict: SlimVerdict) => {
    const list = a.rows.filter((r) => r.verdict === verdict);
    if (!list.length) return;
    out.push(`## ${title} (${list.length})`, "");
    for (const r of list) out.push(`- [ ] ${typeName(r.component.type)} ${r.name.name}${r.name.table ? ` (${r.name.table})` : ""} · ${r.reason}`);
    out.push("");
  };
  section("Remove", "remove");
  section("Convert to shell", "shell");
  section("Unknown, kept", "unknown");
  section("Keep: customized", "customized");
  for (const w of a.warnings) out.push(`> ${w}`, "");
  return out.join("\n");
}

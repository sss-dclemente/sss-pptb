/**
 * Failed import: an upgrade already failed with "The <table>(<id>) component cannot be deleted because it is referenced
 * by N other components". Read the error (solution history or pasted text), find what references each component in the
 * environment where the import failed, where each reference lives (solution layers), and fix it there:
 * - an unmanaged (Active) layer on top of a managed component → RemoveActiveCustomizations;
 * - an unmanaged cloud flow that uses a connection reference the upgrade deletes → re-point it to another connection
 *   reference of the same connector (clientdata rewrite, undoable from the backup).
 * Everything else is reported with where to fix it. One connection: the environment the import failed in.
 */
import { Cancelled } from "./diagnose";
import { assertGuid, fetchOwningSolutions, lid, pool, queryAll, queryByIds, retrieveDependenciesForDelete, type DataverseLike, type MetaCache } from "./fetch";
import { CT, typeName, type Row } from "./types";
import { componentLayers, LAYER_NAMES, named, odataString, UPGRADE_CONCURRENCY, type UComponent } from "./upgrade";

/** One "cannot be deleted" component named in an error. */
export interface BlockedRef {
  /** table logical name or component name as the error writes it ("connectionreference", "Entity") */
  entity: string;
  id: string;
  /** "referenced by N other components" */
  count: number | null;
}

export interface FailedRun {
  id: string;
  solution: string;
  version: string;
  startedOn: string;
  message: string;
  refs: BlockedRef[];
}

const BLOCKED_RE = /([A-Za-z_][\w.]*)\s*\(\s*\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?\s*\)\s*component cannot be deleted because it is referenced by (\d+) other component/gi;

/** Every distinct component an error text says cannot be deleted (the fault XML repeats the message several times). */
export function parseBlocked(text: string): BlockedRef[] {
  const out = new Map<string, BlockedRef>();
  for (const m of text.matchAll(BLOCKED_RE)) {
    const id = m[2].toLowerCase();
    if (!out.has(id)) out.set(id, { entity: m[1], id, count: Number(m[3]) });
  }
  return [...out.values()];
}

/** The solution an error text names: "Solution 'X' failed" / solution history row; empty when it does not say. */
export function parseSolutionName(text: string): string {
  const m = text.match(/solution\s+['"]?([A-Za-z_][\w]*)['"]?\s+(?:failed|import|upgrade)/i);
  return m ? m[1] : "";
}

const HISTORY_SELECT = "msdyn_solutionhistoryid,msdyn_name,msdyn_solutionversion,msdyn_starttime,msdyn_exceptionmessage,msdyn_result,msdyn_operation";
export const HISTORY_TOP = 100;

/**
 * Failed solution operations whose message names a component that cannot be deleted, newest first. msdyn_solutionhistory
 * is a virtual table: when the filtered query is refused, the newest rows are read unfiltered and filtered here.
 */
export async function fetchFailedRuns(api: DataverseLike): Promise<FailedRun[]> {
  let rows: Row[];
  try {
    rows = (await api.queryData(`msdyn_solutionhistories?$select=${HISTORY_SELECT}&$filter=msdyn_result eq false&$orderby=msdyn_starttime desc&$top=${HISTORY_TOP}`)).value ?? [];
  } catch {
    rows = ((await api.queryData(`msdyn_solutionhistories?$select=${HISTORY_SELECT}&$orderby=msdyn_starttime desc&$top=${HISTORY_TOP}`)).value ?? []).filter((r) => r.msdyn_result === false);
  }
  return rows
    .map((r) => {
      const message = String(r.msdyn_exceptionmessage ?? "");
      return {
        id: lid(r.msdyn_solutionhistoryid),
        solution: String(r.msdyn_name ?? ""),
        version: String(r.msdyn_solutionversion ?? ""),
        startedOn: String(r.msdyn_starttime ?? ""),
        message,
        refs: parseBlocked(message),
      };
    })
    .filter((r) => r.refs.length)
    .sort((a, b) => b.startedOn.localeCompare(a.startedOn));
}

/** Component type of the names errors use, when solutioncomponentdefinitions does not say. */
const STATIC_TYPES: Record<string, number> = {
  entity: CT.Entity,
  attribute: CT.Attribute,
  relationship: CT.EntityRelationship,
  entityrelationship: CT.EntityRelationship,
  optionset: CT.OptionSet,
  savedquery: CT.View,
  workflow: CT.Workflow,
  savedqueryvisualization: CT.Chart,
  systemform: CT.Form,
  webresource: CT.WebResource,
  sitemap: CT.SiteMap,
  appmodule: CT.AppModule,
  sdkmessageprocessingstep: CT.PluginStep,
  canvasapp: 300,
  role: 20,
  fieldsecurityprofile: 70,
  pluginassembly: 91,
  plugintype: 90,
  customcontrol: 66,
  environmentvariabledefinition: 380,
  environmentvariablevalue: 381,
};

/** "connectionreference" → its per-org component type; null when unknown. */
export async function componentTypeOf(api: DataverseLike, entity: string): Promise<number | null> {
  const e = entity.toLowerCase();
  const rows = await queryAll(api, "solutioncomponentdefinitions?$select=solutioncomponenttype,name,primaryentityname").catch(() => [] as Row[]);
  const hit = rows.find((r) => String(r.primaryentityname ?? "").toLowerCase() === e) ?? rows.find((r) => String(r.name ?? "").toLowerCase() === e);
  if (hit) return Number(hit.solutioncomponenttype);
  return STATIC_TYPES[e] ?? null;
}

export type FailLocation = "dev" | "release" | "target";

export type FailFix =
  | { id: string; kind: "remove-active"; label: string; layerName: string }
  | { id: string; kind: "repoint-flow"; label: string; from: string; to: { id: string; logicalName: string } }
  | { id: string; kind: "report"; label: string };

export interface FailBlocker {
  key: string;
  required: UComponent;
  dependent: UComponent;
  location: FailLocation;
  owner: string;
  layers: string[];
  layerSource: "layers" | "membership";
  note: string;
  fixes: FailFix[];
}

export interface FailedCheck {
  environment: { name: string; url: string };
  /** the solution whose import failed ("" when the error did not say) */
  solution: string;
  /** components the error names, with what the check found */
  components: { ref: BlockedRef; component: UComponent | null; exists: boolean; dependents: number; error?: string }[];
  blockers: FailBlocker[];
  warnings: string[];
  takenAt: string;
}

export interface FailedOptions {
  /** bound to the environment the import failed in */
  api: DataverseLike;
  meta: MetaCache;
  refs: BlockedRef[];
  solution: string;
  environment: { name: string; url: string };
  onProgress?: (phase: string, done: number, total: number) => void;
  cancelled?: () => boolean;
}

const key = (type: number, id: string): string => `${type}:${id}`;
const msg = (e: unknown): string => (e as Error)?.message ?? String(e);

interface ConnRef {
  id: string;
  logicalName: string;
  displayName: string;
  connectorId: string;
}

async function connRefs(api: DataverseLike, filter: string): Promise<ConnRef[]> {
  const rows = await queryAll(api, `connectionreferences?$select=connectionreferenceid,connectionreferencelogicalname,connectionreferencedisplayname,connectorid&$filter=${filter}`);
  return rows.map((r) => ({
    id: lid(r.connectionreferenceid),
    logicalName: String(r.connectionreferencelogicalname ?? ""),
    displayName: String(r.connectionreferencedisplayname ?? r.connectionreferencelogicalname ?? ""),
    connectorId: String(r.connectorid ?? ""),
  }));
}

/** Logical names of the connection references a cloud flow's clientdata points to (lower case). */
export function flowConnRefNames(clientdata: string): string[] {
  try {
    const o = JSON.parse(clientdata) as { properties?: { connectionReferences?: Record<string, { connection?: { connectionReferenceLogicalName?: unknown } }> } };
    return Object.values(o?.properties?.connectionReferences ?? {})
      .map((v) => v?.connection?.connectionReferenceLogicalName)
      .filter((x): x is string => typeof x === "string" && !!x)
      .map((x) => x.toLowerCase());
  } catch {
    return [];
  }
}

/** clientdata with every reference to `from` (logical name) pointed at `to`; keys, api names and the definition stay. */
export function repointClientdata(clientdata: string, from: string, to: string): { json: string; changed: number } {
  const o = JSON.parse(clientdata) as { properties?: { connectionReferences?: Record<string, { connection?: { connectionReferenceLogicalName?: unknown } }> } };
  let changed = 0;
  for (const v of Object.values(o?.properties?.connectionReferences ?? {})) {
    const c = v?.connection;
    if (c && typeof c.connectionReferenceLogicalName === "string" && c.connectionReferenceLogicalName.toLowerCase() === from.toLowerCase()) {
      c.connectionReferenceLogicalName = to;
      changed++;
    }
  }
  return { json: changed ? JSON.stringify(o) : clientdata, changed };
}

export async function checkFailed(o: FailedOptions): Promise<FailedCheck> {
  const api = o.api;
  const cancelled = () => !!o.cancelled?.();
  const step = (phase: string, done: number, total: number) => o.onProgress?.(phase, done, total);
  const warnings: string[] = [];
  const sLower = o.solution.toLowerCase();
  const upgradeName = `${sLower}_upgrade`;

  // 1. component types, then what references each component
  const types = new Map<string, number | null>();
  for (const r of o.refs) if (!types.has(r.entity.toLowerCase())) types.set(r.entity.toLowerCase(), await componentTypeOf(api, r.entity));
  const comps: FailedCheck["components"] = [];
  const pairs: { req: { type: number; id: string }; dep: { type: number; id: string; parentId: string | null } }[] = [];
  let done = 0;
  step("RetrieveDependenciesForDelete", 0, o.refs.length);
  await pool(
    o.refs,
    UPGRADE_CONCURRENCY,
    async (ref) => {
      const type = types.get(ref.entity.toLowerCase()) ?? null;
      const entry: FailedCheck["components"][number] = { ref, component: null, exists: false, dependents: 0 };
      comps.push(entry);
      if (type == null) {
        entry.error = `unknown component type “${ref.entity}”`;
      } else {
        entry.component = { type, id: ref.id, name: ref.id };
        try {
          const rows = await retrieveDependenciesForDelete(api, ref.id, type);
          const deps = rows.filter((d) => d.dependentId && d.dependentId !== ref.id);
          entry.dependents = deps.length;
          for (const d of deps) pairs.push({ req: { type, id: ref.id }, dep: { type: d.dependentType, id: d.dependentId, parentId: d.dependentParentId } });
        } catch (e) {
          entry.error = msg(e);
        }
      }
      step("RetrieveDependenciesForDelete", ++done, o.refs.length);
    },
    cancelled,
  );
  if (cancelled()) throw new Cancelled();
  comps.sort((a, b) => o.refs.indexOf(a.ref) - o.refs.indexOf(b.ref));

  // 2. names; a component still there resolves to a name (or at least to a solution row)
  step("Reading names", 0, 1);
  const names = await named(api, o.meta, [
    ...comps.filter((c) => c.component).map((c) => ({ type: c.component!.type, id: c.component!.id })),
    ...pairs.map((p) => ({ type: p.dep.type, id: p.dep.id, parentId: p.dep.parentId })),
  ]);
  // per-org types have no fixed type name: the table the error named is the kind ("connectionreference" → Connection reference)
  const kinds = new Map<number, string>();
  for (const [e, t] of types) if (t != null && !STATIC_TYPES[e]) kinds.set(t, e === "connectionreference" ? "Connection reference" : e);
  const nm = (type: number, id: string): UComponent => {
    const c = names.get(key(type, id)) ?? { type, id, name: id };
    return kinds.has(type) && !c.kind ? { ...c, kind: kinds.get(type) } : c;
  };
  const held = await fetchOwningSolutions(api, comps.filter((c) => c.component).map((c) => c.ref.id)).catch(() => new Map<string, string[]>());
  for (const c of comps)
    if (c.component) {
      c.component = nm(c.component.type, c.component.id);
      c.exists = c.component.name !== c.component.id || held.has(c.ref.id) || c.dependents > 0;
    }

  // 3. layers of each dependent
  const dependents = [...new Map(pairs.map((p) => [key(p.dep.type, p.dep.id), p.dep])).values()];
  const defs = new Map<number, string>();
  if (dependents.length)
    for (const r of await queryAll(api, "solutioncomponentdefinitions?$select=solutioncomponenttype,name").catch(() => [] as Row[])) if (r.name) defs.set(Number(r.solutioncomponenttype), String(r.name));
  const layerName = (t: number): string | undefined => LAYER_NAMES[t] ?? defs.get(t);
  const layers = new Map<string, { list: string[]; source: "layers" | "membership" }>();
  done = 0;
  step("Reading solution layers", 0, dependents.length);
  await pool(
    dependents,
    UPGRADE_CONCURRENCY,
    async (d) => {
      const ln = layerName(d.type);
      if (ln) {
        const list = await componentLayers(api, d.id, ln).catch(() => null);
        if (list) layers.set(key(d.type, d.id), { list, source: "layers" });
      }
      step("Reading solution layers", ++done, dependents.length);
    },
    cancelled,
  );
  if (cancelled()) throw new Cancelled();
  const noLayers = dependents.filter((d) => !layers.has(key(d.type, d.id)));
  if (noLayers.length) {
    const h = await fetchOwningSolutions(api, noLayers.map((d) => d.id)).catch(() => new Map<string, string[]>());
    const solIds = [...new Set([...h.values()].flat())];
    const sols = solIds.length ? await queryByIds(api, solIds, "solutionid", (f) => `solutions?$select=solutionid,uniquename,ismanaged&$filter=${f}`).catch(() => [] as Row[]) : [];
    const byId = new Map(sols.map((r) => [lid(r.solutionid), { uniqueName: String(r.uniquename ?? ""), isManaged: !!r.ismanaged }]));
    for (const d of noLayers) {
      const managed = (h.get(d.id) ?? []).map((sid) => byId.get(sid)).filter((x) => x?.isManaged).map((x) => x!.uniqueName);
      layers.set(key(d.type, d.id), { list: managed.length ? managed : ["Active"], source: "membership" });
    }
    warnings.push(`Solution layers unavailable for ${noLayers.length} dependent(s): placed by solution membership. An unmanaged layer on top of a managed component would not show; check “See solution layers”.`);
  }

  // 4. connection references: same-connector alternatives, and the flows' clientdata
  const crType = [...types.entries()].find(([e]) => e === "connectionreference")?.[1] ?? null;
  const crIds = comps.filter((c) => c.component && c.component.type === crType && c.exists).map((c) => c.ref.id);
  const crById = new Map<string, ConnRef>();
  const alternatives = new Map<string, ConnRef[]>();
  const flowRefs = new Map<string, string[]>();
  if (crIds.length) {
    try {
      for (const c of await connRefs(api, crIds.map((id) => `connectionreferenceid eq ${assertGuid(id)}`).join(" or "))) crById.set(c.id, c);
      for (const c of crById.values())
        if (c.connectorId) alternatives.set(c.id, (await connRefs(api, `connectorid eq ${odataString(c.connectorId)}`)).filter((x) => x.id !== c.id).sort((a, b) => a.logicalName.localeCompare(b.logicalName)));
      const flowIds = [...new Set(pairs.filter((p) => p.req.type === crType && p.dep.type === CT.Workflow).map((p) => p.dep.id))];
      if (flowIds.length)
        for (const r of await queryByIds(api, flowIds, "workflowid", (f) => `workflows?$select=workflowid,name,category,clientdata&$filter=${f}`))
          if (Number(r.category) === 5 && typeof r.clientdata === "string") flowRefs.set(lid(r.workflowid), flowConnRefNames(r.clientdata));
    } catch (e) {
      warnings.push(`Connection references could not be read: ${msg(e)}. Re-pointing flows is not offered.`);
    }
  }

  // 5. classify
  const blockers: FailBlocker[] = [];
  for (const p of pairs) {
    const required = nm(p.req.type, p.req.id);
    const dependent = nm(p.dep.type, p.dep.id);
    const lay = layers.get(key(dependent.type, dependent.id)) ?? { list: ["Active"], source: "membership" as const };
    const owner = lay.list[0] ?? "Active";
    const ownerL = owner.toLowerCase();
    const managedBelow = lay.list.slice(1).filter((x) => x.toLowerCase() !== "active");
    const kind = typeName(dependent.type).toLowerCase();
    let location: FailLocation;
    let note: string;
    const fixes: FailFix[] = [];
    if (ownerL === "active") {
      location = "target";
      const ln = layerName(dependent.type);
      if (managedBelow.length) {
        note = `Unmanaged customization in ${o.environment.name} on top of ${managedBelow.join(", ")}: it still references ${required.name}. Remove the active customization (the managed definition takes over again), then import again.`;
        if (ln && lay.source === "layers") fixes.push({ id: "remove-active", kind: "remove-active", label: "Remove active customizations (cannot be undone)", layerName: ln });
      } else note = `Unmanaged ${kind} in ${o.environment.name}, in no managed solution: edit it to drop the reference to ${required.name}, or delete it, then import again.`;
      const cr = crById.get(required.id);
      if (cr && dependent.type === CT.Workflow && (flowRefs.get(dependent.id) ?? []).includes(cr.logicalName.toLowerCase())) {
        for (const alt of alternatives.get(cr.id) ?? []) fixes.push({ id: `repoint:${alt.id}`, kind: "repoint-flow", label: `Re-point flow to ${alt.displayName} (${alt.logicalName})`, from: cr.logicalName, to: { id: alt.id, logicalName: alt.logicalName } });
        if (!(alternatives.get(cr.id) ?? []).length) note += ` No other ${cr.connectorId.split("/").pop() ?? ""} connection reference exists here to re-point the flow to.`;
      }
    } else if (sLower && (ownerL === sLower || ownerL === upgradeName)) {
      location = "dev";
      note = `${o.solution}'s own ${kind} still references ${required.name}. Remove the reference in Dev (or keep ${required.name} in the solution), export and import again. With Dev as the primary connection and this environment as the secondary, Upgrade blockers lists every such reference in one run.`;
    } else {
      location = "release";
      note = `${owner} references it. Ship a new version of ${owner} without the reference and upgrade it before ${o.solution || "this solution"}, or keep ${required.name} in ${o.solution || "the solution"}.`;
    }
    fixes.push({ id: "report", kind: "report", label: location === "dev" ? "Fix in Dev" : "Report only" });
    blockers.push({ key: `${key(dependent.type, dependent.id)}>${key(required.type, required.id)}`, required, dependent, location, owner, layers: lay.list, layerSource: lay.source, note, fixes });
  }
  const order: Record<FailLocation, number> = { target: 0, dev: 1, release: 2 };
  blockers.sort((a, b) => order[a.location] - order[b.location] || a.dependent.name.localeCompare(b.dependent.name));
  return { environment: o.environment, solution: o.solution, components: comps, blockers, warnings, takenAt: new Date().toISOString() };
}

// ---------- fixes ----------

export type FailOp =
  | { kind: "remove-active"; component: UComponent; layerName: string; activeJson: string | null; requires: string }
  | { kind: "repoint-flow"; flow: { id: string; name: string; wasOn: boolean }; from: string; to: string; before: string; after: string };

export interface FailPlan {
  ops: FailOp[];
  skipped: { name: string; reason: string }[];
}

export interface FailSelection {
  blocker: FailBlocker;
  fixId: string;
}

/** Selected fixes → operations, with what the backup needs: the Active layer's JSON, the flow's clientdata before. */
export async function planFailedFixes(api: DataverseLike, selections: FailSelection[]): Promise<FailPlan> {
  const ops: FailOp[] = [];
  const skipped: FailPlan["skipped"] = [];
  const flows = new Map<string, Extract<FailOp, { kind: "repoint-flow" }>>();
  for (const s of selections) {
    const fix = s.blocker.fixes.find((f) => f.id === s.fixId);
    const d = s.blocker.dependent;
    if (!fix || fix.kind === "report") {
      skipped.push({ name: d.name, reason: "report only" });
      continue;
    }
    if (fix.kind === "remove-active") {
      if (ops.some((x) => x.kind === "remove-active" && x.component.id === d.id)) continue;
      let activeJson: string | null = null;
      try {
        const rows = await queryAll(api, `msdyn_componentlayers?$select=msdyn_componentjson,msdyn_solutionname&$filter=msdyn_componentid eq ${odataString(assertGuid(d.id))} and msdyn_solutioncomponentname eq ${odataString(fix.layerName)}`);
        const active = rows.find((r) => String(r.msdyn_solutionname ?? "").toLowerCase() === "active");
        activeJson = active ? String(active.msdyn_componentjson ?? "") : null;
      } catch {
        activeJson = null;
      }
      ops.push({ kind: "remove-active", component: d, layerName: fix.layerName, activeJson, requires: s.blocker.required.name });
      continue;
    }
    // re-point: several connection references of one flow go into one clientdata write
    let op = flows.get(d.id);
    if (!op) {
      const r = (await queryAll(api, `workflows?$select=workflowid,name,statecode,clientdata&$filter=workflowid eq ${assertGuid(d.id)}`))[0];
      if (!r || typeof r.clientdata !== "string") {
        skipped.push({ name: d.name, reason: "flow not found" });
        continue;
      }
      op = { kind: "repoint-flow", flow: { id: d.id, name: String(r.name ?? d.name), wasOn: Number(r.statecode) === 1 }, from: fix.from, to: fix.to.logicalName, before: r.clientdata, after: r.clientdata };
      flows.set(d.id, op);
      ops.push(op);
    } else {
      op.from += `, ${fix.from}`;
      op.to += `, ${fix.to.logicalName}`;
    }
    const next = repointClientdata(op.after, fix.from, fix.to.logicalName);
    if (!next.changed) skipped.push({ name: d.name, reason: `clientdata does not name ${fix.from}` });
    op.after = next.json;
  }
  return { ops: ops.filter((x) => x.kind !== "repoint-flow" || x.after !== x.before), skipped };
}

/**
 * RemoveActiveCustomizations is a Web API function with an Edm.Guid parameter, so it goes through queryData
 * (docs/PPTB-NOTES.md §12). Learn writes the guid as `ComponentId=(…)`; the plain OData literal is tried first.
 */
export async function removeActive(api: DataverseLike, layerName: string, id: string): Promise<void> {
  const g = assertGuid(id);
  const name = odataString(layerName);
  try {
    await api.queryData(`RemoveActiveCustomizations(SolutionComponentName=${name},ComponentId=${g})`);
  } catch (e) {
    try {
      await api.queryData(`RemoveActiveCustomizations(SolutionComponentName=${name},ComponentId=(${g}))`);
    } catch {
      throw e;
    }
  }
}

/** Off (if on) → clientdata → back on; a failure after turning it off tries to turn it back on. */
export async function writeFlow(api: DataverseLike, flow: { id: string; wasOn: boolean }, clientdata: string): Promise<{ leftOff?: boolean }> {
  if (flow.wasOn) await api.update("workflow", flow.id, { statecode: 0, statuscode: 1 });
  try {
    await api.update("workflow", flow.id, { clientdata });
  } catch (e) {
    if (flow.wasOn) await api.update("workflow", flow.id, { statecode: 1, statuscode: 2 }).catch(() => undefined);
    throw e;
  }
  if (flow.wasOn)
    try {
      await api.update("workflow", flow.id, { statecode: 1, statuscode: 2 });
    } catch (e) {
      throw new Error(`clientdata written, but turning the flow back on failed: ${msg(e)}`);
    }
  return {};
}

export interface FailOpResult {
  op: FailOp;
  ok: boolean;
  error?: string;
}

/** Ops are independent: a failure marks its row and the rest runs. */
export async function executeFailedOps(api: DataverseLike, ops: FailOp[], onStep?: (i: number, n: number) => void): Promise<FailOpResult[]> {
  const out: FailOpResult[] = [];
  for (const [i, op] of ops.entries()) {
    onStep?.(i, ops.length);
    try {
      if (op.kind === "remove-active") await removeActive(api, op.layerName, op.component.id);
      else await writeFlow(api, op.flow, op.after);
      out.push({ op, ok: true });
    } catch (e) {
      out.push({ op, ok: false, error: msg(e) });
    }
  }
  onStep?.(ops.length, ops.length);
  return out;
}

export function failOpLabel(op: FailOp): string {
  return op.kind === "remove-active"
    ? `RemoveActiveCustomizations ${op.layerName} ${op.component.name} (drops its reference to ${op.requires})`
    : `Update flow ${op.flow.name}: ${op.from} → ${op.to}${op.flow.wasOn ? " (off, update, on)" : ""}`;
}

// ---------- backup / undo ----------

export const FAILED_BACKUP_KIND = "sss-dependency-cleaner-failed-import-backup";

export interface FailedBackup {
  kind: typeof FAILED_BACKUP_KIND;
  version: 1;
  takenAt: string;
  environment: { name: string; url: string };
  solution: string;
  operations: string[];
  /** Active layers removed: kept as a record only, the platform cannot put them back */
  activeLayers: { id: string; name: string; layerName: string; json: string | null }[];
  /** flows re-pointed: Undo writes `clientdata` back */
  flows: { id: string; name: string; wasOn: boolean; clientdata: string }[];
}

export function buildFailedBackup(c: FailedCheck, p: FailPlan): FailedBackup {
  return {
    kind: FAILED_BACKUP_KIND,
    version: 1,
    takenAt: new Date().toISOString(),
    environment: c.environment,
    solution: c.solution,
    operations: p.ops.map(failOpLabel),
    activeLayers: p.ops.filter((x): x is Extract<FailOp, { kind: "remove-active" }> => x.kind === "remove-active").map((x) => ({ id: x.component.id, name: x.component.name, layerName: x.layerName, json: x.activeJson })),
    flows: p.ops.filter((x): x is Extract<FailOp, { kind: "repoint-flow" }> => x.kind === "repoint-flow").map((x) => ({ id: x.flow.id, name: x.flow.name, wasOn: x.flow.wasOn, clientdata: x.before })),
  };
}

export function parseFailedBackup(text: string): FailedBackup {
  const b = JSON.parse(text) as FailedBackup;
  if (b?.kind !== FAILED_BACKUP_KIND || b.version !== 1 || !Array.isArray(b.flows)) throw new Error("Not a Dependency Cleaner failed-import backup.");
  for (const f of b.flows) assertGuid(String(f.id), "flow id");
  return b;
}

/** Undo the flow re-points of a backup: each flow's clientdata as it was. Removed Active layers cannot come back. */
export async function undoFlows(api: DataverseLike, b: FailedBackup): Promise<{ name: string; ok: boolean; error?: string }[]> {
  const out: { name: string; ok: boolean; error?: string }[] = [];
  for (const f of b.flows) {
    try {
      const now = (await queryAll(api, `workflows?$select=workflowid,statecode&$filter=workflowid eq ${assertGuid(f.id)}`))[0];
      if (!now) throw new Error("flow not found");
      await writeFlow(api, { id: f.id, wasOn: Number(now.statecode) === 1 }, f.clientdata);
      out.push({ name: f.name, ok: true });
    } catch (e) {
      out.push({ name: f.name, ok: false, error: msg(e) });
    }
  }
  return out;
}

// ---------- export ----------

const LOC_LABEL: Record<FailLocation, string> = { target: "Fix in this environment", dev: "Fix in Dev", release: "Release first" };
export const failLocationLabel = (l: FailLocation): string => LOC_LABEL[l];
const label = (c: UComponent): string => `${c.kind ?? typeName(c.type)} ${c.name}`;

export function failedMarkdown(c: FailedCheck): string {
  const out: string[] = [];
  out.push(`# Failed import: ${c.solution || "solution"} in ${c.environment.name}`);
  out.push("");
  out.push(`${c.environment.url} · ${c.takenAt}`);
  out.push("");
  out.push("## Components that could not be deleted");
  out.push("");
  for (const x of c.components) out.push(`- ${x.component ? label(x.component) : `${x.ref.entity} ${x.ref.id}`}: ${x.error ? `check failed (${x.error})` : !x.exists ? "no longer exists" : `${x.dependents} dependent(s)`}`);
  out.push("");
  for (const loc of ["target", "dev", "release"] as FailLocation[]) {
    const list = c.blockers.filter((b) => b.location === loc);
    if (!list.length) continue;
    out.push(`## ${LOC_LABEL[loc]} (${list.length})`);
    out.push("");
    for (const b of list) out.push(`- [ ] ${label(b.dependent)} → ${label(b.required)} · ${b.owner} · ${b.note}`);
    out.push("");
  }
  return out.join("\n");
}

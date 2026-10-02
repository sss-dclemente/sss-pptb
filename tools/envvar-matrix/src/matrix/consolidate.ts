/**
 * Connection reference consolidation: merge several connection references of the same connector into one, rewriting
 * every cloud flow that uses them. A flow names its references in `workflow.clientdata`:
 *   properties.connectionReferences.<key>.connection.connectionReferenceLogicalName
 * Merging rewrites that logical name only; keys, `api.name` and the flow definition are left as they are.
 */
import { connRefComponentType, queryAll, type DataverseLike } from "./fetch";
import type { ColumnMeta, ConnRefRecord, Target } from "./types";
import { sameConnection, stampOf, type ConnectionStamp } from "./write";

type Row = Record<string, unknown>;
const lc = (v: string): string => v.toLowerCase();

export interface FlowRef {
  /** key in clientdata.properties.connectionReferences */
  key: string;
  logicalName: string;
  apiName: string | null;
}

export interface FlowRecord {
  id: string;
  name: string;
  statecode: number;
  statuscode: number;
  isManaged: boolean;
  clientdata: string;
  refs: FlowRef[];
  parseError?: string;
}

/** Connection references a flow's clientdata points to. Throws when clientdata is not JSON. */
export function parseFlowRefs(clientdata: string): FlowRef[] {
  const o = JSON.parse(clientdata) as { properties?: { connectionReferences?: Record<string, Row> } };
  const map = o?.properties?.connectionReferences;
  if (!map || typeof map !== "object") return [];
  const out: FlowRef[] = [];
  for (const [key, v] of Object.entries(map)) {
    const name = (v?.connection as Row | undefined)?.connectionReferenceLogicalName;
    if (typeof name !== "string" || !name) continue;
    const api = (v?.api as Row | undefined)?.name;
    out.push({ key, logicalName: name, apiName: typeof api === "string" ? api : null });
  }
  return out;
}

/** Solution-aware cloud flows (category 5, type 1 = definition) with their connection reference usage. */
export async function fetchFlows(api: DataverseLike, target: Target): Promise<FlowRecord[]> {
  const rows = await queryAll(
    api,
    "workflows?$select=workflowid,name,statecode,statuscode,ismanaged,clientdata&$filter=category eq 5 and type eq 1&$orderby=name",
    target,
  );
  return rows.map((r) => {
    const clientdata = typeof r.clientdata === "string" ? r.clientdata : "";
    let refs: FlowRef[] = [];
    let parseError: string | undefined;
    if (clientdata) {
      try {
        refs = parseFlowRefs(clientdata);
      } catch (e) {
        parseError = `clientdata does not parse: ${(e as Error).message}`;
      }
    }
    return {
      id: String(r.workflowid),
      name: String(r.name ?? r.workflowid),
      statecode: Number(r.statecode ?? 0),
      statuscode: Number(r.statuscode ?? 1),
      isManaged: !!r.ismanaged,
      clientdata,
      refs,
      parseError,
    };
  });
}

/** lowercase logical name → flows that use it (each flow once). */
export function usageByConnRef(flows: FlowRecord[]): Map<string, FlowRecord[]> {
  const out = new Map<string, FlowRecord[]>();
  for (const f of flows)
    for (const n of new Set(f.refs.map((r) => lc(r.logicalName)))) {
      const list = out.get(n);
      if (list) list.push(f);
      else out.set(n, [f]);
    }
  return out;
}

export interface ConnectorGroup {
  connectorId: string;
  connector: string;
  /** suggested keep-target first, then by name */
  refs: ConnRefRecord[];
  suggested: string;
}

/**
 * Connection references grouped by connector, groups of two or more only. Suggested target: bound, then most used,
 * then managed (it ships with a solution and survives), then name.
 */
export function connectorGroups(refs: ConnRefRecord[], usage: Map<string, FlowRecord[]>): ConnectorGroup[] {
  const by = new Map<string, ConnRefRecord[]>();
  for (const r of refs) {
    if (!r.connectorId) continue;
    const k = lc(r.connectorId);
    const list = by.get(k);
    if (list) list.push(r);
    else by.set(k, [r]);
  }
  const used = (r: ConnRefRecord) => usage.get(lc(r.logicalName))?.length ?? 0;
  const score = (r: ConnRefRecord) => [r.connectionId ? 1 : 0, used(r), r.isManaged ? 1 : 0];
  const better = (a: ConnRefRecord, b: ConnRefRecord): number => {
    const x = score(a), y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
    return a.logicalName.localeCompare(b.logicalName);
  };
  return [...by.values()]
    .filter((l) => l.length > 1)
    .map((l) => {
      const best = [...l].sort(better)[0];
      const rest = l.filter((r) => r !== best).sort((a, b) => a.logicalName.localeCompare(b.logicalName));
      return { connectorId: best.connectorId!, connector: best.connector ?? best.connectorId!, refs: [best, ...rest], suggested: best.logicalName };
    })
    .sort((a, b) => a.connector.localeCompare(b.connector));
}

export interface MergeSpec {
  /** logical name kept */
  target: string;
  /** logical names merged into target */
  sources: string[];
}

export interface FlowChange {
  key: string;
  from: string;
  to: string;
}

export type FlowAction = "update" | "skip";

export interface PlannedFlow {
  flowId: string;
  name: string;
  action: FlowAction;
  reason: string;
  wasOn: boolean;
  isManaged: boolean;
  changes: FlowChange[];
  collapsed?: KeyCollapse[];
  oldClientdata: string;
  newClientdata: string | null;
  warning?: string;
}

export type DeleteAction = "delete" | "keep";

export interface PlannedDelete {
  connRefId: string;
  logicalName: string;
  action: DeleteAction;
  reason: string;
}

export interface MergePlan {
  target: ColumnMeta;
  stamp: ConnectionStamp;
  specs: MergeSpec[];
  flows: PlannedFlow[];
  deletes: PlannedDelete[];
  /** plan-level cautions: identity change, unbound target */
  warnings: string[];
  /** blocking problems: nothing is applied while any exist */
  errors: string[];
}

/** Key `drop` of connectionReferences folded into key `into`; `uses` = references rewritten in the definition. */
export interface KeyCollapse {
  drop: string;
  into: string;
  uses: number;
}

const esc = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Point every use of connection key `from` in a flow definition at `to`: `host.connectionName` values and
 * `$connections['from']` expressions. Returns the rewritten definition and the number of uses changed.
 */
export function renameConnectionKey(definition: unknown, from: string, to: string): { definition: unknown; uses: number } {
  let uses = 0;
  // parameters('$connections')['key'] and ['$connections']['key']
  const expr = new RegExp(`(\\$connections'\\s*[)\\]]\\s*\\[\\s*')${esc(from)}('\\s*\\])`, "g");
  const walk = (v: unknown, parentKey: string | null): unknown => {
    if (typeof v === "string") {
      if (parentKey === "connectionName" && v === from) {
        uses++;
        return to;
      }
      let n = 0;
      const out = v.replace(expr, (_m, a: string, b: string) => {
        n++;
        return `${a}${to}${b}`;
      });
      uses += n;
      return out;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, null));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Row).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return { definition: walk(definition, null), uses };
}

/** True when `key` still appears in the definition as a string value or a quoted index (a use renameConnectionKey did not cover). */
function keyStillUsed(definition: unknown, key: string): boolean {
  const text = JSON.stringify(definition ?? null);
  return text.includes(JSON.stringify(key)) || text.includes(`'${key}'`);
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Rewrite clientdata: every reference key whose logical name is in `rename` gets the new name. With `collapse`, keys
 * that then point to the same reference (same api, runtimeSource and impersonation) fold into one: the kept key is the
 * one not renamed (else the one equal to the api name, else the first), the definition is repointed, and a key is only
 * dropped when no use of it is left in the definition.
 */
export function rewriteClientdata(
  clientdata: string,
  rename: Map<string, string>,
  collapse = false,
): { json: string; changes: FlowChange[]; collapsed: KeyCollapse[]; kept: string[] } {
  const o = JSON.parse(clientdata) as { properties?: { connectionReferences?: Record<string, Row>; definition?: unknown } };
  const map = o?.properties?.connectionReferences ?? {};
  const changes: FlowChange[] = [];
  for (const [key, v] of Object.entries(map)) {
    const conn = v?.connection as Row | undefined;
    const name = conn?.connectionReferenceLogicalName;
    if (typeof name !== "string") continue;
    const to = rename.get(lc(name));
    if (!to || lc(to) === lc(name)) continue;
    conn!.connectionReferenceLogicalName = to;
    changes.push({ key, from: name, to });
  }
  const collapsed: KeyCollapse[] = [];
  /** duplicate keys left in place, with the reason */
  const kept: string[] = [];
  if (collapse && o.properties) {
    const renamed = new Set(changes.map((c) => c.key));
    const groups = new Map<string, string[]>();
    for (const [key, v] of Object.entries(map)) {
      const name = (v?.connection as Row | undefined)?.connectionReferenceLogicalName;
      if (typeof name !== "string") continue;
      const g = `${lc(name)}|${lc(String((v?.api as Row | undefined)?.name ?? ""))}`;
      const list = groups.get(g);
      if (list) list.push(key);
      else groups.set(g, [key]);
    }
    for (const keys of groups.values()) {
      if (keys.length < 2 || !keys.some((k) => renamed.has(k))) continue;
      const api = String((map[keys[0]]?.api as Row | undefined)?.name ?? "");
      const into = keys.find((k) => !renamed.has(k)) ?? keys.find((k) => k === api) ?? keys[0];
      for (const drop of keys) {
        if (drop === into) continue;
        const a = map[into], b = map[drop];
        if (!sameJson(a.runtimeSource, b.runtimeSource) || !sameJson(a.impersonation, b.impersonation)) {
          kept.push(`${drop}: runtimeSource / impersonation differs from ${into}`);
          continue;
        }
        const r = renameConnectionKey(o.properties.definition, drop, into);
        if (keyStillUsed(r.definition, drop)) {
          kept.push(`${drop}: used in a form this tool does not rewrite`);
          continue;
        }
        o.properties.definition = r.definition;
        delete map[drop];
        collapsed.push({ drop, into, uses: r.uses });
      }
    }
  }
  return { json: changes.length ? JSON.stringify(o) : clientdata, changes, collapsed, kept };
}

export interface PlanOptions {
  deleteSources: boolean;
  /** fold keys that end up on the same reference into one */
  collapseKeys?: boolean;
}

export function planMerge(target: ColumnMeta, refs: ConnRefRecord[], flows: FlowRecord[], specs: MergeSpec[], opts: PlanOptions): MergePlan {
  const byName = new Map(refs.map((r) => [lc(r.logicalName), r]));
  const errors: string[] = [];
  const warnings: string[] = [];
  const rename = new Map<string, string>();
  const targets = new Set(specs.map((s) => lc(s.target)));
  for (const s of specs) {
    const t = byName.get(lc(s.target));
    if (!t) {
      errors.push(`target ${s.target} does not exist in ${target.name}`);
      continue;
    }
    if (!s.sources.length) continue;
    if (!t.connectionId) warnings.push(`${t.logicalName} is not bound to a connection: flows that are on cannot be turned back on until it is`);
    for (const name of s.sources) {
      const src = byName.get(lc(name));
      if (!src) errors.push(`${name} does not exist in ${target.name}`);
      else if (lc(name) === lc(s.target)) errors.push(`${name} is both source and target`);
      else if (targets.has(lc(name))) errors.push(`${name} is a target of another merge and cannot also be merged`);
      else if (rename.has(lc(name))) errors.push(`${name} is selected in more than one merge`);
      else if (lc(src.connectorId ?? "") !== lc(t.connectorId ?? "")) errors.push(`${name} (${src.connector}) and ${t.logicalName} (${t.connector}) use different connectors`);
      else {
        rename.set(lc(name), t.logicalName);
        if (src.connectionId && t.connectionId && lc(src.connectionId) !== lc(t.connectionId))
          warnings.push(`${src.logicalName} is bound to a different connection than ${t.logicalName}: its flows will run as ${t.logicalName}'s connection`);
      }
    }
  }

  const planned: PlannedFlow[] = [];
  for (const f of flows) {
    if (!f.refs.some((r) => rename.has(lc(r.logicalName)))) continue;
    const base = { flowId: f.id, name: f.name, wasOn: f.statecode === 1, isManaged: f.isManaged, oldClientdata: f.clientdata };
    if (f.parseError) {
      planned.push({ ...base, action: "skip", reason: f.parseError, changes: [], newClientdata: null });
      continue;
    }
    const { json, changes, collapsed, kept } = rewriteClientdata(f.clientdata, rename, !!opts.collapseKeys);
    const cautions: string[] = [];
    if (kept.length) cautions.push(`duplicate key kept: ${kept.join("; ")}`);
    if (f.isManaged) cautions.push("managed flow: the update adds an unmanaged layer on top");
    if (f.statecode === 2) cautions.push("flow is suspended; it is updated and left as it is");
    planned.push({
      ...base,
      action: "update",
      reason: `${changes.length} reference${changes.length === 1 ? "" : "s"} rewritten${collapsed.length ? `, ${collapsed.length} duplicate key${collapsed.length === 1 ? "" : "s"} collapsed` : ""}${f.statecode === 1 ? "; turned off, updated, turned back on" : ""}`,
      changes,
      collapsed,
      newClientdata: json,
      warning: cautions.length ? cautions.join("; ") : undefined,
    });
  }

  const deletes: PlannedDelete[] = [];
  if (opts.deleteSources)
    for (const name of rename.keys()) {
      const r = byName.get(name)!;
      const blocked = planned.some((p) => p.action === "skip" && flows.find((f) => f.id === p.flowId)?.refs.some((x) => lc(x.logicalName) === name));
      if (r.isManaged) deletes.push({ connRefId: r.id, logicalName: r.logicalName, action: "keep", reason: "managed: remove it by updating or uninstalling its solution" });
      else if (blocked) deletes.push({ connRefId: r.id, logicalName: r.logicalName, action: "keep", reason: "a flow using it is skipped" });
      else deletes.push({ connRefId: r.id, logicalName: r.logicalName, action: "delete", reason: "unused after merge (re-checked before delete)" });
    }

  return { target, stamp: stampOf(target), specs, flows: planned, deletes, warnings, errors };
}

// ---------- apply ----------

export interface WriterLike {
  update: (entity: string, id: string, record: Record<string, unknown>, target?: Target) => Promise<void>;
  delete: (entity: string, id: string, target?: Target) => Promise<void>;
}

export interface FlowResult {
  flowId: string;
  name: string;
  ok: boolean;
  /** clientdata written but the flow could not be turned back on */
  leftOff?: boolean;
  error?: string;
}

export interface DeleteResult {
  logicalName: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

const errMsg = (e: unknown): string => (e as Error)?.message ?? String(e);

/** Off (if on) → clientdata → back on. A failure after turning it off tries to turn it back on. */
export async function updateFlow(api: WriterLike, target: Target, f: { flowId: string; name: string; wasOn: boolean; newClientdata: string | null }): Promise<FlowResult> {
  const out = { flowId: f.flowId, name: f.name };
  if (f.newClientdata == null) return { ...out, ok: false, error: "nothing to write" };
  let off = false;
  try {
    if (f.wasOn) {
      await api.update("workflow", f.flowId, { statecode: 0, statuscode: 1 }, target);
      off = true;
    }
    await api.update("workflow", f.flowId, { clientdata: f.newClientdata }, target);
  } catch (e) {
    const msg = errMsg(e);
    if (off) {
      try {
        await api.update("workflow", f.flowId, { statecode: 1, statuscode: 2 }, target);
      } catch (e2) {
        return { ...out, ok: false, leftOff: true, error: `${msg}; turning it back on failed too: ${errMsg(e2)}` };
      }
    }
    return { ...out, ok: false, error: msg };
  }
  if (f.wasOn) {
    try {
      await api.update("workflow", f.flowId, { statecode: 1, statuscode: 2 }, target);
    } catch (e) {
      return { ...out, ok: false, leftOff: true, error: `updated, but turning it back on failed: ${errMsg(e)}` };
    }
  }
  return { ...out, ok: true };
}

/** Turn a flow that is on off and on again (picks up a changed connection reference binding). */
export async function updateFlowState(api: WriterLike | Pick<WriterLike, "update">, target: Target, flowId: string, name: string): Promise<FlowResult> {
  try {
    await api.update("workflow", flowId, { statecode: 0, statuscode: 1 }, target);
  } catch (e) {
    return { flowId, name, ok: false, error: `turning it off failed: ${errMsg(e)}` };
  }
  try {
    await api.update("workflow", flowId, { statecode: 1, statuscode: 2 }, target);
  } catch (e) {
    return { flowId, name, ok: false, leftOff: true, error: `turning it back on failed: ${errMsg(e)}` };
  }
  return { flowId, name, ok: true };
}

export interface ApplyDeps {
  api: DataverseLike & WriterLike;
  currentConnection: (t: Target) => Promise<ConnectionStamp | null>;
  onStep?: (label: string) => void;
}

/** Dependents that block deleting a component (RetrieveDependenciesForDelete). */
export async function dependentsForDelete(api: DataverseLike, target: Target, id: string, type: number): Promise<number> {
  const r = (await api.queryData(`RetrieveDependenciesForDelete(ObjectId=${id},ComponentType=${type})`, target)) as unknown as Row;
  const v = (r.EntityCollection as Row | undefined)?.Entities ?? r.value ?? (r as Row).Entities;
  return Array.isArray(v) ? v.length : 0;
}

export async function applyMerge(plan: MergePlan, deps: ApplyDeps): Promise<{ flows: FlowResult[]; deletes: DeleteResult[] }> {
  const t = plan.target.target;
  if (!t) throw new Error("target column is not a live connection");
  if (plan.errors.length) throw new Error(plan.errors.join("; "));
  const { api } = deps;
  const connOk = async () => sameConnection(plan.stamp, await deps.currentConnection(t).catch(() => null));

  const flows: FlowResult[] = [];
  const todo = plan.flows.filter((f) => f.action === "update");
  let refused = false;
  for (const [i, f] of todo.entries()) {
    deps.onStep?.(`Updating flow ${i + 1} / ${todo.length}: ${f.name}`);
    if (!refused && !(await connOk())) refused = true;
    if (refused) {
      flows.push({ flowId: f.flowId, name: f.name, ok: false, error: "connection changed; not written" });
      continue;
    }
    flows.push(await updateFlow(api, t, f));
  }

  const deletes: DeleteResult[] = [];
  const toDelete = plan.deletes.filter((d) => d.action === "delete");
  if (toDelete.length) {
    deps.onStep?.("Re-checking usage before delete…");
    const failedFlow = flows.some((f) => !f.ok && !f.leftOff);
    let fresh: FlowRecord[] | null = null;
    let crType: number | null = null;
    if (!refused && (await connOk())) {
      fresh = await fetchFlows(api, t).catch(() => null);
      crType = await connRefComponentType(api, t, plan.target.url);
    }
    const usage = fresh ? usageByConnRef(fresh) : null;
    for (const d of toDelete) {
      const skip = (reason: string) => deletes.push({ logicalName: d.logicalName, ok: true, skipped: true, error: reason });
      if (refused || !usage) {
        skip(refused ? "connection changed" : "could not re-read flows");
        continue;
      }
      if (failedFlow && usage.has(lc(d.logicalName))) {
        skip("still used: a flow update failed");
        continue;
      }
      const users = usage.get(lc(d.logicalName));
      if (users?.length) {
        skip(`still used by ${users.map((f) => f.name).join(", ")}`);
        continue;
      }
      try {
        if (crType != null) {
          const n = await dependentsForDelete(api, t, d.connRefId, crType);
          if (n) {
            skip(`${n} other component${n === 1 ? " depends" : "s depend"} on it (canvas app, other flow layer…)`);
            continue;
          }
        }
        if (!(await connOk())) {
          skip("connection changed");
          continue;
        }
        deps.onStep?.(`Deleting ${d.logicalName}…`);
        await api.delete("connectionreference", d.connRefId, t);
        deletes.push({ logicalName: d.logicalName, ok: true });
      } catch (e) {
        deletes.push({ logicalName: d.logicalName, ok: false, error: errMsg(e) });
      }
    }
  }
  deps.onStep?.("");
  return { flows, deletes };
}

// ---------- backup / restore ----------

export const MERGE_BACKUP_KIND = "sss-connref-merge-backup";

export interface MergeBackup {
  kind: typeof MERGE_BACKUP_KIND;
  version: 1;
  takenAt: string;
  environment: { name: string; url: string };
  specs: MergeSpec[];
  flows: { id: string; name: string; statecode: number; clientdata: string }[];
  connectionReferences: { id: string; logicalName: string; displayName: string; connectorId: string | null; connectionId: string | null }[];
}

export function buildMergeBackup(plan: MergePlan, refs: ConnRefRecord[]): MergeBackup {
  const names = new Set([...plan.specs.flatMap((s) => [s.target, ...s.sources]), ...plan.deletes.map((d) => d.logicalName)].map(lc));
  return {
    kind: MERGE_BACKUP_KIND,
    version: 1,
    takenAt: new Date().toISOString(),
    environment: { name: plan.target.name, url: plan.target.url },
    specs: plan.specs,
    flows: plan.flows.filter((f) => f.action === "update").map((f) => ({ id: f.flowId, name: f.name, statecode: f.wasOn ? 1 : 0, clientdata: f.oldClientdata })),
    connectionReferences: refs
      .filter((r) => names.has(lc(r.logicalName)))
      .map((r) => ({ id: r.id, logicalName: r.logicalName, displayName: r.displayName, connectorId: r.connectorId, connectionId: r.connectionId })),
  };
}

export function mergeBackupFileName(env: string, at = new Date()): string {
  return `connref-merge-backup-${env.replace(/[^a-z0-9._-]+/gi, "_")}-${at.toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
}

export function parseMergeBackup(text: string): MergeBackup {
  let o: Partial<MergeBackup>;
  try {
    o = JSON.parse(text) as Partial<MergeBackup>;
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (o?.kind !== MERGE_BACKUP_KIND) throw new Error("not a connection reference merge backup");
  if (o.version !== 1) throw new Error(`unsupported backup version ${String(o.version)}`);
  if (!o.environment?.url || !Array.isArray(o.flows) || !Array.isArray(o.connectionReferences)) throw new Error("backup is incomplete");
  return o as MergeBackup;
}

export interface RestorePlan {
  target: ColumnMeta;
  stamp: ConnectionStamp;
  /** connection references in the backup that no longer exist: recreated first */
  recreate: MergeBackup["connectionReferences"];
  flows: PlannedFlow[];
  /** flows in the backup that no longer exist */
  missing: string[];
  errors: string[];
}

const normUrl = (u: string): string => u.trim().toLowerCase().replace(/\/+$/, "");

export function planRestore(target: ColumnMeta, b: MergeBackup, refs: ConnRefRecord[], flows: FlowRecord[]): RestorePlan {
  const errors: string[] = [];
  if (normUrl(b.environment.url) !== normUrl(target.url)) errors.push(`backup is for ${b.environment.url}, target is ${target.url}`);
  const have = new Set(refs.map((r) => lc(r.logicalName)));
  const byId = new Map(flows.map((f) => [lc(f.id), f]));
  const planned: PlannedFlow[] = [];
  const missing: string[] = [];
  for (const bf of b.flows) {
    const cur = byId.get(lc(bf.id));
    if (!cur) {
      missing.push(bf.name);
      continue;
    }
    const same = cur.clientdata === bf.clientdata;
    planned.push({
      flowId: cur.id,
      name: cur.name,
      action: same ? "skip" : "update",
      reason: same ? "already as in backup" : `clientdata restored${cur.statecode === 1 ? "; turned off, updated, turned back on" : ""}`,
      wasOn: cur.statecode === 1,
      isManaged: cur.isManaged,
      changes: [],
      oldClientdata: cur.clientdata,
      newClientdata: same ? null : bf.clientdata,
    });
  }
  return { target, stamp: stampOf(target), recreate: b.connectionReferences.filter((r) => !have.has(lc(r.logicalName))), flows: planned, missing, errors };
}

export interface CreatorLike {
  create: (entity: string, record: Record<string, unknown>, target?: Target) => Promise<unknown>;
}

export async function applyRestore(plan: RestorePlan, deps: ApplyDeps & { api: CreatorLike }): Promise<{ created: DeleteResult[]; flows: FlowResult[] }> {
  const t = plan.target.target;
  if (!t) throw new Error("target column is not a live connection");
  if (plan.errors.length) throw new Error(plan.errors.join("; "));
  const connOk = async () => sameConnection(plan.stamp, await deps.currentConnection(t).catch(() => null));
  const created: DeleteResult[] = [];
  for (const r of plan.recreate) {
    if (!(await connOk())) {
      created.push({ logicalName: r.logicalName, ok: false, error: "connection changed" });
      continue;
    }
    deps.onStep?.(`Recreating ${r.logicalName}…`);
    try {
      const rec: Record<string, unknown> = { connectionreferencelogicalname: r.logicalName, connectionreferencedisplayname: r.displayName, connectorid: r.connectorId };
      if (r.connectionId) rec.connectionid = r.connectionId;
      await deps.api.create("connectionreference", rec, t);
      created.push({ logicalName: r.logicalName, ok: true });
    } catch (e) {
      created.push({ logicalName: r.logicalName, ok: false, error: errMsg(e) });
    }
  }
  const flows: FlowResult[] = [];
  const todo = plan.flows.filter((f) => f.action === "update");
  for (const [i, f] of todo.entries()) {
    deps.onStep?.(`Restoring flow ${i + 1} / ${todo.length}: ${f.name}`);
    if (!(await connOk())) {
      flows.push({ flowId: f.flowId, name: f.name, ok: false, error: "connection changed; not written" });
      continue;
    }
    flows.push(await updateFlow(deps.api, t, f));
  }
  deps.onStep?.("");
  return { created, flows };
}

// ---------- unused cleanup ----------

/** Connection references no cloud flow uses. Other dependents (canvas apps) are checked separately. */
export function unusedConnRefs(refs: ConnRefRecord[], usage: Map<string, FlowRecord[]>): ConnRefRecord[] {
  return refs.filter((r) => !usage.get(lc(r.logicalName))?.length).sort((a, b) => a.logicalName.localeCompare(b.logicalName));
}

/** Delete-only plan: runs through applyMerge / buildMergeBackup like a merge with no flow changes. */
export function planCleanup(target: ColumnMeta, refs: ConnRefRecord[], flows: FlowRecord[], names: string[]): MergePlan {
  const byName = new Map(refs.map((r) => [lc(r.logicalName), r]));
  const usage = usageByConnRef(flows);
  const errors: string[] = [];
  const deletes: PlannedDelete[] = [];
  for (const n of names) {
    const r = byName.get(lc(n));
    if (!r) errors.push(`${n} does not exist in ${target.name}`);
    else if (r.isManaged) deletes.push({ connRefId: r.id, logicalName: r.logicalName, action: "keep", reason: "managed: remove it by updating or uninstalling its solution" });
    else if (usage.get(lc(n))?.length) deletes.push({ connRefId: r.id, logicalName: r.logicalName, action: "keep", reason: `used by ${usage.get(lc(n))!.map((f) => f.name).join(", ")}` });
    else deletes.push({ connRefId: r.id, logicalName: r.logicalName, action: "delete", reason: "not used by any cloud flow (re-checked before delete)" });
  }
  return { target, stamp: stampOf(target), specs: [], flows: [], deletes, warnings: [], errors };
}

/** Preview-time dependency check: planned deletes with dependents become "keep". Best effort: a failed check leaves the row for the apply-time check. */
export async function markDependents(api: DataverseLike, plan: MergePlan): Promise<void> {
  const t = plan.target.target;
  if (!t) return;
  const type = await connRefComponentType(api, t, plan.target.url);
  if (type == null) return;
  for (const d of plan.deletes) {
    if (d.action !== "delete") continue;
    try {
      const n = await dependentsForDelete(api, t, d.connRefId, type);
      if (n) Object.assign(d, { action: "keep", reason: `${n} other component${n === 1 ? " depends" : "s depend"} on it (canvas app, other flow layer…)` });
    } catch {
      /* re-checked at apply */
    }
  }
}

// ---------- solution fit ----------

/** Cloud flow component type (workflow). */
export const WORKFLOW_COMPONENT = 29;

export async function fetchSolutionFlowIds(api: DataverseLike, target: Target, solutionId: string): Promise<Set<string>> {
  const rows = await queryAll(api, `solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${solutionId} and componenttype eq ${WORKFLOW_COMPONENT}`, target);
  return new Set(rows.map((r) => lc(String(r.objectid))));
}

export interface FitIssue {
  logicalName: string;
  /** null: the flow names a reference that does not exist in the environment */
  ref: ConnRefRecord | null;
  flows: string[];
}

/** References used by the solution's flows that are not in the solution (`scope`: lowercase names in the solution). */
export function solutionFit(flows: FlowRecord[], flowIds: Set<string>, refs: ConnRefRecord[], scope: Set<string>): FitIssue[] {
  const byName = new Map(refs.map((r) => [lc(r.logicalName), r]));
  const out = new Map<string, FitIssue>();
  for (const f of flows) {
    if (!flowIds.has(lc(f.id))) continue;
    for (const r of f.refs) {
      const n = lc(r.logicalName);
      if (scope.has(n)) continue;
      const issue = out.get(n) ?? { logicalName: byName.get(n)?.logicalName ?? r.logicalName, ref: byName.get(n) ?? null, flows: [] };
      if (!issue.flows.includes(f.name)) issue.flows.push(f.name);
      out.set(n, issue);
    }
  }
  return [...out.values()].sort((a, b) => a.logicalName.localeCompare(b.logicalName));
}

export interface ExecLike {
  execute: (req: DataverseAPI.ExecuteRequest, target?: Target) => Promise<Record<string, unknown>>;
}

/** AddSolutionComponent for each reference (no required components, no subcomponents). */
export async function addRefsToSolution(
  api: DataverseLike & ExecLike,
  target: ColumnMeta,
  stamp: ConnectionStamp,
  solutionUniqueName: string,
  refs: ConnRefRecord[],
  currentConnection: (t: Target) => Promise<ConnectionStamp | null>,
): Promise<DeleteResult[]> {
  const t = target.target;
  if (!t) throw new Error("target column is not a live connection");
  const type = await connRefComponentType(api, t, target.url);
  if (type == null) throw new Error("could not read the connection reference component type (EntityDefinitions)");
  const out: DeleteResult[] = [];
  for (const r of refs) {
    if (!sameConnection(stamp, await currentConnection(t).catch(() => null))) {
      out.push({ logicalName: r.logicalName, ok: false, error: "connection changed; not written" });
      continue;
    }
    try {
      await api.execute(
        {
          operationName: "AddSolutionComponent",
          operationType: "action",
          parameters: { ComponentId: r.id, ComponentType: type, SolutionUniqueName: solutionUniqueName, AddRequiredComponents: false, DoNotIncludeSubcomponents: false },
        },
        t,
      );
      out.push({ logicalName: r.logicalName, ok: true });
    } catch (e) {
      out.push({ logicalName: r.logicalName, ok: false, error: errMsg(e) });
    }
  }
  return out;
}

// ---------- turn on flows (post-import) ----------

export interface OffFlow {
  flowId: string;
  name: string;
  isManaged: boolean;
  /** logical names the flow uses */
  refs: string[];
  /** every reference exists and is bound */
  ready: boolean;
  /** why it is not ready (unbound / missing references, unreadable clientdata) */
  reason: string;
}

/** Flows that are off (statecode 0), classified by whether every connection reference they use is bound. */
export function offFlows(flows: FlowRecord[], refs: ConnRefRecord[]): OffFlow[] {
  const byName = new Map(refs.map((r) => [lc(r.logicalName), r]));
  return flows
    .filter((f) => f.statecode === 0)
    .map((f) => {
      const names = [...new Map(f.refs.map((r) => [lc(r.logicalName), r.logicalName])).values()];
      const base = { flowId: f.id, name: f.name, isManaged: f.isManaged, refs: names };
      if (f.parseError) return { ...base, ready: false, reason: f.parseError };
      const missing = names.filter((n) => !byName.has(lc(n)));
      const unbound = names.filter((n) => byName.get(lc(n)) && !byName.get(lc(n))!.connectionId);
      const problems = [missing.length ? `missing reference${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}` : "", unbound.length ? `unbound: ${unbound.join(", ")}` : ""].filter(Boolean);
      return { ...base, ready: !problems.length, reason: problems.length ? problems.join("; ") : names.length ? "all references bound" : "uses no connection references" };
    })
    .sort((a, b) => Number(b.ready) - Number(a.ready) || a.name.localeCompare(b.name));
}

/** Turn flows on (statecode 1, statuscode 2), re-checking the connection before each write. */
export async function turnOnFlows(
  api: Pick<WriterLike, "update">,
  target: ColumnMeta,
  stamp: ConnectionStamp,
  flows: { flowId: string; name: string }[],
  currentConnection: (t: Target) => Promise<ConnectionStamp | null>,
  onStep?: (m: string) => void,
): Promise<FlowResult[]> {
  const t = target.target;
  if (!t) throw new Error("target column is not a live connection");
  const out: FlowResult[] = [];
  for (const [i, f] of flows.entries()) {
    onStep?.(`Turning on ${i + 1} / ${flows.length}: ${f.name}`);
    if (!sameConnection(stamp, await currentConnection(t).catch(() => null))) {
      out.push({ flowId: f.flowId, name: f.name, ok: false, error: "connection changed; not turned on" });
      continue;
    }
    try {
      await api.update("workflow", f.flowId, { statecode: 1, statuscode: 2 }, t);
      out.push({ flowId: f.flowId, name: f.name, ok: true });
    } catch (e) {
      out.push({ flowId: f.flowId, name: f.name, ok: false, error: errMsg(e) });
    }
  }
  onStep?.("");
  return out;
}

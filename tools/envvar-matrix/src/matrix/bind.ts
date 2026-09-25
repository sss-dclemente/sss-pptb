/**
 * Bind connection references: copy connection ids from a source column (deploymentSettings.json, snapshot, other live
 * column) into `connectionreference.connectionid` of a live column. Connection ids belong to one environment, so a source
 * that is known to be another org is refused; a settings file carries no org and is trusted as written for the target.
 */
import { fetchFlows, updateFlowState, usageByConnRef, type DeleteResult, type FlowResult } from "./consolidate";
import type { DataverseLike } from "./fetch";
import type { ColumnMeta, ConnRefRow, Target } from "./types";
import { sameConnection, stampOf, type ConnectionStamp } from "./write";

export type BindAction = "update" | "skip" | "invalid";

export interface PlannedBind {
  logicalName: string;
  connRefId: string | null;
  action: BindAction;
  reason: string;
  current: string | null;
  next: string | null;
  warning?: string;
}

export interface BindPlan {
  target: ColumnMeta;
  stamp: ConnectionStamp;
  source: ColumnMeta;
  items: PlannedBind[];
}

const normUrl = (u: string): string => u.trim().toLowerCase().replace(/\/+$/, "");
const last = (id: string | null | undefined): string => (id ?? "").split("/").pop()!.toLowerCase();

/** Why a source column cannot provide connection ids for `target`, or null when it can. */
export function sourceProblem(source: ColumnMeta, target: ColumnMeta): string | null {
  if (!source.url) return null; // settings file: no org recorded
  if (normUrl(source.url) === normUrl(target.url)) return null;
  return `connection ids belong to one environment: source is ${source.name} (${source.url}), target is ${target.name} (${target.url})`;
}

export function planBind(rows: ConnRefRow[], source: ColumnMeta, target: ColumnMeta): BindPlan {
  const problem = sourceProblem(source, target);
  const items = rows.map((r): PlannedBind => {
    const src = r.cells[source.key];
    const dst = r.cells[target.key];
    const base = { logicalName: r.logicalName, connRefId: dst?.record?.id ?? null, current: dst?.connectionId ?? null, next: src?.connectionId ?? null };
    if (!dst || dst.state === "absent" || !dst.record) return { ...base, action: "skip", reason: "reference does not exist in target" };
    if (problem) return { ...base, action: "invalid", reason: problem };
    if (!src || !src.connectionId) return { ...base, action: "skip", reason: "source has no connection id" };
    const sc = src.record?.connectorId;
    if (sc && dst.record.connectorId && last(sc) !== last(dst.record.connectorId))
      return { ...base, action: "invalid", reason: `connector differs: source ${last(sc)}, target ${last(dst.record.connectorId)}` };
    if (dst.connectionId && dst.connectionId.toLowerCase() === src.connectionId.toLowerCase()) return { ...base, action: "skip", reason: "already bound to this connection" };
    return {
      ...base,
      action: "update",
      reason: dst.connectionId ? "rebinding to a different connection" : "binding an unbound reference",
      warning: dst.record.isManaged ? "managed reference: the binding is stored as an unmanaged change, as pac --settings-file does" : undefined,
    };
  });
  return { target, stamp: stampOf(target), source, items };
}

export interface BindWriter {
  update: (entity: string, id: string, record: Record<string, unknown>, target?: Target) => Promise<void>;
}

export interface BindResult {
  refs: DeleteResult[];
  /** flows turned off and on to pick up the new binding */
  flows: FlowResult[];
}

/**
 * Write the bindings; with `restart`, then turn every flow that is on and uses a rebound reference off and on again.
 * The connection is re-checked before every write.
 */
export async function applyBind(
  api: DataverseLike & BindWriter,
  plan: BindPlan,
  currentConnection: (t: Target) => Promise<ConnectionStamp | null>,
  restart: boolean,
  onStep?: (m: string) => void,
): Promise<BindResult> {
  const t = plan.target.target;
  if (!t) throw new Error("target column is not a live connection");
  const connOk = async () => sameConnection(plan.stamp, await currentConnection(t).catch(() => null));
  const refs: DeleteResult[] = [];
  const bound = new Set<string>();
  const todo = plan.items.filter((i) => i.action === "update");
  for (const [n, i] of todo.entries()) {
    onStep?.(`Binding ${n + 1} / ${todo.length}: ${i.logicalName}`);
    if (!(await connOk())) {
      refs.push({ logicalName: i.logicalName, ok: false, error: "connection changed; not written" });
      continue;
    }
    try {
      await api.update("connectionreference", i.connRefId!, { connectionid: i.next }, t);
      refs.push({ logicalName: i.logicalName, ok: true });
      bound.add(i.logicalName.toLowerCase());
    } catch (e) {
      refs.push({ logicalName: i.logicalName, ok: false, error: (e as Error)?.message ?? String(e) });
    }
  }
  const flows: FlowResult[] = [];
  if (restart && bound.size && (await connOk())) {
    onStep?.("Reading cloud flows…");
    const all = await fetchFlows(api, t);
    const usage = usageByConnRef(all);
    const ids = new Set<string>();
    const affected = [...bound].flatMap((n) => usage.get(n) ?? []).filter((f) => f.statecode === 1 && !ids.has(f.id) && ids.add(f.id));
    for (const [n, f] of affected.entries()) {
      onStep?.(`Restarting flow ${n + 1} / ${affected.length}: ${f.name}`);
      if (!(await connOk())) {
        flows.push({ flowId: f.id, name: f.name, ok: false, error: "connection changed; not restarted" });
        continue;
      }
      flows.push(await updateFlowState(api, t, f.id, f.name));
    }
  }
  onStep?.("");
  return { refs, flows };
}

// ---------- backup / restore ----------

export const BIND_BACKUP_KIND = "sss-connref-bind-backup";

export interface BindBackup {
  kind: typeof BIND_BACKUP_KIND;
  version: 1;
  takenAt: string;
  environment: { name: string; url: string };
  /** bindings before the write; connectionId null = was unbound */
  bindings: { connRefId: string; logicalName: string; connectorId: string | null; connectionId: string | null }[];
}

/** Current bindings of every reference the plan will update. */
export function buildBindBackup(plan: BindPlan, rows: ConnRefRow[]): BindBackup {
  const byName = new Map(rows.map((r) => [r.logicalName.toLowerCase(), r]));
  return {
    kind: BIND_BACKUP_KIND,
    version: 1,
    takenAt: new Date().toISOString(),
    environment: { name: plan.target.name, url: plan.target.url },
    bindings: plan.items
      .filter((i) => i.action === "update" && i.connRefId)
      .map((i) => {
        const rec = byName.get(i.logicalName.toLowerCase())?.cells[plan.target.key]?.record;
        return { connRefId: i.connRefId!, logicalName: i.logicalName, connectorId: rec?.connectorId ?? null, connectionId: i.current };
      }),
  };
}

export function bindBackupFileName(env: string, at = new Date()): string {
  return `connref-bind-backup-${env.replace(/[^a-z0-9._-]+/gi, "_")}-${at.toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
}

/** Parsed backup, or null when the JSON is not a bind backup (the caller tries other kinds). Throws when it is one but broken. */
export function parseBindBackup(o: unknown): BindBackup | null {
  const b = o as Partial<BindBackup> | null;
  if (b?.kind !== BIND_BACKUP_KIND) return null;
  if (b.version !== 1) throw new Error(`unsupported bind backup version ${String(b.version)}`);
  if (!b.environment?.url || !Array.isArray(b.bindings)) throw new Error("bind backup is incomplete");
  return b as BindBackup;
}

export interface PlannedRestoreBinding {
  connRefId: string;
  logicalName: string;
  action: "update" | "skip";
  reason: string;
  current: string | null;
  restore: string | null;
}

export interface BindRestorePlan {
  target: ColumnMeta;
  stamp: ConnectionStamp;
  items: PlannedRestoreBinding[];
  errors: string[];
}

/** Put the backed-up bindings back; a binding that was unbound is restored as unbound (connectionid null). */
export function planBindRestore(target: ColumnMeta, b: BindBackup, rows: ConnRefRow[]): BindRestorePlan {
  const errors: string[] = [];
  if (normUrl(b.environment.url) !== normUrl(target.url)) errors.push(`backup is for ${b.environment.url}, target is ${target.url}`);
  const byId = new Map<string, ConnRefRow>();
  const byName = new Map<string, ConnRefRow>();
  for (const r of rows) {
    const rec = r.cells[target.key]?.record;
    if (rec) byId.set(rec.id.toLowerCase(), r);
    byName.set(r.logicalName.toLowerCase(), r);
  }
  const items = b.bindings.map((x): PlannedRestoreBinding => {
    const row = byId.get(x.connRefId.toLowerCase()) ?? byName.get(x.logicalName.toLowerCase());
    const rec = row?.cells[target.key]?.record;
    const base = { connRefId: rec?.id ?? x.connRefId, logicalName: x.logicalName, current: rec?.connectionId ?? null, restore: x.connectionId };
    if (!rec) return { ...base, action: "skip", reason: "reference no longer exists in target" };
    if ((rec.connectionId ?? "").toLowerCase() === (x.connectionId ?? "").toLowerCase()) return { ...base, action: "skip", reason: "already as in backup" };
    return { ...base, action: "update", reason: x.connectionId ? "restore previous connection" : "restore: unbind (was unbound)" };
  });
  return { target, stamp: stampOf(target), items, errors };
}

export async function applyBindRestore(
  api: BindWriter,
  plan: BindRestorePlan,
  currentConnection: (t: Target) => Promise<ConnectionStamp | null>,
): Promise<DeleteResult[]> {
  const t = plan.target.target;
  if (!t) throw new Error("target column is not a live connection");
  if (plan.errors.length) throw new Error(plan.errors.join("; "));
  const out: DeleteResult[] = [];
  for (const i of plan.items.filter((x) => x.action === "update")) {
    if (!sameConnection(plan.stamp, await currentConnection(t).catch(() => null))) {
      out.push({ logicalName: i.logicalName, ok: false, error: "connection changed; not written" });
      continue;
    }
    try {
      await api.update("connectionreference", i.connRefId, { connectionid: i.restore }, t);
      out.push({ logicalName: i.logicalName, ok: true });
    } catch (e) {
      out.push({ logicalName: i.logicalName, ok: false, error: (e as Error)?.message ?? String(e) });
    }
  }
  return out;
}

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

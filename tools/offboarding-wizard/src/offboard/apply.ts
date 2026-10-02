/**
 * Runs a confirmed plan. One result row per operation, ok or failed; a failure never stops
 * the run and is never retried. Bounded concurrency so a large reassignment does not flood
 * the environment. Nothing here decides what to write — that is plan.ts.
 */
import { pool, type DataverseLike, type PoolControl } from "./fetch";
import type { OpResult, PlannedOp } from "./types";

export const DEFAULT_WRITE_CONCURRENCY = 4;

export type Writer = Pick<DataverseLike, "update" | "associate" | "disassociate">;

export async function runOp(api: Writer, op: PlannedOp): Promise<void> {
  const c = op.call;
  if (c.op === "update") return api.update(c.entity, c.id, c.record);
  if (c.op === "associate") return api.associate(c.entity, c.id, c.relationship, c.relatedEntity, c.relatedId);
  return api.disassociate(c.entity, c.id, c.relationship, c.relatedId);
}

export interface ApplyOptions {
  concurrency?: number;
  control?: PoolControl;
  onProgress?: (done: number, total: number) => void;
}

export async function applyPlan(api: Writer, ops: PlannedOp[], o: ApplyOptions = {}): Promise<OpResult[]> {
  return pool<PlannedOp, OpResult>(
    ops,
    o.concurrency ?? DEFAULT_WRITE_CONCURRENCY,
    async (op) => {
      try {
        await runOp(api, op);
        return { op, ok: true, error: null };
      } catch (e) {
        return { op, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    (done, total) => o.onProgress?.(done, total),
    o.control,
  );
}

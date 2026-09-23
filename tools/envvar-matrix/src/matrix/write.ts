import type { ColumnMeta, EnvVarRow, Target } from "./types";

export type PlanAction = "create" | "update" | "skip" | "invalid";

export interface PlannedWrite {
  schemaName: string;
  action: PlanAction;
  reason: string;
  currentValue: string | null;
  currentSource: string;
  newValue: string | null;
  definitionId: string | null;
  valueId: string | null;
  /** non-blocking caution shown in the preview (managed value row, duplicate value rows) */
  warning?: string;
}

export interface WriteResult extends PlannedWrite {
  ok: boolean;
  error?: string;
}

/** The connection a plan was previewed against: the org its definition/value ids belong to. */
export interface ConnectionStamp {
  connectionId: string | null;
  url: string;
}

export interface WritePlan {
  target: ColumnMeta;
  /** stamped at preview time; Apply refuses if the target's current connection differs */
  stamp: ConnectionStamp;
  items: PlannedWrite[];
}

export const stampOf = (m: ColumnMeta): ConnectionStamp => ({ connectionId: m.connectionId ?? null, url: m.url });

const normUrl = (u: string): string => u.trim().toLowerCase().replace(/\/+$/, "");

/** Same org and (when both known) same connection id. */
export function sameConnection(a: ConnectionStamp, b: ConnectionStamp | null | undefined): boolean {
  if (!b) return false;
  if (normUrl(a.url) !== normUrl(b.url)) return false;
  return !a.connectionId || !b.connectionId || a.connectionId === b.connectionId;
}

export function connectionChangedMessage(plan: WritePlan, current: ConnectionStamp | null | undefined): string {
  return `Connection changed: the preview was built for ${plan.target.name} (${plan.stamp.url}) but the ${plan.target.target ?? "target"} connection is now ${current ? current.url : "not set"}. Nothing written; refresh and preview again.`;
}

/** Validate a value against the environment variable type. Returns an error message, or null when valid. */
export function validateValue(type: string, value: string): string | null {
  if (type === "Boolean") return value === "yes" || value === "no" ? null : `Boolean must be "yes" or "no"`;
  if (type === "Number") return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim()) ? null : "Number must be numeric";
  if (type === "JSON") {
    try {
      JSON.parse(value);
      return null;
    } catch (e) {
      return `JSON does not parse: ${(e as Error).message}`;
    }
  }
  return null;
}

interface PlanSource {
  value: string | null;
  label: string;
  /** the value comes from the source's definition default, not a value row */
  fromDefault?: boolean;
}

function planOne(row: EnvVarRow, targetKey: string, src: PlanSource): PlannedWrite {
  const cell = row.cells[targetKey];
  const newValue = src.value;
  const rec = cell?.record;
  const warnings: string[] = [];
  if (rec?.valueId && rec.valueIsManaged) warnings.push("value row is managed; updating it adds an unmanaged layer on top");
  if ((rec?.valueCount ?? 0) > 1) warnings.push(`target has ${rec!.valueCount} value rows for this definition; only one is updated`);
  const mask = (v: string | null | undefined): string | null => (v == null ? null : row.isSecret ? "••••••" : v);
  const base = {
    schemaName: row.schemaName,
    currentValue: mask(cell?.effective),
    currentSource: cell?.source ?? "absent",
    newValue: row.isSecret ? mask(newValue) : newValue,
    definitionId: rec?.definitionId ?? null,
    valueId: rec?.valueId ?? null,
  };
  if (!cell || cell.source === "absent") return { ...base, action: "skip", reason: "definition does not exist in target" };
  if (row.isSecret) return { ...base, action: "skip", reason: "secret variables are read-only here" };
  if (newValue == null || newValue.trim() === "") return { ...base, action: "skip", reason: src.label === "input" ? "empty input; nothing written" : `${src.label} has no value` };
  const invalid = validateValue(row.type, newValue);
  if (invalid) return { ...base, action: "invalid", reason: invalid };
  // Equal effective value: a new value row would only pin what the target already resolves to.
  if (cell.effective === newValue)
    return { ...base, action: "skip", reason: cell.source === "value" ? "already equal" : "equals target default; no value row needed" };
  const from = src.fromDefault ? " (from source default)" : "";
  const warning = warnings.length ? warnings.join("; ") : undefined;
  if (rec?.valueId) return { ...base, action: "update", reason: (cell.source === "value" ? "value differs" : "value row exists") + from, warning };
  return { ...base, action: "create", reason: (cell.source === "default" ? "only default set; creating value row" : "no value row") + from, warning };
}

/** Copy effective values of `rows` from column `fromKey` into live column `target`. */
export function planCopy(rows: EnvVarRow[], fromKey: string, target: ColumnMeta): WritePlan {
  return {
    target,
    stamp: stampOf(target),
    items: rows.map((r) => {
      const c = r.cells[fromKey];
      return planOne(r, target.key, { value: c?.effective ?? null, label: "source", fromDefault: c?.source === "default" });
    }),
  };
}

/** Set one explicit value in live column `target`. */
export function planSet(row: EnvVarRow, target: ColumnMeta, newValue: string): WritePlan {
  return { target, stamp: stampOf(target), items: [planOne(row, target.key, { value: newValue, label: "input" })] };
}

export interface WriterLike {
  create: (entity: string, record: Record<string, unknown>, target?: Target) => Promise<{ id: string } | Record<string, unknown>>;
  update: (entity: string, id: string, record: Record<string, unknown>, target?: Target) => Promise<void>;
}

/**
 * Write the plan. `currentConnection` re-reads the target's live connection; it is checked before every write, and once
 * it no longer matches `plan.stamp` the remaining writes are refused (the plan's ids belong to the stamped org).
 */
export async function applyPlan(
  api: WriterLike,
  plan: WritePlan,
  currentConnection: (t: Target) => Promise<ConnectionStamp | null>,
): Promise<WriteResult[]> {
  const target = plan.target.target;
  if (!target) throw new Error("target column is not a live connection");
  const out: WriteResult[] = [];
  let refused: string | null = null;
  for (const item of plan.items) {
    if (item.action === "skip" || item.action === "invalid") {
      out.push({ ...item, ok: item.action === "skip", error: item.action === "invalid" ? item.reason : undefined });
      continue;
    }
    if (!refused) {
      const cur = await currentConnection(target).catch(() => null);
      if (!sameConnection(plan.stamp, cur)) refused = connectionChangedMessage(plan, cur);
    }
    if (refused) {
      out.push({ ...item, ok: false, error: refused });
      continue;
    }
    try {
      if (item.action === "update" && item.valueId) {
        await api.update("environmentvariablevalue", item.valueId, { value: item.newValue }, target);
      } else if (item.definitionId) {
        await api.create(
          "environmentvariablevalue",
          { value: item.newValue, "EnvironmentVariableDefinitionId@odata.bind": `/environmentvariabledefinitions(${item.definitionId})` },
          target,
        );
      } else {
        throw new Error("no definition id");
      }
      out.push({ ...item, ok: true });
    } catch (e) {
      out.push({ ...item, ok: false, error: (e as Error).message ?? String(e) });
    }
  }
  return out;
}

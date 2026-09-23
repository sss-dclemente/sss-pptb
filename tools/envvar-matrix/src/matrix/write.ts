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

export interface WritePlan {
  target: ColumnMeta;
  items: PlannedWrite[];
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
    items: rows.map((r) => {
      const c = r.cells[fromKey];
      return planOne(r, target.key, { value: c?.effective ?? null, label: "source", fromDefault: c?.source === "default" });
    }),
  };
}

/** Set one explicit value in live column `target`. */
export function planSet(row: EnvVarRow, target: ColumnMeta, newValue: string): WritePlan {
  return { target, items: [planOne(row, target.key, { value: newValue, label: "input" })] };
}

export interface WriterLike {
  create: (entity: string, record: Record<string, unknown>, target?: Target) => Promise<{ id: string } | Record<string, unknown>>;
  update: (entity: string, id: string, record: Record<string, unknown>, target?: Target) => Promise<void>;
}

export async function applyPlan(api: WriterLike, plan: WritePlan): Promise<WriteResult[]> {
  const target = plan.target.target;
  if (!target) throw new Error("target column is not a live connection");
  const out: WriteResult[] = [];
  for (const item of plan.items) {
    if (item.action === "skip" || item.action === "invalid") {
      out.push({ ...item, ok: item.action === "skip", error: item.action === "invalid" ? item.reason : undefined });
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

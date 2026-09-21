import type { ColumnMeta, EnvVarRow, Target } from "./types";

export type PlanAction = "create" | "update" | "skip";

export interface PlannedWrite {
  schemaName: string;
  action: PlanAction;
  reason: string;
  currentValue: string | null;
  currentSource: string;
  newValue: string | null;
  definitionId: string | null;
  valueId: string | null;
}

export interface WriteResult extends PlannedWrite {
  ok: boolean;
  error?: string;
}

export interface WritePlan {
  target: ColumnMeta;
  items: PlannedWrite[];
}

function planOne(row: EnvVarRow, targetKey: string, newValue: string | null, sourceLabel: string): PlannedWrite {
  const cell = row.cells[targetKey];
  const base = {
    schemaName: row.schemaName,
    currentValue: cell?.effective ?? null,
    currentSource: cell?.source ?? "absent",
    newValue,
    definitionId: cell?.record?.definitionId ?? null,
    valueId: cell?.record?.valueId ?? null,
  };
  if (!cell || cell.source === "absent") return { ...base, action: "skip", reason: "definition does not exist in target" };
  if (row.isSecret) return { ...base, action: "skip", reason: "secret variables are read-only here" };
  if (newValue == null) return { ...base, action: "skip", reason: `${sourceLabel} has no value` };
  if (cell.source === "value" && cell.effective === newValue) return { ...base, action: "skip", reason: "already equal" };
  if (cell.record?.valueId) return { ...base, action: "update", reason: cell.source === "value" ? "value differs" : "value row exists" };
  return { ...base, action: "create", reason: cell.source === "default" ? "only default set; creating value row" : "no value row" };
}

/** Copy effective values of `rows` from column `fromKey` into live column `target`. */
export function planCopy(rows: EnvVarRow[], fromKey: string, target: ColumnMeta): WritePlan {
  return {
    target,
    items: rows.map((r) => planOne(r, target.key, r.cells[fromKey]?.effective ?? null, "source")),
  };
}

/** Set one explicit value in live column `target`. */
export function planSet(row: EnvVarRow, target: ColumnMeta, newValue: string): WritePlan {
  return { target, items: [planOne(row, target.key, newValue, "input")] };
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
    if (item.action === "skip") {
      out.push({ ...item, ok: true });
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

import { fullAttributeDefinition, fullEntityDefinition, toFlag, type DataverseLike } from "./fetch";
import type { EnvMeta, Matrix, MatrixColumnRow, MatrixTableRow, Target } from "./types";

export type Level = "table" | "column";

export interface PlanItem {
  level: Level;
  table: string;
  tableDisplay: string;
  column: string | null;
  columnDisplay: string | null;
  current: boolean;
  next: boolean;
  reason: string;
}

export interface Plan {
  target: EnvMeta;
  items: PlanItem[];
}

export interface PlanResult extends PlanItem {
  ok: boolean;
  error?: string;
}

/** Reasons a row is excluded from a plan; surfaced in the UI so nothing is silently dropped. */
export interface Skipped {
  label: string;
  reason: string;
}

export interface PlanBuild {
  items: PlanItem[];
  skipped: Skipped[];
}

const tableItem = (r: MatrixTableRow, next: boolean, reason: string): PlanItem => ({
  level: "table",
  table: r.logicalName,
  tableDisplay: r.displayName,
  column: null,
  columnDisplay: null,
  current: r.state === "on",
  next,
  reason,
});

const columnItem = (r: MatrixTableRow, c: MatrixColumnRow, next: boolean, reason: string): PlanItem => ({
  level: "column",
  table: r.logicalName,
  tableDisplay: r.displayName,
  column: c.logicalName,
  columnDisplay: c.displayName,
  current: c.state === "on",
  next,
  reason,
});

/**
 * Set the audit flag of the selected tables / columns to `next` on the primary connection.
 * A locked flag (`CanBeChanged: false`) or a table missing from the primary is never planned.
 */
export function planSet(rows: MatrixTableRow[], selected: Set<string>, next: boolean): PlanBuild {
  const items: PlanItem[] = [];
  const skipped: Skipped[] = [];
  for (const r of rows) {
    if (selected.has(`t:${r.key}`)) {
      if (r.state === "absent") skipped.push({ label: r.logicalName, reason: "table not in the primary environment" });
      else if (r.locked) skipped.push({ label: r.logicalName, reason: "audit flag locked (CanBeChanged: false)" });
      else if ((r.state === "on") === next) skipped.push({ label: r.logicalName, reason: "already " + (next ? "on" : "off") });
      else items.push(tableItem(r, next, `set table audit ${next ? "on" : "off"}`));
    }
    for (const c of r.columns ?? []) {
      if (!selected.has(`c:${c.key}`)) continue;
      const name = `${r.logicalName}.${c.logicalName}`;
      if (c.locked) skipped.push({ label: name, reason: "audit flag locked (CanBeChanged: false)" });
      else if ((c.state === "on") === next) skipped.push({ label: name, reason: "already " + (next ? "on" : "off") });
      else items.push(columnItem(r, c, next, `set column audit ${next ? "on" : "off"}`));
    }
  }
  return { items, skipped };
}

/**
 * Make the primary environment match the comparison environment: every differing table and
 * every differing column of a loaded table, excluding locked flags and tables the primary
 * does not have (this tool changes audit flags, it does not create tables or columns).
 */
export function planMatchOther(matrix: Matrix): PlanBuild {
  const items: PlanItem[] = [];
  const skipped: Skipped[] = [];
  if (!matrix.other) return { items, skipped };
  for (const r of matrix.rows) {
    if (r.differs) {
      if (r.state === "absent") skipped.push({ label: r.logicalName, reason: "table not in the primary environment" });
      else if (r.otherState === "absent") skipped.push({ label: r.logicalName, reason: `table not in ${matrix.other.name}` });
      else if (r.locked) skipped.push({ label: r.logicalName, reason: "audit flag locked (CanBeChanged: false)" });
      else items.push(tableItem(r, r.otherState === "on", `${matrix.other.name} has it ${r.otherState}`));
    }
    for (const c of r.columns ?? []) {
      if (!c.differs) continue;
      const name = `${r.logicalName}.${c.logicalName}`;
      if (c.otherState === "absent") skipped.push({ label: name, reason: `column not in ${matrix.other.name}` });
      else if (c.locked) skipped.push({ label: name, reason: "audit flag locked (CanBeChanged: false)" });
      else items.push(columnItem(r, c, c.otherState === "on", `${matrix.other.name} has it ${c.otherState}`));
    }
  }
  return { items, skipped };
}

/** Drop OData response-only annotations and normalise `@odata.type` before sending a definition back. */
export function cleanDefinition(def: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def)) {
    if (k.startsWith("@odata.") && k !== "@odata.type") continue;
    if (k.includes("@OData.") || k.includes("@Microsoft.Dynamics.CRM.")) continue;
    out[k] = v;
  }
  const t = out["@odata.type"];
  if (typeof t === "string") out["@odata.type"] = t.replace(/^#/, "");
  // Attributes come back on some entity reads; they are updated through updateAttribute, never in the entity PUT.
  delete out.Attributes;
  return out;
}

async function writeTable(api: DataverseLike, item: PlanItem, target: Target): Promise<void> {
  const def = cleanDefinition(await fullEntityDefinition(api, item.table, target));
  const flag = toFlag(def.IsAuditEnabled);
  if (def.IsAuditEnabled == null) throw new Error("IsAuditEnabled missing from the entity definition");
  if (!flag.canBeChanged) throw new Error("audit flag is locked (CanBeChanged: false)");
  def.IsAuditEnabled = {
    Value: item.next,
    CanBeChanged: flag.canBeChanged,
    ManagedPropertyLogicalName: flag.managedPropertyLogicalName ?? "canmodifyauditsettings",
  };
  await api.updateEntityDefinition(item.table, def, { mergeLabels: true }, target);
}

async function writeColumn(api: DataverseLike, item: PlanItem, target: Target): Promise<void> {
  const def = cleanDefinition(await fullAttributeDefinition(api, item.table, item.column!, target));
  const flag = toFlag(def.IsAuditEnabled);
  if (def.IsAuditEnabled == null) throw new Error("IsAuditEnabled missing from the attribute definition");
  if (!flag.canBeChanged) throw new Error("audit flag is locked (CanBeChanged: false)");
  if (!def["@odata.type"]) throw new Error("attribute definition has no @odata.type");
  def.IsAuditEnabled = {
    Value: item.next,
    CanBeChanged: flag.canBeChanged,
    ManagedPropertyLogicalName: flag.managedPropertyLogicalName ?? "canmodifyauditsettings",
  };
  await api.updateAttribute(item.table, item.column!, def, { mergeLabels: true }, target);
}

export interface ApplyOptions {
  /** How many tables are written in parallel. Items of one table always run in order. */
  concurrency?: number;
  onProgress?: (done: number, total: number, current: string) => void;
  cancelled?: () => boolean;
}

/**
 * Apply a plan with bounded concurrency. Metadata writes are slow and each one re-reads the
 * current definition first, so this never reuses the matrix projection as a write payload.
 * Items of the same table run sequentially; whole tables run at most `concurrency` at a time.
 */
export async function applyPlan(api: DataverseLike, plan: Plan, opts: ApplyOptions = {}): Promise<PlanResult[]> {
  const target = plan.target.target;
  if (!target) throw new Error("the target column is not a live connection");
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const groups = new Map<string, PlanItem[]>();
  for (const item of plan.items) {
    const g = groups.get(item.table) ?? [];
    g.push(item);
    groups.set(item.table, g);
  }
  const queue = [...groups.values()];
  const results: PlanResult[] = [];
  let done = 0;

  const runGroup = async (items: PlanItem[]): Promise<void> => {
    for (const item of items) {
      if (opts.cancelled?.()) {
        results.push({ ...item, ok: false, error: "cancelled" });
        done++;
        continue;
      }
      const name = item.level === "table" ? item.table : `${item.table}.${item.column}`;
      try {
        if (item.level === "table") await writeTable(api, item, target);
        else await writeColumn(api, item, target);
        results.push({ ...item, ok: true });
      } catch (e) {
        results.push({ ...item, ok: false, error: (e as Error)?.message ?? String(e) });
      }
      done++;
      opts.onProgress?.(done, plan.items.length, name);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let g = queue.shift(); g; g = queue.shift()) await runGroup(g);
  });
  await Promise.all(workers);
  return results;
}

/** Tables touched by successful writes, for a scoped publish. */
export function tablesToPublish(results: PlanResult[]): string[] {
  return [...new Set(results.filter((r) => r.ok).map((r) => r.table))].sort();
}

export async function publishTables(api: DataverseLike, tables: string[], target: Target): Promise<PlanResult[]> {
  const out: PlanResult[] = [];
  for (const t of tables) {
    const item: PlanItem = { level: "table", table: t, tableDisplay: t, column: null, columnDisplay: null, current: false, next: false, reason: "publish" };
    try {
      await api.publishCustomizations(t, target);
      out.push({ ...item, ok: true });
    } catch (e) {
      out.push({ ...item, ok: false, error: (e as Error)?.message ?? String(e) });
    }
  }
  return out;
}

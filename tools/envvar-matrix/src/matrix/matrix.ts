import { SECRET_TYPE, type ColumnData, type ColumnMeta, type ConnRefCell, type ConnRefRow, type EnvVarCell, type EnvVarRow, type Filters, type Matrix } from "./types";

function envVarCell(rec: EnvVarRecordOrNull): EnvVarCell {
  if (!rec) return { source: "absent", effective: null, record: null };
  if (rec.value != null) return { source: "value", effective: rec.value, record: rec };
  if (rec.defaultValue != null) return { source: "default", effective: rec.defaultValue, record: rec };
  return { source: "missing", effective: null, record: rec };
}
type EnvVarRecordOrNull = ColumnData["envVars"][number] | null;

function connRefCell(rec: ColumnData["connRefs"][number] | null): ConnRefCell {
  if (!rec) return { state: "absent", connector: null, connectionId: null, record: null };
  return { state: rec.connectionId ? "bound" : "unbound", connector: rec.connector, connectionId: rec.connectionId, record: rec };
}

/**
 * Rows are the union over every column and carry cells for every column (copy and bind read any of them), but
 * `differs` / `anyMissing` / `anyAbsent` compare only the visible ones: keys in `hidden` are left out of the
 * comparison and of `Matrix.columns` (the rendered and CSV-exported columns).
 */
export function buildMatrix(columns: ColumnData[], hidden: ReadonlySet<string> = new Set()): Matrix {
  const visible = columns.filter((c) => !hidden.has(c.meta.key));
  // Columns that failed to load have no data: show them, but leave them out of the comparison.
  const keys = visible.filter((c) => !c.meta.error).map((c) => c.meta.key);

  const evNames = new Map<string, { schemaName: string; displayName: string; type: string; isSecret: boolean }>();
  for (const c of columns)
    for (const e of c.envVars) {
      const k = e.schemaName.toLowerCase();
      if (!evNames.has(k)) evNames.set(k, { schemaName: e.schemaName, displayName: e.displayName, type: e.type, isSecret: e.typeCode === SECRET_TYPE });
    }
  const envVars: EnvVarRow[] = Array.from(evNames.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, head]) => {
      const cells: Record<string, EnvVarCell> = {};
      for (const c of columns) cells[c.meta.key] = envVarCell(c.envVars.find((e) => e.schemaName.toLowerCase() === key) ?? null);
      const present = keys.map((k) => cells[k]).filter((x) => x.source !== "absent");
      // Secrets: compare by presence only (values are Key Vault references / masked in snapshots)
      const values = new Set(present.map((x) => (head.isSecret ? x.source : (x.effective ?? "\u0000missing"))));
      return {
        key,
        ...head,
        cells,
        // absent from every compared column (only in a hidden one) is not a difference between the visible ones
        differs: values.size > 1 || (present.length > 0 && present.length !== keys.length),
        anyMissing: keys.some((k) => cells[k].source === "missing"),
        anyAbsent: keys.some((k) => cells[k].source === "absent"),
      };
    });

  const crNames = new Map<string, { logicalName: string; displayName: string; connector: string | null }>();
  for (const c of columns)
    for (const r of c.connRefs) {
      const k = r.logicalName.toLowerCase();
      if (!crNames.has(k)) crNames.set(k, { logicalName: r.logicalName, displayName: r.displayName, connector: r.connector });
    }
  const connRefs: ConnRefRow[] = Array.from(crNames.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, head]) => {
      const cells: Record<string, ConnRefCell> = {};
      for (const c of columns) cells[c.meta.key] = connRefCell(c.connRefs.find((r) => r.logicalName.toLowerCase() === key) ?? null);
      const states = new Set(keys.map((k) => cells[k].state));
      // Same logical name bound to different connectors across environments is a difference too.
      const connectors = new Set(keys.map((k) => cells[k].record?.connectorId?.toLowerCase()).filter((x): x is string => !!x));
      return {
        key,
        ...head,
        cells,
        differs: states.size > 1 || connectors.size > 1,
        anyUnbound: keys.some((k) => cells[k].state === "unbound"),
        anyAbsent: keys.some((k) => cells[k].state === "absent"),
      };
    });

  return { columns: visible.map((c) => c.meta), envVars, connRefs };
}

/**
 * "Missing value / unbound" and "Not deployed" each narrow to rows with that problem; with both on, a row with
 * either one is shown (two kinds of gap, not a combination nobody asks for).
 */
const gapOk = (f: Filters, missing: boolean, absent: boolean): boolean => (!f.onlyMissing && !f.onlyAbsent) || (f.onlyMissing && missing) || (f.onlyAbsent && absent);

export function filterEnvVars(rows: EnvVarRow[], f: Filters): EnvVarRow[] {
  const t = f.text.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!t || r.key.includes(t) || r.displayName.toLowerCase().includes(t)) &&
      (!f.onlyDiff || r.differs) &&
      gapOk(f, r.anyMissing, r.anyAbsent) &&
      (!f.scope || f.scope.has(r.key)),
  );
}

export function filterConnRefs(rows: ConnRefRow[], f: Filters): ConnRefRow[] {
  const t = f.text.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (!t || r.key.includes(t) || r.displayName.toLowerCase().includes(t) || (r.connector ?? "").toLowerCase().includes(t)) &&
      (!f.onlyDiff || r.differs) &&
      gapOk(f, r.anyUnbound, r.anyAbsent) &&
      (!f.scope || f.scope.has(r.key)),
  );
}

/** What `differs` compares in an env var cell: secrets by presence only, others by effective value; absent is its own value. */
function envVarCellKey(row: EnvVarRow, cell: EnvVarCell): string {
  if (cell.source === "absent") return "\u0000absent";
  return row.isSecret ? cell.source : (cell.effective ?? "\u0000missing");
}

/** What `differs` compares in a connection reference cell: state and connector (connection ids are per environment). */
const connRefCellKey = (cell: ConnRefCell): string => `${cell.state}|${cell.record?.connectorId?.toLowerCase() ?? ""}`;

function diffCells<C>(cells: Record<string, C>, columns: ColumnMeta[], key: (c: C) => string): Set<string> {
  // columns that failed to load have no data and are not compared (as in buildMatrix)
  const keys = columns.filter((c) => !c.error && cells[c.key]).map((c) => c.key);
  const out = new Set<string>();
  if (keys.length < 2) return out;
  const ref = key(cells[keys[0]]);
  for (const k of keys.slice(1)) if (key(cells[k]) !== ref) out.add(k);
  return out;
}

/** Keys of the columns whose cell differs from the first compared column of `columns` (the visible ones, in order). */
export const envVarDiffCells = (row: EnvVarRow, columns: ColumnMeta[]): Set<string> => diffCells(row.cells, columns, (c) => envVarCellKey(row, c));
export const connRefDiffCells = (row: ConnRefRow, columns: ColumnMeta[]): Set<string> => diffCells(row.cells, columns, connRefCellKey);

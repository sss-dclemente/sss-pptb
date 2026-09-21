import type { ColumnAudit, ColumnStats, Counts, EnvData, Filters, FlagState, Matrix, MatrixColumnRow, MatrixTableRow, TableAudit } from "./types";

const state = (a: { audit: { value: boolean } } | null | undefined): FlagState => (!a ? "absent" : a.audit.value ? "on" : "off");

function columnRows(table: string, mine: ColumnAudit[], theirs: ColumnAudit[] | null): MatrixColumnRow[] {
  const byName = new Map<string, ColumnAudit>();
  for (const c of theirs ?? []) byName.set(c.logicalName.toLowerCase(), c);
  return mine.map((c) => {
    const other = byName.get(c.logicalName.toLowerCase()) ?? null;
    const otherState: FlagState = theirs ? state(other) : "absent";
    return {
      key: `${table}:${c.logicalName}`,
      tableLogicalName: table,
      logicalName: c.logicalName,
      displayName: c.displayName,
      attributeType: c.attributeType,
      isManaged: c.isManaged,
      isSecured: c.isSecured,
      locked: !c.audit.canBeChanged,
      state: state(c),
      otherState,
      differs: !!theirs && otherState !== state(c),
    };
  });
}

function stats(rows: MatrixColumnRow[]): ColumnStats {
  return {
    audited: rows.filter((r) => r.state === "on").length,
    total: rows.length,
    differs: rows.filter((r) => r.differs).length,
    secured: rows.filter((r) => r.isSecured).length,
  };
}

/**
 * Merge the primary environment with the comparison environment (a secondary connection
 * or a loaded snapshot). Rows are the primary's tables; a table only in the other
 * environment is shown too, with the primary cell "absent".
 */
export function buildMatrix(primary: EnvData | null, other: EnvData | null): Matrix {
  const mine = new Map<string, TableAudit>();
  for (const t of primary?.tables ?? []) mine.set(t.logicalName.toLowerCase(), t);
  const theirs = new Map<string, TableAudit>();
  for (const t of other?.tables ?? []) theirs.set(t.logicalName.toLowerCase(), t);

  const keys = [...new Set([...mine.keys(), ...theirs.keys()])];
  const rows: MatrixTableRow[] = keys
    .map((key) => {
      const p = mine.get(key) ?? null;
      const o = theirs.get(key) ?? null;
      const head = p ?? o!;
      const myCols = primary?.columns[head.logicalName] ?? null;
      const otherCols = other ? (other.columns[head.logicalName] ?? null) : null;
      const cols = myCols ? columnRows(head.logicalName, myCols, other ? otherCols : null) : null;
      const otherState: FlagState = other ? state(o) : "absent";
      return {
        key,
        logicalName: head.logicalName,
        schemaName: head.schemaName,
        displayName: head.displayName,
        ownership: head.ownership,
        isManaged: head.isManaged,
        locked: !p || !p.audit.canBeChanged,
        state: state(p),
        otherState,
        differs: !!other && otherState !== state(p),
        columns: cols,
        stats: cols ? stats(cols) : null,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.logicalName.localeCompare(b.logicalName));

  const loaded = rows.filter((r) => r.stats);
  const counts: Counts = {
    tables: rows.length,
    tablesAudited: rows.filter((r) => r.state === "on").length,
    tablesDiffer: rows.filter((r) => r.differs).length,
    loadedTables: loaded.length,
    columnsAudited: loaded.reduce((n, r) => n + r.stats!.audited, 0),
    columnsDiffer: loaded.reduce((n, r) => n + r.stats!.differs, 0),
  };
  return { primary: primary?.meta ?? null, other: other?.meta ?? null, rows, counts };
}

export function filterRows(rows: MatrixTableRow[], f: Filters): MatrixTableRow[] {
  const t = f.text.trim().toLowerCase();
  return rows.filter((r) => {
    if (t && !r.logicalName.includes(t) && !r.displayName.toLowerCase().includes(t) && !r.schemaName.toLowerCase().includes(t)) return false;
    if (f.audit === "on" && r.state !== "on") return false;
    if (f.audit === "off" && r.state !== "off") return false;
    if (f.onlyDiff && !r.differs && !(r.stats && r.stats.differs > 0)) return false;
    if (f.managed === "managed" && !r.isManaged) return false;
    if (f.managed === "custom" && r.isManaged) return false;
    if (f.withColumns && !(r.stats && (r.stats.audited > 0 || r.stats.secured > 0))) return false;
    return true;
  });
}

/** Column sub-rows to show under a table row: all of them, or only the differing ones. */
export function visibleColumns(row: MatrixTableRow, f: Filters): MatrixColumnRow[] {
  const cols = row.columns ?? [];
  const t = f.text.trim().toLowerCase();
  return cols.filter((c) => {
    if (f.onlyDiff && !c.differs) return false;
    if (f.audit === "on" && c.state !== "on") return false;
    if (f.audit === "off" && c.state !== "off") return false;
    // the text filter matches the table; a column row is only narrowed by it when it would hide nothing useful
    return !t || row.logicalName.includes(t) || row.displayName.toLowerCase().includes(t) || c.logicalName.includes(t) || c.displayName.toLowerCase().includes(t);
  });
}

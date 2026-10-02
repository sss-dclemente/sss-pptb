import type { ColumnAudit, ColumnStats, Counts, EnvData, Filters, FlagState, Matrix, MatrixColumnRow, MatrixTableRow, TableAudit } from "./types";

const state = (a: { audit: { value: boolean } } | null | undefined): FlagState => (!a ? "absent" : a.audit.value ? "on" : "off");

function columnRows(table: string, mine: ColumnAudit[], theirs: ColumnAudit[] | null, capturing: boolean): MatrixColumnRow[] {
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
      inert: state(c) === "on" && !capturing,
    };
  });
}

function stats(rows: MatrixColumnRow[]): ColumnStats {
  return {
    audited: rows.filter((r) => r.state === "on").length,
    inert: rows.filter((r) => r.inert).length,
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

  const orgOn = primary?.org?.isAuditEnabled ?? null;
  const keys = [...new Set([...mine.keys(), ...theirs.keys()])];
  const rows: MatrixTableRow[] = keys
    .map((key) => {
      const p = mine.get(key) ?? null;
      const o = theirs.get(key) ?? null;
      const head = p ?? o!;
      const myCols = primary?.columns[head.logicalName] ?? null;
      const otherCols = other ? (other.columns[head.logicalName] ?? null) : null;
      // A column is only captured when the organization, the table and the column are all on.
      const capturing = orgOn !== false && state(p) === "on";
      const cols = myCols ? columnRows(head.logicalName, myCols, other ? otherCols : null, capturing) : null;
      const otherState: FlagState = other ? state(o) : "absent";
      return {
        key,
        logicalName: head.logicalName,
        schemaName: head.schemaName,
        displayName: head.displayName,
        ownership: head.ownership,
        isManaged: head.isManaged,
        isCustom: p?.isCustom ?? o?.isCustom ?? null,
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
    columnsInert: loaded.reduce((n, r) => n + r.stats!.inert, 0),
  };
  return {
    primary: primary?.meta ?? null,
    other: other?.meta ?? null,
    rows,
    counts,
    orgAuditEnabled: orgOn,
    inertTables: orgOn === false ? rows.filter((r) => r.state === "on").length : 0,
  };
}

const tableMatches = (r: MatrixTableRow, t: string): boolean =>
  r.logicalName.includes(t) || r.displayName.toLowerCase().includes(t) || r.schemaName.toLowerCase().includes(t);
const columnMatches = (c: MatrixColumnRow, t: string): boolean => c.logicalName.includes(t) || c.displayName.toLowerCase().includes(t);

/**
 * Table rows passing the filters. The text matches the table's names, or the name of one of its
 * loaded columns: column flags are only read when a row's columns are loaded, so a column name
 * cannot find a table whose columns never were.
 *
 * "Only differences" (at column level) and "Has audited / secured columns" can likewise only judge
 * loaded tables. `pending` names the rows whose columns are still to be loaded; those pass these two
 * column tests instead of failing them, which is how the tool finds the tables worth loading.
 */
export function filterRows(rows: MatrixTableRow[], f: Filters, pending?: (r: MatrixTableRow) => boolean): MatrixTableRow[] {
  const t = f.text.trim().toLowerCase();
  return rows.filter((r) => {
    // a locked table flag still leaves changeable columns worth showing
    if (f.onlyChangeable && r.locked && !(r.columns ?? []).some((c) => !c.locked)) return false;
    if (t && !tableMatches(r, t) && !(r.columns ?? []).some((c) => columnMatches(c, t) && !(f.onlyChangeable && c.locked))) return false;
    if (f.audit === "on" && r.state !== "on") return false;
    if (f.audit === "off" && r.state !== "off") return false;
    if (f.managed === "managed" && !r.isManaged) return false;
    if (f.managed === "unmanaged" && r.isManaged) return false;
    if (f.origin === "custom" && r.isCustom !== true) return false;
    if (f.origin === "microsoft" && r.isCustom !== false) return false;
    const unknown = !!pending?.(r);
    // under "Only changeable" a difference in a locked column is not one this tool can act on
    const colDiffers = f.onlyChangeable ? (r.columns ?? []).some((c) => c.differs && !c.locked) : !!(r.stats && r.stats.differs > 0);
    if (f.onlyDiff && !r.differs && !colDiffers && !unknown) return false;
    if (f.withColumns && !(r.stats && (r.stats.audited > 0 || r.stats.secured > 0)) && !unknown) return false;
    return true;
  });
}

/** Above this many tables a first-time viewer starts on custom tables only (see originDefault). */
export const ORIGIN_DEFAULT_THRESHOLD = 100;

/**
 * Whether a viewer who never chose an origin should start on "custom": a typical environment carries
 * hundreds of Microsoft tables that bury the few someone built. Only when the environment says which
 * tables are custom at all — with IsCustomEntity missing everywhere the default would hide every table.
 */
export function originDefault(tables: TableAudit[]): "custom" | null {
  return tables.length > ORIGIN_DEFAULT_THRESHOLD && tables.some((t) => t.isCustom !== null) ? "custom" : null;
}

/**
 * Column sub-rows to show under a table row: all of them, or only the differing / changeable ones. A text that
 * matches the table keeps every column; one that only matches column names narrows to those columns.
 */
export function visibleColumns(row: MatrixTableRow, f: Filters): MatrixColumnRow[] {
  const cols = row.columns ?? [];
  const t = f.text.trim().toLowerCase();
  const byTable = !t || tableMatches(row, t);
  return cols.filter((c) => {
    if (f.onlyChangeable && c.locked) return false;
    if (f.onlyDiff && !c.differs) return false;
    if (f.audit === "on" && c.state !== "on") return false;
    if (f.audit === "off" && c.state !== "off") return false;
    return byTable || columnMatches(c, t);
  });
}

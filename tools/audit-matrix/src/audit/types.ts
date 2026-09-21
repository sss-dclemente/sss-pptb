export type Target = "primary" | "secondary";

/**
 * Dataverse managed property (`BooleanManagedProperty`) as it appears on
 * EntityMetadata.IsAuditEnabled and AttributeMetadata.IsAuditEnabled:
 * `{ Value, CanBeChanged, ManagedPropertyLogicalName }`.
 * `CanBeChanged: false` = the flag is locked by the managing solution.
 */
export interface ManagedFlag {
  value: boolean;
  canBeChanged: boolean;
  managedPropertyLogicalName: string | null;
}

/** Cell state of one audit flag in one environment. */
export type FlagState = "on" | "off" | "absent";

export interface TableAudit {
  logicalName: string;
  schemaName: string;
  displayName: string;
  audit: ManagedFlag;
  isManaged: boolean;
  ownership: string;
}

export interface ColumnAudit {
  logicalName: string;
  displayName: string;
  attributeType: string;
  audit: ManagedFlag;
  isManaged: boolean;
  isSecured: boolean;
}

/** Org-level audit switches. `null` = the environment did not return the field. */
export interface OrgAudit {
  organizationId: string | null;
  name: string | null;
  isAuditEnabled: boolean | null;
  isUserAccessAuditEnabled: boolean | null;
  isReadAuditEnabled: boolean | null;
  retentionDays: number | null;
  /**
   * Which column the retention came from. `auditretentionperiodv2` is the current one and is null
   * on environments that still carry the value in the legacy `auditretentionperiod`, so reading
   * only v2 reports "unknown" for an environment that does have a retention set.
   */
  retentionSource: "v2" | "legacy" | null;
  /** Names of requested fields this environment did not return. */
  unavailable: string[];
}

export interface EnvMeta {
  /** "primary" | "secondary" | "snap:<n>" */
  key: string;
  kind: "live" | "snapshot";
  target?: Target;
  name: string;
  url: string;
  environment: string;
  color?: string;
  takenAt: string;
}

export interface EnvData {
  meta: EnvMeta;
  tables: TableAudit[];
  /** logical name -> attributes, filled lazily on row expand (snapshots may carry it). */
  columns: Record<string, ColumnAudit[]>;
  org: OrgAudit | null;
}

export interface MatrixColumnRow {
  key: string;
  tableLogicalName: string;
  logicalName: string;
  displayName: string;
  attributeType: string;
  isManaged: boolean;
  isSecured: boolean;
  locked: boolean;
  state: FlagState;
  otherState: FlagState;
  differs: boolean;
  /**
   * The column's flag is on but nothing is captured for it, because auditing is off one level up:
   * on the table, or on the organization. Dataverse audits a column only when organization, table
   * and column are all on, so a green column under an off table is a false reassurance.
   */
  inert: boolean;
}

export interface ColumnStats {
  audited: number;
  /** Audited columns that capture nothing because the table or the organization is off. */
  inert: number;
  total: number;
  differs: number;
  secured: number;
}

export interface MatrixTableRow {
  key: string;
  logicalName: string;
  schemaName: string;
  displayName: string;
  ownership: string;
  isManaged: boolean;
  locked: boolean;
  state: FlagState;
  otherState: FlagState;
  differs: boolean;
  /** null until the row's columns have been loaded. */
  columns: MatrixColumnRow[] | null;
  stats: ColumnStats | null;
}

export interface Counts {
  tables: number;
  tablesAudited: number;
  tablesDiffer: number;
  loadedTables: number;
  columnsAudited: number;
  columnsDiffer: number;
  /** Audited columns that capture nothing because their table or the organization is off. */
  columnsInert: number;
}

export interface Matrix {
  primary: EnvMeta | null;
  other: EnvMeta | null;
  rows: MatrixTableRow[];
  counts: Counts;
  /** organization.isauditenabled of the primary environment: false means nothing here is captured. */
  orgAuditEnabled: boolean | null;
  /** Table rows whose flag is on while the organization switch is off. */
  inertTables: number;
}

export type AuditFilter = "all" | "on" | "off";
export type ManagedFilter = "all" | "custom" | "managed";

export interface Filters {
  text: string;
  audit: AuditFilter;
  onlyDiff: boolean;
  managed: ManagedFilter;
  /** Only tables whose loaded columns include an audited or secured column. */
  withColumns: boolean;
}

const OWNERSHIP: Record<string, string> = {
  UserOwned: "user",
  TeamOwned: "team",
  BusinessOwned: "bu",
  OrganizationOwned: "org",
  None: "none",
};

/**
 * OwnershipType arrives as the Web API's string ("UserOwned") or as the client metadata API's
 * OwnershipTypes flags integer (1 user, 2 team, 4 business, 8 organization), depending on which
 * side of the bridge answered. Reading only the string labelled every table "none".
 */
export function ownershipLabel(v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (Number.isFinite(n)) {
    if ((n & 1) !== 0) return "user";
    if ((n & 2) !== 0) return "team";
    if ((n & 4) !== 0) return "bu";
    if ((n & 8) !== 0) return "org";
    return "none";
  }
  return OWNERSHIP[String(v)] ?? "none";
}

/** Attribute types that never carry an audit flag worth showing. */
export const NON_AUDITABLE_TYPES = new Set(["Virtual", "EntityName", "CalendarRules", "PartyList", "ManagedProperty"]);

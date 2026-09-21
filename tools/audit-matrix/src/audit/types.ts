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
}

export interface ColumnStats {
  audited: number;
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
}

export interface Matrix {
  primary: EnvMeta | null;
  other: EnvMeta | null;
  rows: MatrixTableRow[];
  counts: Counts;
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

export const OWNERSHIP: Record<string, string> = {
  UserOwned: "user",
  TeamOwned: "team",
  BusinessOwned: "bu",
  OrganizationOwned: "org",
  None: "none",
};

/** Attribute types that never carry an audit flag worth showing. */
export const NON_AUDITABLE_TYPES = new Set(["Virtual", "EntityName", "CalendarRules", "PartyList", "ManagedProperty"]);

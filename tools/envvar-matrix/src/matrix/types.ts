export type Target = "primary" | "secondary";

export const ENV_VAR_TYPE: Record<number, string> = {
  100000000: "String",
  100000001: "Number",
  100000002: "Boolean",
  100000003: "JSON",
  100000004: "Data source",
  100000005: "Secret",
};
export const SECRET_TYPE = 100000005;

export interface EnvVarRecord {
  definitionId: string;
  schemaName: string;
  displayName: string;
  typeCode: number;
  type: string;
  defaultValue: string | null;
  value: string | null;
  valueId: string | null;
  isManaged: boolean;
}

export interface ConnRefRecord {
  id: string;
  logicalName: string;
  displayName: string;
  connectorId: string | null;
  connector: string | null;
  connectionId: string | null;
  isManaged: boolean;
}

export interface ColumnMeta {
  /** stable key used in row cells: "primary" | "secondary" | "snap:<n>" */
  key: string;
  kind: "live" | "snapshot";
  target?: Target;
  name: string;
  url: string;
  environment: string;
  color?: string;
  takenAt: string;
}

export interface ColumnData {
  meta: ColumnMeta;
  envVars: EnvVarRecord[];
  connRefs: ConnRefRecord[];
}

export type EnvVarSource = "value" | "default" | "missing" | "absent";

export interface EnvVarCell {
  source: EnvVarSource;
  effective: string | null;
  record: EnvVarRecord | null;
}

export interface EnvVarRow {
  key: string; // lowercase schema name
  schemaName: string;
  displayName: string;
  type: string;
  isSecret: boolean;
  cells: Record<string, EnvVarCell>;
  differs: boolean;
  anyMissing: boolean;
  anyAbsent: boolean;
}

export type ConnRefState = "bound" | "unbound" | "absent";

export interface ConnRefCell {
  state: ConnRefState;
  connector: string | null;
  connectionId: string | null;
  record: ConnRefRecord | null;
}

export interface ConnRefRow {
  key: string;
  logicalName: string;
  displayName: string;
  connector: string | null;
  cells: Record<string, ConnRefCell>;
  differs: boolean;
  anyUnbound: boolean;
  anyAbsent: boolean;
}

export interface Matrix {
  columns: ColumnMeta[];
  envVars: EnvVarRow[];
  connRefs: ConnRefRow[];
}

export interface Filters {
  text: string;
  onlyDiff: boolean;
  onlyMissing: boolean;
  /** lowercase schema/logical names allowed; null = no solution filter */
  scope: Set<string> | null;
}

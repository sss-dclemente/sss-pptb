import { NON_AUDITABLE_TYPES, OWNERSHIP, type ColumnAudit, type EnvData, type EnvMeta, type ManagedFlag, type OrgAudit, type TableAudit, type Target } from "./types";

type Row = Record<string, unknown>;

const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const esc = (v: string): string => v.replace(/'/g, "''");

/** Label of a Dataverse metadata Label object, falling back to the logical name. */
export function label(v: unknown, fallback: string): string {
  const l = v as { UserLocalizedLabel?: { Label?: string }; LocalizedLabels?: { Label?: string }[] } | undefined;
  return l?.UserLocalizedLabel?.Label ?? l?.LocalizedLabels?.[0]?.Label ?? fallback;
}

/**
 * Read a BooleanManagedProperty. Dataverse returns `{ Value, CanBeChanged, ManagedPropertyLogicalName }`;
 * older payloads or trimmed projections may return a bare boolean, or nothing at all.
 */
export function toFlag(v: unknown): ManagedFlag {
  if (typeof v === "boolean") return { value: v, canBeChanged: true, managedPropertyLogicalName: null };
  const o = v as { Value?: unknown; CanBeChanged?: unknown; ManagedPropertyLogicalName?: unknown } | null | undefined;
  if (!o || typeof o !== "object") return { value: false, canBeChanged: false, managedPropertyLogicalName: null };
  return {
    value: !!o.Value,
    canBeChanged: o.CanBeChanged !== false,
    managedPropertyLogicalName: s(o.ManagedPropertyLogicalName),
  };
}

/** Subset of `window.dataverseAPI` this tool uses; kept structural so the e2e mock and tests can supply it. */
export interface DataverseLike {
  queryData: (odata: string, target?: Target) => Promise<{ value: Row[] }>;
  getAllEntitiesMetadata: (props?: string[], target?: Target) => Promise<{ value: Row[] }>;
  getEntityMetadata: (entity: string, byLogicalName: boolean, props?: string[], target?: Target) => Promise<Row>;
  getEntityRelatedMetadata: (entity: string, path: string, props?: string[], target?: Target) => Promise<Row & { value?: Row[] }>;
  updateEntityDefinition: (entity: string, def: Row, options?: DataverseAPI.MetadataOperationOptions, target?: Target) => Promise<void>;
  updateAttribute: (entity: string, attribute: string, def: Row, options?: DataverseAPI.MetadataOperationOptions, target?: Target) => Promise<void>;
  publishCustomizations: (table?: string, target?: Target) => Promise<void>;
}

export const TABLE_PROPS = [
  "LogicalName",
  "SchemaName",
  "DisplayName",
  "IsAuditEnabled",
  "IsManaged",
  "IsCustomizable",
  "IsIntersect",
  "IsPrivate",
  "IsLogicalEntity",
  "OwnershipType",
];

export const ATTRIBUTE_PROPS = ["LogicalName", "DisplayName", "IsAuditEnabled", "IsValidForRead", "IsSecured", "AttributeType", "IsManaged"];

/** All real, user-facing tables with their table-level audit flag. */
export async function fetchTables(api: DataverseLike, target: Target): Promise<TableAudit[]> {
  const r = await api.getAllEntitiesMetadata(TABLE_PROPS, target);
  return r.value
    .filter((e) => e.LogicalName && !e.IsIntersect && !e.IsPrivate && !e.IsLogicalEntity)
    .map((e) => ({
      logicalName: String(e.LogicalName),
      schemaName: String(e.SchemaName ?? e.LogicalName),
      displayName: label(e.DisplayName, String(e.LogicalName)),
      audit: toFlag(e.IsAuditEnabled),
      isManaged: !!e.IsManaged,
      ownership: OWNERSHIP[String(e.OwnershipType)] ?? "none",
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.logicalName.localeCompare(b.logicalName));
}

/** Auditable attributes of one table. Lazy: called when a row is expanded. */
export async function fetchColumns(api: DataverseLike, table: string, target: Target): Promise<ColumnAudit[]> {
  const r = await api.getEntityRelatedMetadata(table, "Attributes", ATTRIBUTE_PROPS, target);
  return (r.value ?? [])
    .filter((a) => a.LogicalName && a.IsValidForRead !== false && a.IsAuditEnabled != null && !NON_AUDITABLE_TYPES.has(String(a.AttributeType)))
    .map((a) => ({
      logicalName: String(a.LogicalName),
      displayName: label(a.DisplayName, String(a.LogicalName)),
      attributeType: String(a.AttributeType ?? ""),
      audit: toFlag(a.IsAuditEnabled),
      isManaged: !!a.IsManaged,
      isSecured: !!a.IsSecured,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.logicalName.localeCompare(b.logicalName));
}

/**
 * Org-level audit switches. The exact attribute set differs between versions, so the
 * widest $select is tried first and narrower ones after; whatever is not returned is
 * reported as unavailable instead of failing the read.
 */
const ORG_SELECTS = [
  ["organizationid", "name", "isauditenabled", "isuseraccessauditenabled", "isreadauditenabled", "auditretentionperiodv2"],
  ["organizationid", "name", "isauditenabled", "isuseraccessauditenabled", "auditretentionperiodv2"],
  ["organizationid", "name", "isauditenabled", "isuseraccessauditenabled"],
  ["organizationid", "name", "isauditenabled"],
];

export async function fetchOrg(api: DataverseLike, target: Target): Promise<OrgAudit> {
  let row: Row | null = null;
  let got: string[] = [];
  for (const sel of ORG_SELECTS) {
    try {
      const r = await api.queryData(`organizations?$select=${sel.join(",")}&$top=1`, target);
      row = r.value[0] ?? {};
      got = sel;
      break;
    } catch {
      /* narrower $select next */
    }
  }
  if (!row) throw new Error("organizations could not be read");
  const want = ORG_SELECTS[0];
  const bool = (k: string): boolean | null => (got.includes(k) && row[k] != null ? !!row[k] : null);
  return {
    organizationId: s(row.organizationid),
    name: s(row.name),
    isAuditEnabled: bool("isauditenabled"),
    isUserAccessAuditEnabled: bool("isuseraccessauditenabled"),
    isReadAuditEnabled: bool("isreadauditenabled"),
    retentionDays: got.includes("auditretentionperiodv2") && row.auditretentionperiodv2 != null ? Number(row.auditretentionperiodv2) : null,
    unavailable: want.filter((k) => !got.includes(k) || row[k] === undefined),
  };
}

/** Table list + org settings for one live connection. Columns stay empty until rows are expanded. */
export async function fetchEnv(api: DataverseLike, meta: EnvMeta): Promise<EnvData> {
  if (!meta.target) throw new Error("fetchEnv needs a live target");
  const [tables, org] = await Promise.all([fetchTables(api, meta.target), fetchOrg(api, meta.target).catch(() => null)]);
  return { meta: { ...meta, takenAt: new Date().toISOString() }, tables, columns: {}, org };
}

/** Fresh full entity definition, used before a write (never PUT back a trimmed projection). */
export async function fullEntityDefinition(api: DataverseLike, table: string, target: Target): Promise<Row> {
  return api.getEntityMetadata(table, true, undefined, target);
}

/** Fresh full attribute definition, used before a write. */
export async function fullAttributeDefinition(api: DataverseLike, table: string, column: string, target: Target): Promise<Row> {
  return api.getEntityRelatedMetadata(table, `Attributes(LogicalName='${esc(column)}')`, undefined, target);
}

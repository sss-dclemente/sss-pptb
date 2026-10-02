import type { ColumnAudit, EnvData, ManagedFlag, OrgAudit, TableAudit } from "./types";

export const SNAPSHOT_KIND = "sss-audit-matrix-snapshot";
export const SNAPSHOT_VERSION = 1;

interface SnapFlag {
  value?: boolean;
  canBeChanged?: boolean;
  managedPropertyLogicalName?: string | null;
}
interface SnapColumn {
  logicalName: string;
  displayName?: string;
  attributeType?: string;
  audit?: SnapFlag;
  isManaged?: boolean;
  isSecured?: boolean;
}
interface SnapTable {
  logicalName: string;
  schemaName?: string;
  displayName?: string;
  ownership?: string;
  audit?: SnapFlag;
  isManaged?: boolean;
  /** Present only for tables whose columns had been loaded when the snapshot was taken. */
  columns?: SnapColumn[];
}
interface Snap {
  kind: string;
  version: number;
  environment?: { name?: string; url?: string; environment?: string; takenAt?: string };
  org?: Partial<OrgAudit> | null;
  tables?: SnapTable[];
}

const flag = (f: SnapFlag | undefined): ManagedFlag => ({
  value: !!f?.value,
  canBeChanged: f?.canBeChanged !== false,
  managedPropertyLogicalName: f?.managedPropertyLogicalName ?? null,
});

export function serializeSnapshot(env: EnvData): string {
  const doc: Snap = {
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    environment: { name: env.meta.name, url: env.meta.url, environment: env.meta.environment, takenAt: env.meta.takenAt || new Date().toISOString() },
    org: env.org,
    tables: env.tables.map((t) => {
      const cols = env.columns[t.logicalName];
      const out: SnapTable = {
        logicalName: t.logicalName,
        schemaName: t.schemaName,
        displayName: t.displayName,
        ownership: t.ownership,
        audit: { value: t.audit.value, canBeChanged: t.audit.canBeChanged, managedPropertyLogicalName: t.audit.managedPropertyLogicalName },
        isManaged: t.isManaged,
      };
      if (cols)
        out.columns = cols.map((c) => ({
          logicalName: c.logicalName,
          displayName: c.displayName,
          attributeType: c.attributeType,
          audit: { value: c.audit.value, canBeChanged: c.audit.canBeChanged, managedPropertyLogicalName: c.audit.managedPropertyLogicalName },
          isManaged: c.isManaged,
          isSecured: c.isSecured,
        }));
      return out;
    }),
  };
  return JSON.stringify(doc, null, 2);
}

let counter = 0;

export function parseSnapshot(json: string, fileName: string): EnvData {
  let obj: Snap;
  try {
    obj = JSON.parse(json) as Snap;
  } catch {
    throw new Error("not valid JSON");
  }
  if (obj?.kind !== SNAPSHOT_KIND) throw new Error("not an audit matrix snapshot (kind mismatch)");
  if (Number(obj.version) > SNAPSHOT_VERSION) throw new Error(`snapshot version ${obj.version} is newer than this tool understands (${SNAPSHOT_VERSION})`);
  if (!Array.isArray(obj.tables)) throw new Error("snapshot has no tables array");
  counter++;
  const env = obj.environment ?? {};
  const tables: TableAudit[] = [];
  const columns: Record<string, ColumnAudit[]> = {};
  for (const t of obj.tables) {
    if (!t?.logicalName) continue;
    tables.push({
      logicalName: String(t.logicalName),
      schemaName: t.schemaName ?? String(t.logicalName),
      displayName: t.displayName ?? String(t.logicalName),
      audit: flag(t.audit),
      isManaged: !!t.isManaged,
      ownership: t.ownership ?? "none",
    });
    if (Array.isArray(t.columns))
      columns[String(t.logicalName)] = t.columns
        .filter((c) => c?.logicalName)
        .map((c) => ({
          logicalName: String(c.logicalName),
          displayName: c.displayName ?? String(c.logicalName),
          attributeType: c.attributeType ?? "",
          audit: flag(c.audit),
          isManaged: !!c.isManaged,
          isSecured: !!c.isSecured,
        }));
  }
  tables.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    meta: {
      key: `snap:${counter}`,
      kind: "snapshot",
      name: env.name ?? fileName.replace(/\.json$/i, ""),
      url: env.url ?? "",
      environment: env.environment ?? "Snapshot",
      takenAt: env.takenAt ?? "",
    },
    tables,
    columns,
    org: (obj.org as OrgAudit | null) ?? null,
  };
}

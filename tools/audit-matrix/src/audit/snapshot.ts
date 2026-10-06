import type { ColumnAudit, EnvData, ManagedFlag, OrgAudit, TableAudit } from "./types";
import type { PlanItem } from "./write";

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
  /** IsCustomEntity; absent in snapshots taken before it was read. */
  isCustom?: boolean | null;
  /** Present only for tables whose columns had been loaded when the snapshot was taken. */
  columns?: SnapColumn[];
}
interface Snap {
  kind: string;
  version: number;
  /**
   * "backup": saved before Apply, carrying only the tables and columns that plan wrote (see
   * serializeBackup). Absent or "full": a snapshot of the whole environment as loaded.
   */
  scope?: "full" | "backup";
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
        isCustom: t.isCustom,
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

/**
 * The backup saved before Apply: the audit flags the plan is about to change, as the preview shows
 * them ("Current"), in the snapshot format. Loaded with "Load snapshot…" as the comparison, "Plan:
 * match other env" then plans exactly the writes that put those flags back. Each touched table is
 * recorded with its own flag (its current value) and only the planned columns; the "backup" scope
 * tells the matrix that anything else missing from the file is not recorded rather than absent.
 */
export function serializeBackup(env: EnvData, items: PlanItem[], takenAt = new Date().toISOString()): string {
  const byTable = new Map<string, PlanItem[]>();
  for (const i of items) byTable.set(i.table, [...(byTable.get(i.table) ?? []), i]);
  const tables: SnapTable[] = [];
  for (const [name, group] of byTable) {
    const t = env.tables.find((x) => x.logicalName === name);
    const own = group.find((i) => i.level === "table");
    const tableFlag = own ? own.current : !!t?.audit.value;
    const cols = env.columns[name] ?? [];
    const planned = group.filter((i) => i.level === "column");
    const out: SnapTable = {
      logicalName: name,
      schemaName: t?.schemaName ?? name,
      displayName: t?.displayName ?? group[0].tableDisplay,
      ownership: t?.ownership,
      audit: { value: tableFlag, canBeChanged: t?.audit.canBeChanged ?? true, managedPropertyLogicalName: t?.audit.managedPropertyLogicalName ?? null },
      isManaged: t?.isManaged,
      isCustom: t?.isCustom ?? null,
    };
    if (planned.length)
      out.columns = planned.map((i) => {
        const c = cols.find((x) => x.logicalName === i.column);
        return {
          logicalName: i.column!,
          displayName: c?.displayName ?? i.columnDisplay ?? i.column!,
          attributeType: c?.attributeType,
          audit: { value: i.current, canBeChanged: c?.audit.canBeChanged ?? true, managedPropertyLogicalName: c?.audit.managedPropertyLogicalName ?? null },
          isManaged: c?.isManaged,
          isSecured: c?.isSecured,
        };
      });
    tables.push(out);
  }
  const doc: Snap = {
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    scope: "backup",
    environment: { name: env.meta.name, url: env.meta.url, environment: env.meta.environment, takenAt },
    org: env.org,
    tables,
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
      isCustom: typeof t.isCustom === "boolean" ? t.isCustom : null,
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
      partial: obj.scope === "backup",
    },
    tables,
    columns,
    org: (obj.org as OrgAudit | null) ?? null,
  };
}

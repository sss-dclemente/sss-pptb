/**
 * All Dataverse reads for the wizard. Primary connection only, every collection through
 * queryData with a $filter so the response is the { value } array the host guarantees.
 *
 * Verification status of the OData sets / relationships used here (see docs/OFFBOARDING-PLAN.md):
 *  - VERIFIED against @pptb/types 1.2.5 docs or the sibling Access Checker:
 *    systemusers, teams, businessunits, systemuserroles_association, teammembership_association,
 *    systemuserprofiles_association, getAllEntitiesMetadata.
 *  - UNVERIFIED (no source in @pptb/types or docs/PPTB-NOTES.md; degrade to an error row, never throw):
 *    workflows, userqueries, userqueryvisualizations, queues, queuemembership_association,
 *    connectionreferences, and the "@odata.count" annotation surviving the host bridge.
 */
import type { CategoryKey, CategoryResult, InventoryItem, LeaverInfo, ScanSummary, TableInfo, TableScanRow, TeamRef, UserInfo } from "./types";
import { WORKFLOW_CATEGORY_LABEL, WORKFLOW_STATE_LABEL } from "./types";

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const id = (v: unknown): string => String(v ?? "").toLowerCase();
const esc = (v: string): string => v.replace(/'/g, "''");
const num = (v: unknown): number | null => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

export interface DataverseLike {
  queryData: (odata: string) => Promise<{ value: Row[] }>;
  getAllEntitiesMetadata: (props?: string[]) => Promise<{ value: Row[] }>;
  update: (entityLogicalName: string, id: string, record: Record<string, unknown>) => Promise<void>;
  associate: (primaryEntityName: string, primaryEntityId: string, relationshipName: string, relatedEntityName: string, relatedEntityId: string) => Promise<void>;
  disassociate: (primaryEntityName: string, primaryEntityId: string, relationshipName: string, relatedEntityId: string) => Promise<void>;
}

const err = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------- users & teams ----------
const USER_SELECT = "systemuserid,fullname,domainname,internalemailaddress,_businessunitid_value,_parentsystemuserid_value,isdisabled,accessmode";

const toUser = (r: Row): UserInfo => ({
  id: id(r.systemuserid),
  fullName: s(r.fullname) ?? s(r.domainname) ?? id(r.systemuserid),
  domainName: s(r.domainname),
  email: s(r.internalemailaddress),
  businessUnitId: r._businessunitid_value ? id(r._businessunitid_value) : null,
  managerId: r._parentsystemuserid_value ? id(r._parentsystemuserid_value) : null,
  isDisabled: !!r.isdisabled,
  accessMode: num(r.accessmode),
});

export async function searchUsers(api: DataverseLike, text: string): Promise<UserInfo[]> {
  const t = esc(text.trim());
  if (!t) return [];
  const r = await api.queryData(
    `systemusers?$select=${USER_SELECT}&$filter=(contains(fullname,'${t}') or contains(domainname,'${t}') or contains(internalemailaddress,'${t}')) and applicationid eq null&$orderby=fullname&$top=20`,
  );
  return r.value.map(toUser);
}

export async function fetchUser(api: DataverseLike, userId: string): Promise<UserInfo | null> {
  const r = await api.queryData(`systemusers?$select=${USER_SELECT}&$filter=systemuserid eq ${userId}`);
  return r.value.length ? toUser(r.value[0]) : null;
}

export async function searchTeams(api: DataverseLike, text: string): Promise<TeamRef[]> {
  const t = esc(text.trim());
  if (!t) return [];
  const r = await api.queryData(`teams?$select=teamid,name,teamtype,_businessunitid_value&$filter=contains(name,'${t}')&$orderby=name&$top=20`);
  return r.value.map((x) => ({
    id: id(x.teamid),
    name: s(x.name) ?? id(x.teamid),
    type: num(x.teamtype) ?? 0,
    businessUnitId: x._businessunitid_value ? id(x._businessunitid_value) : null,
  }));
}

async function businessUnitName(api: DataverseLike, buId: string | null): Promise<string | null> {
  if (!buId) return null;
  try {
    const r = await api.queryData(`businessunits?$select=businessunitid,name&$filter=businessunitid eq ${buId}`);
    return s(r.value[0]?.name);
  } catch {
    return null;
  }
}

/** The leaver header: fresh user row, business unit name, manager. Never throws on the optional parts. */
export async function fetchLeaver(api: DataverseLike, user: UserInfo): Promise<LeaverInfo> {
  const fresh = (await fetchUser(api, user.id).catch(() => null)) ?? user;
  const [bu, manager] = await Promise.all([
    businessUnitName(api, fresh.businessUnitId),
    fresh.managerId ? fetchUser(api, fresh.managerId).catch(() => null) : Promise.resolve(null),
  ]);
  return { user: fresh, businessUnitName: bu, manager };
}

// ---------- tables ----------
const label = (v: unknown, fallback: string): string => {
  const l = (v as { UserLocalizedLabel?: { Label?: string }; LocalizedLabels?: { Label?: string }[] } | undefined) ?? {};
  return l.UserLocalizedLabel?.Label ?? l.LocalizedLabels?.[0]?.Label ?? fallback;
};

/** User- and team-owned tables only: those are the ones an owner filter applies to. */
export async function fetchOwnedTables(api: DataverseLike): Promise<TableInfo[]> {
  const r = await api.getAllEntitiesMetadata([
    "LogicalName",
    "SchemaName",
    "DisplayName",
    "EntitySetName",
    "PrimaryNameAttribute",
    "PrimaryIdAttribute",
    "OwnershipType",
    "IsIntersect",
    "IsPrivate",
    "IsLogicalEntity",
  ]);
  return r.value
    .filter((e) => {
      const own = String(e.OwnershipType ?? "");
      return !e.IsIntersect && !e.IsPrivate && !e.IsLogicalEntity && e.EntitySetName && e.PrimaryIdAttribute && (own === "UserOwned" || own === "TeamOwned");
    })
    .map((e) => ({
      logicalName: String(e.LogicalName),
      displayName: label(e.DisplayName, String(e.LogicalName)),
      entitySetName: String(e.EntitySetName),
      primaryId: String(e.PrimaryIdAttribute),
      primaryName: s(e.PrimaryNameAttribute),
      ownership: String(e.OwnershipType) === "TeamOwned" ? ("team" as const) : ("user" as const),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

// ---------- bounded-concurrency pool ----------
export interface PoolControl {
  /** Set to true from the UI to stop dispatching new work. */
  cancelled: boolean;
}

export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onDone?: (done: number, total: number, item: T) => void,
  control?: PoolControl,
): Promise<R[]> {
  const out: (R | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  let done = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      if (control?.cancelled) return;
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
      onDone?.(++done, items.length, items[i]);
    }
  });
  await Promise.all(workers);
  return out.filter((x): x is R => x !== undefined);
}

// ---------- record scan ----------
/**
 * Count records owned by the leaver in one table.
 * `$count=true&$top=0` and read `@odata.count`; if the host bridge drops the annotation
 * (UNVERIFIED), fall back to a capped page of ids so the scan still produces a number.
 */
export async function countOwned(api: DataverseLike, t: TableInfo, leaverId: string, cap: number): Promise<{ count: number | null; approximate: boolean }> {
  const res = (await api.queryData(`${t.entitySetName}?$filter=_ownerid_value eq ${leaverId}&$count=true&$top=0`)) as unknown as {
    value?: Row[];
    "@odata.count"?: number | string;
  };
  const c = num(res["@odata.count"]);
  if (c != null) return { count: c, approximate: false };
  const page = await api.queryData(`${t.entitySetName}?$select=${t.primaryId}&$filter=_ownerid_value eq ${leaverId}&$top=${cap + 1}`);
  return { count: Math.min(page.value.length, cap), approximate: page.value.length > cap };
}

export interface ScanOptions {
  concurrency: number;
  cap: number;
  control: PoolControl;
  onProgress: (done: number, total: number, table: string) => void;
}

/** Scan every requested table. Per-table failures become "not scanned" rows, never a failed run. */
export async function scanOwnedRecords(api: DataverseLike, tables: TableInfo[], leaverId: string, o: ScanOptions): Promise<ScanSummary> {
  const rows = await pool<TableInfo, TableScanRow>(
    tables,
    o.concurrency,
    async (t) => {
      try {
        const { count, approximate } = await countOwned(api, t, leaverId, o.cap);
        return { table: t, count, approximate, error: null };
      } catch (e) {
        return { table: t, count: null, approximate: false, error: err(e) };
      }
    },
    (done, total, t) => o.onProgress(done, total, t.displayName),
    o.control,
  );
  return {
    rows: rows.filter((r) => r.error == null && (r.count ?? 0) > 0).sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
    scanned: rows.length,
    requested: tables.length,
    cancelled: o.control.cancelled,
    failed: rows.filter((r) => r.error != null),
  };
}

/** Ids of the leaver's records in one table, capped. Used when the plan is built, not during the scan. */
export async function fetchOwnedRecordIds(api: DataverseLike, t: TableInfo, leaverId: string, cap: number): Promise<{ id: string; name: string }[]> {
  const sel = [t.primaryId, ...(t.primaryName ? [t.primaryName] : [])].join(",");
  const r = await api.queryData(`${t.entitySetName}?$select=${sel}&$filter=_ownerid_value eq ${leaverId}&$top=${cap}`);
  return r.value.map((row) => ({ id: id(row[t.primaryId]), name: (t.primaryName ? s(row[t.primaryName]) : null) ?? id(row[t.primaryId]) }));
}

// ---------- categories ----------
async function workflows(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`workflows?$select=workflowid,name,category,statecode,type&$filter=_ownerid_value eq ${leaverId}&$orderby=name`);
  return r.value
    .filter((w) => num(w.type) !== 2) // type 2 = activation copy of a definition; the definition row is the one that matters
    .map((w) => {
      const cat = num(w.category) ?? 0;
      const state = num(w.statecode) ?? 0;
      const hot = cat === 5 && state === 1;
      return {
        entity: "workflow",
        id: id(w.workflowid),
        label: s(w.name) ?? id(w.workflowid),
        meta: `${WORKFLOW_CATEGORY_LABEL[cat] ?? `category ${cat}`} · ${WORKFLOW_STATE_LABEL[state] ?? `state ${state}`}`,
        flag: hot ? "active modern flow — breaks when the owner is disabled" : null,
        data: { category: cat, statecode: state },
      };
    });
}

async function userQueries(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`userqueries?$select=userqueryid,name,returnedtypecode&$filter=_ownerid_value eq ${leaverId}&$orderby=name`);
  return r.value.map((q) => ({ entity: "userquery", id: id(q.userqueryid), label: s(q.name) ?? id(q.userqueryid), meta: s(q.returnedtypecode) ?? "", flag: null }));
}

async function userCharts(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`userqueryvisualizations?$select=userqueryvisualizationid,name,primaryentitytypecode&$filter=_ownerid_value eq ${leaverId}&$orderby=name`);
  return r.value.map((c) => ({
    entity: "userqueryvisualization",
    id: id(c.userqueryvisualizationid),
    label: s(c.name) ?? id(c.userqueryvisualizationid),
    meta: s(c.primaryentitytypecode) ?? "",
    flag: null,
  }));
}

async function ownedQueues(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`queues?$select=queueid,name,queuetypecode&$filter=_ownerid_value eq ${leaverId}&$orderby=name`);
  return r.value.map((q) => ({
    entity: "queue",
    id: id(q.queueid),
    label: s(q.name) ?? id(q.queueid),
    meta: num(q.queuetypecode) === 1 ? "private queue" : "queue",
    flag: null,
  }));
}

async function queueMemberships(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`systemusers?$select=systemuserid&$filter=systemuserid eq ${leaverId}&$expand=queuemembership_association($select=queueid,name)`);
  return ((r.value[0]?.queuemembership_association as Row[] | undefined) ?? []).map((q) => ({
    entity: "queue",
    id: id(q.queueid),
    label: s(q.name) ?? id(q.queueid),
    meta: "member",
    flag: "membership is not changed by this tool in v1",
  }));
}

async function teamMemberships(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`systemusers?$select=systemuserid&$filter=systemuserid eq ${leaverId}&$expand=teammembership_association($select=teamid,name,teamtype,_businessunitid_value)`);
  return ((r.value[0]?.teammembership_association as Row[] | undefined) ?? []).map((t) => {
    const type = num(t.teamtype) ?? 0;
    return {
      entity: "team",
      id: id(t.teamid),
      label: s(t.name) ?? id(t.teamid),
      meta: type === 0 ? "owner team" : type === 1 ? "access team" : type === 2 ? "Entra security group team" : "Entra office group team",
      flag:
        type === 0
          ? "owner team: records owned by the team stay with the team"
          : type >= 2
            ? "membership comes from Entra and cannot be changed here"
            : null,
      data: { teamtype: type },
    };
  });
}

async function securityRoles(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`systemusers?$select=systemuserid&$filter=systemuserid eq ${leaverId}&$expand=systemuserroles_association($select=roleid,name,_businessunitid_value)`);
  return ((r.value[0]?.systemuserroles_association as Row[] | undefined) ?? []).map((x) => ({
    entity: "role",
    id: id(x.roleid),
    label: s(x.name) ?? id(x.roleid),
    meta: "direct role",
    flag: null,
  }));
}

async function fieldProfiles(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`systemusers?$select=systemuserid&$filter=systemuserid eq ${leaverId}&$expand=systemuserprofiles_association($select=fieldsecurityprofileid,name)`);
  return ((r.value[0]?.systemuserprofiles_association as Row[] | undefined) ?? []).map((x) => ({
    entity: "fieldsecurityprofile",
    id: id(x.fieldsecurityprofileid),
    label: s(x.name) ?? id(x.fieldsecurityprofileid),
    meta: "field security profile",
    flag: null,
  }));
}

async function connectionReferences(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(
    `connectionreferences?$select=connectionreferenceid,connectionreferencedisplayname,connectionreferencelogicalname,connectorid&$filter=_ownerid_value eq ${leaverId}&$orderby=connectionreferencedisplayname`,
  );
  return r.value.map((c) => ({
    entity: "connectionreference",
    id: id(c.connectionreferenceid),
    label: s(c.connectionreferencedisplayname) ?? s(c.connectionreferencelogicalname) ?? id(c.connectionreferenceid),
    meta: s(c.connectorid) ?? "",
    flag: "the underlying connection stays with the leaver and must be re-authenticated by the successor",
  }));
}

async function directReports(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`systemusers?$select=systemuserid,fullname,domainname,isdisabled&$filter=_parentsystemuserid_value eq ${leaverId}&$orderby=fullname`);
  return r.value.map((u) => ({
    entity: "systemuser",
    id: id(u.systemuserid),
    label: s(u.fullname) ?? id(u.systemuserid),
    meta: s(u.domainname) ?? "",
    flag: null,
  }));
}

interface CategorySpec {
  key: CategoryKey;
  label: string;
  hint: string;
  writable: boolean;
  load: (api: DataverseLike, leaverId: string) => Promise<InventoryItem[]>;
}

const SPECS: CategorySpec[] = [
  { key: "workflows", label: "Flows & classic processes", hint: "workflows owned by the leaver", writable: true, load: workflows },
  { key: "userqueries", label: "Personal views", hint: "userqueries", writable: true, load: userQueries },
  { key: "usercharts", label: "Personal charts", hint: "userqueryvisualizations", writable: true, load: userCharts },
  { key: "queues", label: "Queues owned", hint: "queues owned by the leaver", writable: true, load: ownedQueues },
  { key: "queuemembership", label: "Queue memberships", hint: "queues the leaver is a member of", writable: false, load: queueMemberships },
  { key: "teams", label: "Team memberships", hint: "teammembership_association", writable: true, load: teamMemberships },
  { key: "roles", label: "Security roles", hint: "systemuserroles_association", writable: true, load: securityRoles },
  { key: "fieldprofiles", label: "Field security profiles", hint: "systemuserprofiles_association", writable: true, load: fieldProfiles },
  { key: "connectionreferences", label: "Connection references", hint: "connectionreferences owned by the leaver", writable: true, load: connectionReferences },
  { key: "directreports", label: "Direct reports", hint: "users whose manager is the leaver", writable: true, load: directReports },
];

/** Every non-record category, in parallel. A failing category yields an error row, never a rejection. */
export async function fetchCategories(api: DataverseLike, leaverId: string): Promise<CategoryResult[]> {
  return Promise.all(
    SPECS.map(async (spec) => {
      try {
        return { key: spec.key, label: spec.label, hint: spec.hint, writable: spec.writable, items: await spec.load(api, leaverId), error: null };
      } catch (e) {
        return { key: spec.key, label: spec.label, hint: spec.hint, writable: spec.writable, items: [], error: err(e) };
      }
    }),
  );
}

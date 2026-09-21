/**
 * All Dataverse reads for the wizard. Primary connection only, every collection through
 * queryData with a $filter so the response is the { value } array the host guarantees.
 *
 * Verification status of the OData sets / relationships used here (see docs/OFFBOARDING-PLAN.md):
 *  - VERIFIED against @pptb/types 1.2.5 or the sibling Access Checker:
 *    systemusers, teams, businessunits, systemuserroles_association, teammembership_association,
 *    systemuserprofiles_association, getAllEntitiesMetadata.
 *  - VERIFIED against the Microsoft Learn table reference (EntitySetName) and a live environment's
 *    metadata: workflows, userqueries, userqueryvisualizations, queues, connectionreferences,
 *    connections, roles, queuemembership_association, and systemuser.accessmode. All six of those
 *    tables are UserOwned and expose _ownerid_value, so the owner filter below is valid on each.
 *  - UNVERIFIED, and the reason it degrades instead of throwing: whether getAllEntitiesMetadata
 *    yields OwnershipType as the Web API's string or as the client metadata API's integer. Both are
 *    handled. ("@odata.count" is settled: PPTB-NOTES §12, queryData returns response.data unchanged.)
 */
import type { CategoryKey, CategoryResult, InventoryItem, LeaverInfo, OrgAssignSettings, PrincipalHeld, RoleRef, ScanSummary, TableInfo, TableScanRow, TeamRef, UserInfo } from "./types";
import { WORKFLOW_CATEGORY_LABEL, WORKFLOW_STATE_LABEL } from "./types";

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const id = (v: unknown): string => String(v ?? "").toLowerCase();
/**
 * A search term is interpolated into a URL query string, so doubling the OData quote is not enough:
 * an unencoded &, #, + or % in what the user typed truncates or corrupts the request. Double the
 * quote first (OData string escaping), then percent-encode the result (URL escaping).
 */
const esc = (v: string): string => encodeURIComponent(v.replace(/'/g, "''"));
const num = (v: unknown): number | null => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

export interface DataverseLike {
  queryData: (odata: string) => Promise<{ value: Row[] }>;
  getAllEntitiesMetadata: (props?: string[]) => Promise<{ value: Row[] }>;
  update: (entityLogicalName: string, id: string, record: Record<string, unknown>) => Promise<void>;
  associate: (primaryEntityName: string, primaryEntityId: string, relationshipName: string, relatedEntityName: string, relatedEntityId: string) => Promise<void>;
  disassociate: (primaryEntityName: string, primaryEntityId: string, relationshipName: string, relatedEntityId: string) => Promise<void>;
}

const err = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Dataverse returns at most 5 000 standard-table rows per request and does not support $skip;
 * beyond that it pages through @odata.nextLink, which queryData's { value } shape cannot expose.
 * Every collection read here therefore asks for at most this many rows and says so when it is hit.
 */
export const PAGE_LIMIT = 5000;

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

/** OwnershipTypes as flags, or null when the value is not a number at all (an empty string is not). */
const ownershipFlags = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const isOwned = (v: unknown): boolean => {
  const n = ownershipFlags(v);
  if (n != null) return (n & 1) !== 0 || (n & 2) !== 0; // UserOwned | TeamOwned
  return v === "UserOwned" || v === "TeamOwned";
};

const isTeamOwned = (v: unknown): boolean => {
  const n = ownershipFlags(v);
  return n != null ? (n & 2) !== 0 : v === "TeamOwned";
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
      // The Web API returns OwnershipType as a string ("UserOwned"), the client metadata API as the
      // OwnershipTypes flags integer (UserOwned 1, TeamOwned 2). Which one reaches us through the
      // ToolBox bridge is untested, and getting it wrong would silently scan zero tables.
      return !e.IsIntersect && !e.IsPrivate && !e.IsLogicalEntity && e.EntitySetName && e.PrimaryIdAttribute && isOwned(e.OwnershipType);
    })
    .map((e) => ({
      logicalName: String(e.LogicalName),
      displayName: label(e.DisplayName, String(e.LogicalName)),
      entitySetName: String(e.EntitySetName),
      primaryId: String(e.PrimaryIdAttribute),
      primaryName: s(e.PrimaryNameAttribute),
      ownership: isTeamOwned(e.OwnershipType) ? ("team" as const) : ("user" as const),
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
 *
 * `$count=true` returns the count "regardless of the page size requested", so a single row is asked
 * for rather than the undocumented `$top=0`. The annotation saturates at PAGE_LIMIT without saying
 * so — distinguishing 5 000 from 5 000+ needs a Prefer header that queryData cannot send — so a
 * count at the limit is reported as approximate. The bridge does forward the annotation
 * (PPTB-NOTES §12: queryData returns response.data unchanged), so the capped id-page fallback below
 * is belt-and-braces rather than the expected path.
 */
export async function countOwned(api: DataverseLike, t: TableInfo, leaverId: string, cap: number): Promise<{ count: number | null; approximate: boolean }> {
  const res = (await api.queryData(`${t.entitySetName}?$select=${t.primaryId}&$filter=_ownerid_value eq ${leaverId}&$count=true&$top=1`)) as unknown as {
    value?: Row[];
    "@odata.count"?: number | string;
  };
  const c = num(res["@odata.count"]);
  if (c != null) return { count: c, approximate: c >= PAGE_LIMIT };
  const top = Math.min(cap + 1, PAGE_LIMIT);
  const page = await api.queryData(`${t.entitySetName}?$select=${t.primaryId}&$filter=_ownerid_value eq ${leaverId}&$top=${top}`);
  return { count: Math.min(page.value.length, cap), approximate: page.value.length > cap || page.value.length >= PAGE_LIMIT };
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
  const r = await api.queryData(`${t.entitySetName}?$select=${sel}&$filter=_ownerid_value eq ${leaverId}&$top=${Math.min(cap, PAGE_LIMIT)}`);
  return r.value.map((row) => ({ id: id(row[t.primaryId]), name: (t.primaryName ? s(row[t.primaryName]) : null) ?? id(row[t.primaryId]) }));
}

// ---------- successor state ----------
/**
 * What the successor already holds. An `associate` for something they have already fails with a
 * duplicate-key error, so the plan skips those instead of collecting guaranteed red rows.
 * Never throws: an unreadable category yields an empty set, and the plan is simply less clever.
 */
export async function fetchPrincipalHeld(api: DataverseLike, userId: string): Promise<PrincipalHeld> {
  const one = async (expand: string, key: string, idField: string): Promise<Set<string>> => {
    try {
      const r = await api.queryData(`systemusers?$select=systemuserid&$filter=systemuserid eq ${userId}&$expand=${expand}($select=${idField})`);
      return new Set(((r.value[0]?.[key] as Row[] | undefined) ?? []).map((x) => id(x[idField])));
    } catch {
      return new Set<string>();
    }
  };
  const [roleIds, profileIds, teamIds] = await Promise.all([
    one("systemuserroles_association", "systemuserroles_association", "roleid"),
    one("systemuserprofiles_association", "systemuserprofiles_association", "fieldsecurityprofileid"),
    one("teammembership_association", "teammembership_association", "teamid"),
  ]);
  return { roleIds, profileIds, teamIds };
}

/**
 * Map each of the leaver's roles onto the equivalent role in the successor's business unit.
 *
 * Security roles are business-unit scoped: assigning a role that belongs to another BU is rejected
 * by the platform. Dataverse keeps one copy of a role per BU, all sharing `parentrootroleid`, so the
 * equivalent role is the one in the target BU with the same root. A role with no equivalent there
 * maps to null and the plan skips it with a reason rather than failing at apply time.
 */
export async function resolveRolesInBusinessUnit(api: DataverseLike, roots: string[], businessUnitId: string): Promise<Map<string, RoleRef>> {
  const out = new Map<string, RoleRef>();
  const unique = [...new Set(roots)];
  for (let i = 0; i < unique.length; i += 20) {
    const chunk = unique.slice(i, i + 20);
    const filter = chunk.map((x) => `_parentrootroleid_value eq ${x}`).join(" or ");
    try {
      const r = await api.queryData(`roles?$select=roleid,name,_parentrootroleid_value&$filter=_businessunitid_value eq ${businessUnitId} and (${filter})`);
      for (const row of r.value) {
        const root = row._parentrootroleid_value ? id(row._parentrootroleid_value) : id(row.roleid);
        out.set(root, { id: id(row.roleid), name: s(row.name) ?? id(row.roleid) });
      }
    } catch {
      // A failed chunk leaves those roots unresolved; the plan reports them as skipped.
    }
  }
  return out;
}

// ---------- categories ----------
/**
 * type 1 = Definition, 2 = Activation (a copy Dataverse makes of every activated process),
 * 3 = Template. Only definitions are worth showing or reassigning, and on a real environment the
 * activation copies outnumber them, so the filter belongs in OData rather than in the client.
 */
async function workflows(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(
    `workflows?$select=workflowid,name,category,statecode,type&$filter=_ownerid_value eq ${leaverId} and type eq 1&$orderby=name&$top=${PAGE_LIMIT}`,
  );
  return r.value.map((w) => {
    const cat = num(w.category) ?? 0;
    const state = num(w.statecode) ?? 0;
    const active = state === 1;
    return {
      entity: "workflow",
      id: id(w.workflowid),
      label: s(w.name) ?? id(w.workflowid),
      meta: `${WORKFLOW_CATEGORY_LABEL[cat] ?? `category ${cat}`} · ${WORKFLOW_STATE_LABEL[state] ?? `state ${state}`}`,
      flag:
        cat === 5 && active
          ? "active modern flow — breaks when the owner is disabled. Only solution-aware flows can change owner this way, and the leaver stays a co-owner"
          : cat === 5
            ? "only solution-aware flows can change owner this way, and the leaver stays a co-owner"
            : active && (cat === 2 || cat === 4)
              ? "active: reassigning it does not stop it, but only its owner can deactivate or edit it"
              : null,
      data: { category: cat, statecode: state },
    };
  });
}

async function userQueries(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`userqueries?$select=userqueryid,name,returnedtypecode&$filter=_ownerid_value eq ${leaverId}&$orderby=name&$top=${PAGE_LIMIT}`);
  return r.value.map((q) => ({ entity: "userquery", id: id(q.userqueryid), label: s(q.name) ?? id(q.userqueryid), meta: s(q.returnedtypecode) ?? "", flag: null }));
}

async function userCharts(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`userqueryvisualizations?$select=userqueryvisualizationid,name,primaryentitytypecode&$filter=_ownerid_value eq ${leaverId}&$orderby=name&$top=${PAGE_LIMIT}`);
  return r.value.map((c) => ({
    entity: "userqueryvisualization",
    id: id(c.userqueryvisualizationid),
    label: s(c.name) ?? id(c.userqueryvisualizationid),
    meta: s(c.primaryentitytypecode) ?? "",
    flag: null,
  }));
}

async function ownedQueues(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`queues?$select=queueid,name,queuetypecode&$filter=_ownerid_value eq ${leaverId}&$orderby=name&$top=${PAGE_LIMIT}`);
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
  const r = await api.queryData(
    `systemusers?$select=systemuserid&$filter=systemuserid eq ${leaverId}&$expand=systemuserroles_association($select=roleid,name,_businessunitid_value,_parentrootroleid_value)`,
  );
  return ((r.value[0]?.systemuserroles_association as Row[] | undefined) ?? []).map((x) => ({
    entity: "role",
    id: id(x.roleid),
    label: s(x.name) ?? id(x.roleid),
    meta: "direct role",
    flag: null,
    // A role is scoped to a business unit: the same role exists once per BU, sharing a root role.
    // The plan needs both to hand the successor the right copy. See resolveRolesInBusinessUnit.
    data: { businessUnitId: x._businessunitid_value ? id(x._businessunitid_value) : null, rootRoleId: x._parentrootroleid_value ? id(x._parentrootroleid_value) : id(x.roleid) },
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
    `connectionreferences?$select=connectionreferenceid,connectionreferencedisplayname,connectionreferencelogicalname,connectorid&$filter=_ownerid_value eq ${leaverId}&$orderby=connectionreferencedisplayname&$top=${PAGE_LIMIT}`,
  );
  return r.value.map((c) => ({
    entity: "connectionreference",
    id: id(c.connectionreferenceid),
    label: s(c.connectionreferencedisplayname) ?? s(c.connectionreferencelogicalname) ?? id(c.connectionreferenceid),
    meta: s(c.connectorid) ?? "",
    flag: "the underlying connection stays with the leaver and must be re-authenticated by the successor. The Power Apps portal cannot transfer a connection reference at all, so this is the only supported route",
  }));
}

/**
 * The connections behind the connection references. When the leaver's account is disabled the
 * connection becomes invalid for everyone sharing it, which is what actually breaks a flow, so
 * listing them is not optional. Assign maps to PATCH ownerid here as it does for the rest.
 */
async function connections(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`connections?$select=connectionid,name,statuscode&$filter=_ownerid_value eq ${leaverId}&$orderby=name&$top=${PAGE_LIMIT}`);
  return r.value.map((c) => ({
    entity: "connection",
    id: id(c.connectionid),
    label: s(c.name) ?? id(c.connectionid),
    meta: "connection",
    flag: "changing the owner does not re-authenticate it: the successor still has to sign in before any flow using it will run",
  }));
}

async function directReports(api: DataverseLike, leaverId: string): Promise<InventoryItem[]> {
  const r = await api.queryData(`systemusers?$select=systemuserid,fullname,domainname,isdisabled&$filter=_parentsystemuserid_value eq ${leaverId}&$orderby=fullname&$top=${PAGE_LIMIT}`);
  return r.value.map((u) => ({
    entity: "systemuser",
    id: id(u.systemuserid),
    label: s(u.fullname) ?? id(u.systemuserid),
    meta: s(u.domainname) ?? "",
    flag: null,
  }));
}

/**
 * Organization settings that change what a reassignment means. Read once per inventory; a failure
 * leaves the fields null and the plan simply omits the corresponding warning.
 */
export async function fetchOrgAssignSettings(api: DataverseLike): Promise<OrgAssignSettings | null> {
  try {
    const r = await api.queryData("organizations?$select=organizationid,sharetopreviousowneronassign&$top=1");
    const row = r.value[0];
    if (!row) return null;
    return { shareToPreviousOwnerOnAssign: row.sharetopreviousowneronassign == null ? null : !!row.sharetopreviousowneronassign };
  } catch {
    return null;
  }
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
  { key: "connections", label: "Connections", hint: "connections owned by the leaver", writable: true, load: connections },
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

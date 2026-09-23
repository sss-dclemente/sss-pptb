/**
 * All Dataverse reads for the checker. Primary connection only.
 * Collections always go through queryData with $filter so results are a { value } array,
 * which is the one shape the host guarantees.
 */
import { parseAccessMask, parseDepth, rightOfPrivilegeType, tablePrivilegeName } from "./privileges";
import { RIGHTS } from "./types";
import type {
  BusinessUnit,
  Depth,
  FieldPermission,
  FieldProfile,
  HeldRole,
  Ownership,
  PrivilegeDef,
  RecordInfo,
  RoleRef,
  RolePrivilegeMap,
  SecuredColumn,
  ShareEntry,
  TableInfo,
  TablePrivileges,
  TeamInfo,
  TeamType,
  UserInfo,
} from "./types";

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const id = (v: unknown): string => String(v ?? "").toLowerCase();
/** Guard before a guid is interpolated into an OData path. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const esc = (v: string): string => v.replace(/'/g, "''");

/**
 * Every page of a collection query. queryData returns the response body unchanged, so a paged result
 * carries @odata.nextLink (absolute URL, default page size 5 000). queryData prefixes the connection's
 * Web API root, so pass only what follows /api/data/v9.x/.
 */
export async function queryAll(api: DataverseLike, odata: string): Promise<Row[]> {
  const out: Row[] = [];
  let next: string | null = odata;
  for (let page = 0; next && page < 200; page++) {
    const r = (await api.queryData(next)) as { value: Row[]; "@odata.nextLink"?: string };
    out.push(...(r.value ?? []));
    const link = r["@odata.nextLink"];
    next = link ? link.replace(/^.*?\/api\/data\/v\d+(\.\d+)?\//, "") : null;
  }
  return out;
}

/** Ids per `or` filter: `x eq <guid>` is ~52 chars, so a chunk is ~2 kB of filter, well inside URL length limits however many principals a record is shared with. */
const OR_CHUNK = 40;
/** Run `build(filter)` for chunks of an `or` filter over ids and concatenate every page of every chunk. */
async function queryByIds(api: DataverseLike, ids: string[], field: string, build: (filter: string) => string): Promise<Row[]> {
  const uniq = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += OR_CHUNK) chunks.push(uniq.slice(i, i + OR_CHUNK));
  const pages = await Promise.all(chunks.map((c) => queryAll(api, build(c.map((x) => `${field} eq ${x}`).join(" or ")))));
  return pages.flat();
}

export interface DataverseLike {
  queryData: (odata: string) => Promise<{ value: Row[] }>;
  execute: (req: DataverseAPI.ExecuteRequest) => Promise<Row>;
  getAllEntitiesMetadata: (props?: string[]) => Promise<{ value: Row[] }>;
  getEntityRelatedMetadata: (entity: string, path: "Attributes", props?: string[]) => Promise<{ value: Row[] }>;
}

export class Cache {
  businessUnits: BusinessUnit[] | null = null;
  privileges: PrivilegeDef[] | null = null;
  tables: TableInfo[] | null = null;
  rolePrivileges: RolePrivilegeMap = {};
  /** userId → privilege name (lower-case) → effective depth, or null when the user does not hold it.
   *  From RetrieveUserPrivilegeByPrivilegeName; an absent key means not asked yet. */
  userPrivileges: Record<string, Record<string, Depth | null>> = {};
  hierarchy: boolean | null | undefined = undefined;
  hierarchyMaxDepth: number | undefined = undefined;
  /** table logical name → stored privilege name per right, from entity metadata. */
  tablePrivileges: Record<string, TablePrivileges> = {};
}

// ---------- users ----------
const USER_SELECT = "systemuserid,fullname,domainname,internalemailaddress,_businessunitid_value,_parentsystemuserid_value,isdisabled";
const toUser = (r: Row): UserInfo => ({
  id: id(r.systemuserid),
  fullName: s(r.fullname) ?? s(r.domainname) ?? id(r.systemuserid),
  domainName: s(r.domainname),
  email: s(r.internalemailaddress),
  businessUnitId: r._businessunitid_value ? id(r._businessunitid_value) : null,
  managerId: r._parentsystemuserid_value ? id(r._parentsystemuserid_value) : null,
  isDisabled: !!r.isdisabled,
});

export async function searchUsers(api: DataverseLike, text: string): Promise<UserInfo[]> {
  const t = esc(text.trim());
  if (!t) return [];
  const r = await api.queryData(`systemusers?$select=${USER_SELECT}&$filter=(contains(fullname,'${t}') or contains(domainname,'${t}') or contains(internalemailaddress,'${t}')) and applicationid eq null&$orderby=fullname&$top=20`);
  return r.value.map(toUser);
}

export async function fetchUser(api: DataverseLike, userId: string): Promise<UserInfo | null> {
  const r = await api.queryData(`systemusers?$select=${USER_SELECT}&$filter=systemuserid eq ${userId}`);
  return r.value.length ? toUser(r.value[0]) : null;
}

export async function fetchUsersById(api: DataverseLike, ids: string[]): Promise<Map<string, UserInfo>> {
  const out = new Map<string, UserInfo>();
  if (!ids.length) return out;
  const rows = await queryByIds(api, ids, "systemuserid", (f) => `systemusers?$select=${USER_SELECT}&$filter=${f}`);
  for (const row of rows) out.set(id(row.systemuserid), toUser(row));
  return out;
}

// ---------- roles & teams ----------
const ROLE_SELECT = "roleid,name,_businessunitid_value,_roletemplateid_value,isinherited";
const toRole = (r: Row): RoleRef => ({
  id: id(r.roleid),
  name: s(r.name) ?? id(r.roleid),
  businessUnitId: r._businessunitid_value ? id(r._businessunitid_value) : null,
  templateId: r._roletemplateid_value ? id(r._roletemplateid_value) : null,
  // 1 (the default) unless the role explicitly says 0 "Team privileges only".
  isInherited: r.isinherited == null || Number(r.isinherited) !== 0,
});

export async function fetchDirectRoles(api: DataverseLike, userId: string): Promise<RoleRef[]> {
  const r = await api.queryData(`systemusers?$select=systemuserid&$filter=systemuserid eq ${userId}&$expand=systemuserroles_association($select=${ROLE_SELECT})`);
  const roles = (r.value[0]?.systemuserroles_association as Row[] | undefined) ?? [];
  return roles.map(toRole);
}

export async function fetchTeams(api: DataverseLike, userId: string): Promise<TeamInfo[]> {
  const r = await api.queryData(`systemusers?$select=systemuserid&$filter=systemuserid eq ${userId}&$expand=teammembership_association($select=teamid,name,teamtype,_businessunitid_value)`);
  const teams = ((r.value[0]?.teammembership_association as Row[] | undefined) ?? []).map((t) => ({
    id: id(t.teamid),
    name: s(t.name) ?? id(t.teamid),
    type: (Number(t.teamtype ?? 0) as TeamType) ?? 0,
    businessUnitId: t._businessunitid_value ? id(t._businessunitid_value) : null,
    roles: [] as RoleRef[],
  }));
  if (!teams.length) return teams;
  const tr = await queryByIds(api, teams.map((t) => t.id), "teamid", (f) => `teams?$select=teamid&$filter=${f}&$expand=teamroles_association($select=${ROLE_SELECT})`);
  for (const row of tr) {
    const team = teams.find((t) => t.id === id(row.teamid));
    if (team) team.roles = ((row.teamroles_association as Row[] | undefined) ?? []).map(toRole);
  }
  return teams;
}

export async function fetchTeamsById(api: DataverseLike, ids: string[]): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  if (!ids.length) return out;
  const rows = await queryByIds(api, ids, "teamid", (f) => `teams?$select=teamid,name&$filter=${f}`);
  for (const row of rows) out.set(id(row.teamid), { id: id(row.teamid), name: s(row.name) ?? id(row.teamid) });
  return out;
}

export function heldRoles(direct: RoleRef[], teams: TeamInfo[]): HeldRole[] {
  const out: HeldRole[] = direct.map((role) => ({ role, viaTeam: null }));
  for (const t of teams) for (const role of t.roles) out.push({ role, viaTeam: t });
  return out;
}

// ---------- privileges ----------
export async function fetchPrivilegeDefs(api: DataverseLike, cache: Cache): Promise<PrivilegeDef[]> {
  if (cache.privileges) return cache.privileges;
  const rows = await queryAll(api, "privileges?$select=privilegeid,name");
  cache.privileges = rows.map((p) => ({ id: id(p.privilegeid), name: String(p.name ?? "") }));
  return cache.privileges;
}

/** privilege name (lower-case) → depth for each role, via RetrieveRolePrivilegesRole. Cached per role. */
export async function fetchRolePrivileges(api: DataverseLike, cache: Cache, roles: RoleRef[]): Promise<RolePrivilegeMap> {
  const defs = await fetchPrivilegeDefs(api, cache);
  const nameById = new Map(defs.map((d) => [d.id, d.name.toLowerCase()]));
  const todo = [...new Map(roles.map((r) => [r.id, r])).values()].filter((r) => !cache.rolePrivileges[r.id]);
  await Promise.all(
    todo.map(async (role) => {
      // RetrieveRolePrivilegesRole is an UNBOUND function whose RoleId is an Edm.Guid.
      // It cannot go through execute(): binding it to the role entity gives "Resource not
      // found for the segment", and passing RoleId as a parameter gives "Expression of type
      // 'Edm.String' cannot be converted to type 'Edm.Guid'", because the host quotes every
      // string parameter and has no branch for a Guid. queryData appends the path verbatim,
      // which is the only way to send the unquoted Guid the function expects.
      // RetrieveUserPrivilegeByPrivilegeName below is bound to systemuser and its id goes into the path,
      // so it is unaffected.
      if (!GUID_RE.test(role.id)) throw new Error(`RetrieveRolePrivilegesRole: unexpected role id ${role.id}`);
      const res = (await api.queryData(`RetrieveRolePrivilegesRole(RoleId=${role.id})`)) as unknown as Row;
      const map: Record<string, Depth> = {};
      for (const p of (res.RolePrivileges as Row[] | undefined) ?? []) {
        const name = nameById.get(id(p.PrivilegeId));
        const depth = parseDepth(p.Depth);
        if (name && depth != null && (map[name] == null || map[name] < depth)) map[name] = depth;
      }
      cache.rolePrivileges[role.id] = map;
    }),
  );
  const out: RolePrivilegeMap = {};
  for (const r of roles) out[r.id] = cache.rolePrivileges[r.id] ?? {};
  return out;
}

/**
 * Privilege name per right for one table, from EntityDefinitions(LogicalName='x')?$select=Privileges
 * (PrivilegeType + Name). Names do not follow prv{Right}{Table} everywhere: every activity table
 * shares prv*Activity, annotation is prv*Note, systemuser is prv*User. Cached per table. On failure
 * returns {} so callers fall back to the naming convention (not cached, retried next check).
 */
export async function fetchTablePrivileges(api: DataverseLike, cache: Cache, tableLogicalName: string): Promise<TablePrivileges> {
  const hit = cache.tablePrivileges[tableLogicalName];
  if (hit) return hit;
  try {
    // A single-entity read returns the entity itself, not { value }: same cast as RetrieveRolePrivilegesRole.
    const res = (await api.queryData(`EntityDefinitions(LogicalName='${esc(tableLogicalName)}')?$select=Privileges`)) as unknown as Row;
    const out: TablePrivileges = {};
    for (const p of (res.Privileges as Row[] | undefined) ?? []) {
      const right = rightOfPrivilegeType(p.PrivilegeType);
      if (right && p.Name) out[right] = String(p.Name);
    }
    if (!Object.keys(out).length) return out;
    cache.tablePrivileges[tableLogicalName] = out;
    return out;
  } catch {
    return {};
  }
}

/**
 * Effective depth for the eight rights of one table, as the platform computes it.
 *
 * Not RetrieveUserPrivileges: that one reports privileges inherited through team membership at
 * Basic depth only, whatever the team's roles actually grant, so it understates precisely the
 * case this tool exists to explain. RetrieveUserPrivilegeByPrivilegeName returns the real
 * effective depth, team roles included, but works one privilege at a time — hence asking only
 * for the rights of the table being checked rather than every privilege in the environment.
 *
 * It is bound to systemuser and its parameter is an Edm.String, so it can go through execute().
 * RetrieveRolePrivilegesRole cannot: its Edm.Guid does not survive the host's parameter
 * formatting (PPTB-NOTES §12).
 *
 * null if any call fails, so the caller shows no platform column rather than a partial map
 * whose missing entries would read as denials.
 */
export async function fetchUserPrivileges(api: DataverseLike, cache: Cache, userId: string, tableLogicalName: string, tp: TablePrivileges): Promise<Record<string, Depth> | null> {
  const defs = await fetchPrivilegeDefs(api, cache);
  // Names come from entity metadata (convention only as fallback); maps are keyed lower-case, so
  // match case-insensitively and send back the stored spelling. A right with no privilege for this
  // table (Assign and Share on an organization-owned table) simply has no def to send.
  const storedByLower = new Map(defs.map((d) => [d.name.toLowerCase(), d.name]));
  const wanted = RIGHTS.map((r) => tablePrivilegeName(tp, r, tableLogicalName))
    .filter((lower): lower is string => lower != null)
    .map((lower) => ({ lower, stored: storedByLower.get(lower) }))
    .filter((x): x is { lower: string; stored: string } => x.stored != null);

  const known = (cache.userPrivileges[userId] ??= {});
  const todo = wanted.filter((w) => !(w.lower in known));

  try {
    await Promise.all(
      todo.map(async ({ lower, stored }) => {
        const res = await api.execute({
          entityName: "systemuser",
          entityId: userId,
          operationName: "RetrieveUserPrivilegeByPrivilegeName",
          operationType: "function",
          parameters: { PrivilegeName: stored },
        });
        // An empty RolePrivileges means the user does not hold the privilege. Record that as
        // null rather than leaving the key out, so it is not re-fetched on the next check.
        let best: Depth | null = null;
        for (const pr of (res.RolePrivileges as Row[] | undefined) ?? []) {
          const d = parseDepth(pr.Depth);
          if (d != null && (best == null || d > best)) best = d;
        }
        known[lower] = best;
      }),
    );
  } catch {
    for (const { lower } of todo) delete known[lower];
    return null;
  }

  const map: Record<string, Depth> = {};
  for (const { lower } of wanted) {
    const d = known[lower];
    if (d != null) map[lower] = d;
  }
  return map;
}

// ---------- business units, org ----------
export async function fetchBusinessUnits(api: DataverseLike, cache: Cache): Promise<BusinessUnit[]> {
  if (cache.businessUnits) return cache.businessUnits;
  const rows = await queryAll(api, "businessunits?$select=businessunitid,name,_parentbusinessunitid_value");
  cache.businessUnits = rows.map((b) => ({ id: id(b.businessunitid), name: s(b.name) ?? id(b.businessunitid), parentId: b._parentbusinessunitid_value ? id(b._parentbusinessunitid_value) : null }));
  return cache.businessUnits;
}

/** Default of organization.maxdepthforhierarchicalsecuritymodel. */
export const DEFAULT_HIERARCHY_DEPTH = 3;

/**
 * Organization hierarchy settings: ishierarchicalsecuritymodelenabled and
 * maxdepthforhierarchicalsecuritymodel (both documented on the organization table).
 * enabled null = unknown, hierarchy hint is then skipped; maxDepth falls back to the default 3.
 */
export async function fetchHierarchySettings(api: DataverseLike, cache: Cache): Promise<{ enabled: boolean | null; maxDepth: number }> {
  if (cache.hierarchy === undefined) {
    try {
      const r = await api.queryData("organizations?$select=ishierarchicalsecuritymodelenabled,maxdepthforhierarchicalsecuritymodel&$top=1");
      const v = r.value[0]?.ishierarchicalsecuritymodelenabled;
      const m = Number(r.value[0]?.maxdepthforhierarchicalsecuritymodel);
      cache.hierarchy = typeof v === "boolean" ? v : null;
      cache.hierarchyMaxDepth = Number.isInteger(m) && m > 0 ? m : DEFAULT_HIERARCHY_DEPTH;
    } catch {
      cache.hierarchy = null;
      cache.hierarchyMaxDepth = DEFAULT_HIERARCHY_DEPTH;
    }
  }
  return { enabled: cache.hierarchy, maxDepth: cache.hierarchyMaxDepth ?? DEFAULT_HIERARCHY_DEPTH };
}

/** Walk the manager chain above a user (nearest first), at most `max` levels (the org's hierarchy depth). */
export async function fetchManagerChain(api: DataverseLike, start: UserInfo, max = DEFAULT_HIERARCHY_DEPTH): Promise<UserInfo[]> {
  const out: UserInfo[] = [];
  let cur = start;
  const seen = new Set<string>([start.id]);
  while (cur.managerId && out.length < max && !seen.has(cur.managerId)) {
    const m = await fetchUser(api, cur.managerId);
    if (!m) break;
    seen.add(m.id);
    out.push(m);
    cur = m;
  }
  return out;
}

// ---------- tables & records ----------
const OWNERSHIP: Record<string, Ownership> = { UserOwned: "user", TeamOwned: "team", OrganizationOwned: "org", BusinessOwned: "bu", None: "none" };
const label = (v: unknown, fallback: string): string => {
  const l = (v as { UserLocalizedLabel?: { Label?: string }; LocalizedLabels?: { Label?: string }[] } | undefined) ?? {};
  return l.UserLocalizedLabel?.Label ?? l.LocalizedLabels?.[0]?.Label ?? fallback;
};

export async function fetchTables(api: DataverseLike, cache: Cache): Promise<TableInfo[]> {
  if (cache.tables) return cache.tables;
  const r = await api.getAllEntitiesMetadata(["LogicalName", "SchemaName", "DisplayName", "EntitySetName", "PrimaryNameAttribute", "PrimaryIdAttribute", "OwnershipType", "IsIntersect", "IsPrivate", "IsLogicalEntity"]);
  cache.tables = r.value
    .filter((e) => !e.IsIntersect && !e.IsPrivate && !e.IsLogicalEntity && e.EntitySetName && e.PrimaryIdAttribute)
    .map((e) => ({
      logicalName: String(e.LogicalName),
      schemaName: String(e.SchemaName ?? e.LogicalName),
      displayName: label(e.DisplayName, String(e.LogicalName)),
      entitySetName: String(e.EntitySetName),
      primaryId: String(e.PrimaryIdAttribute),
      primaryName: s(e.PrimaryNameAttribute),
      ownership: OWNERSHIP[String(e.OwnershipType)] ?? "none",
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return cache.tables;
}

const ownerFields = (t: TableInfo): string[] => (t.ownership === "user" || t.ownership === "team" ? ["_ownerid_value", "_owningbusinessunit_value"] : t.ownership === "bu" ? ["_owningbusinessunit_value"] : []);

function toRecord(t: TableInfo, r: Row): RecordInfo {
  const ownerType = s(r["_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname"]);
  return {
    id: id(r[t.primaryId]),
    name: (t.primaryName ? s(r[t.primaryName]) : null) ?? id(r[t.primaryId]),
    ownerId: r._ownerid_value ? id(r._ownerid_value) : null,
    ownerType: ownerType === "systemuser" || ownerType === "team" ? ownerType : r._ownerid_value ? "systemuser" : null,
    ownerName: s(r["_ownerid_value@OData.Community.Display.V1.FormattedValue"]),
    owningBusinessUnitId: r._owningbusinessunit_value ? id(r._owningbusinessunit_value) : null,
  };
}

export async function fetchRecord(api: DataverseLike, t: TableInfo, recordId: string): Promise<RecordInfo | null> {
  const sel = [t.primaryId, ...(t.primaryName ? [t.primaryName] : []), ...ownerFields(t)].join(",");
  const r = await api.queryData(`${t.entitySetName}?$select=${sel}&$filter=${t.primaryId} eq ${recordId}`);
  return r.value.length ? toRecord(t, r.value[0]) : null;
}

export async function searchRecords(api: DataverseLike, t: TableInfo, text: string): Promise<RecordInfo[]> {
  const q = esc(text.trim());
  if (!q || !t.primaryName) return [];
  const sel = [t.primaryId, t.primaryName, ...ownerFields(t)].join(",");
  const r = await api.queryData(`${t.entitySetName}?$select=${sel}&$filter=contains(${t.primaryName},'${q}')&$orderby=${t.primaryName}&$top=20`);
  return r.value.map((row) => toRecord(t, row));
}

// ---------- platform verdicts ----------
export async function fetchPrincipalAccess(api: DataverseLike, userId: string, t: TableInfo, recordId: string): Promise<ReturnType<typeof parseAccessMask> | null> {
  try {
    const res = await api.execute({
      entityName: "systemuser",
      entityId: userId,
      operationName: "RetrievePrincipalAccess",
      operationType: "function",
      parameters: { Target: { entityLogicalName: t.logicalName, id: recordId } },
    });
    return parseAccessMask(res.AccessRights);
  } catch {
    return null;
  }
}

export async function fetchShares(api: DataverseLike, t: TableInfo, recordId: string): Promise<ShareEntry[]> {
  const res = await api.execute({ entityName: t.logicalName, entityId: recordId, operationName: "RetrieveSharedPrincipalsAndAccess", operationType: "function" });
  const raw = ((res.PrincipalAccesses as Row[] | undefined) ?? []).map((pa) => {
    const p = (pa.Principal as Row | undefined) ?? {};
    const type = p.teamid || String(p["@odata.type"] ?? "").endsWith(".team") ? "team" : "systemuser";
    return { principalType: type as "systemuser" | "team", principalId: id(p.teamid ?? p.systemuserid ?? p.ownerid), rights: parseAccessMask(pa.AccessMask) };
  });
  const [users, teams] = await Promise.all([
    fetchUsersById(api, raw.filter((x) => x.principalType === "systemuser").map((x) => x.principalId)),
    fetchTeamsById(api, raw.filter((x) => x.principalType === "team").map((x) => x.principalId)),
  ]);
  return raw.map((x) => ({ ...x, principalName: (x.principalType === "team" ? teams.get(x.principalId)?.name : users.get(x.principalId)?.fullName) ?? null }));
}

// ---------- column security ----------
export async function fetchSecuredColumns(api: DataverseLike, t: TableInfo): Promise<SecuredColumn[]> {
  const r = await api.getEntityRelatedMetadata(t.logicalName, "Attributes", ["LogicalName", "DisplayName", "IsSecured"]);
  return r.value
    .filter((a) => !!a.IsSecured)
    .map((a) => ({ logicalName: String(a.LogicalName), displayName: label(a.DisplayName, String(a.LogicalName)) }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function fetchFieldProfiles(api: DataverseLike, userId: string, teams: TeamInfo[]): Promise<FieldProfile[]> {
  const out: FieldProfile[] = [];
  const u = await api.queryData(`systemusers?$select=systemuserid&$filter=systemuserid eq ${userId}&$expand=systemuserprofiles_association($select=fieldsecurityprofileid,name)`);
  for (const p of (u.value[0]?.systemuserprofiles_association as Row[] | undefined) ?? []) out.push({ id: id(p.fieldsecurityprofileid), name: s(p.name) ?? id(p.fieldsecurityprofileid), viaTeam: null });
  if (teams.length) {
    const tr = await queryByIds(api, teams.map((t) => t.id), "teamid", (f) => `teams?$select=teamid&$filter=${f}&$expand=teamprofiles_association($select=fieldsecurityprofileid,name)`);
    for (const row of tr) {
      const team = teams.find((t) => t.id === id(row.teamid));
      for (const p of (row.teamprofiles_association as Row[] | undefined) ?? []) out.push({ id: id(p.fieldsecurityprofileid), name: s(p.name) ?? id(p.fieldsecurityprofileid), viaTeam: team ?? null });
    }
  }
  return out;
}

export async function fetchFieldPermissions(api: DataverseLike, t: TableInfo, profileIds: string[]): Promise<FieldPermission[]> {
  if (!profileIds.length) return [];
  const rows = await queryAll(api, `fieldpermissions?$select=attributelogicalname,canread,canupdate,cancreate,_fieldsecurityprofileid_value&$filter=entityname eq '${esc(t.logicalName)}'`);
  const wanted = new Set(profileIds);
  return rows
    .map((p) => ({ profileId: id(p._fieldsecurityprofileid_value), attribute: String(p.attributelogicalname ?? ""), canRead: Number(p.canread) === 4, canUpdate: Number(p.canupdate) === 4, canCreate: Number(p.cancreate) === 4 }))
    .filter((p) => wanted.has(p.profileId));
}

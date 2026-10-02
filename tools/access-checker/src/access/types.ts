/** Domain types for the Access Checker. Everything here is plain data; no DOM, no host. */

export const RIGHTS = ["Create", "Read", "Write", "Delete", "Append", "AppendTo", "Assign", "Share"] as const;
export type Right = (typeof RIGHTS)[number];

/** Privilege depth as returned by RetrieveRolePrivilegesRole / RetrieveUserPrivilegeByPrivilegeName. */
export type Depth = 0 | 1 | 2 | 3; // Basic, Local, Deep, Global
export const DEPTH_LABEL: Record<Depth, string> = { 0: "Basic", 1: "Local", 2: "Deep", 3: "Global" };

export interface UserInfo {
  id: string;
  fullName: string;
  domainName: string | null;
  email: string | null;
  businessUnitId: string | null;
  managerId: string | null;
  isDisabled: boolean;
}

export interface BusinessUnit {
  id: string;
  name: string;
  parentId: string | null;
}

export interface RoleRef {
  id: string;
  name: string;
  /** BU the role belongs to. With record ownership across BUs (modernized BUs) a user can hold a role
   *  from a BU other than their own; Local/Deep depth is then evaluated against this BU. */
  businessUnitId: string | null;
  /** roletemplateid: identical across the per-BU copies of a system role (System Administrator etc.). */
  templateId: string | null;
  /** role.isinherited, "Member's privilege inheritance". true = 1 "Direct User (Basic) access level and
   *  Team privileges" (the default); false = 0 "Team privileges only". Only matters for team roles. */
  isInherited: boolean;
}

/** roletemplateid of System Administrator, the same in every environment and BU. */
export const SYSADMIN_TEMPLATE_ID = "627090ff-40a3-4053-8790-584edc5be201";

/** Stored privilege name per right for one table, from EntityDefinitions(...).Privileges. A right the
 *  table has no privilege for (Assign/Share on an organization-owned table) is absent. */
export type TablePrivileges = Partial<Record<Right, string>>;

export type TeamType = 0 | 1 | 2 | 3; // owner, access, AAD security group, AAD office group
export const TEAM_TYPE_LABEL: Record<TeamType, string> = { 0: "owner team", 1: "access team", 2: "Entra security group team", 3: "Entra office group team" };

export interface TeamInfo {
  id: string;
  name: string;
  type: TeamType;
  businessUnitId: string | null;
  roles: RoleRef[];
}

/** A role the user holds, either assigned directly or through a team. */
export interface HeldRole {
  role: RoleRef;
  viaTeam: TeamInfo | null;
}

/** privilege name (lower-case, e.g. "prvreadaccount") → depth, per role id. */
export type RolePrivilegeMap = Record<string, Record<string, Depth>>;

export interface PrivilegeDef {
  id: string;
  name: string;
}

export type Ownership = "user" | "team" | "org" | "bu" | "none";

export interface TableInfo {
  logicalName: string;
  schemaName: string;
  displayName: string;
  entitySetName: string;
  primaryId: string;
  primaryName: string | null;
  ownership: Ownership;
}

export interface RecordInfo {
  id: string;
  name: string;
  ownerId: string | null;
  ownerType: "systemuser" | "team" | null;
  ownerName: string | null;
  owningBusinessUnitId: string | null;
}

export interface ShareEntry {
  principalType: "systemuser" | "team";
  principalId: string;
  principalName: string | null;
  rights: Right[];
}

export interface SecuredColumn {
  logicalName: string;
  displayName: string;
}

export interface FieldProfile {
  id: string;
  name: string;
  viaTeam: TeamInfo | null;
}

export interface FieldPermission {
  profileId: string;
  attribute: string;
  canRead: boolean;
  canUpdate: boolean;
  canCreate: boolean;
}

/** Everything fetched for one check. `record` and `shares` are null for a table-level check. */
export interface CheckData {
  user: UserInfo;
  userBu: BusinessUnit | null;
  businessUnits: BusinessUnit[];
  heldRoles: HeldRole[];
  teams: TeamInfo[];
  rolePrivileges: RolePrivilegeMap;
  table: TableInfo;
  /** Privilege names of the checked table from entity metadata (prvReadActivity for task, prvReadNote for annotation …). */
  tablePrivileges: TablePrivileges;
  record: RecordInfo | null;
  shares: ShareEntry[] | null;
  /** Rights the platform reports for the user on the record (RetrievePrincipalAccess). null when unavailable. */
  platformRights: Right[] | null;
  /** Effective depth per privilege name reported by the platform (RetrieveUserPrivilegeByPrivilegeName),
   *  for the rights of the checked table only. null when unavailable. */
  platformDepths: Record<string, Depth> | null;
  hierarchyEnabled: boolean | null;
  /** organization.maxdepthforhierarchicalsecuritymodel (default 3): how many manager levels hierarchy security reaches. */
  hierarchyMaxDepth: number;
  /** Manager chain above the record owner (nearest first, at most hierarchyMaxDepth levels), only when the owner is a user and hierarchy is on. */
  ownerManagers: UserInfo[];
}

export type Applies = "yes" | "no" | "n/a";

export interface PrivilegePath {
  role: RoleRef;
  viaTeam: TeamInfo | null;
  depth: Depth;
  /** BU the depth is evaluated against (the role's BU for direct roles, team BU for team roles). */
  baseBuId: string | null;
  reaches: boolean | null; // null when no record
  reason: string;
}

export interface RightVerdict {
  right: Right;
  applicable: boolean;
  /** Tool's own conclusion. */
  computed: Applies;
  /** Platform verdict (RetrievePrincipalAccess) or effective depth (table-level). */
  platform: Applies;
  platformDepth: Depth | null;
  bestDepth: Depth | null;
  paths: PrivilegePath[];
  sharePaths: string[];
  /** false when a share grants the right but the user holds no role with the privilege: the platform ignores such a share. */
  sharesEffective: boolean;
  hierarchyHint: string | null;
  /** One-line summary of why. */
  summary: string;
  agrees: boolean | null;
}

export interface Explanation {
  mode: "record" | "table";
  verdicts: RightVerdict[];
  ownership: {
    ownerLabel: string;
    owningBu: BusinessUnit | null;
    userBu: BusinessUnit | null;
    relation: string;
    userIsOwner: boolean;
    userInOwningTeam: boolean;
  } | null;
  sharesForUser: { entry: ShareEntry; via: string }[];
  hierarchy: string | null;
  notes: string[];
}

export interface ColumnAccess {
  column: SecuredColumn;
  read: FieldProfile[];
  update: FieldProfile[];
  create: FieldProfile[];
}

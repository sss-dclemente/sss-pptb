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
  businessUnitId: string | null;
}

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
  record: RecordInfo | null;
  shares: ShareEntry[] | null;
  /** Rights the platform reports for the user on the record (RetrievePrincipalAccess). null when unavailable. */
  platformRights: Right[] | null;
  /** Effective depth per privilege name reported by the platform (RetrieveUserPrivilegeByPrivilegeName),
   *  for the rights of the checked table only. null when unavailable. */
  platformDepths: Record<string, Depth> | null;
  hierarchyEnabled: boolean | null;
  /** Manager chain above the record owner (nearest first), only when the owner is a user and hierarchy is on. */
  ownerManagers: UserInfo[];
}

export type Applies = "yes" | "no" | "n/a";

export interface PrivilegePath {
  role: RoleRef;
  viaTeam: TeamInfo | null;
  depth: Depth;
  /** BU the depth is evaluated against (user BU for direct roles, team BU for team roles). */
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

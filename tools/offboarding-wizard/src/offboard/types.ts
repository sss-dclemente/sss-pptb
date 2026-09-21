/** Domain types for the Offboarding Wizard. Plain data only; no DOM, no host. */

export interface UserInfo {
  id: string;
  fullName: string;
  domainName: string | null;
  email: string | null;
  businessUnitId: string | null;
  managerId: string | null;
  isDisabled: boolean;
  /** systemuser.accessmode, values per the table's own choice metadata (see ACCESS_MODE_LABEL). */
  accessMode: number | null;
}

/** A role as it exists in one business unit. */
export interface RoleRef {
  id: string;
  name: string;
}

/** What a principal already holds, used to skip associates that would fail as duplicates. */
export interface PrincipalHeld {
  roleIds: Set<string>;
  profileIds: Set<string>;
  teamIds: Set<string>;
}

export interface TeamRef {
  id: string;
  name: string;
  /** 0 owner, 1 access, 2 Entra security group, 3 Entra office group. */
  type: number;
  businessUnitId: string | null;
}

export const TEAM_TYPE_LABEL: Record<number, string> = {
  0: "owner team",
  1: "access team",
  2: "Entra security group team",
  3: "Entra office group team",
};

/** systemuser.accessmode. Labels read off the choice metadata of a live environment, not guessed:
 *  3 is Support User and 4 is Non-interactive, which is the pair most often written the other way round. */
export const ACCESS_MODE_LABEL: Record<number, string> = {
  0: "Read-Write",
  1: "Administrative",
  2: "Read",
  3: "Support User",
  4: "Non-interactive",
  5: "Delegated Admin",
};

/** 0 workflow, 1 dialog, 2 business rule, 3 action, 4 business process flow, 5 modern flow. */
export const WORKFLOW_CATEGORY_LABEL: Record<number, string> = {
  0: "classic workflow",
  1: "dialog",
  2: "business rule",
  3: "action",
  4: "business process flow",
  5: "modern flow",
};

export const WORKFLOW_STATE_LABEL: Record<number, string> = { 0: "draft", 1: "activated", 2: "suspended" };

export interface TableInfo {
  logicalName: string;
  displayName: string;
  entitySetName: string;
  primaryId: string;
  primaryName: string | null;
  /** "user" | "team" — only owned tables are scanned. */
  ownership: "user" | "team";
}

export interface LeaverInfo {
  user: UserInfo;
  businessUnitName: string | null;
  manager: UserInfo | null;
}

export type CategoryKey =
  | "records"
  | "workflows"
  | "userqueries"
  | "usercharts"
  | "queues"
  | "queuemembership"
  | "teams"
  | "roles"
  | "fieldprofiles"
  | "connectionreferences"
  | "connections"
  | "directreports";

/** One holding of the leaver inside a category. `entity`/`id` identify the record the write targets. */
export interface InventoryItem {
  entity: string;
  id: string;
  label: string;
  meta: string;
  /** Non-null marks the row as needing attention (high-risk or not writable). */
  flag: string | null;
  /** Category-specific payload the planner needs (team type, workflow category, …). */
  data?: Record<string, unknown>;
}

export interface CategoryResult {
  key: CategoryKey;
  label: string;
  hint: string;
  /** false = inventory only, no write offered in v1. */
  writable: boolean;
  items: InventoryItem[];
  /** Set when the read failed: the category shows an error row and never breaks the run. */
  error: string | null;
}

export interface TableScanRow {
  table: TableInfo;
  /** null when the table could not be counted. */
  count: number | null;
  /** true when the count came from a capped id page rather than $count. */
  approximate: boolean;
  error: string | null;
}

export interface ScanSummary {
  rows: TableScanRow[];
  scanned: number;
  requested: number;
  cancelled: boolean;
  /** Tables whose count query was rejected by the platform. */
  failed: TableScanRow[];
}

export interface Inventory {
  leaver: LeaverInfo;
  categories: CategoryResult[];
  scan: ScanSummary | null;
  takenAt: string;
  /** Organization settings that change what a reassignment means. Null when they could not be read. */
  orgAssign: OrgAssignSettings | null;
}

export interface OrgAssignSettings {
  /**
   * organization.sharetopreviousowneronassign. When true, assigning a record shares it back to the
   * previous owner with full rights — so reassigning a leaver's records leaves them able to read and
   * write every one of them. It is the single setting that can defeat an offboarding.
   */
  shareToPreviousOwnerOnAssign: boolean | null;
}

/** The exact Dataverse call an operation performs. Rendered verbatim in the preview dialog. */
export type Call =
  | { op: "update"; entity: string; id: string; record: Record<string, unknown> }
  | { op: "associate"; entity: string; id: string; relationship: string; relatedEntity: string; relatedId: string }
  | { op: "disassociate"; entity: string; id: string; relationship: string; relatedId: string };

export type OpKind =
  | "reassign-record"
  | "reassign-asset"
  | "role-copy"
  | "role-remove"
  | "profile-copy"
  | "profile-remove"
  | "team-remove"
  | "team-add"
  | "manager-reassign";

export interface PlannedOp {
  key: string;
  category: CategoryKey;
  kind: OpKind;
  /** What the operation touches, for the preview and the report. */
  label: string;
  detail: string;
  danger: boolean;
  call: Call;
}

export interface Plan {
  ops: PlannedOp[];
  warnings: string[];
  /** Things deliberately left out of the plan, with the reason. */
  skipped: string[];
  /** Per-category op counts, in category order. */
  counts: { category: CategoryKey; label: string; count: number }[];
}

export interface OpResult {
  op: PlannedOp;
  ok: boolean;
  error: string | null;
}

export const CALL_TEXT = (c: Call): string => {
  if (c.op === "update") return `update ${c.entity}(${c.id}) ${JSON.stringify(c.record)}`;
  if (c.op === "associate") return `associate ${c.entity}(${c.id}) ${c.relationship} → ${c.relatedEntity}(${c.relatedId})`;
  return `disassociate ${c.entity}(${c.id}) ${c.relationship} → (${c.relatedId})`;
};

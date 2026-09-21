/**
 * Inventory + choices → the exact list of Dataverse calls. Pure: no host, no DOM, no I/O.
 *
 * Write mechanism per category (see docs/OFFBOARDING-PLAN.md § UNVERIFIED):
 *  - ownership moves (records, flows, views, charts, queues, connection references) use
 *    `update(entity, id, { "ownerid@odata.bind": "/systemusers(id)" })`. The SDK `Assign`
 *    message is NOT used: it is not documented as an OData action in @pptb/types 1.2.5, while
 *    `update` and `@odata.bind` are. Setting ownerid is the Web API way to reassign a record.
 *  - roles / field security profiles / teams use `associate` / `disassociate`, which @pptb/types
 *    documents with exactly these relationship names. `AddMembersTeam` / `RemoveMembersTeam`
 *    are NOT used: their collection-of-EntityReference parameter shape is unverified over the bridge.
 *  - direct reports use `update("systemuser", id, { "parentsystemuserid@odata.bind": … })`.
 */
import type { CategoryKey, CategoryResult, InventoryItem, Inventory, Plan, PlannedOp, PrincipalHeld, RoleRef, TableInfo, UserInfo } from "./types";

/** Records per table fetched for the plan; more than this and the table is truncated with a warning. */
export const DEFAULT_RECORD_CAP = 500;
/** No plan may exceed this many operations. */
export const HARD_OP_CAP = 5000;
/** Above this the preview dialog shows a danger banner. */
export const LARGE_PLAN_WARNING = 1000;

export type OwnerTarget = { kind: "user"; id: string; name: string } | { kind: "team"; id: string; name: string };

export interface PlanOptions {
  successor: UserInfo;
  /** Where reassigned records go. Non-record assets always go to the successor user. */
  recordTarget: OwnerTarget;
  /** Category keys the user ticked on the Inventory tab. */
  categories: Set<CategoryKey>;
  /** Logical names of the tables ticked inside the records category. */
  tables: Set<string>;
  roleCopy: boolean;
  roleRemove: boolean;
  profileCopy: boolean;
  profileRemove: boolean;
  teamRemove: boolean;
  teamAdd: boolean;
  recordCap: number;
  /** What the successor already holds. Absent = the checks are skipped and nothing is filtered out. */
  successorHeld?: PrincipalHeld;
  /**
   * The leaver's roles mapped onto the successor's business unit, keyed by the leaver's role id.
   * A key present with `null` means the role has no equivalent there. Absent map = no remapping,
   * which is correct when both users are in the same business unit.
   */
  roleRemap?: Map<string, RoleRef | null>;
}

const ownerBind = (t: OwnerTarget): Record<string, unknown> => ({
  "ownerid@odata.bind": `/${t.kind === "team" ? "teams" : "systemusers"}(${t.id})`,
});

const CATEGORY_LABEL: Record<CategoryKey, string> = {
  records: "Records",
  workflows: "Flows & classic processes",
  userqueries: "Personal views",
  usercharts: "Personal charts",
  queues: "Queues owned",
  queuemembership: "Queue memberships",
  teams: "Team memberships",
  roles: "Security roles",
  fieldprofiles: "Field security profiles",
  connectionreferences: "Connection references",
  directreports: "Direct reports",
};

/** Categories whose items are simply re-owned by the successor user. */
const ASSET_CATEGORIES: CategoryKey[] = ["workflows", "userqueries", "usercharts", "queues", "connectionreferences"];

function assetOps(cat: CategoryResult, successor: UserInfo): PlannedOp[] {
  return cat.items.map((it) => ({
    key: `${cat.key}:${it.id}`,
    category: cat.key,
    kind: "reassign-asset" as const,
    label: it.label,
    detail: `owner → ${successor.fullName}`,
    danger: false,
    call: { op: "update" as const, entity: it.entity, id: it.id, record: ownerBind({ kind: "user", id: successor.id, name: successor.fullName }) },
  }));
}

function teamOps(cat: CategoryResult, leaverId: string, successor: UserInfo, o: PlanOptions, skipped: string[]): PlannedOp[] {
  const ops: PlannedOp[] = [];
  for (const it of cat.items) {
    const type = Number((it.data?.teamtype as number | undefined) ?? 0);
    if (type >= 2) {
      skipped.push(`Team "${it.label}": membership is managed in Entra ID and cannot be changed through Dataverse.`);
      continue;
    }
    if (o.teamAdd && o.successorHeld?.teamIds.has(it.id)) {
      skipped.push(`Team "${it.label}": ${successor.fullName} is already a member.`);
    } else if (o.teamAdd)
      ops.push({
        key: `teams:add:${it.id}`,
        category: "teams",
        kind: "team-add",
        label: it.label,
        detail: `add ${successor.fullName}`,
        danger: false,
        call: { op: "associate", entity: "team", id: it.id, relationship: "teammembership_association", relatedEntity: "systemuser", relatedId: successor.id },
      });
    if (o.teamRemove)
      ops.push({
        key: `teams:remove:${it.id}`,
        category: "teams",
        kind: "team-remove",
        label: it.label,
        detail: "remove the leaver",
        danger: true,
        call: { op: "disassociate", entity: "team", id: it.id, relationship: "teammembership_association", relatedId: leaverId },
      });
  }
  return ops;
}

interface PrincipalOpts {
  relationship: string;
  relatedEntity: string;
  copy: boolean;
  remove: boolean;
  kindCopy: PlannedOp["kind"];
  kindRemove: PlannedOp["kind"];
  /** Ids the successor already holds; a copy of one of these is skipped, not planned. */
  held?: Set<string>;
  /** Roles only: leaver role id → the equivalent role in the successor's BU, or null if there is none. */
  remap?: Map<string, RoleRef | null>;
  skipped: string[];
}

function principalOps(cat: CategoryResult, leaverId: string, successor: UserInfo, p: PrincipalOpts): PlannedOp[] {
  const ops: PlannedOp[] = [];
  for (const it of cat.items) {
    if (p.copy) {
      // Roles live per business unit: grant the successor the copy that belongs to theirs.
      const target: RoleRef | null = p.remap ? (p.remap.get(it.id) ?? null) : { id: it.id, name: it.label };
      if (p.remap && !target) {
        p.skipped.push(`Role "${it.label}": no equivalent role exists in ${successor.fullName}'s business unit, so it cannot be granted from here.`);
      } else if (target && p.held?.has(target.id)) {
        p.skipped.push(`${cat.label} "${it.label}": ${successor.fullName} already has it.`);
      } else if (target) {
        const remapped = target.id !== it.id;
        ops.push({
          key: `${cat.key}:copy:${it.id}`,
          category: cat.key,
          kind: p.kindCopy,
          label: it.label,
          detail: remapped ? `grant to ${successor.fullName} (their business unit's copy of this role)` : `grant to ${successor.fullName}`,
          danger: true,
          call: { op: "associate", entity: "systemuser", id: successor.id, relationship: p.relationship, relatedEntity: p.relatedEntity, relatedId: target.id },
        });
      }
    }
    if (p.remove)
      ops.push({
        key: `${cat.key}:remove:${it.id}`,
        category: cat.key,
        kind: p.kindRemove,
        label: it.label,
        detail: "remove from the leaver",
        danger: true,
        call: { op: "disassociate", entity: "systemuser", id: leaverId, relationship: p.relationship, relatedId: it.id },
      });
  }
  return ops;
}

function recordOps(inv: Inventory, recordIds: Map<string, { id: string; name: string }[]>, o: PlanOptions, warnings: string[]): PlannedOp[] {
  const ops: PlannedOp[] = [];
  for (const row of inv.scan?.rows ?? []) {
    const t: TableInfo = row.table;
    if (!o.tables.has(t.logicalName)) continue;
    const ids = recordIds.get(t.logicalName) ?? [];
    if ((row.count ?? 0) > ids.length) warnings.push(`${t.displayName}: ${row.count} records owned, only the first ${ids.length} are in this plan (cap ${o.recordCap}).`);
    for (const r of ids)
      ops.push({
        key: `records:${t.logicalName}:${r.id}`,
        category: "records",
        kind: "reassign-record",
        label: `${t.displayName} · ${r.name}`,
        detail: `owner → ${o.recordTarget.name}`,
        danger: false,
        call: { op: "update", entity: t.logicalName, id: r.id, record: ownerBind(o.recordTarget) },
      });
  }
  return ops;
}

/** Build the plan. `recordIds` holds the ids fetched for each ticked table. */
export function buildPlan(inv: Inventory, recordIds: Map<string, { id: string; name: string }[]>, o: PlanOptions): Plan {
  const leaverId = inv.leaver.user.id;
  const warnings: string[] = [];
  const skipped: string[] = [];
  const byKey = new Map(inv.categories.map((c) => [c.key, c]));
  let ops: PlannedOp[] = [];

  if (o.categories.has("records")) ops = ops.concat(recordOps(inv, recordIds, o, warnings));

  for (const key of ASSET_CATEGORIES) {
    const cat = byKey.get(key);
    if (!cat || !o.categories.has(key) || !cat.items.length) continue;
    ops = ops.concat(assetOps(cat, o.successor));
  }

  const roles = byKey.get("roles");
  if (roles && o.categories.has("roles")) {
    if (!o.roleCopy && !o.roleRemove) skipped.push("Security roles: neither copy nor remove was chosen.");
    ops = ops.concat(
      principalOps(roles, leaverId, o.successor, {
        relationship: "systemuserroles_association",
        relatedEntity: "role",
        copy: o.roleCopy,
        remove: o.roleRemove,
        kindCopy: "role-copy",
        kindRemove: "role-remove",
        held: o.successorHeld?.roleIds,
        remap: o.roleRemap,
        skipped,
      }),
    );
  }

  const profiles = byKey.get("fieldprofiles");
  if (profiles && o.categories.has("fieldprofiles")) {
    if (!o.profileCopy && !o.profileRemove) skipped.push("Field security profiles: neither copy nor remove was chosen.");
    ops = ops.concat(
      principalOps(profiles, leaverId, o.successor, {
        relationship: "systemuserprofiles_association",
        relatedEntity: "fieldsecurityprofile",
        copy: o.profileCopy,
        remove: o.profileRemove,
        kindCopy: "profile-copy",
        kindRemove: "profile-remove",
        held: o.successorHeld?.profileIds,
        skipped,
      }),
    );
  }

  const teams = byKey.get("teams");
  if (teams && o.categories.has("teams")) {
    if (!o.teamAdd && !o.teamRemove) skipped.push("Team memberships: neither add nor remove was chosen.");
    ops = ops.concat(teamOps(teams, leaverId, o.successor, o, skipped));
  }

  const reports = byKey.get("directreports");
  if (reports && o.categories.has("directreports"))
    ops = ops.concat(
      reports.items.map((it: InventoryItem) => ({
        key: `directreports:${it.id}`,
        category: "directreports" as CategoryKey,
        kind: "manager-reassign" as const,
        label: it.label,
        detail: `manager → ${o.successor.fullName}`,
        danger: false,
        call: { op: "update" as const, entity: "systemuser", id: it.id, record: { "parentsystemuserid@odata.bind": `/systemusers(${o.successor.id})` } },
      })),
    );

  if (o.categories.has("queuemembership")) skipped.push("Queue memberships are inventory only in v1: remove the leaver from the queue in the maker portal.");
  if (byKey.get("connectionreferences")?.items.length && o.categories.has("connectionreferences"))
    warnings.push("Connection references change owner, but the connection behind them still belongs to the leaver: the successor must re-authenticate it.");
  if (inv.scan?.failed.length) warnings.push(`${inv.scan.failed.length} table(s) could not be counted and are not in this plan.`);
  if (inv.scan?.cancelled) warnings.push("The table scan was cancelled: the record inventory is incomplete.");

  if (ops.length > HARD_OP_CAP) {
    warnings.push(`Plan truncated to the hard cap of ${HARD_OP_CAP} operations (${ops.length} were built). Narrow the selection and run again.`);
    ops = ops.slice(0, HARD_OP_CAP);
  }

  const counts = (Object.keys(CATEGORY_LABEL) as CategoryKey[])
    .map((k) => ({ category: k, label: CATEGORY_LABEL[k], count: ops.filter((op) => op.category === k).length }))
    .filter((c) => c.count > 0);

  return { ops, warnings, skipped, counts };
}

export const categoryLabel = (k: CategoryKey): string => CATEGORY_LABEL[k];

/** How many operations the current selection would produce, without fetching any record id. */
export function estimateCounts(inv: Inventory, o: Pick<PlanOptions, "categories" | "tables" | "roleCopy" | "roleRemove" | "profileCopy" | "profileRemove" | "teamRemove" | "teamAdd" | "recordCap">): { label: string; count: number }[] {
  const out: { label: string; count: number }[] = [];
  if (o.categories.has("records")) {
    const n = (inv.scan?.rows ?? []).filter((r) => o.tables.has(r.table.logicalName)).reduce((sum, r) => sum + Math.min(r.count ?? 0, o.recordCap), 0);
    if (n) out.push({ label: CATEGORY_LABEL.records, count: n });
  }
  for (const c of inv.categories) {
    if (!o.categories.has(c.key) || !c.writable) continue;
    // Entra group teams are always skipped when the plan is built, so they must not be counted here
    // either: an estimate that disagrees with the preview is worse than no estimate.
    const items = c.key === "teams" ? c.items.filter((it) => Number((it.data?.teamtype as number | undefined) ?? 0) < 2).length : c.items.length;
    const mult =
      c.key === "roles"
        ? (o.roleCopy ? 1 : 0) + (o.roleRemove ? 1 : 0)
        : c.key === "fieldprofiles"
          ? (o.profileCopy ? 1 : 0) + (o.profileRemove ? 1 : 0)
          : c.key === "teams"
            ? (o.teamAdd ? 1 : 0) + (o.teamRemove ? 1 : 0)
            : 1;
    if (items * mult) out.push({ label: CATEGORY_LABEL[c.key], count: items * mult });
  }
  return out;
}

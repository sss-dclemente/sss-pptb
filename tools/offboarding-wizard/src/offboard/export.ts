/** JSON / CSV exports for the audit trail. Pure. */
import { categoryLabel } from "./plan";
import { CALL_TEXT, type Inventory, type OpResult, type Plan, type PlannedOp, type UserInfo } from "./types";

export const safeFileName = (s: string): string => s.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "export";

const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csv = (rows: unknown[][]): string => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

const userOut = (u: UserInfo | null): Record<string, unknown> | null =>
  u ? { id: u.id, name: u.fullName, domainName: u.domainName, email: u.email, disabled: u.isDisabled, accessMode: u.accessMode } : null;

/**
 * The value an operation replaces, so a run can be reversed by hand from the export. Every record and
 * asset in a plan is owned by the leaver and every direct report has the leaver as manager (that is how
 * the inventory selects them), so the previous value is known before anything is written. Grants to the
 * successor have no previous value: undoing one means removing it again.
 */
export function previousValue(op: PlannedOp, leaver: UserInfo): string {
  const who = `${leaver.fullName} (systemuser ${leaver.id})`;
  if (op.kind === "reassign-record" || op.kind === "reassign-asset") return `owner: ${who}`;
  if (op.kind === "manager-reassign") return `manager: ${who}`;
  if (op.kind === "role-remove" || op.kind === "profile-remove") return `held by ${who}`;
  if (op.kind === "team-remove") return `member: ${who}`;
  return "";
}

/** The confirmed plan before anything is written: one row per operation with the value it replaces. */
export function planCsv(plan: Plan, leaver: UserInfo): string {
  return csv([
    ["category", "kind", "entity", "id", "target", "detail", "call", "previous"],
    ...plan.ops.map((op) => [categoryLabel(op.category), op.kind, op.call.entity, op.call.id, op.label, op.detail, CALL_TEXT(op.call), previousValue(op, leaver)]),
  ]);
}

export function inventoryJson(inv: Inventory, environment: string | null): string {
  return JSON.stringify(
    {
      tool: "Offboarding Wizard",
      exportedAt: new Date().toISOString(),
      environment,
      leaver: { ...userOut(inv.leaver.user), businessUnit: inv.leaver.businessUnitName, manager: userOut(inv.leaver.manager) },
      takenAt: inv.takenAt,
      // Audit-relevant: whether this environment was re-sharing every reassigned record back to the
      // previous owner at the moment the offboarding ran. Null when the setting could not be read.
      environmentSettings: { shareToPreviousOwnerOnAssign: inv.orgAssign?.shareToPreviousOwnerOnAssign ?? null },
      recordScan: inv.scan
        ? {
            tablesRequested: inv.scan.requested,
            tablesScanned: inv.scan.scanned,
            cancelled: inv.scan.cancelled,
            withRecords: inv.scan.rows.map((r) => ({ table: r.table.logicalName, displayName: r.table.displayName, count: r.count, approximate: r.approximate })),
            notScanned: inv.scan.failed.map((r) => ({ table: r.table.logicalName, error: r.error })),
          }
        : null,
      categories: inv.categories.map((c) => ({
        key: c.key,
        label: c.label,
        error: c.error,
        count: c.items.length,
        items: c.items.map((i) => ({ entity: i.entity, id: i.id, label: i.label, meta: i.meta, flag: i.flag })),
      })),
      remainingManualSteps: [
        "Disable the leaver's Dataverse user (this tool never does).",
        "Release or reassign the Microsoft 365 / Power Platform licence.",
        "Re-authenticate the connections behind any reassigned connection reference.",
        "Remove the leaver from queues they were a member of.",
        "Remove the leaver as co-owner of any cloud flow that was reassigned: changing the owner adds the new owner, it does not remove the old one.",
        ...(inv.orgAssign?.shareToPreviousOwnerOnAssign === true
          ? ["Revoke the shares this environment created back to the leaver: with \"share to previous owner on assign\" enabled, every reassigned record was shared to them with full rights."]
          : []),
      ],
    },
    null,
    2,
  );
}

export function inventoryCsv(inv: Inventory): string {
  const rows: unknown[][] = [["category", "entity", "id", "label", "meta", "flag"]];
  for (const r of inv.scan?.rows ?? []) rows.push(["records", r.table.logicalName, "", r.table.displayName, `${r.count}${r.approximate ? "+" : ""} owned`, ""]);
  for (const r of inv.scan?.failed ?? []) rows.push(["records", r.table.logicalName, "", r.table.displayName, "not scanned", r.error ?? ""]);
  for (const c of inv.categories) {
    if (c.error) rows.push([c.key, "", "", c.label, "category failed", c.error]);
    for (const i of c.items) rows.push([c.key, i.entity, i.id, i.label, i.meta, i.flag ?? ""]);
  }
  return csv(rows);
}

export function resultsJson(inv: Inventory, plan: Plan, results: OpResult[], successor: UserInfo, environment: string | null): string {
  return JSON.stringify(
    {
      tool: "Offboarding Wizard",
      exportedAt: new Date().toISOString(),
      environment,
      leaver: userOut(inv.leaver.user),
      successor: userOut(successor),
      summary: { planned: plan.ops.length, applied: results.length, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length },
      warnings: plan.warnings,
      skipped: plan.skipped,
      operations: results.map((r) => ({
        category: categoryLabel(r.op.category),
        kind: r.op.kind,
        target: r.op.label,
        detail: r.op.detail,
        call: CALL_TEXT(r.op.call),
        previous: previousValue(r.op, inv.leaver.user),
        ok: r.ok,
        error: r.error,
      })),
    },
    null,
    2,
  );
}

export function resultsCsv(results: OpResult[], leaver: UserInfo): string {
  return csv([
    ["category", "kind", "target", "detail", "call", "previous", "result", "error"],
    ...results.map((r) => [categoryLabel(r.op.category), r.op.kind, r.op.label, r.op.detail, CALL_TEXT(r.op.call), previousValue(r.op, leaver), r.ok ? "ok" : "failed", r.error ?? ""]),
  ]);
}

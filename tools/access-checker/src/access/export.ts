/** JSON / CSV exports. Pure. */
import { depthLabel } from "./privileges";
import type { CheckData, ColumnAccess, Explanation, ShareEntry } from "./types";

export const safeFileName = (s: string): string => s.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "export";

const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const csv = (rows: unknown[][]): string => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

export function checkJson(d: CheckData, x: Explanation, environment: string | null): string {
  return JSON.stringify(
    {
      tool: "SSS Access Checker",
      exportedAt: new Date().toISOString(),
      environment,
      user: { id: d.user.id, name: d.user.fullName, domainName: d.user.domainName, businessUnit: d.userBu?.name ?? null, disabled: d.user.isDisabled },
      table: { logicalName: d.table.logicalName, ownership: d.table.ownership },
      record: d.record ? { id: d.record.id, name: d.record.name, owner: d.record.ownerName ?? d.record.ownerId, ownerType: d.record.ownerType, owningBusinessUnitId: d.record.owningBusinessUnitId } : null,
      roles: d.heldRoles.map((h) => ({ role: h.role.name, roleId: h.role.id, via: h.viaTeam ? `team:${h.viaTeam.name}` : "direct" })),
      teams: d.teams.map((t) => ({ id: t.id, name: t.name, type: t.type })),
      verdicts: x.verdicts.map((v) => ({
        right: v.right,
        applicable: v.applicable,
        platform: v.platform,
        platformDepth: v.platformDepth == null ? null : depthLabel(v.platformDepth),
        computed: v.computed,
        agrees: v.agrees,
        summary: v.summary,
        paths: v.paths.map((p) => ({ role: p.role.name, viaTeam: p.viaTeam?.name ?? null, depth: depthLabel(p.depth), reaches: p.reaches, reason: p.reason })),
        shares: v.sharePaths,
        hierarchyHint: v.hierarchyHint,
      })),
      ownership: x.ownership ? { ...x.ownership, owningBu: x.ownership.owningBu?.name ?? null, userBu: x.ownership.userBu?.name ?? null } : null,
      hierarchy: x.hierarchy,
      notes: x.notes,
    },
    null,
    2,
  );
}

export function sharesCsv(shares: ShareEntry[], affects: (e: ShareEntry) => string | null): string {
  return csv([["principalType", "principal", "principalId", "rights", "affectsCheckedUser"], ...shares.map((e) => [e.principalType, e.principalName ?? "", e.principalId, e.rights.join(" "), affects(e) ?? ""])]);
}

export function columnsCsv(rows: ColumnAccess[]): string {
  const via = (p: { name: string; viaTeam: { name: string } | null }[]): string => p.map((x) => (x.viaTeam ? `${x.name} (team ${x.viaTeam.name})` : x.name)).join("; ");
  return csv([["column", "displayName", "read", "update", "create", "readVia", "updateVia", "createVia"], ...rows.map((r) => [r.column.logicalName, r.column.displayName, r.read.length > 0, r.update.length > 0, r.create.length > 0, via(r.read), via(r.update), via(r.create)])]);
}

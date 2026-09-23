/** Explanation engine. Pure: data in, verdicts + reasons out. Never overrides the platform verdict. */
import { depthLabel, isSystemAdminRole, maxDepth, tablePrivilegeName } from "./privileges";
import { RIGHTS, type Applies, type BusinessUnit, type CheckData, type Depth, type Explanation, type PrivilegePath, type RightVerdict } from "./types";

/** Is `buId` equal to `baseId` or a descendant of it. */
export function isInSubtree(bus: BusinessUnit[], baseId: string | null, buId: string | null): boolean {
  if (!baseId || !buId) return false;
  const parent = new Map(bus.map((b) => [b.id, b.parentId]));
  let cur: string | null | undefined = buId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === baseId) return true;
    seen.add(cur);
    cur = parent.get(cur);
  }
  return false;
}

const buName = (bus: BusinessUnit[], id: string | null): string => (id && bus.find((b) => b.id === id)?.name) || "unknown BU";

function reach(d: CheckData, p: Pick<PrivilegePath, "depth" | "baseBuId" | "role" | "viaTeam">, userIsOwner: boolean, userInOwningTeam: boolean): { reaches: boolean; reason: string } {
  const rec = d.record!;
  const owningBu = rec.owningBusinessUnitId;
  if (d.table.ownership === "org" || d.table.ownership === "none") return { reaches: true, reason: "organization-owned table: any depth applies" };
  if (p.depth === 3) return { reaches: true, reason: "Global depth reaches every record" };
  if (p.depth === 2) {
    const ok = isInSubtree(d.businessUnits, p.baseBuId, owningBu);
    return { reaches: ok, reason: ok ? `Deep depth: record BU ${buName(d.businessUnits, owningBu)} is under ${buName(d.businessUnits, p.baseBuId)}` : `Deep depth stops at ${buName(d.businessUnits, p.baseBuId)} and its children; record is in ${buName(d.businessUnits, owningBu)}` };
  }
  if (p.depth === 1) {
    const ok = !!owningBu && owningBu === p.baseBuId;
    return { reaches: ok, reason: ok ? `Local depth: record is in the same BU (${buName(d.businessUnits, owningBu)})` : `Local depth covers only ${buName(d.businessUnits, p.baseBuId)}; record is in ${buName(d.businessUnits, owningBu)}` };
  }
  // A team role set to "Team privileges only" (isinherited = 0) gives its members Basic access to
  // records owned by that team only: not to their own records, not to other teams' records.
  if (p.viaTeam && !p.role.isInherited) {
    const ok = rec.ownerType === "team" && rec.ownerId === p.viaTeam.id;
    return {
      reaches: ok,
      reason: ok ? `Basic depth (Team privileges only): record is owned by team ${p.viaTeam.name}` : `Basic depth from a "Team privileges only" role covers only records owned by team ${p.viaTeam.name}${userIsOwner ? ", not the user's own records" : ""}`,
    };
  }
  if (userIsOwner) return { reaches: true, reason: "Basic depth: user owns the record" };
  if (userInOwningTeam) return { reaches: true, reason: "Basic depth: record is owned by a team the user belongs to" };
  return { reaches: false, reason: "Basic depth covers only records the user (or one of their teams) owns" };
}

const shareText = (viaTeam: string | null): string => (viaTeam ? `shared with team ${viaTeam}` : "shared directly with the user");

export function explain(d: CheckData): Explanation {
  const notes: string[] = [];
  const mode = d.record ? "record" : "table";
  const orgOwned = d.table.ownership === "org" || d.table.ownership === "none";
  const teamIds = new Set(d.teams.map((t) => t.id));
  const isAdmin = d.heldRoles.some((h) => isSystemAdminRole(h.role));
  if (d.user.isDisabled) notes.push("User is disabled: the platform denies everything regardless of roles.");
  if (isAdmin) notes.push("User holds System Administrator: all privileges at Global depth, column security bypassed.");
  if (!d.heldRoles.length) notes.push("User holds no security roles, directly or through teams.");
  if (d.platformRights === null && mode === "record") notes.push("RetrievePrincipalAccess failed or is unavailable; platform verdict not shown.");
  if (d.platformDepths === null && mode === "table") notes.push("RetrieveUserPrivilegeByPrivilegeName failed or is unavailable; platform depths not shown.");
  const teamBuNote = d.heldRoles.some((h) => h.viaTeam && h.viaTeam.businessUnitId && h.viaTeam.businessUnitId !== d.user.businessUnitId);
  if (teamBuNote) notes.push("Some roles come from a team in another BU: Local/Deep depth for those is evaluated against the team's BU (approximation of inherited team privileges).");
  for (const h of d.heldRoles) {
    if (!h.viaTeam && h.role.businessUnitId && d.user.businessUnitId && h.role.businessUnitId !== d.user.businessUnitId)
      notes.push(`Direct role ${h.role.name} belongs to BU ${buName(d.businessUnits, h.role.businessUnitId)} (record ownership across business units): its Local/Deep depth is evaluated against that BU, not the user's.`);
  }
  const teamOnly = d.heldRoles.filter((h) => h.viaTeam && !h.role.isInherited);
  if (teamOnly.length) notes.push(`"Team privileges only" roles (${teamOnly.map((h) => `${h.role.name} via team ${h.viaTeam!.name}`).join(", ")}): their Basic depth covers only records owned by that team, not the user's own records.`);

  // ownership
  let userIsOwner = false;
  let userInOwningTeam = false;
  let ownership: Explanation["ownership"] = null;
  const sharesForUser: Explanation["sharesForUser"] = [];
  if (d.record) {
    const rec = d.record;
    userIsOwner = rec.ownerType === "systemuser" && rec.ownerId === d.user.id;
    userInOwningTeam = rec.ownerType === "team" && !!rec.ownerId && teamIds.has(rec.ownerId);
    const owningBu = d.businessUnits.find((b) => b.id === rec.owningBusinessUnitId) ?? null;
    let relation = "n/a (organization-owned)";
    if (!orgOwned) {
      if (userIsOwner) relation = "user owns the record";
      else if (userInOwningTeam) relation = "record owned by one of the user's teams";
      else if (rec.owningBusinessUnitId && rec.owningBusinessUnitId === d.user.businessUnitId) relation = "record in the user's BU";
      else if (isInSubtree(d.businessUnits, d.user.businessUnitId, rec.owningBusinessUnitId)) relation = "record in a child BU of the user's BU";
      else relation = "record outside the user's BU subtree";
    }
    ownership = {
      ownerLabel: orgOwned ? "organization" : `${rec.ownerName ?? rec.ownerId ?? "unknown"} (${rec.ownerType ?? "?"})`,
      owningBu,
      userBu: d.userBu,
      relation,
      userIsOwner,
      userInOwningTeam,
    };
    for (const e of d.shares ?? []) {
      if (e.principalType === "systemuser" && e.principalId === d.user.id) sharesForUser.push({ entry: e, via: "direct" });
      else if (e.principalType === "team" && teamIds.has(e.principalId)) sharesForUser.push({ entry: e, via: `team ${e.principalName ?? e.principalId}` });
    }
  }

  // hierarchy
  let hierarchy: string | null = null;
  // ownerManagers is fetched at most hierarchyMaxDepth levels deep; guard again in case it was not.
  const chainLevel = d.record && d.record.ownerType === "systemuser" ? d.ownerManagers.findIndex((m) => m.id === d.user.id) : -1;
  const managerLevel = chainLevel >= 0 && chainLevel < d.hierarchyMaxDepth ? chainLevel : -1;
  if (d.record && d.hierarchyEnabled && managerLevel >= 0) {
    hierarchy = managerLevel === 0 ? "User is the owner's direct manager: hierarchy security can grant Read, Write, Append, AppendTo (not asserted here)." : `User is ${managerLevel + 1} levels above the owner (organization hierarchy depth ${d.hierarchyMaxDepth}): hierarchy security can grant Read (not asserted here).`;
  } else if (d.record && d.hierarchyEnabled === false && managerLevel >= 0) hierarchy = "User is above the owner in the manager chain, but hierarchy security is off for this organization.";
  else if (d.record && d.hierarchyEnabled === null) hierarchy = "Hierarchy security state unknown (organization setting not readable).";

  // verdicts
  const verdicts: RightVerdict[] = RIGHTS.map((right) => {
    const applicable = !(orgOwned && (right === "Assign" || right === "Share"));
    const prv = tablePrivilegeName(d.tablePrivileges, right, d.table.logicalName);
    const prvLabel = d.tablePrivileges[right] ?? prv ?? `${right} privilege`;
    const paths: PrivilegePath[] = [];
    let bestDepth: Depth | null = null;
    for (const h of d.heldRoles) {
      const depth = prv ? d.rolePrivileges[h.role.id]?.[prv] : undefined;
      if (depth == null) continue;
      bestDepth = maxDepth(bestDepth, depth);
      // Team role: the team's BU. Direct role: the role's own BU, which differs from the user's BU when
      // record ownership across business units (modernized BUs) assigns a role from another BU.
      const baseBuId = h.viaTeam ? (h.viaTeam.businessUnitId ?? h.role.businessUnitId ?? d.user.businessUnitId) : (h.role.businessUnitId ?? d.user.businessUnitId);
      const p: PrivilegePath = { role: h.role, viaTeam: h.viaTeam, depth, baseBuId, reaches: null, reason: `${depthLabel(depth)} depth` };
      if (d.record) {
        const r = reach(d, p, userIsOwner, userInOwningTeam);
        p.reaches = r.reaches;
        p.reason = r.reason;
      }
      paths.push(p);
    }
    paths.sort((a, b) => Number(b.reaches) - Number(a.reaches) || b.depth - a.depth);
    const sharePaths = sharesForUser.filter((x) => x.entry.rights.includes(right)).map((x) => shareText(x.via === "direct" ? null : x.via.replace(/^team /, "")));
    // A share only takes effect once the privilege check passes: the user must hold the privilege at
    // some depth (Basic or more) through a role, direct or via a team. Without it the share is ignored.
    const sharesEffective = !sharePaths.length || bestDepth != null;

    let computed: Applies = "n/a";
    let summary = "not applicable on an organization-owned table";
    let hierarchyHint: string | null = null;
    if (applicable) {
      if (mode === "table") {
        computed = bestDepth != null ? "yes" : "no";
        summary = bestDepth != null ? `${depthLabel(bestDepth)} via ${paths.filter((p) => p.depth === bestDepth).map((p) => (p.viaTeam ? `${p.role.name} (team ${p.viaTeam.name})` : p.role.name)).join(", ")}` : "no role grants this privilege";
      } else {
        const winner = paths.find((p) => p.reaches);
        if (winner) {
          computed = "yes";
          summary = `${winner.role.name}${winner.viaTeam ? ` via team ${winner.viaTeam.name}` : ""}: ${winner.reason}`;
        } else if (sharePaths.length && sharesEffective) {
          computed = "yes";
          summary = `${sharePaths[0]} (user holds ${prvLabel} at ${depthLabel(bestDepth)}, which a share requires)`;
        } else if (sharePaths.length) {
          computed = "no";
          summary = `${sharePaths[0]}, but no role grants ${prvLabel}: a share only takes effect when the user holds the privilege at Basic depth or more through a role`;
        } else {
          computed = "no";
          summary = paths.length ? `${paths[0].role.name}${paths[0].viaTeam ? ` via team ${paths[0].viaTeam.name}` : ""}: ${paths[0].reason}` : "no role grants this privilege and no share applies";
          if (hierarchy && d.hierarchyEnabled && (right === "Read" || (managerLevel === 0 && ["Write", "Append", "AppendTo"].includes(right)))) hierarchyHint = "possible via manager hierarchy";
        }
      }
      if (d.user.isDisabled) computed = "no";
    }

    let platform: Applies = "n/a";
    let platformDepth: Depth | null = null;
    if (applicable) {
      if (mode === "record") platform = d.platformRights ? (d.platformRights.includes(right) ? "yes" : "no") : "n/a";
      else {
        platformDepth = d.platformDepths && prv ? (d.platformDepths[prv] ?? null) : null;
        platform = d.platformDepths ? (platformDepth != null ? "yes" : "no") : "n/a";
      }
    }
    const agrees = applicable && platform !== "n/a" ? platform === computed : null;
    return { right, applicable, computed, platform, platformDepth, bestDepth, paths, sharePaths, sharesEffective, hierarchyHint, summary, agrees };
  });

  if (verdicts.some((v) => v.agrees === false)) notes.push("Platform verdict differs from the tool's explanation for at least one right: access teams, inherited privileges, hierarchy or a disabled user are the usual causes. Trust the platform.");
  return { mode, verdicts, ownership, sharesForUser, hierarchy, notes };
}

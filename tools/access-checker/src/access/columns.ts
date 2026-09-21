/** Column security: secured columns × effective read / update / create for the user, with the granting profile(s). Pure. */
import type { ColumnAccess, FieldPermission, FieldProfile, SecuredColumn } from "./types";

export function columnAccess(columns: SecuredColumn[], profiles: FieldProfile[], permissions: FieldPermission[], isAdmin: boolean): ColumnAccess[] {
  const byId = new Map<string, FieldProfile[]>();
  for (const p of profiles) byId.set(p.id, [...(byId.get(p.id) ?? []), p]);
  return columns.map((column) => {
    const rows = permissions.filter((p) => p.attribute === column.logicalName);
    const grants = (pick: (p: FieldPermission) => boolean): FieldProfile[] => {
      const out: FieldProfile[] = [];
      for (const r of rows) if (pick(r)) out.push(...(byId.get(r.profileId) ?? []));
      if (isAdmin) out.push({ id: "sysadmin", name: "System Administrator (bypasses column security)", viaTeam: null });
      return out;
    };
    return { column, read: grants((p) => p.canRead), update: grants((p) => p.canUpdate), create: grants((p) => p.canCreate) };
  });
}

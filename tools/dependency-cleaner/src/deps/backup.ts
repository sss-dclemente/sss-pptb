/**
 * Backup (D5) and restore. Form XML edits cannot be undone through the platform, so the original
 * formxml / fetchxml / layoutxml and the full solution membership are saved before any write.
 */
import { fetchComponents, fetchForms, fetchViews, type DataverseLike, type FormRecord, type ViewRecord } from "./fetch";
import { CT, type Diagnosis, type SolutionInfo } from "./types";
import { opLabel, type Op, type Prepared } from "./write";

export const BACKUP_KIND = "sss-dependency-cleaner-backup";

export interface BackupMember {
  objectId: string;
  type: number;
  behavior: number | null;
  /** objectid of the root row (row ids change when a component is re-added) */
  rootObjectId: string | null;
  name: string;
}

export interface Backup {
  kind: typeof BACKUP_KIND;
  version: 1;
  takenAt: string;
  environment: { name: string; url: string };
  solution: { id: string; uniqueName: string; friendlyName: string };
  membership: BackupMember[];
  forms: FormRecord[];
  views: ViewRecord[];
  /** human-readable list of the operations the backup was taken for */
  operations: string[];
}

export function buildBackup(d: Diagnosis, p: Prepared, ops: Op[]): Backup {
  const byRow = new Map(d.components.map((c) => [c.rowId, c]));
  return {
    kind: BACKUP_KIND,
    version: 1,
    takenAt: new Date().toISOString(),
    environment: { name: d.environment.name, url: d.environment.url },
    solution: { id: d.solution.id, uniqueName: d.solution.uniqueName, friendlyName: d.solution.friendlyName },
    membership: d.components.map((c) => ({
      objectId: c.objectId,
      type: c.type,
      behavior: c.behavior,
      rootObjectId: c.rootRowId ? (byRow.get(c.rootRowId)?.objectId ?? null) : null,
      name: c.name ?? c.objectId,
    })),
    forms: p.forms.map((f) => f.form),
    views: p.views.map((v) => v.view),
    operations: ops.map(opLabel),
  };
}

export function backupFileName(solution: string, at = new Date()): string {
  const ts = at.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `dependency-cleaner-backup-${solution.replace(/[^a-z0-9._-]+/gi, "_")}-${ts}.json`;
}

export function parseBackup(text: string): Backup {
  let o: Partial<Backup>;
  try {
    o = JSON.parse(text) as Partial<Backup>;
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (o?.kind !== BACKUP_KIND) throw new Error("not a Dependency Cleaner backup");
  if (o.version !== 1) throw new Error(`unsupported backup version ${String(o.version)}`);
  if (!o.solution?.uniqueName || !Array.isArray(o.membership) || !Array.isArray(o.forms) || !Array.isArray(o.views)) throw new Error("backup is incomplete");
  return o as Backup;
}

export interface RestorePlan {
  solution: SolutionInfo;
  ops: Op[];
  notes: string[];
}

/** Compare the backup to the environment now and list what puts it back. Refuses managed or missing solutions (D7). */
export async function planRestore(api: DataverseLike, b: Backup, solutions: SolutionInfo[], envUrl: string): Promise<RestorePlan> {
  const sol = solutions.find((s) => s.uniqueName.toLowerCase() === b.solution.uniqueName.toLowerCase());
  if (!sol) throw new Error(`solution ${b.solution.uniqueName} is not in this environment`);
  if (sol.isManaged) throw new Error(`solution ${sol.uniqueName} is managed: writes are refused`);
  const notes: string[] = [];
  if (b.environment.url && envUrl && b.environment.url.replace(/\/+$/, "").toLowerCase() !== envUrl.replace(/\/+$/, "").toLowerCase())
    notes.push(`Backup was taken in ${b.environment.name} (${b.environment.url}), not this environment.`);

  const current = await fetchComponents(api, sol.id);
  const key = (type: number, id: string) => `${type}:${id}`;
  const cur = new Map(current.map((c) => [key(c.type, c.objectId), c]));
  const ops: Op[] = [];
  const allAssetsAgain = new Set<string>();

  for (const m of b.membership.filter((x) => !x.rootObjectId || x.rootObjectId === x.objectId)) {
    const now = cur.get(key(m.type, m.objectId));
    const comp = { type: m.type, id: m.objectId, name: m.name };
    if (!now) {
      ops.push({ kind: "add", component: comp, doNotIncludeSubcomponents: m.behavior !== 0, reason: "re-add removed component" });
      if (m.type === CT.Entity && m.behavior === 0) allAssetsAgain.add(m.objectId);
    } else if (m.type === CT.Entity && m.behavior === 0 && now.behavior !== 0) {
      ops.push({ kind: "remove", component: comp, reason: "shell → back to all assets" });
      ops.push({ kind: "add", component: comp, doNotIncludeSubcomponents: false, reason: "re-add with all subcomponents" });
      allAssetsAgain.add(m.objectId);
    }
  }
  for (const m of b.membership.filter((x) => x.rootObjectId && x.rootObjectId !== x.objectId)) {
    if (cur.has(key(m.type, m.objectId)) || allAssetsAgain.has(m.rootObjectId!)) continue;
    ops.push({ kind: "add", component: { type: m.type, id: m.objectId, name: m.name }, doNotIncludeSubcomponents: false, reason: "re-add removed subcomponent" });
  }

  const [forms, views] = await Promise.all([
    b.forms.length ? fetchForms(api, b.forms.map((f) => f.id)) : Promise.resolve([] as FormRecord[]),
    b.views.length ? fetchViews(api, b.views.map((v) => v.id)) : Promise.resolve([] as ViewRecord[]),
  ]);
  const tables = new Set<string>();
  for (const f of b.forms) {
    const now = forms.find((x) => x.id === f.id);
    if (!now) {
      notes.push(`Form ${f.name} no longer exists; not restored.`);
      continue;
    }
    if (now.formxml === f.formxml) continue;
    ops.push({ kind: "update-form", edit: { form: now, after: f.formxml, removed: [], kept: [], warnings: [] } });
    tables.add(now.table || f.table);
  }
  for (const v of b.views) {
    const now = views.find((x) => x.id === v.id);
    if (!now) {
      notes.push(`View ${v.name} no longer exists; not restored.`);
      continue;
    }
    if (now.fetchxml === v.fetchxml && now.layoutxml === v.layoutxml) continue;
    ops.push({ kind: "update-view", edit: { view: now, after: { fetchxml: v.fetchxml, layoutxml: v.layoutxml }, removed: [], warnings: [] } });
    tables.add(now.table || v.table);
  }
  if (tables.size) ops.push({ kind: "publish", tables: [...tables].filter(Boolean).sort() });
  return { solution: sol, ops, notes };
}

/** Packages per environment → app × environment matrix (plan §2), selection → install plan. */
import { compareVersions } from "./api";
import type { Cell, EnvPackages, Environment, Matrix, Package, PlannedInstall, Row } from "./types";

const BUSY = new Set(["installing", "installrequested", "installscheduled", "installretrying", "uninstalling", "uninstallrequested"]);
const lower = (s: string) => s.toLowerCase();
export const cellKey = (envId: string, uniqueName: string): string => `${envId}|${lower(uniqueName)}`;

/** Highest version per unique name. */
function newest(list: Package[]): Map<string, Package> {
  const out = new Map<string, Package>();
  for (const p of list) {
    const k = lower(p.uniqueName);
    const cur = out.get(k);
    if (!cur || compareVersions(p.version, cur.version) > 0) out.set(k, p);
  }
  return out;
}

export function cellFor(installed: Package | undefined, available: Package | undefined): Cell {
  if (installed) {
    const s = lower(installed.state);
    if (s.endsWith("failed")) return { kind: "failed", installed, target: available ?? installed, action: "retry", note: installed.error ?? installed.state };
    if (BUSY.has(s)) return { kind: "busy", installed, target: null, action: null, note: installed.state };
    if (s !== "uninstalled") {
      if (available && compareVersions(available.version, installed.version) > 0) return { kind: "update", installed, target: available, action: "update", note: available.customHandleUpgrade || installed.customHandleUpgrade ? "custom upgrade" : null };
      return { kind: "current", installed, target: null, action: null, note: null };
    }
  }
  if (available) return { kind: "available", installed: null, target: available, action: "install", note: null };
  return { kind: "absent", installed: null, target: null, action: null, note: null };
}

export function buildMatrix(results: EnvPackages[], opts: { showNotInstalled: boolean }): Matrix {
  const envs = results.map((r) => r.env);
  const errors = new Map(results.filter((r) => r.error).map((r) => [r.env.id, r.error!]));
  const perEnv = new Map(
    results.map((r) => [
      r.env.id,
      {
        installed: new Map(r.installed.map((p) => [lower(p.uniqueName), p])),
        available: newest(r.available),
      },
    ]),
  );
  const names = new Map<string, Package>();
  for (const r of results) for (const p of r.installed) if (lower(p.state) !== "uninstalled" && !names.has(lower(p.uniqueName))) names.set(lower(p.uniqueName), p);
  if (opts.showNotInstalled) for (const r of results) for (const p of r.available) if (!names.has(lower(p.uniqueName))) names.set(lower(p.uniqueName), p);

  const rows: Row[] = [...names.entries()].map(([k, first]) => {
    const cells = new Map<string, Cell>();
    let custom = false;
    for (const env of envs) {
      const e = perEnv.get(env.id)!;
      const c = cellFor(e.installed.get(k), e.available.get(k));
      custom ||= !!(c.installed?.customHandleUpgrade || c.target?.customHandleUpgrade);
      cells.set(env.id, c);
    }
    return { uniqueName: first.uniqueName, name: first.name, publisher: first.publisher, customHandleUpgrade: custom, cells };
  });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return { envs, rows, errors };
}

/** Cells "Select all updates" ticks: updates, except custom-upgrade packages (plan D8). */
export function updateKeys(m: Matrix): string[] {
  const out: string[] = [];
  for (const r of m.rows) for (const env of m.envs) if (r.cells.get(env.id)?.kind === "update" && !r.customHandleUpgrade) out.push(cellKey(env.id, r.uniqueName));
  return out;
}

/** Selection → installs, per environment in matrix column order, apps in row order. Cells without an action are skipped. */
export function planInstalls(m: Matrix, selected: Set<string>): PlannedInstall[] {
  const out: PlannedInstall[] = [];
  for (const env of m.envs)
    for (const r of m.rows) {
      if (!selected.has(cellKey(env.id, r.uniqueName))) continue;
      const c = r.cells.get(env.id);
      if (!c?.action) continue;
      out.push({ env, uniqueName: r.uniqueName, name: r.name, action: c.action, from: c.installed?.version ?? null, to: c.target?.version ?? null, customHandleUpgrade: r.customHandleUpgrade });
    }
  return out;
}

export const isProduction = (e: Environment): boolean => /production/i.test(e.type);

/** Row counts for the summary line. */
export function counts(m: Matrix): { updates: number; failed: number; busy: number } {
  let updates = 0;
  let failed = 0;
  let busy = 0;
  for (const r of m.rows)
    for (const c of r.cells.values()) {
      if (c.kind === "update") updates++;
      if (c.kind === "failed") failed++;
      if (c.kind === "busy") busy++;
    }
  return { updates, failed, busy };
}

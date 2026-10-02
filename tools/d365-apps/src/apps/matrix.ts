/** Packages per environment → app × environment matrix (plan §2), selection → install plan. */
import { compareVersions } from "./api";
import type { Cell, CellKind, EnvPackages, Environment, Matrix, Package, PlannedInstall, Row } from "./types";

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

/** Cells "Select all updates" ticks: updates, except custom-upgrade packages (plan D8). Rows the filter hides and hidden environment columns are included only when `visible` allows them. */
export function updateKeys(m: Matrix, visible: (uniqueName: string, envId: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const r of m.rows) for (const env of m.envs) if (visible(r.uniqueName, env.id) && r.cells.get(env.id)?.kind === "update" && !r.customHandleUpgrade) out.push(cellKey(env.id, r.uniqueName));
  return out;
}

/** Cells "Select all failed" ticks: every failed install, for a retry. Rows the filter hides and hidden environment columns are included only when `visible` allows them. */
export function failedKeys(m: Matrix, visible: (uniqueName: string, envId: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const r of m.rows) for (const env of m.envs) if (visible(r.uniqueName, env.id) && r.cells.get(env.id)?.kind === "failed") out.push(cellKey(env.id, r.uniqueName));
  return out;
}

/** Cell kinds that mean "something is installed here" (installed, update, failed, in progress); "available" and "—" do not. */
const HAS_APP = new Set<CellKind>(["current", "update", "failed", "busy"]);

/** Environments with nothing installed in any row ("Hide empty environments"). Unreadable environments are never empty: their error header matters. */
export function emptyEnvIds(m: Matrix): Set<string> {
  const out = new Set<string>();
  for (const env of m.envs) if (!m.errors.has(env.id) && !m.rows.some((r) => HAS_APP.has(r.cells.get(env.id)?.kind ?? "absent"))) out.add(env.id);
  return out;
}

/** The environment columns the matrix shows, in column order: not hidden with ✕, and not empty while `hideEmpty`. */
export function visibleEnvs(m: Matrix, hidden: ReadonlySet<string>, hideEmpty: boolean): Environment[] {
  const empty = hideEmpty ? emptyEnvIds(m) : new Set<string>();
  return m.envs.filter((e) => !hidden.has(e.id) && !empty.has(e.id));
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

/** The summary badges that filter rows by state: update available, failed install, install in progress. */
export type StateKind = Extract<CellKind, "update" | "failed" | "busy">;
export const STATE_KINDS: readonly StateKind[] = ["update", "failed", "busy"];

/** True when the row has any of `states` in one of the `cols` environment columns (the pressed badges combine as OR). */
export const rowHasState = (r: Row, states: ReadonlySet<CellKind>, cols: ReadonlySet<string>): boolean => [...r.cells].some(([id, c]) => cols.has(id) && states.has(c.kind));

/** Cell counts for the summary line; only the `cols` environment columns when given (the shown ones). */
export function counts(m: Matrix, cols?: ReadonlySet<string>): { updates: number; failed: number; busy: number } {
  let updates = 0;
  let failed = 0;
  let busy = 0;
  for (const r of m.rows)
    for (const [id, c] of r.cells) {
      if (cols && !cols.has(id)) continue;
      if (c.kind === "update") updates++;
      if (c.kind === "failed") failed++;
      if (c.kind === "busy") busy++;
    }
  return { updates, failed, busy };
}

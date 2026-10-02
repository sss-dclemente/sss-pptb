/**
 * "Unused apps" report (read-only), for the connection's environment. See docs/D365-APPS-PLAN.md §7–8.
 *
 * package → solutions:  msdyn_solutionhistories (Import rows carry msdyn_packagename) ∩ installed managed solutions,
 *                       plus the anchor solution whose uniquename is the package's uniqueName.
 * solution → tables:    solutioncomponents type 1 (objectid = EntityMetadata.MetadataId) → EntityDefinitions.
 * solution → apps:      solutioncomponents type 80 (objectid = appmoduleid) → appmodules + appmoduleroles_association.
 * table → rows:         RetrieveTotalRecordCount (snapshot < 24 h), every 0 / missing double-checked with $top=1.
 *
 * Only solutions and tables that belong to ONE installed package decide its verdict: a table shared with another
 * package can hold that package's data. No usage telemetry is reachable, so the best verdict is "probably unused".
 */
import type { Package } from "./types";

type Row = Record<string, unknown>;

export interface DvLike {
  queryData: (q: string) => Promise<unknown>;
}

export interface SolutionRef {
  id: string;
  uniqueName: string;
  name: string;
  version: string | null;
}

export interface TableUse {
  logicalName: string;
  entitySet: string;
  /** null = could not be counted */
  rows: number | null;
  /** true when `rows` is a lower bound (snapshot said 0 / nothing, $top=1 found a row) */
  atLeast: boolean;
}

export interface AppUse {
  id: string;
  name: string;
  uniqueName: string | null;
  /** security roles the app is shared with; null when the roles could not be read */
  roles: number | null;
}

export type Verdict = "unused" | "light" | "in-use" | "no-signal" | "platform" | "not-found";

export interface PackageUse {
  pkg: Package;
  verdict: Verdict;
  /** how the solutions were found */
  mappedBy: "history" | "anchor" | "history+anchor" | null;
  /** solutions only this package installed */
  solutions: SolutionRef[];
  /** solutions other installed packages also brought in (not used for the verdict) */
  shared: SolutionRef[];
  /** tables only this package's solutions contain (decide the verdict) */
  tables: TableUse[];
  /** tables also in another package's solutions (listed, not counted) */
  sharedTables: string[];
  apps: AppUse[];
  /** rows across `tables` (lower bound when some are `atLeast`) */
  rows: number;
}

export interface UnusedReport {
  packages: PackageUse[];
  /** false when msdyn_solutionhistories could not be read: only anchors were mapped */
  history: boolean;
  /** reads that failed but did not stop the report */
  warnings: string[];
}

/**
 * Auto-installed platform packages: removing them is refused ("restricted solution") or they come back.
 * Seen on a real tenant 2026-10-02 (docs/D365-APPS-PLAN.md §6).
 */
export const PLATFORM_PACKAGES = new Set(
  [
    "msdyn_PowerAppsCheckerAnchor",
    "msdyn_FlowApprovals",
    "msdyn_AppDeploymentAnchor",
    "msdyn_AISolutionAnchor",
    "msdyn_ContextualHelpAnchor",
    "msdyn_AppProfileManagerAnchor",
    "DataverseAccelerator_Anchor",
    "MicrosoftDataflowAnchor",
    "PowerAppsSharePointIntegrationApp_Anchor",
    "PowerPlatformEnvironmentSettingsApp_Anchor",
    "PowerPlatformAppAgentsApp_Anchor",
    "PowerAppsUXAgentApp_Anchor",
    "MCPPlatform_Anchor",
    "DataValidationApp_Anchor",
  ].map((s) => s.toLowerCase()),
);

/** A table whose largest row count is at most this is "light": install-time seed or configuration data. */
export const LIGHT_MAX_ROWS = 10;
const OR_CHUNK = 20;
const COUNT_CHUNK = 50;
const CONCURRENCY = 4;
const MAX_PAGES = 200;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const lid = (v: unknown): string => String(v ?? "").toLowerCase();
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guid = (v: string): string => {
  if (!GUID.test(v)) throw new Error(`not a guid: ${v}`);
  return v;
};
const NAME = /^[a-z0-9_]+$/i;

function relativeNextLink(link: string): string {
  const m = link.match(/\/api\/data\/v\d+(?:\.\d+)*\/(.*)$/i);
  return m ? m[1] : link;
}

export async function queryAll(dv: DvLike, q: string): Promise<Row[]> {
  const out: Row[] = [];
  const seen = new Set<string>();
  let next: string | null = q;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const r = ((await dv.queryData(next)) ?? {}) as { value?: Row[]; "@odata.nextLink"?: string };
    if (Array.isArray(r.value)) out.push(...r.value);
    const link = str(r["@odata.nextLink"]);
    next = link ? relativeNextLink(link) : null;
    if (next && seen.has(next)) throw new Error(`paging loop at ${next}`);
    if (next) seen.add(next);
  }
  return out;
}

async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) await fn(x);
  }));
}

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const orFilter = (field: string, ids: string[]) => ids.map((id) => `${field} eq ${guid(id)}`).join(" or ");

// ---------- package → solutions ----------

/** packagename (lower) → solution uniquenames (lower) from successful or unknown-result Import rows. */
export function historyMap(rows: Row[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const op = r.msdyn_operation;
    if (op !== undefined && op !== null && Number(op) !== 0) continue;
    if (r.msdyn_result === false) continue;
    const pkgName = str(r.msdyn_packagename);
    const sol = str(r.msdyn_name);
    if (!pkgName || !sol) continue;
    const k = pkgName.toLowerCase();
    if (!out.has(k)) out.set(k, new Set());
    out.get(k)!.add(sol.toLowerCase());
  }
  return out;
}

export interface Mapping {
  /** package uniqueName (lower) → solution uniquenames (lower), only solutions installed now */
  byPackage: Map<string, Set<string>>;
  mappedBy: Map<string, PackageUse["mappedBy"]>;
  /** solution uniquename (lower) → packages (lower) that brought it in */
  owners: Map<string, Set<string>>;
}

export function mapPackages(packages: Package[], solutions: Map<string, SolutionRef>, history: Map<string, Set<string>>): Mapping {
  const byPackage = new Map<string, Set<string>>();
  const mappedBy = new Map<string, PackageUse["mappedBy"]>();
  const owners = new Map<string, Set<string>>();
  for (const p of packages) {
    const k = p.uniqueName.toLowerCase();
    const set = new Set<string>();
    const fromHistory = [...(history.get(k) ?? [])].filter((s) => solutions.has(s));
    fromHistory.forEach((s) => set.add(s));
    const anchor = solutions.has(k);
    if (anchor) set.add(k);
    byPackage.set(k, set);
    mappedBy.set(k, fromHistory.length && anchor ? "history+anchor" : fromHistory.length ? "history" : anchor ? "anchor" : null);
    for (const s of set) {
      if (!owners.has(s)) owners.set(s, new Set());
      owners.get(s)!.add(k);
    }
  }
  return { byPackage, mappedBy, owners };
}

// ---------- verdict ----------

export function verdictFor(pkg: Package, mapped: boolean, tables: TableUse[]): Verdict {
  if (PLATFORM_PACKAGES.has(pkg.uniqueName.toLowerCase())) return "platform";
  if (!mapped) return "not-found";
  const counted = tables.filter((t) => t.rows !== null);
  if (!counted.length) return "no-signal";
  // a row the < 24 h snapshot did not count yet was written recently: in use
  if (counted.some((t) => t.atLeast)) return "in-use";
  const max = Math.max(...counted.map((t) => t.rows!));
  if (max === 0) return "unused";
  if (max <= LIGHT_MAX_ROWS) return "light";
  return "in-use";
}

// ---------- record counts ----------

/** RetrieveTotalRecordCount: `{ EntityRecordCountCollection: { Keys: [...], Values: [...] } }` (or a plain map). */
export function parseCounts(body: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const c = ((body ?? {}) as Row).EntityRecordCountCollection as Row | undefined;
  if (c && Array.isArray(c.Keys) && Array.isArray(c.Values)) {
    c.Keys.forEach((k, i) => {
      const n = Number((c.Values as unknown[])[i]);
      if (typeof k === "string" && Number.isFinite(n)) out.set(k.toLowerCase(), n);
    });
  } else if (c && typeof c === "object") {
    for (const [k, v] of Object.entries(c)) if (Number.isFinite(Number(v)) && !k.startsWith("@")) out.set(k.toLowerCase(), Number(v));
  }
  return out;
}

export const countPath = (names: string[]): string => `RetrieveTotalRecordCount(EntityNames=@p1)?@p1=${encodeURIComponent(JSON.stringify(names))}`;

// ---------- run ----------

export interface AnalyzeOptions {
  dv: DvLike;
  installed: Package[];
  onProgress?: (msg: string) => void;
}

interface EntityDef {
  logicalName: string;
  entitySet: string;
  primaryId: string;
}

export async function analyzeUnused(o: AnalyzeOptions): Promise<UnusedReport> {
  const { dv } = o;
  const say = o.onProgress ?? (() => undefined);
  const warnings: string[] = [];
  const packages = o.installed.filter((p) => p.state === "" || /^(installed|none)$/i.test(p.state) || /failed$/i.test(p.state));

  say("Reading solutions…");
  const solRows = await queryAll(dv, "solutions?$select=solutionid,uniquename,friendlyname,version&$filter=ismanaged eq true and isvisible eq true");
  const solutions = new Map<string, SolutionRef>();
  for (const r of solRows) {
    const u = str(r.uniquename);
    if (u) solutions.set(u.toLowerCase(), { id: lid(r.solutionid), uniqueName: u, name: str(r.friendlyname) ?? u, version: str(r.version) });
  }

  say("Reading solution history…");
  let history = true;
  let histRows: Row[] = [];
  try {
    histRows = await queryAll(dv, "msdyn_solutionhistories?$select=msdyn_name,msdyn_packagename,msdyn_operation,msdyn_result&$filter=msdyn_operation eq 0 and msdyn_packagename ne null");
  } catch (e) {
    try {
      // virtual table: some filters are not supported by its provider; filter here instead
      histRows = await queryAll(dv, "msdyn_solutionhistories?$select=msdyn_name,msdyn_packagename,msdyn_operation,msdyn_result");
    } catch (e2) {
      history = false;
      warnings.push(`Solution history unreadable (${(e2 as Error)?.message ?? e2}); only anchor solutions were mapped.`);
    }
  }
  const map = mapPackages(packages, solutions, historyMap(histRows));

  // components of every mapped solution
  const mappedIds = [...new Set([...map.owners.keys()].map((s) => solutions.get(s)!.id))];
  const comps: Row[] = [];
  say(`Reading components of ${mappedIds.length} solutions…`);
  await pool(chunks(mappedIds, OR_CHUNK), CONCURRENCY, async (ids) => {
    comps.push(...(await queryAll(dv, `solutioncomponents?$select=objectid,componenttype,_solutionid_value&$filter=(componenttype eq 1 or componenttype eq 80) and (${orFilter("_solutionid_value", ids)})`)));
  });
  const solById = new Map([...solutions.values()].map((s) => [s.id, s]));
  /** table/app objectid → packages (lower) whose solutions contain it */
  const compOwners = new Map<string, Set<string>>();
  const compType = new Map<string, number>();
  for (const c of comps) {
    const sol = solById.get(lid(c._solutionid_value));
    const id = lid(c.objectid);
    if (!sol || !id) continue;
    compType.set(id, Number(c.componenttype));
    if (!compOwners.has(id)) compOwners.set(id, new Set());
    for (const p of map.owners.get(sol.uniqueName.toLowerCase()) ?? []) compOwners.get(id)!.add(p);
  }
  const solComps = new Map<string, Set<string>>();
  for (const c of comps) {
    const s = lid(c._solutionid_value);
    if (!solComps.has(s)) solComps.set(s, new Set());
    solComps.get(s)!.add(lid(c.objectid));
  }

  // tables: custom, not intersect, not virtual
  say("Reading table definitions…");
  const defs = new Map<string, EntityDef>();
  const tableIds = [...compType].filter(([, t]) => t === 1).map(([id]) => id);
  if (tableIds.length) {
    const rows = await queryAll(dv, "EntityDefinitions?$select=MetadataId,LogicalName,EntitySetName,PrimaryIdAttribute,IsCustomEntity,IsIntersect,TableType");
    for (const r of rows) {
      const id = lid(r.MetadataId);
      if (!compType.has(id)) continue;
      if (r.IsCustomEntity !== true || r.IsIntersect === true || /^virtual$/i.test(String(r.TableType ?? ""))) continue;
      const ln = str(r.LogicalName);
      const set = str(r.EntitySetName);
      const pk = str(r.PrimaryIdAttribute);
      if (ln && set && pk && NAME.test(ln) && NAME.test(set) && NAME.test(pk)) defs.set(id, { logicalName: ln, entitySet: set, primaryId: pk });
    }
  }

  // which tables decide a verdict: in exactly one package
  const exclusive = new Map<string, string>(); // table metadataid → package
  for (const [id, owners] of compOwners) if (defs.has(id) && owners.size === 1) exclusive.set(id, [...owners][0]);

  // counts
  const counts = new Map<string, TableUse>();
  const toCount = [...new Set(exclusive.keys())].map((id) => defs.get(id)!);
  say(`Counting rows in ${toCount.length} tables…`);
  const snap = new Map<string, number>();
  await pool(chunks(toCount.map((d) => d.logicalName), COUNT_CHUNK), CONCURRENCY, async (names) => {
    try {
      for (const [k, v] of parseCounts(await dv.queryData(countPath(names)))) snap.set(k, v);
    } catch (e) {
      warnings.push(`Record count failed for ${names.length} tables (${(e as Error)?.message ?? e}); checked one by one.`);
    }
  });
  await pool(toCount, CONCURRENCY, async (d) => {
    const n = snap.get(d.logicalName.toLowerCase());
    if (n !== undefined && n > 0) {
      counts.set(d.logicalName, { logicalName: d.logicalName, entitySet: d.entitySet, rows: n, atLeast: false });
      return;
    }
    try {
      const r = (await dv.queryData(`${d.entitySet}?$select=${d.primaryId}&$top=1`)) as { value?: unknown[] };
      const has = Array.isArray(r?.value) && r.value.length > 0;
      counts.set(d.logicalName, { logicalName: d.logicalName, entitySet: d.entitySet, rows: has ? 1 : 0, atLeast: has });
    } catch {
      counts.set(d.logicalName, { logicalName: d.logicalName, entitySet: d.entitySet, rows: null, atLeast: false });
    }
  });

  // model-driven apps, exclusive to one package
  const appIds = [...compOwners].filter(([id, owners]) => compType.get(id) === 80 && owners.size === 1).map(([id]) => id);
  const apps = new Map<string, AppUse>();
  if (appIds.length) {
    say(`Reading ${appIds.length} model-driven apps…`);
    await pool(chunks(appIds, OR_CHUNK), CONCURRENCY, async (ids) => {
      let rows: Row[];
      let withRoles = true;
      try {
        rows = await queryAll(dv, `appmodules?$select=appmoduleid,name,uniquename&$filter=${orFilter("appmoduleid", ids)}&$expand=appmoduleroles_association($select=roleid)`);
      } catch {
        withRoles = false;
        rows = await queryAll(dv, `appmodules?$select=appmoduleid,name,uniquename&$filter=${orFilter("appmoduleid", ids)}`).catch(() => []);
      }
      for (const r of rows) {
        const id = lid(r.appmoduleid);
        const roles = r.appmoduleroles_association;
        apps.set(id, { id, name: str(r.name) ?? id, uniqueName: str(r.uniquename), roles: withRoles && Array.isArray(roles) ? roles.length : null });
      }
    });
  }

  const out: PackageUse[] = packages.map((pkg) => {
    const k = pkg.uniqueName.toLowerCase();
    const sols = [...(map.byPackage.get(k) ?? [])].map((s) => solutions.get(s)!);
    const own = sols.filter((s) => map.owners.get(s.uniqueName.toLowerCase())!.size === 1);
    const shared = sols.filter((s) => map.owners.get(s.uniqueName.toLowerCase())!.size > 1);
    const ids = new Set(sols.flatMap((s) => [...(solComps.get(s.id) ?? [])]));
    const tables = [...ids].filter((id) => exclusive.get(id) === k).map((id) => counts.get(defs.get(id)!.logicalName)!).filter(Boolean).sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1) || a.logicalName.localeCompare(b.logicalName));
    const sharedTables = [...ids].filter((id) => defs.has(id) && (compOwners.get(id)?.size ?? 0) > 1).map((id) => defs.get(id)!.logicalName).sort();
    const pkgApps = [...ids].map((id) => apps.get(id)).filter((a): a is AppUse => !!a && compOwners.get(a.id)?.size === 1);
    const verdict = verdictFor(pkg, sols.length > 0, tables);
    return {
      pkg,
      verdict,
      mappedBy: map.mappedBy.get(k) ?? null,
      solutions: own,
      shared,
      tables,
      sharedTables,
      apps: pkgApps,
      rows: tables.reduce((n, t) => n + (t.rows ?? 0), 0),
    };
  });
  const rank: Record<Verdict, number> = { unused: 0, light: 1, "no-signal": 2, "in-use": 3, "not-found": 4, platform: 5 };
  out.sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.pkg.name.localeCompare(b.pkg.name));
  return { packages: out, history, warnings };
}

// ---------- export ----------

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n;]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s;
};

export const VERDICT_LABEL: Record<Verdict, string> = {
  unused: "Probably unused",
  light: "Seed data only?",
  "in-use": "In use",
  "no-signal": "No signal",
  "not-found": "Solutions not found",
  platform: "Platform (skipped)",
};

export function unusedCsv(r: UnusedReport, envName: string): string {
  const head = ["Environment", "App", "Unique name", "Version", "Verdict", "Rows (own tables)", "Own tables", "Tables with rows", "Own solutions", "Shared solutions", "Model-driven apps", "Mapped by"];
  const lines = r.packages.map((p) =>
    [
      envName,
      p.pkg.name,
      p.pkg.uniqueName,
      p.pkg.version ?? "",
      VERDICT_LABEL[p.verdict],
      p.rows,
      p.tables.length,
      p.tables.filter((t) => (t.rows ?? 0) > 0).map((t) => `${t.logicalName}=${t.atLeast ? "≥" : ""}${t.rows}`).join(" "),
      p.solutions.map((s) => s.uniqueName).join(" "),
      p.shared.map((s) => s.uniqueName).join(" "),
      p.apps.map((a) => `${a.name} (${a.roles ?? "?"} role${a.roles === 1 ? "" : "s"})`).join("; "),
      p.mappedBy ?? "",
    ].map(csvCell).join(","),
  );
  return [head.join(","), ...lines].join("\r\n") + "\r\n";
}

// ---------- view ----------
/** Verdicts hidden unless Show all is ticked or their badge is pressed. */
export const QUIET: readonly Verdict[] = ["in-use", "platform"];
/** One badge per group: "not found" counts as "no signal". */
export const verdictGroup = (v: Verdict): Verdict => (v === "not-found" ? "no-signal" : v);

export interface UnusedView {
  /** Show all (in use, platform) */
  all: boolean;
  /** pressed verdict badges (groups); any of them */
  verdicts: ReadonlySet<Verdict>;
  /** name filter */
  query: string;
}

/** The report rows shown: pressed verdict badges win over Show all (else in use / platform only with Show all), then the name filter. */
export function unusedShown(packages: PackageUse[], v: UnusedView): PackageUse[] {
  const q = v.query.trim().toLowerCase();
  return packages.filter(
    (p) => (v.verdicts.size ? v.verdicts.has(verdictGroup(p.verdict)) : v.all || !QUIET.includes(p.verdict)) && (!q || `${p.pkg.name} ${p.pkg.uniqueName}`.toLowerCase().includes(q)),
  );
}

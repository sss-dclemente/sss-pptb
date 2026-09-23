/** Diagnosis engine: components → required components → owning solutions → filter / target → findings. Plan §1–§2. */
import { classify, matchesFilter } from "./classify";
import { fetchComponents, fetchOwningSolutions, pool, resolveNames, retrieveRequired, type DataverseLike, type DependencyRow, type MetaCache, type NameRequest } from "./fetch";
import { CT, type Component, type Diagnosis, type Finding, type NamedComponent, type RequiredRef, type RequiredSolution, type SolutionInfo } from "./types";

export const CONCURRENCY = 4;
const SYSTEM_BUCKETS = new Set(["default", "active", "basic"]);

export class Cancelled extends Error {
  constructor() {
    super("Diagnosis cancelled");
  }
}

export interface DiagnoseInput {
  api: DataverseLike;
  meta: MetaCache;
  /** session cache: `${type}:${objectId}` → RetrieveRequiredComponents rows */
  reqCache: Map<string, DependencyRow[]>;
  solution: SolutionInfo;
  allSolutions: SolutionInfo[];
  /** unique names (lower case) of solutions in the target, or null when there is no target */
  targetSolutions: Set<string> | null;
  filter: string[];
  environment: Diagnosis["environment"];
  target: Diagnosis["target"];
  link: (c: NamedComponent) => string;
  onProgress?: (done: number, total: number) => void;
  cancelled?: () => boolean;
}

export const reqKey = (type: number, id: string): string => `${type}:${id}`;

export async function diagnose(i: DiagnoseInput): Promise<Diagnosis> {
  const cancelled = i.cancelled ?? (() => false);
  const components = await fetchComponents(i.api, i.solution.id);
  const inSolution = new Set(components.map((c) => c.objectId));
  const byRowId = new Map(components.map((c) => [c.rowId, c]));

  // 1. required components per component, 4 in flight, cached per session
  const errors: Diagnosis["errors"] = [];
  const deps = new Map<Component, DependencyRow[]>();
  let done = 0;
  i.onProgress?.(0, components.length);
  await pool(
    components,
    CONCURRENCY,
    async (c) => {
      const k = reqKey(c.type, c.objectId);
      let rows = i.reqCache.get(k);
      if (!rows) {
        try {
          rows = await retrieveRequired(i.api, c.objectId, c.type);
          i.reqCache.set(k, rows);
        } catch (e) {
          errors.push({ component: k, error: (e as Error).message ?? String(e) });
          rows = [];
        }
      }
      deps.set(c, rows.filter((r) => r.requiredId && r.requiredId !== c.objectId));
      i.onProgress?.(++done, components.length);
    },
    cancelled,
  );
  if (cancelled()) throw new Cancelled();

  // 2. owning solutions of every required component
  // Our own components are looked up too: "all assets" pulls managed msdyn columns, forms and views into the solution.
  const requiredIds = [...new Set([...deps.values()].flat().map((r) => r.requiredId).concat(components.map((c) => c.objectId)))];
  const owning = requiredIds.length ? await fetchOwningSolutions(i.api, requiredIds) : new Map<string, string[]>();
  const solById = new Map(i.allSolutions.map((s) => [s.id, s]));
  const asReq = (s: SolutionInfo): RequiredSolution => ({ uniqueName: s.uniqueName, friendlyName: s.friendlyName, prefix: s.prefix, isManaged: s.isManaged });
  const managedOwners = (id: string): SolutionInfo[] =>
    (owning.get(id) ?? [])
      .map((sid) => solById.get(sid))
      .filter((s): s is SolutionInfo => !!s && s.isManaged && s.id !== i.solution.id && !SYSTEM_BUCKETS.has(s.uniqueName.toLowerCase()));

  // 3. names (all solution components, for display and the shell preview; required components)
  const nameReqs: NameRequest[] = components.map((c) => {
    const root = c.rootRowId ? byRowId.get(c.rootRowId) : undefined;
    return { type: c.type, id: c.objectId, parentId: root?.type === CT.Entity ? root.objectId : null };
  });
  for (const rows of deps.values()) for (const r of rows) nameReqs.push({ type: r.requiredType, id: r.requiredId, parentId: r.requiredParentId });
  const names = await resolveNames(i.api, i.meta, nameReqs);
  const named = (type: number, id: string): NamedComponent => names.get(reqKey(type, id)) ?? { type, id, name: id };
  for (const c of components) {
    const n = named(c.type, c.objectId);
    c.name = n.name;
    c.table = n.table;
    // ownership for the shell preview: forms, views and charts are named by display name, so a prefix says nothing
    c.filteredOwner = managedOwners(c.objectId).find((s) => matchesFilter(i.filter, s, n.name))?.uniqueName ?? null;
  }

  // 4. filter + target → findings grouped by dependent
  const findings: Finding[] = [];
  for (const [c, depRows] of deps) {
    const required: (RequiredRef & { blocker: boolean })[] = [];
    const seen = new Set<string>();
    // the component itself first: a managed component from another solution is a dependency of this one
    const self: DependencyRow = { requiredId: c.objectId, requiredType: c.type, requiredParentId: null, requiredBaseSolutionId: null };
    const rows = [self, ...depRows];
    let selfOwned = false;
    for (const r of rows) {
      const k = reqKey(r.requiredType, r.requiredId);
      if (seen.has(k)) continue;
      seen.add(k);
      const n = named(r.requiredType, r.requiredId);
      const managed = managedOwners(r.requiredId);
      // a component that ships in this solution and no managed solution owns is ours
      if (!managed.length && inSolution.has(r.requiredId)) continue;
      if (r === self && !managed.length) continue;
      const base = r.requiredBaseSolutionId ? solById.get(r.requiredBaseSolutionId) : undefined;
      const owner = (base?.isManaged ? base : undefined) ?? managed.find((s) => matchesFilter(i.filter, s, n.name)) ?? managed[0] ?? null;
      const inFilter = matchesFilter(i.filter, owner, n.name);
      const present = !!owner && !!i.targetSolutions?.has(owner.uniqueName.toLowerCase());
      const missingInTarget = !!i.targetSolutions && !!owner && !present;
      if (!inFilter && !missingInTarget) continue;
      if (r === self) selfOwned = true;
      required.push({ ...n, solution: owner ? asReq(owner) : null, solutions: managed.map((s) => s.uniqueName), blocker: !present });
    }
    if (!required.length) continue;
    const dep = named(c.type, c.objectId);
    const rootRow = c.type === CT.Entity ? c : c.rootRowId ? byRowId.get(c.rootRowId) : undefined;
    const root = rootRow && rootRow.type === CT.Entity ? { ...named(rootRow.type, rootRow.objectId), behavior: rootRow.behavior ?? 0 } : null;
    const cls = classify({ ...dep, behavior: c.behavior, root, selfOwned }, required, i.filter, i.link(dep));
    findings.push({
      key: reqKey(c.type, c.objectId),
      dependent: { ...dep, rootBehavior: root?.behavior ?? null, rootTable: root?.name, selfOwned },
      required: required.map(({ blocker: _b, ...r }) => r),
      cause: cls.cause,
      fixes: cls.fixes,
      status: required.some((r) => r.blocker) ? "blocker" : "safe",
    });
  }
  findings.sort((a, b) => (a.status === b.status ? 0 : a.status === "blocker" ? -1 : 1) || a.dependent.type - b.dependent.type || a.dependent.name.localeCompare(b.dependent.name));

  return {
    solution: i.solution,
    environment: i.environment,
    target: i.target,
    filter: i.filter,
    components,
    findings,
    errors,
    takenAt: new Date().toISOString(),
  };
}

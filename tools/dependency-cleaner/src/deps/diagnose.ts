/** Diagnosis engine: components → required components → owning solutions → filter / target → findings. Plan §1–§2. */
import { classify, matchesFilter } from "./classify";
import { fetchComponents, fetchOwningSolutions, pool, resolveNames, retrieveRequired, type DataverseLike, type DependencyRow, type MetaCache, type NameRequest } from "./fetch";
import { CT, type Component, type Diagnosis, type Finding, type NamedComponent, type RequiredRef, type RequiredSolution, type SolutionInfo } from "./types";

export const CONCURRENCY = 4;
const SYSTEM_BUCKETS = new Set(["default", "active", "basic"]);
/** component types whose name is a schema name carrying the publisher prefix (msdyn_x); forms, views, charts… carry display names */
const SCHEMA_NAMED = new Set<number>([CT.Entity, CT.Attribute, CT.OptionSet, CT.Relationship, CT.EntityRelationship, CT.WebResource]);

/**
 * Who owns a component: the solution that CREATED it, not every managed solution with a solutioncomponent row for it.
 * In a D365 dev environment every msdyn app that extends account or contact (Sales, Field Service…) has a row for the
 * table and often for its main form, so "any managed solution that contains it" made account look like Field Service's.
 * First match wins:
 *  1. Dataverse names the base (creating) solution in a dependency row (requiredcomponentbasesolutionid; also taken
 *     from any other row of the diagnosis that requires the same component) and it is managed → that solution.
 *  2. Platform component → System, never in the filter: table metadata IsCustomEntity = false, column metadata
 *     IsCustomAttribute = false, or, for other types (forms, views…) or unknown metadata, the managed System solution
 *     contains it (out of the box).
 *  3. Exactly one managed solution contains it → that one.
 *  4. Several: the one whose publisher prefix is the component's schema-name prefix (msdyn_x → msdyn); else the first
 *     when every candidate matches the filter; else (a mix) the first candidate outside the filter: ambiguous ownership
 *     is never read as filtered, so nothing is removed or dropped on a guess.
 * Present in the target: a platform component always; otherwise when ANY managed solution containing it is there
 * (installing it brings the component along).
 */
export interface Ownership {
  owner: SolutionInfo | null;
  /** every managed solution with a row for it (System included) */
  candidates: SolutionInfo[];
  platform: boolean;
}


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
  const isSystem = (s: SolutionInfo): boolean => s.uniqueName.toLowerCase() === "system";
  const systemSolution: SolutionInfo = i.allSolutions.find(isSystem) ?? { id: "", uniqueName: "System", friendlyName: "System", version: "", isManaged: true, publisherId: null, prefix: "" };
  // base (creating) solution per component, from every dependency row that names one
  const baseOf = new Map<string, string>();
  for (const rows of deps.values()) for (const r of rows) if (r.requiredBaseSolutionId && !baseOf.has(r.requiredId)) baseOf.set(r.requiredId, r.requiredBaseSolutionId);

  // 3. names (all solution components, for display and the shell preview; required components)
  const nameReqs: NameRequest[] = components.map((c) => {
    const root = c.rootRowId ? byRowId.get(c.rootRowId) : undefined;
    return { type: c.type, id: c.objectId, parentId: root?.type === CT.Entity ? root.objectId : null };
  });
  for (const rows of deps.values()) for (const r of rows) nameReqs.push({ type: r.requiredType, id: r.requiredId, parentId: r.requiredParentId });
  const nameFailures = new Map<string, string>();
  const names = await resolveNames(i.api, i.meta, nameReqs, nameFailures);
  const warnings: string[] = [];
  if (nameFailures.size)
    warnings.push(
      `Name lookup failed for ${nameFailures.size} component(s) (${[...new Set(nameFailures.values())].slice(0, 2).join("; ")}). Findings that involve them are report only: an edit keyed on an unresolved name would change nothing. Run Diagnose again.`,
    );
  const named = (type: number, id: string): NamedComponent => names.get(reqKey(type, id)) ?? { type, id, name: id };
  const isCustom = (n: NamedComponent): boolean | null => {
    if (n.type === CT.Entity) return i.meta.entities?.get(n.id)?.isCustom ?? null;
    if (n.type === CT.Attribute && n.table) return i.meta.attributes.get(n.table)?.find((a) => a.id === n.id)?.isCustom ?? null;
    return null;
  };
  const ownership = (n: NamedComponent, baseId: string | null): Ownership => {
    const all = managedOwners(n.id);
    const base = solById.get(baseId ?? baseOf.get(n.id) ?? "");
    const custom = isCustom(n);
    const platform = (o: SolutionInfo = systemSolution): Ownership => ({ owner: o, candidates: all, platform: true });
    if (base?.isManaged && !SYSTEM_BUCKETS.has(base.uniqueName.toLowerCase())) return isSystem(base) ? platform(base) : { owner: base, candidates: all, platform: false };
    if (custom === false) return platform();
    const sys = all.find(isSystem);
    if (sys && custom === null) return platform(sys);
    const cands = all.filter((s) => !isSystem(s));
    if (cands.length <= 1) return { owner: cands[0] ?? null, candidates: all, platform: false };
    const pfx = SCHEMA_NAMED.has(n.type) ? /^([a-z0-9]+)_/i.exec(n.name)?.[1]?.toLowerCase() : undefined;
    const byPrefix = pfx ? cands.find((s) => s.prefix === pfx) : undefined;
    const inFilter = cands.filter((s) => matchesFilter(i.filter, s, n.name));
    const owner = byPrefix ?? (inFilter.length === cands.length ? cands[0] : cands.find((s) => !matchesFilter(i.filter, s, n.name))!);
    return { owner, candidates: all, platform: false };
  };
  for (const c of components) {
    const n = named(c.type, c.objectId);
    c.name = n.name;
    c.table = n.table;
    // ownership for the shell preview: forms, views and charts are named by display name, so a prefix says nothing
    const o = ownership(n, null).owner;
    c.filteredOwner = o && matchesFilter(i.filter, o, n.name) ? o.uniqueName : null;
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
      const { owner, candidates: managed, platform } = ownership(n, r.requiredBaseSolutionId);
      // a component that ships in this solution and no managed solution owns is ours
      if (!owner && inSolution.has(r.requiredId)) continue;
      if (r === self && !owner) continue;
      const inFilter = !platform && matchesFilter(i.filter, owner, n.name);
      const inTarget = (s: SolutionInfo) => !!i.targetSolutions?.has(s.uniqueName.toLowerCase());
      const present = !!owner && (platform || inTarget(owner) || managed.some(inTarget));
      const missingInTarget = !!i.targetSolutions && !!owner && !present;
      if (!inFilter && !missingInTarget) continue;
      if (r === self) selfOwned = true;
      required.push({ ...n, solution: owner ? asReq(owner) : null, solutions: managed.map((s) => s.uniqueName), blocker: !present });
    }
    if (!required.length) continue;
    const dep = named(c.type, c.objectId);
    const rootRow = c.type === CT.Entity ? c : c.rootRowId ? byRowId.get(c.rootRowId) : undefined;
    const root = rootRow && rootRow.type === CT.Entity ? { ...named(rootRow.type, rootRow.objectId), behavior: rootRow.behavior ?? 0 } : null;
    // a name that could not be read makes form / view edits and shell choices guesswork: report only
    const lookupErrors = [...new Set([reqKey(c.type, c.objectId), ...required.map((r) => reqKey(r.type, r.id))].map((k) => nameFailures.get(k)).filter((x): x is string => !!x))];
    const cls = lookupErrors.length
      ? {
          cause: `Some names could not be read (${lookupErrors.join("; ")}), so this cannot be fixed automatically. Run Diagnose again.`,
          fixes: [{ kind: "report" as const, label: "Report only: open in maker portal", link: i.link(dep), note: "Name lookup failed: not edited automatically." }],
        }
      : classify({ ...dep, behavior: c.behavior, root, selfOwned }, required, i.filter, i.link(dep));
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
    warnings,
    takenAt: new Date().toISOString(),
  };
}

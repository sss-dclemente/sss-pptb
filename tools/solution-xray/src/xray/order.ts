import { isActiveSolution, isBuiltinSolution } from "./componentTypes";
import { compareVersions } from "./diff";
import type { RootComponent, SolutionInfo } from "./types";

export interface Edge {
  from: string; // must be installed before
  to: string; // depends on `from`
  reasons: string[];
}

export interface ExternalDependency {
  solution: string;
  requiredSolution: string;
  component: string;
}

export interface InstallOrder {
  /** Solutions in install order (empty when a cycle blocks ordering) */
  order: string[];
  edges: Edge[];
  /** Nodes that could not be ordered because of cycles */
  cycle: string[];
  /** One concrete cycle path, if found */
  cyclePath: string[];
  external: ExternalDependency[];
  duplicates: string[];
}

function rcKey(type: number, schemaName: string | null, id: string | null): string {
  return `${type}:${(schemaName ?? id ?? "").toLowerCase()}`;
}

/** One solution per unique name: the highest version wins; ties (or unparsable versions) keep the first loaded. */
export function latestByName(solutions: SolutionInfo[]): Map<string, SolutionInfo> {
  const byName = new Map<string, SolutionInfo>();
  for (const s of solutions) {
    const prev = byName.get(s.uniqueName);
    if (!prev || compareVersions(s.version, prev.version) > 0) byName.set(s.uniqueName, s);
  }
  return byName;
}

/** A solution creates a table when it ships it with all subcomponents and it is a custom (prefix_) table. */
function createsTable(rc: RootComponent): boolean {
  return rc.type === 1 && rc.behavior === 0 && !!rc.schemaName && /^[a-z0-9]+_/i.test(rc.schemaName);
}

/**
 * Build the dependency graph between loaded solutions and order them with Kahn's algorithm.
 * Edge A -> B when B needs A:
 *  1. B.MissingDependencies.Required.solution names A
 *  2. B.MissingDependencies.Required component is a root component of A
 *  3. B includes a table as shell/partial (behavior != 0) that A creates
 * A table is owned only by a solution that creates it (custom table, behavior 0); when several do, the one whose
 * publisher prefix matches wins, else the first. Tables no loaded solution creates (system tables such as account)
 * never produce edges. When the same unique name is loaded twice, the highest version is used.
 */
export function computeInstallOrder(solutions: SolutionInfo[]): InstallOrder {
  const byName = latestByName(solutions);
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const s of solutions) {
    if (seen.has(s.uniqueName) && !duplicates.includes(s.uniqueName)) duplicates.push(s.uniqueName);
    seen.add(s.uniqueName);
  }
  const names = Array.from(byName.keys());

  const tableOwner = new Map<string, SolutionInfo>(); // table -> solution that creates it
  const rootIndex = new Map<string, string>(); // rcKey -> solution uniqueName (first full owner), non-table components
  for (const s of byName.values()) {
    for (const rc of s.rootComponents) {
      if (rc.type === 1) {
        if (!createsTable(rc)) continue;
        const t = rc.schemaName!.toLowerCase();
        const prev = tableOwner.get(t);
        const prefixMatches = (x: SolutionInfo) => !!x.publisher.prefix && t.startsWith(x.publisher.prefix.toLowerCase() + "_");
        if (!prev || (!prefixMatches(prev) && prefixMatches(s))) tableOwner.set(t, s);
        continue;
      }
      const k = rcKey(rc.type, rc.schemaName, rc.id);
      if (rc.behavior === 0 && !rootIndex.has(k)) rootIndex.set(k, s.uniqueName);
    }
  }
  const ownerOf = (type: number, schemaName: string | null, id: string | null): string | undefined =>
    type === 1 ? (schemaName ? tableOwner.get(schemaName.toLowerCase())?.uniqueName : undefined) : rootIndex.get(rcKey(type, schemaName, id));

  const edgeMap = new Map<string, Edge>();
  const external: ExternalDependency[] = [];
  const addEdge = (from: string, to: string, reason: string) => {
    if (from === to) return;
    const k = `${from}→${to}`;
    const e = edgeMap.get(k) ?? { from, to, reasons: [] };
    if (!e.reasons.includes(reason)) e.reasons.push(reason);
    edgeMap.set(k, e);
  };

  for (const s of byName.values()) {
    for (const md of s.missingDependencies) {
      const req = md.required;
      const comp = `${req.typeName} ${req.schemaName ?? req.id ?? "?"}`;
      const reqSolution = req.solutionName;
      if (reqSolution && byName.has(reqSolution)) {
        addEdge(reqSolution, s.uniqueName, `needs ${comp}`);
        continue;
      }
      const owner = ownerOf(req.type, req.schemaName, req.id);
      if (owner && owner !== s.uniqueName) {
        addEdge(owner, s.uniqueName, `needs ${comp}`);
        continue;
      }
      if (isActiveSolution(reqSolution))
        external.push({ solution: s.uniqueName, requiredSolution: "Active (unmanaged in source environment; add it to the solution or a prerequisite solution)", component: comp });
      else if (!isBuiltinSolution(reqSolution)) external.push({ solution: s.uniqueName, requiredSolution: req.solution ?? "?", component: comp });
    }
    for (const rc of s.rootComponents) {
      if (rc.type !== 1 || rc.behavior === 0 || !rc.schemaName) continue;
      const owner = ownerOf(1, rc.schemaName, null);
      if (owner && owner !== s.uniqueName) addEdge(owner, s.uniqueName, `table ${rc.schemaName} created there`);
    }
  }

  const edges = Array.from(edgeMap.values());

  // Kahn
  const indeg = new Map<string, number>(names.map((n) => [n, 0]));
  const out = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const e of edges) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    out.get(e.from)!.push(e.to);
  }
  const queue = names.filter((n) => indeg.get(n) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of out.get(n)!.sort()) {
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) {
        queue.push(m);
        queue.sort();
      }
    }
  }
  const cycle = names.filter((n) => !order.includes(n));

  // Find one concrete cycle among the stuck nodes (DFS)
  let cyclePath: string[] = [];
  if (cycle.length) {
    const stuck = new Set(cycle);
    const state = new Map<string, 0 | 1 | 2>();
    const stack: string[] = [];
    const dfs = (n: string): boolean => {
      state.set(n, 1);
      stack.push(n);
      for (const m of out.get(n)!) {
        if (!stuck.has(m)) continue;
        const st = state.get(m) ?? 0;
        if (st === 1) {
          cyclePath = stack.slice(stack.indexOf(m)).concat(m);
          return true;
        }
        if (st === 0 && dfs(m)) return true;
      }
      stack.pop();
      state.set(n, 2);
      return false;
    };
    for (const n of cycle) if ((state.get(n) ?? 0) === 0 && dfs(n)) break;
  }

  return { order: cycle.length ? [] : order, edges, cycle, cyclePath, external, duplicates };
}

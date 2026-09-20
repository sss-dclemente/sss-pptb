import { isBuiltinSolution } from "./componentTypes";
import type { SolutionInfo } from "./types";

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

/**
 * Build the dependency graph between loaded solutions and order them with Kahn's algorithm.
 * Edge A -> B when B needs A:
 *  1. B.MissingDependencies.Required.solution names A
 *  2. B.MissingDependencies.Required component is a root component of A
 *  3. B includes a table as shell/partial (behavior != 0) that A includes fully (behavior 0)
 */
export function computeInstallOrder(solutions: SolutionInfo[]): InstallOrder {
  const byName = new Map<string, SolutionInfo>();
  const duplicates: string[] = [];
  for (const s of solutions) {
    if (byName.has(s.uniqueName)) duplicates.push(s.uniqueName);
    else byName.set(s.uniqueName, s);
  }
  const names = Array.from(byName.keys());

  const rootIndex = new Map<string, string>(); // rcKey -> solution uniqueName (first full owner)
  const fullTables = new Map<string, string>(); // table -> solution with behavior 0
  for (const s of byName.values()) {
    for (const rc of s.rootComponents) {
      const k = rcKey(rc.type, rc.schemaName, rc.id);
      if (!rootIndex.has(k)) rootIndex.set(k, s.uniqueName);
      if (rc.type === 1 && rc.behavior === 0 && rc.schemaName) fullTables.set(rc.schemaName.toLowerCase(), s.uniqueName);
    }
    for (const e of s.entities) if (!fullTables.has(e.name.toLowerCase())) fullTables.set(e.name.toLowerCase(), s.uniqueName);
  }

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
      const owner = rootIndex.get(rcKey(req.type, req.schemaName, req.id));
      if (owner && owner !== s.uniqueName) {
        addEdge(owner, s.uniqueName, `needs ${comp}`);
        continue;
      }
      if (!isBuiltinSolution(reqSolution)) external.push({ solution: s.uniqueName, requiredSolution: req.solution ?? "?", component: comp });
    }
    for (const rc of s.rootComponents) {
      if (rc.type !== 1 || rc.behavior === 0 || !rc.schemaName) continue;
      const owner = fullTables.get(rc.schemaName.toLowerCase());
      if (owner && owner !== s.uniqueName) addEdge(owner, s.uniqueName, `table ${rc.schemaName} defined fully there`);
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

/**
 * Cycles, docs/CYCLES-PLAN.md: dependencies between several unmanaged solutions, the cycles that leave no import order,
 * and the fixes that break them (shared components into a base solution, copies, moves). Membership only.
 */
import { Cancelled, reqKey } from "./diagnose";
import { fetchComponents, pool, resolveNames, retrieveRequired, type DataverseLike, type DependencyRow, type MetaCache, type NameRequest } from "./fetch";
import { CT, typeName, type Component, type NamedComponent, type SolutionInfo } from "./types";
import { addRequest, removeComponent } from "./write";

export const CYCLES_CONCURRENCY = 4;
/** the unmanaged (Active) solution: base solution of every unmanaged component */
export const ACTIVE_SOLUTION_ID = "fd140aae-4df4-11dd-bd17-0019b9312238";

export interface Pair {
  /** component of the "from" solution */
  dependent: NamedComponent & { rowId: string; root: boolean; behavior: number | null };
  required: NamedComponent;
}

export interface Edge {
  /** solution ids: `from` must be imported after `to` */
  from: string;
  to: string;
  pairs: Pair[];
}

/** One fix row: a required component on one edge, with every dependent that needs it. */
export interface FixRow {
  /** `${from}>${to}>${required key}` */
  key: string;
  from: string;
  to: string;
  required: NamedComponent & { rowIdInTo: string | null; rootInTo: boolean; behaviorInTo: number | null };
  dependents: Pair["dependent"][];
  /** every dependent is a root row: "move dependents" is possible */
  movable: boolean;
  /** this edge is part of a cycle */
  inCycle: boolean;
}

export interface Orphan {
  required: NamedComponent;
  dependents: { solution: string; component: NamedComponent }[];
}

export interface CyclesAnalysis {
  solutions: SolutionInfo[];
  base: SolutionInfo | null;
  environment: { name: string; url: string };
  /** solution id → membership */
  members: Map<string, Component[]>;
  edges: Edge[];
  /** solution ids, each list one cycle (an SCC of size ≥ 2) */
  cycles: string[][];
  /** import order (ids), base first; null while a cycle exists */
  order: string[] | null;
  fixRows: FixRow[];
  orphans: Orphan[];
  /** required components whose base solution is managed: Diagnose's business */
  managedRequired: number;
  /** required components satisfied by the base solution */
  viaBase: number;
  errors: { component: string; error: string }[];
  warnings: string[];
  takenAt: string;
}

export interface CyclesOptions {
  api: DataverseLike;
  meta: MetaCache;
  reqCache: Map<string, DependencyRow[]>;
  solutions: SolutionInfo[];
  base: SolutionInfo | null;
  allSolutions: SolutionInfo[];
  environment: { name: string; url: string };
  onProgress?: (phase: string, done: number, total: number) => void;
  cancelled?: () => boolean;
}

const key = (type: number, id: string): string => `${type}:${id}`;
const msg = (e: unknown): string => (e as Error)?.message ?? String(e);

// ---------- graph ----------

/** Strongly connected components (Tarjan), each as a list of node ids; singletons without a self-loop are not cycles. */
export function stronglyConnected(nodes: string[], edges: { from: string; to: string }[]): string[][] {
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const e of edges) adj.get(e.from)?.push(e.to);
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      out.push(scc.reverse());
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  return out;
}

/** Cycles (SCCs of size ≥ 2) and, when there are none, the import order: dependencies first, base first, ties by name. */
export function orderSolutions(nodes: string[], edges: { from: string; to: string }[], baseId: string | null, name: (id: string) => string): { cycles: string[][]; order: string[] | null } {
  const cycles = stronglyConnected(nodes, edges).filter((s) => s.length > 1);
  if (cycles.length) return { cycles, order: null };
  // Kahn over "to before from"
  const after = new Map<string, Set<string>>(nodes.map((n) => [n, new Set()]));
  const inDeg = new Map<string, number>(nodes.map((n) => [n, 0]));
  for (const e of edges) {
    if (e.from === e.to || after.get(e.to)!.has(e.from)) continue;
    after.get(e.to)!.add(e.from);
    inDeg.set(e.from, inDeg.get(e.from)! + 1);
  }
  const ready = () => nodes.filter((n) => inDeg.get(n) === 0 && !done.has(n)).sort((a, b) => Number(b === baseId) - Number(a === baseId) || name(a).localeCompare(name(b)));
  const done = new Set<string>();
  const order: string[] = [];
  for (;;) {
    const next = ready()[0];
    if (!next) break;
    done.add(next);
    order.push(next);
    for (const m of after.get(next) ?? []) inDeg.set(m, inDeg.get(m)! - 1);
  }
  return { cycles, order: order.length === nodes.length ? order : null };
}

// ---------- analysis ----------

interface Membership {
  /** component key → solution ids containing it */
  holders: Map<string, Set<string>>;
  /** solution id → component key → row */
  rows: Map<string, Map<string, Component>>;
}

function membership(members: Map<string, Component[]>): Membership {
  const holders = new Map<string, Set<string>>();
  const rows = new Map<string, Map<string, Component>>();
  for (const [sid, list] of members) {
    const m = new Map<string, Component>();
    for (const c of list) {
      const k = key(c.type, c.objectId);
      m.set(k, c);
      if (!holders.has(k)) holders.set(k, new Set());
      holders.get(k)!.add(sid);
    }
    rows.set(sid, m);
  }
  return { holders, rows };
}

/** Edges from the membership and the required rows; pure, so the preview can simulate a plan (D8). */
export function computeEdges(solutionIds: string[], baseId: string | null, members: Map<string, Component[]>, required: Map<string, DependencyRow[]>, isManagedBase: (baseSolutionId: string | null) => boolean, name: (type: number, id: string) => NamedComponent): { edges: Edge[]; orphans: Orphan[]; managedRequired: number; viaBase: number } {
  const { holders, rows } = membership(members);
  const edgeMap = new Map<string, Edge>();
  const orphanMap = new Map<string, Orphan>();
  let managedRequired = 0;
  let viaBase = 0;
  const seenPair = new Set<string>();
  for (const sid of solutionIds) {
    for (const c of rows.get(sid)?.values() ?? []) {
      const dep: Pair["dependent"] = { ...name(c.type, c.objectId), rowId: c.rowId, root: !c.rootRowId, behavior: c.behavior };
      for (const r of required.get(reqKey(c.type, c.objectId)) ?? []) {
        const rk = key(r.requiredType, r.requiredId);
        const h = holders.get(rk) ?? new Set<string>();
        if (h.has(sid)) continue; // internal
        if (isManagedBase(r.requiredBaseSolutionId)) {
          managedRequired++;
          continue;
        }
        if (baseId && h.has(baseId)) {
          viaBase++;
          continue;
        }
        const others = solutionIds.filter((o) => o !== sid && h.has(o));
        const reqNamed = name(r.requiredType, r.requiredId);
        if (!others.length) {
          const pk = `${rk}|${sid}|${key(c.type, c.objectId)}`;
          if (seenPair.has(pk)) continue;
          seenPair.add(pk);
          const o = orphanMap.get(rk) ?? { required: reqNamed, dependents: [] };
          o.dependents.push({ solution: sid, component: dep });
          orphanMap.set(rk, o);
          continue;
        }
        for (const to of others) {
          const ek = `${sid}>${to}`;
          const pk = `${ek}|${rk}|${key(c.type, c.objectId)}`;
          if (seenPair.has(pk)) continue;
          seenPair.add(pk);
          const e = edgeMap.get(ek) ?? { from: sid, to, pairs: [] };
          e.pairs.push({ dependent: dep, required: reqNamed });
          edgeMap.set(ek, e);
        }
      }
    }
  }
  return { edges: [...edgeMap.values()], orphans: [...orphanMap.values()], managedRequired, viaBase };
}

function fixRowsOf(edges: Edge[], cycles: string[][], members: Map<string, Component[]>): FixRow[] {
  const { rows } = membership(members);
  const inCycle = new Set(cycles.flatMap((c) => c.flatMap((a) => c.filter((b) => b !== a).map((b) => `${a}>${b}`))));
  const out: FixRow[] = [];
  for (const e of edges) {
    const byReq = new Map<string, FixRow>();
    for (const p of e.pairs) {
      const rk = key(p.required.type, p.required.id);
      const inTo = rows.get(e.to)?.get(rk);
      const row = byReq.get(rk) ?? {
        key: `${e.from}>${e.to}>${rk}`,
        from: e.from,
        to: e.to,
        required: { ...p.required, rowIdInTo: inTo?.rowId ?? null, rootInTo: !!inTo && !inTo.rootRowId, behaviorInTo: inTo?.behavior ?? null },
        dependents: [],
        movable: true,
        inCycle: inCycle.has(`${e.from}>${e.to}`),
      };
      if (!row.dependents.some((d) => d.id === p.dependent.id && d.type === p.dependent.type)) row.dependents.push(p.dependent);
      row.movable = row.dependents.every((d) => d.root);
      byReq.set(rk, row);
    }
    out.push(...byReq.values());
  }
  return out.sort((a, b) => Number(b.inCycle) - Number(a.inCycle) || a.key.localeCompare(b.key));
}

export async function analyzeCycles(o: CyclesOptions): Promise<CyclesAnalysis> {
  const { api, meta } = o;
  const cancelled = () => !!o.cancelled?.();
  const warnings: string[] = [];
  const errors: CyclesAnalysis["errors"] = [];
  if (o.solutions.length < 2) throw new Error("Pick at least two unmanaged solutions.");
  if (o.solutions.some((s) => s.isManaged) || o.base?.isManaged) throw new Error("Only unmanaged solutions can be analyzed or used as the base.");

  // 1. membership
  const ids = o.solutions.map((s) => s.id);
  const all = o.base && !ids.includes(o.base.id) ? [...o.solutions, o.base] : o.solutions;
  o.onProgress?.("Reading solution membership", 0, all.length);
  const members = new Map<string, Component[]>();
  let read = 0;
  for (const s of all) {
    members.set(s.id, await fetchComponents(api, s.id));
    o.onProgress?.("Reading solution membership", ++read, all.length);
    if (cancelled()) throw new Cancelled();
  }

  // 2. required components of every member of the selected solutions, cached
  const todo = [...new Map(ids.flatMap((sid) => (members.get(sid) ?? []).map((c) => [reqKey(c.type, c.objectId), c] as const))).values()];
  let done = 0;
  o.onProgress?.("RetrieveRequiredComponents", 0, todo.length);
  await pool(
    todo,
    CYCLES_CONCURRENCY,
    async (c) => {
      const k = reqKey(c.type, c.objectId);
      if (!o.reqCache.has(k)) {
        try {
          o.reqCache.set(k, await retrieveRequired(api, c.objectId, c.type));
        } catch (e) {
          errors.push({ component: `${typeName(c.type)} ${c.name ?? c.objectId}`, error: msg(e) });
        }
      }
      o.onProgress?.("RetrieveRequiredComponents", ++done, todo.length);
    },
    cancelled,
  );
  if (cancelled()) throw new Cancelled();

  // 3. names: members (parent = root row's table) and requireds (parent from the row)
  const byRow = new Map<string, Component>();
  for (const list of members.values()) for (const c of list) byRow.set(c.rowId, c);
  const nameReqs = new Map<string, NameRequest>();
  for (const list of members.values()) for (const c of list) nameReqs.set(key(c.type, c.objectId), { type: c.type, id: c.objectId, parentId: c.rootRowId ? (byRow.get(c.rootRowId)?.objectId ?? null) : null });
  for (const c of todo) for (const r of o.reqCache.get(reqKey(c.type, c.objectId)) ?? []) if (!nameReqs.has(key(r.requiredType, r.requiredId))) nameReqs.set(key(r.requiredType, r.requiredId), { type: r.requiredType, id: r.requiredId, parentId: r.requiredParentId });
  const failedNames = new Map<string, string>();
  o.onProgress?.("Resolving names", 0, 1);
  const names = await resolveNames(api, meta, [...nameReqs.values()], failedNames);
  if (failedNames.size) warnings.push(`${failedNames.size} name lookup(s) failed; those components are listed by id.`);
  for (const list of members.values())
    for (const c of list) {
      const n = names.get(key(c.type, c.objectId));
      c.name = n?.name ?? c.objectId;
      c.table = n?.table;
    }
  const name = (type: number, id: string): NamedComponent => names.get(key(type, id)) ?? { type, id, name: id };

  // 4. edges, cycles, order
  const solById = new Map(o.allSolutions.map((s) => [s.id, s]));
  const isManagedBase = (bid: string | null): boolean => !!bid && bid !== ACTIVE_SOLUTION_ID && (solById.get(bid)?.isManaged ?? false);
  const required = new Map<string, DependencyRow[]>();
  for (const c of todo) required.set(reqKey(c.type, c.objectId), o.reqCache.get(reqKey(c.type, c.objectId)) ?? []);
  const baseId = o.base?.id ?? null;
  const { edges, orphans, managedRequired, viaBase } = computeEdges(ids, baseId, members, required, isManagedBase, name);
  const solName = (id: string) => solById.get(id)?.uniqueName ?? id;
  const { cycles, order } = orderSolutions(ids, edges, baseId && ids.includes(baseId) ? baseId : null, solName);
  const fixRows = fixRowsOf(edges, cycles, members);
  if (!o.base) warnings.push("No base solution picked: cycles are report-only, and orphan required components cannot be placed.");
  if (errors.length) warnings.push(`RetrieveRequiredComponents failed for ${errors.length} component(s): their dependencies are unknown, so an edge or a cycle may be missing.`);
  return { solutions: o.solutions, base: o.base, environment: o.environment, members, edges, cycles, order, fixRows, orphans, managedRequired, viaBase, errors, warnings, takenAt: new Date().toISOString() };
}

// ---------- plan ----------

export type FixKind = "base" | "copy" | "move" | "none";

export interface FixChoice {
  kind: FixKind;
  /** with "base": also remove the required component from the solution that carried it (root rows only) */
  alsoRemove?: boolean;
}

export type CycleOp = { kind: "add"; solution: SolutionInfo; component: NamedComponent; doNotIncludeSubcomponents: boolean; reason: string } | { kind: "remove"; solution: SolutionInfo; component: NamedComponent; behaviorBefore: number | null; reason: string };

export interface CyclePlan {
  ops: CycleOp[];
  /** after the plan: edges, cycles and order recomputed on the simulated membership (D8) */
  after: { edges: Edge[]; cycles: string[][]; order: string[] | null; orphans: Orphan[] };
  skipped: { what: string; reason: string }[];
}

/** Build the operations for the chosen fixes (fix rows and orphans) and simulate the result. */
export function planCycles(a: CyclesAnalysis, choices: Map<string, FixChoice>, orphanToBase: Set<string>, reqCache: Map<string, DependencyRow[]>, isManagedBase: (bid: string | null) => boolean): CyclePlan {
  const solById = new Map([...a.solutions, ...(a.base ? [a.base] : [])].map((s) => [s.id, s]));
  const ops: CycleOp[] = [];
  const skipped: CyclePlan["skipped"] = [];
  const { rows } = membership(a.members);
  const has = (sid: string, c: { type: number; id: string }) => !!rows.get(sid)?.has(key(c.type, c.id));
  const asShell = (c: NamedComponent) => c.type === CT.Entity;
  const add = (sol: SolutionInfo, c: NamedComponent, doNot: boolean, reason: string) => {
    if (has(sol.id, c)) return;
    if (!ops.some((op) => op.kind === "add" && op.solution.id === sol.id && op.component.type === c.type && op.component.id === c.id)) ops.push({ kind: "add", solution: sol, component: c, doNotIncludeSubcomponents: doNot, reason });
  };
  const removes: CycleOp[] = [];
  const remove = (sol: SolutionInfo, c: NamedComponent & { rowId?: string }, behaviorBefore: number | null, reason: string) => {
    if (!has(sol.id, c)) return;
    if (!removes.some((op) => op.kind === "remove" && op.solution.id === sol.id && op.component.type === c.type && op.component.id === c.id)) removes.push({ kind: "remove", solution: sol, component: c, behaviorBefore, reason });
  };
  for (const r of a.fixRows) {
    const ch = choices.get(r.key);
    if (!ch || ch.kind === "none") continue;
    const from = solById.get(r.from)!;
    const to = solById.get(r.to)!;
    if (ch.kind === "base") {
      if (!a.base) {
        skipped.push({ what: `${typeName(r.required.type)} ${r.required.name}`, reason: "no base solution" });
        continue;
      }
      add(a.base, r.required, asShell(r.required), `shared by ${from.uniqueName} and ${to.uniqueName}: into the base`);
      if (ch.alsoRemove) {
        if (r.required.rootInTo) remove(to, { ...r.required, rowId: r.required.rowIdInTo ?? undefined }, r.required.behaviorInTo, `moved to the base, leaves ${to.uniqueName}`);
        else skipped.push({ what: `${typeName(r.required.type)} ${r.required.name} out of ${to.uniqueName}`, reason: "not a root row there (included by its table)" });
      }
    } else if (ch.kind === "copy") add(from, r.required, asShell(r.required), `${from.uniqueName} carries it itself`);
    else if (ch.kind === "move") {
      if (!r.movable) {
        skipped.push({ what: `dependents of ${r.required.name}`, reason: "a dependent is not a root row" });
        continue;
      }
      for (const d of r.dependents) {
        add(to, d, d.type === CT.Entity && d.behavior !== 0, `${typeName(d.type)} ${d.name} moves to ${to.uniqueName}`);
        remove(from, d, d.behavior, `moved to ${to.uniqueName}`);
      }
    }
  }
  for (const orph of a.orphans) {
    if (!orphanToBase.has(key(orph.required.type, orph.required.id))) continue;
    if (!a.base) {
      skipped.push({ what: `${typeName(orph.required.type)} ${orph.required.name}`, reason: "no base solution" });
      continue;
    }
    add(a.base, orph.required, asShell(orph.required), "required by a selected solution, carried by none: into the base");
  }
  ops.push(...removes);

  // simulate (D8)
  const members = new Map<string, Component[]>();
  for (const [sid, list] of a.members) members.set(sid, list.map((c) => ({ ...c })));
  if (a.base && !members.has(a.base.id)) members.set(a.base.id, []);
  for (const op of ops) {
    const list = members.get(op.solution.id)!;
    if (op.kind === "add") list.push({ rowId: `sim:${op.component.type}:${op.component.id}`, objectId: op.component.id, type: op.component.type, behavior: op.component.type === CT.Entity ? (op.doNotIncludeSubcomponents ? 1 : 0) : null, rootRowId: null, name: op.component.name, table: op.component.table });
    else {
      const row = list.find((c) => c.type === op.component.type && c.objectId === op.component.id);
      members.set(op.solution.id, list.filter((c) => c !== row && c.rootRowId !== row?.rowId));
    }
  }
  const nm = (type: number, id: string): NamedComponent => {
    for (const list of a.members.values()) for (const c of list) if (c.type === type && c.objectId === id) return { type, id, name: c.name ?? id, table: c.table };
    const r = a.fixRows.find((x) => x.required.type === type && x.required.id === id)?.required ?? a.orphans.find((x) => x.required.type === type && x.required.id === id)?.required;
    return r ? { type, id, name: r.name, table: r.table } : { type, id, name: id };
  };
  const ids = a.solutions.map((s) => s.id);
  const sim = computeEdges(ids, a.base?.id ?? null, members, reqCache, isManagedBase, nm);
  const solName = (id: string) => solById.get(id)?.uniqueName ?? id;
  const { cycles, order } = orderSolutions(ids, sim.edges, a.base && ids.includes(a.base.id) ? a.base.id : null, solName);
  return { ops, after: { edges: sim.edges, cycles, order, orphans: sim.orphans }, skipped };
}

// ---------- execute / undo ----------

export interface CycleOpResult {
  op: CycleOp;
  ok: boolean;
  error?: string;
}

/** Every operation runs; a failure marks its row (D10). */
export async function executeCycles(api: DataverseLike, ops: CycleOp[], onStep?: (i: number, n: number) => void): Promise<CycleOpResult[]> {
  const out: CycleOpResult[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    onStep?.(i, ops.length);
    try {
      if (op.kind === "add") await api.execute(addRequest(op.component, op.solution.uniqueName, op.doNotIncludeSubcomponents));
      else await removeComponent(api, op.component, op.solution.uniqueName);
      out.push({ op, ok: true });
    } catch (e) {
      out.push({ op, ok: false, error: msg(e) });
    }
  }
  onStep?.(ops.length, ops.length);
  return out;
}

export const CYCLES_BACKUP_KIND = "sss-dependency-cleaner-cycles-backup";

export interface CyclesBackup {
  kind: typeof CYCLES_BACKUP_KIND;
  version: 1;
  takenAt: string;
  environment: { name: string; url: string };
  /** the operations as planned, in order */
  operations: { kind: "add" | "remove"; solution: string; type: number; id: string; name: string; doNotIncludeSubcomponents?: boolean; behaviorBefore?: number | null }[];
}

export function buildCyclesBackup(environment: { name: string; url: string }, ops: CycleOp[]): CyclesBackup {
  return {
    kind: CYCLES_BACKUP_KIND,
    version: 1,
    takenAt: new Date().toISOString(),
    environment,
    operations: ops.map((op) =>
      op.kind === "add"
        ? { kind: "add", solution: op.solution.uniqueName, type: op.component.type, id: op.component.id, name: op.component.name, doNotIncludeSubcomponents: op.doNotIncludeSubcomponents }
        : { kind: "remove", solution: op.solution.uniqueName, type: op.component.type, id: op.component.id, name: op.component.name, behaviorBefore: op.behaviorBefore },
    ),
  };
}

export function parseCyclesBackup(text: string): CyclesBackup {
  let o: Partial<CyclesBackup>;
  try {
    o = JSON.parse(text) as Partial<CyclesBackup>;
  } catch (e) {
    throw new Error(`not JSON: ${(e as Error).message}`);
  }
  if (o?.kind !== CYCLES_BACKUP_KIND) throw new Error("not a Cycles backup");
  if (o.version !== 1 || !Array.isArray(o.operations) || !o.environment?.url) throw new Error("backup is incomplete");
  return o as CyclesBackup;
}

/** The inverse operations, last first: an add becomes a remove, a remove an add with the previous root behaviour. */
export function undoOps(b: CyclesBackup, solutions: SolutionInfo[]): { ops: CycleOp[]; notes: string[] } {
  const notes: string[] = [];
  const ops: CycleOp[] = [];
  for (const op of [...b.operations].reverse()) {
    const sol = solutions.find((s) => s.uniqueName.toLowerCase() === op.solution.toLowerCase());
    if (!sol) {
      notes.push(`Solution ${op.solution} is not in this environment; ${op.name} not undone.`);
      continue;
    }
    if (sol.isManaged) {
      notes.push(`Solution ${op.solution} is managed; ${op.name} not undone.`);
      continue;
    }
    const component: NamedComponent = { type: op.type, id: op.id, name: op.name };
    if (op.kind === "add") ops.push({ kind: "remove", solution: sol, component, behaviorBefore: null, reason: "undo add" });
    else ops.push({ kind: "add", solution: sol, component, doNotIncludeSubcomponents: op.type === CT.Entity ? op.behaviorBefore !== 0 : false, reason: "undo remove" });
  }
  return { ops, notes };
}

export function cycleOpLabel(op: CycleOp): string {
  return op.kind === "add"
    ? `AddSolutionComponent ${typeName(op.component.type)} ${op.component.name} → ${op.solution.uniqueName}${op.doNotIncludeSubcomponents ? " (DoNotIncludeSubcomponents)" : ""}`
    : `RemoveSolutionComponent ${typeName(op.component.type)} ${op.component.name} ← ${op.solution.uniqueName}`;
}

// ---------- export ----------

export function cyclesMarkdown(a: CyclesAnalysis): string {
  const n = (id: string) => [...a.solutions, ...(a.base ? [a.base] : [])].find((s) => s.id === id)?.uniqueName ?? id;
  const out = [`# Import order · ${a.environment.name}`, "", `Solutions: ${a.solutions.map((s) => s.uniqueName).join(", ")}. Base: ${a.base?.uniqueName ?? "none"}.`, ""];
  if (a.order) out.push(`**Import order:** ${[...(a.base && !a.order.includes(a.base.id) ? [a.base.uniqueName] : []), ...a.order.map(n)].join(" → ")}`, "");
  else out.push(`**No import order:** ${a.cycles.length} cycle(s).`, "");
  for (const c of a.cycles) {
    out.push(`## Cycle ${c.map(n).join(" ⇄ ")}`, "");
    for (const r of a.fixRows.filter((x) => x.inCycle && c.includes(x.from) && c.includes(x.to))) out.push(`- [ ] ${n(r.from)} needs ${typeName(r.required.type)} ${r.required.name} from ${n(r.to)} (for ${r.dependents.map((d) => `${typeName(d.type)} ${d.name}`).join(", ")})`);
    out.push("");
  }
  const acyclic = a.fixRows.filter((r) => !r.inCycle);
  if (acyclic.length) {
    out.push(`## Cross-solution dependencies (${acyclic.length})`, "");
    for (const r of acyclic) out.push(`- ${n(r.from)} after ${n(r.to)}: ${typeName(r.required.type)} ${r.required.name} (for ${r.dependents.map((d) => d.name).join(", ")})`);
    out.push("");
  }
  if (a.orphans.length) {
    out.push(`## Required by a selected solution, carried by none (${a.orphans.length})`, "");
    for (const o of a.orphans) out.push(`- [ ] ${typeName(o.required.type)} ${o.required.name} (for ${o.dependents.map((d) => `${n(d.solution)}: ${d.component.name}`).join(", ")})`);
    out.push("");
  }
  for (const w of a.warnings) out.push(`> ${w}`, "");
  return out.join("\n");
}

export function cyclesCsv(a: CyclesAnalysis, csvCell: (v: string) => string): string {
  const n = (id: string) => [...a.solutions, ...(a.base ? [a.base] : [])].find((s) => s.id === id)?.uniqueName ?? id;
  const rows = [["from", "to", "in cycle", "required type", "required", "table", "dependents"]];
  for (const r of a.fixRows) rows.push([n(r.from), n(r.to), String(r.inCycle), typeName(r.required.type), r.required.name, r.required.table ?? "", r.dependents.map((d) => `${typeName(d.type)} ${d.name}`).join("; ")]);
  for (const o of a.orphans) rows.push(["", "(none)", "false", typeName(o.required.type), o.required.name, o.required.table ?? "", o.dependents.map((d) => `${n(d.solution)}: ${typeName(d.component.type)} ${d.component.name}`).join("; ")]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

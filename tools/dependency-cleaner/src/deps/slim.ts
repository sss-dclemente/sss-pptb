/**
 * Slim, docs/SOLUTION-SLIMMER-PLAN.md: which components of an unmanaged solution do not belong there.
 * Keep = unmanaged (ismanaged false) or managed with an unmanaged "Active" layer (msdyn_componentlayers).
 * Everything else is removed from the solution (membership only: RemoveSolutionComponent never touches the environment).
 * A managed table included with all assets becomes a shell and gets its kept subcomponents re-added (D3).
 * Anything whose state cannot be read is kept and flagged (D7).
 */
import { Cancelled } from "./diagnose";
import { assertGuid, fetchComponents, fetchOwningSolutions, lid, pool, queryAll, queryByIds, RECORD_TYPES, resolveNames, type DataverseLike, type EntityMeta, type MetaCache } from "./fetch";
import { CT, typeName, type Component, type NamedComponent, type Row, type SolutionInfo } from "./types";
import { componentDefinitions, LAYER_NAMES } from "./upgrade";
import { addRequest, removeRequest } from "./write";

export const SLIM_CONCURRENCY = 4;
const SYSTEM_SOLUTIONS = new Set(["default", "active", "basic"]);
const ENV_VAR_VALUE = 381;
const ENV_VAR_DEF = 380;

export type SlimVerdict = "unmanaged" | "customized" | "included" | "parent" | "shell" | "remove" | "unknown";

export interface SlimRow {
  /** type:objectId */
  key: string;
  component: Component;
  name: NamedComponent;
  verdict: SlimVerdict;
  /** why, in one line */
  reason: string;
  /** null = unknown */
  isManaged: boolean | null;
  /** layers, top first; empty when none / unavailable */
  layers: string[];
  /** owning managed solution (base layer) for managed components */
  owner: string | null;
  /** other unmanaged solutions (not this one, not Default) that also contain a customized component */
  alsoIn: string[];
  /** the shell plan this row belongs to, for subcomponents of an all-assets managed table */
  shellOf?: string;
  error?: string;
}

export interface ShellTable {
  /** table row key */
  key: string;
  table: NamedComponent;
  /** the table row itself stays (Active layer or kept children) */
  keepTable: boolean;
  kept: SlimRow[];
  leaving: SlimRow[];
}

export interface SlimAnalysis {
  solution: SolutionInfo;
  environment: { name: string; url: string };
  components: Component[];
  rows: SlimRow[];
  shells: ShellTable[];
  counts: Record<SlimVerdict, number> & { total: number };
  errors: { component: string; error: string }[];
  warnings: string[];
  takenAt: string;
}

export interface SlimOptions {
  api: DataverseLike;
  meta: MetaCache;
  solution: SolutionInfo;
  /** D5: keep a pristine managed parent (table, env var definition) whose child stays */
  keepParents: boolean;
  environment: { name: string; url: string };
  onProgress?: (phase: string, done: number, total: number) => void;
  cancelled?: () => boolean;
}

const key = (type: number, id: string): string => `${type}:${id}`;
const msg = (e: unknown): string => (e as Error)?.message ?? String(e);
const odataString = (v: string): string => `'${v.replace(/'/g, "''")}'`;
const named = (c: Component, n?: NamedComponent): NamedComponent => n ?? { type: c.type, id: c.objectId, name: c.name ?? c.objectId, table: c.table };

// ---------- managed flags ----------

interface Flags {
  managed: Map<string, boolean>;
  names: Map<string, NamedComponent>;
  failed: Map<string, string>;
}

/** entity set, id column, name column for a record-backed type: the static map, else solutioncomponentdefinitions.primaryentityname → metadata. */
async function recordSource(api: DataverseLike, meta: MetaCache, type: number, defs: Map<number, { name: string; entity: string | null }>): Promise<[string, string, string] | null> {
  const fixed = RECORD_TYPES[type];
  if (fixed) return [fixed[0], fixed[1], fixed[2]];
  const entity = defs.get(type)?.entity;
  if (!entity) return null;
  const e = await meta.entityByName(api, entity.toLowerCase()).catch(() => undefined);
  if (!e?.entitySetName || !e.primaryId) return null;
  return [e.entitySetName, e.primaryId, e.primaryName ?? e.primaryId];
}

/** ismanaged per component (metadata types from metadata, record types from their table), plus names. */
async function managedFlags(api: DataverseLike, meta: MetaCache, comps: Component[], defs: Map<number, { name: string; entity: string | null }>): Promise<Flags> {
  const managed = new Map<string, boolean>();
  const failed = new Map<string, string>();
  const names = new Map<string, NamedComponent>();
  const byRow = new Map(comps.map((c) => [c.rowId, c]));
  const parentOf = (c: Component): string | null => (c.rootRowId ? (byRow.get(c.rootRowId)?.objectId ?? null) : null);

  // names for every type resolveNames knows (tables, columns, relationships, common records)
  const resolved = await resolveNames(api, meta, comps.map((c) => ({ type: c.type, id: c.objectId, parentId: parentOf(c) })), failed);
  for (const [k, v] of resolved) names.set(k, v);

  const entities = await meta.entitiesById(api).catch((e) => {
    for (const c of comps) if (c.type === CT.Entity || c.type === CT.Attribute) failed.set(key(c.type, c.objectId), msg(e));
    return new Map<string, EntityMeta>();
  });
  for (const c of comps.filter((x) => x.type === CT.Entity)) {
    const e = entities.get(c.objectId);
    if (e?.isManaged != null) managed.set(key(c.type, c.objectId), e.isManaged);
    else if (!failed.has(key(c.type, c.objectId))) failed.set(key(c.type, c.objectId), e ? "IsManaged not returned by the host" : "table not found in metadata");
  }
  const byParent = new Map<string, Component[]>();
  for (const c of comps.filter((x) => x.type === CT.Attribute)) {
    const p = parentOf(c) ?? "";
    byParent.set(p, [...(byParent.get(p) ?? []), c]);
  }
  for (const [parent, list] of byParent) {
    const table = entities.get(parent)?.logicalName;
    if (!table) {
      for (const c of list) failed.set(key(c.type, c.objectId), "column without a table row in the solution");
      continue;
    }
    const attrs = await meta.attributesOf(api, table).catch((e) => {
      for (const c of list) failed.set(key(c.type, c.objectId), msg(e));
      return null;
    });
    if (!attrs) continue;
    for (const c of list) {
      const a = attrs.find((x) => x.id === c.objectId);
      if (a?.isManaged != null) managed.set(key(c.type, c.objectId), a.isManaged);
      else failed.set(key(c.type, c.objectId), a ? "IsManaged not returned by the host" : "column not found in metadata");
    }
  }
  // relationships and global choices: one metadata read each
  const single: [number, (id: string) => string, string][] = [
    [CT.EntityRelationship, (id) => `RelationshipDefinitions(${id})?$select=SchemaName,IsManaged`, "SchemaName"],
    [CT.Relationship, (id) => `RelationshipDefinitions(${id})?$select=SchemaName,IsManaged`, "SchemaName"],
    [CT.OptionSet, (id) => `GlobalOptionSetDefinitions(${id})?$select=Name,IsManaged`, "Name"],
  ];
  for (const [type, build, nameCol] of single) {
    await pool(
      comps.filter((c) => c.type === type),
      SLIM_CONCURRENCY,
      async (c) => {
        try {
          const row = (await api.queryData(build(assertGuid(c.objectId)))) as unknown as Row;
          if (typeof row?.IsManaged === "boolean") managed.set(key(c.type, c.objectId), row.IsManaged);
          else failed.set(key(c.type, c.objectId), "IsManaged not returned by the host");
          if (row?.[nameCol]) names.set(key(c.type, c.objectId), { type: c.type, id: c.objectId, name: String(row[nameCol]) });
        } catch (e) {
          failed.set(key(c.type, c.objectId), msg(e));
        }
      },
    );
  }
  // record-backed: by entity set, 40 ids per call
  const metaTypes = new Set<number>([CT.Entity, CT.Attribute, CT.EntityRelationship, CT.Relationship, CT.OptionSet]);
  const byType = new Map<number, Component[]>();
  for (const c of comps) if (!metaTypes.has(c.type)) byType.set(c.type, [...(byType.get(c.type) ?? []), c]);
  await Promise.all(
    [...byType].map(async ([type, list]) => {
      const src = await recordSource(api, meta, type, defs);
      if (!src) {
        for (const c of list) failed.set(key(c.type, c.objectId), `no table known for ${typeName(type)} (${type})`);
        return;
      }
      const [set, idCol, nameCol] = src;
      const ids = list.map((c) => c.objectId);
      let rows: Row[];
      try {
        rows = await queryByIds(api, ids, idCol, (f) => `${set}?$select=${[...new Set([idCol, nameCol, "ismanaged"])].join(",")}&$filter=${f}`);
      } catch (e) {
        // a table without ismanaged: names still help the listing, the flag stays unknown
        const err = msg(e);
        rows = await queryByIds(api, ids, idCol, (f) => `${set}?$select=${[...new Set([idCol, nameCol])].join(",")}&$filter=${f}`).catch(() => [] as Row[]);
        for (const c of list) failed.set(key(c.type, c.objectId), err);
        for (const r of rows) {
          const id = lid(r[idCol]);
          if (r[nameCol] != null) names.set(key(type, id), { type, id, name: String(r[nameCol]) });
        }
        return;
      }
      const seen = new Set<string>();
      for (const r of rows) {
        const id = lid(r[idCol]);
        seen.add(id);
        if (typeof r.ismanaged === "boolean") managed.set(key(type, id), r.ismanaged);
        else failed.set(key(type, id), "ismanaged not returned by the host");
        if (r[nameCol] != null) names.set(key(type, id), { type, id, name: String(r[nameCol]) });
      }
      for (const c of list) if (!seen.has(c.objectId)) failed.set(key(c.type, c.objectId), `${typeName(type)} not found in ${set}`);
    }),
  );
  return { managed, names, failed };
}

// ---------- layers ----------

interface LayerInfo {
  /** top first */
  layers: string[];
  active: boolean;
  owner: string | null;
}

/** Layers of every managed component: one msdyn_componentlayers read each (plan §1). Unavailable layers → `failed`. */
async function readLayers(api: DataverseLike, comps: Component[], layerName: (t: number) => string | undefined, o: SlimOptions): Promise<{ layers: Map<string, LayerInfo>; failed: Map<string, string> }> {
  const layers = new Map<string, LayerInfo>();
  const failed = new Map<string, string>();
  let done = 0;
  o.onProgress?.("Reading solution layers", 0, comps.length);
  await pool(
    comps,
    SLIM_CONCURRENCY,
    async (c) => {
      const k = key(c.type, c.objectId);
      const ln = layerName(c.type);
      if (!ln) failed.set(k, `no layer component name known for ${typeName(c.type)} (${c.type})`);
      else {
        try {
          const rows = await queryAll(api, `msdyn_componentlayers?$select=msdyn_solutionname,msdyn_order&$filter=msdyn_componentid eq ${odataString(assertGuid(c.objectId))} and msdyn_solutioncomponentname eq ${odataString(ln)}`);
          const sorted = rows.map((r) => ({ s: String(r.msdyn_solutionname ?? ""), o: Number(r.msdyn_order ?? 0) })).sort((a, b) => b.o - a.o);
          const list = sorted.map((x) => x.s);
          const base = [...sorted].reverse().find((x) => x.s.toLowerCase() !== "active")?.s ?? null;
          layers.set(k, { layers: list, active: list.some((s) => s.toLowerCase() === "active"), owner: base });
        } catch (e) {
          failed.set(k, msg(e));
        }
      }
      o.onProgress?.("Reading solution layers", ++done, comps.length);
    },
    () => !!o.cancelled?.(),
  );
  return { layers, failed };
}

// ---------- analysis ----------

export async function analyzeSlim(o: SlimOptions): Promise<SlimAnalysis> {
  const { api, meta, solution } = o;
  const cancelled = () => !!o.cancelled?.();
  const warnings: string[] = [];
  if (solution.isManaged) throw new Error(`${solution.uniqueName} is managed: nothing can be removed from it.`);

  o.onProgress?.("Reading solution membership", 0, 1);
  const components = await fetchComponents(api, solution.id);
  if (cancelled()) throw new Cancelled();
  const byRow = new Map(components.map((c) => [c.rowId, c]));
  const rootOf = (c: Component): Component | undefined => (c.rootRowId ? byRow.get(c.rootRowId) : undefined);

  // component types: layer names and backing tables
  const defs = new Map<number, { name: string; entity: string | null }>();
  try {
    const rows = await queryAll(api, "solutioncomponentdefinitions?$select=solutioncomponenttype,name,primaryentityname");
    for (const r of rows) if (r.name) defs.set(Number(r.solutioncomponenttype), { name: String(r.name), entity: r.primaryentityname ? String(r.primaryentityname) : null });
  } catch {
    const basic = await componentDefinitions(api);
    for (const [t, n] of basic) defs.set(t, { name: n, entity: null });
    if (!basic.size) warnings.push("solutioncomponentdefinitions could not be read: only the built-in component types are classified; the rest is kept as unknown.");
  }
  const layerName = (t: number): string | undefined => defs.get(t)?.name ?? LAYER_NAMES[t];

  o.onProgress?.("Reading managed flags", 0, 1);
  const flags = await managedFlags(api, meta, components, defs);
  if (cancelled()) throw new Cancelled();
  for (const c of components) {
    c.name = flags.names.get(key(c.type, c.objectId))?.name ?? c.objectId;
    c.table = flags.names.get(key(c.type, c.objectId))?.table;
  }

  const managedComps = components.filter((c) => flags.managed.get(key(c.type, c.objectId)) === true);
  const { layers, failed: layerFailed } = await readLayers(api, managedComps, layerName, o);
  if (cancelled()) throw new Cancelled();

  // other unmanaged solutions holding the customized components (D2 flag)
  const customizedIds = managedComps.filter((c) => layers.get(key(c.type, c.objectId))?.active).map((c) => c.objectId);
  const alsoIn = new Map<string, string[]>();
  if (customizedIds.length) {
    try {
      const held = await fetchOwningSolutions(api, customizedIds);
      const sids = [...new Set([...held.values()].flat())].filter((sid) => sid !== solution.id);
      const sols = sids.length ? await queryByIds(api, sids, "solutionid", (f) => `solutions?$select=solutionid,uniquename,ismanaged&$filter=${f}`) : [];
      const unmanaged = new Map(sols.filter((s) => !s.ismanaged && !SYSTEM_SOLUTIONS.has(String(s.uniquename ?? "").toLowerCase())).map((s) => [lid(s.solutionid), String(s.uniquename ?? "")]));
      for (const [id, list] of held) alsoIn.set(id, list.map((sid) => unmanaged.get(sid)).filter((x): x is string => !!x).sort());
    } catch (e) {
      warnings.push(`Other unmanaged solutions could not be read (${msg(e)}): customized components are not flagged as shared.`);
    }
  }

  // environment variable values → definitions (D5)
  const valueDef = new Map<string, string>();
  const values = components.filter((c) => c.type === ENV_VAR_VALUE);
  if (o.keepParents && values.length && components.some((c) => c.type === ENV_VAR_DEF)) {
    try {
      const rows = await queryByIds(api, values.map((c) => c.objectId), "environmentvariablevalueid", (f) => `environmentvariablevalues?$select=environmentvariablevalueid,_environmentvariabledefinitionid_value&$filter=${f}`);
      for (const r of rows) if (r._environmentvariabledefinitionid_value) valueDef.set(lid(r.environmentvariablevalueid), lid(r._environmentvariabledefinitionid_value));
    } catch (e) {
      warnings.push(`Environment variable values could not be linked to their definitions (${msg(e)}).`);
    }
  }

  // ---- classify (plan §2) ----
  const rows = new Map<string, SlimRow>();
  const errors: SlimAnalysis["errors"] = [];
  const base = (c: Component): SlimRow => {
    const k = key(c.type, c.objectId);
    const li = layers.get(k);
    return { key: k, component: c, name: named(c, flags.names.get(k)), verdict: "unknown", reason: "", isManaged: flags.managed.get(k) ?? null, layers: li?.layers ?? [], owner: li?.owner ?? null, alsoIn: alsoIn.get(c.objectId) ?? [] };
  };
  const isKeep = (r: SlimRow): boolean => r.verdict !== "remove" && r.verdict !== "shell";
  // rules 1–4 for every row
  for (const c of components) {
    const r = base(c);
    const k = r.key;
    const root = rootOf(c);
    const err = flags.failed.get(k) ?? (r.isManaged === true ? layerFailed.get(k) : undefined);
    if (r.isManaged === false) {
      r.verdict = "unmanaged";
      r.reason = "unmanaged: created in this environment";
    } else if (root && root.type === CT.Entity && root.behavior === 0 && flags.managed.get(key(root.type, root.objectId)) === false) {
      r.verdict = "included";
      r.reason = `included by ${root.name ?? "its table"} (all assets)`;
    } else if (r.isManaged === null || err) {
      r.verdict = "unknown";
      r.error = err ?? "state could not be read";
      r.reason = `kept: ${r.error}`;
      errors.push({ component: `${typeName(c.type)} ${r.name.name}`, error: r.error });
    } else if (layers.get(k)?.active) {
      r.verdict = "customized";
      r.reason = r.alsoIn.length ? `customized (Active layer); also in ${r.alsoIn.join(", ")}` : "customized: unmanaged layer on top";
    } else {
      r.verdict = "remove";
      r.reason = r.owner ? `managed, no customization: ${r.owner}'s` : "managed, no customization";
    }
    rows.set(k, r);
  }
  // rule 5: managed tables with all assets → shells; rule 6: parents of kept children
  const shells: ShellTable[] = [];
  const childrenOf = new Map<string, SlimRow[]>();
  for (const r of rows.values()) {
    const root = rootOf(r.component);
    if (root && root.rowId !== r.component.rowId) childrenOf.set(root.rowId, [...(childrenOf.get(root.rowId) ?? []), r]);
  }
  for (const r of rows.values()) {
    const c = r.component;
    if (c.type !== CT.Entity || c.rootRowId) continue;
    const children = childrenOf.get(c.rowId) ?? [];
    const keptChildren = children.filter(isKeep);
    if (r.isManaged === true && c.behavior === 0 && r.verdict !== "unknown") {
      const keepTable = r.verdict === "customized" || keptChildren.length > 0;
      r.verdict = "shell";
      r.reason = keepTable
        ? `managed table with all assets → shell, ${keptChildren.length} of ${children.length} subcomponents re-added`
        : `managed table with all assets, nothing of yours in it → removed with its ${children.length} subcomponents`;
      const sh: ShellTable = { key: r.key, table: r.name, keepTable, kept: keptChildren, leaving: children.filter((x) => !isKeep(x)) };
      shells.push(sh);
      for (const ch of children) ch.shellOf = r.key;
      continue;
    }
    if (r.verdict === "remove" && o.keepParents && keptChildren.length) {
      r.verdict = "parent";
      r.reason = `parent of ${keptChildren.length} kept subcomponent${keptChildren.length === 1 ? "" : "s"}`;
    }
  }
  if (o.keepParents)
    for (const r of rows.values()) {
      if (r.verdict !== "remove" || r.component.type !== ENV_VAR_DEF) continue;
      const kept = [...rows.values()].filter((v) => v.component.type === ENV_VAR_VALUE && isKeep(v) && valueDef.get(v.component.objectId) === r.component.objectId);
      if (kept.length) {
        r.verdict = "parent";
        r.reason = `definition of ${kept.length} kept value${kept.length === 1 ? "" : "s"}`;
      }
    }

  const list = [...rows.values()].sort((a, b) => a.component.type - b.component.type || a.name.name.localeCompare(b.name.name));
  const counts = { total: list.length, unmanaged: 0, customized: 0, included: 0, parent: 0, shell: 0, remove: 0, unknown: 0 };
  for (const r of list) counts[r.verdict]++;
  if (counts.unknown) warnings.push(`${counts.unknown} component(s) could not be classified and are kept. Open Unknown for the errors.`);
  return { solution, environment: o.environment, components, rows: list, shells, counts, errors, warnings, takenAt: new Date().toISOString() };
}

// ---------- plan ----------

export type SlimOp = { kind: "remove"; component: NamedComponent; reason: string; group: string } | { kind: "add"; component: NamedComponent; doNotIncludeSubcomponents: boolean; reason: string; group: string };

export interface SlimPlan {
  ops: SlimOp[];
  /** rows the plan removes (overrides applied) */
  removing: SlimRow[];
  shells: number;
}

/**
 * Operations for the analysis with the user's overrides: `overrides` maps a row key to true (remove) or false (keep).
 * A default comes from the verdict: remove / shell rows are removed, every other row stays.
 */
export function planSlim(a: SlimAnalysis, overrides: Map<string, boolean>): SlimPlan {
  const remove = (r: SlimRow): boolean => overrides.get(r.key) ?? (r.verdict === "remove" || r.verdict === "shell");
  const ops: SlimOp[] = [];
  const removing: SlimRow[] = [];
  const done = new Set<string>();
  let shells = 0;
  for (const sh of a.shells) {
    const tableRow = a.rows.find((r) => r.key === sh.key)!;
    if (!remove(tableRow)) continue; // kept as all assets by override
    const children = a.rows.filter((r) => r.shellOf === sh.key);
    const kept = children.filter((r) => !remove(r));
    const leaving = children.filter(remove);
    const keepTable = sh.keepTable || kept.length > 0 || overrides.get(sh.key) === false;
    if (!leaving.length) continue; // nothing leaves: converting changes nothing
    const g = `shell:${sh.key}`;
    ops.push({ kind: "remove", component: sh.table, reason: keepTable ? `convert ${sh.table.name} to a shell` : `remove ${sh.table.name} with all its subcomponents`, group: g });
    if (keepTable) {
      ops.push({ kind: "add", component: sh.table, doNotIncludeSubcomponents: true, reason: "re-add as shell (no subcomponents)", group: g });
      for (const r of kept) ops.push({ kind: "add", component: r.name, doNotIncludeSubcomponents: false, reason: `keep: ${r.reason}`, group: g });
    }
    shells++;
    removing.push(...leaving, ...(keepTable ? [] : [tableRow]));
    done.add(sh.key);
    for (const r of children) done.add(r.key);
  }
  // plain removals: subcomponent rows first, then roots
  const plain = a.rows.filter((r) => !done.has(r.key) && remove(r)).sort((x, y) => Number(!x.component.rootRowId) - Number(!y.component.rootRowId));
  for (const r of plain) {
    ops.push({ kind: "remove", component: r.name, reason: r.reason, group: `remove:${r.key}` });
    removing.push(r);
  }
  const seen = new Set<string>();
  return {
    ops: ops.filter((op) => {
      const k = `${op.kind}:${op.component.type}:${op.component.id}:${op.kind === "add" ? op.doNotIncludeSubcomponents : ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
    removing,
    shells,
  };
}

export interface SlimOpResult {
  op: SlimOp;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

/** D9: a failure skips the rest of its group (a shell conversion); every other group still runs. */
export async function executeSlim(api: DataverseLike, ops: SlimOp[], solution: string, onStep?: (i: number, n: number) => void): Promise<SlimOpResult[]> {
  const out: SlimOpResult[] = [];
  const failedGroups = new Set<string>();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    onStep?.(i, ops.length);
    if (failedGroups.has(op.group)) {
      out.push({ op, ok: false, skipped: true, error: "not run: an earlier step of this table failed" });
      continue;
    }
    try {
      if (op.kind === "remove") await api.execute(removeRequest(op.component, solution));
      else await api.execute(addRequest(op.component, solution, op.doNotIncludeSubcomponents));
      out.push({ op, ok: true });
    } catch (e) {
      failedGroups.add(op.group);
      out.push({ op, ok: false, error: msg(e) });
    }
  }
  onStep?.(ops.length, ops.length);
  return out;
}

export function slimOpLabel(op: SlimOp): string {
  return op.kind === "remove"
    ? `RemoveSolutionComponent ${typeName(op.component.type)} ${op.component.name}`
    : `AddSolutionComponent ${typeName(op.component.type)} ${op.component.name}${op.doNotIncludeSubcomponents ? " (DoNotIncludeSubcomponents)" : ""}`;
}

// ---------- export ----------

export const VERDICT_LABEL: Record<SlimVerdict, string> = {
  remove: "Remove",
  shell: "Convert to shell",
  customized: "Keep: customized managed",
  unmanaged: "Keep: unmanaged",
  included: "Keep: included by its table",
  parent: "Keep: parent of a kept component",
  unknown: "Unknown: kept",
};

export function slimCsv(a: SlimAnalysis, csvCell: (v: string) => string): string {
  const rows = [["verdict", "type", "name", "table", "managed", "layers", "owner", "also in", "reason"]];
  for (const r of a.rows) rows.push([VERDICT_LABEL[r.verdict], typeName(r.component.type), r.name.name, r.name.table ?? "", r.isManaged === null ? "unknown" : String(r.isManaged), r.layers.join(" > "), r.owner ?? "", r.alsoIn.join("; "), r.reason]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

export function slimMarkdown(a: SlimAnalysis): string {
  const c = a.counts;
  const out = [
    `# Slim ${a.solution.uniqueName} ${a.solution.version} (${a.environment.name})`,
    "",
    `${c.total} components: ${c.remove} to remove, ${c.shell} table(s) to convert to a shell, ${c.customized} customized managed kept, ${c.unmanaged} unmanaged, ${c.parent} parent(s) kept, ${c.included} included by an unmanaged table, ${c.unknown} unknown (kept).`,
    "",
  ];
  const section = (title: string, verdict: SlimVerdict) => {
    const list = a.rows.filter((r) => r.verdict === verdict);
    if (!list.length) return;
    out.push(`## ${title} (${list.length})`, "");
    for (const r of list) out.push(`- [ ] ${typeName(r.component.type)} ${r.name.name}${r.name.table ? ` (${r.name.table})` : ""} · ${r.reason}`);
    out.push("");
  };
  section("Remove", "remove");
  section("Convert to shell", "shell");
  section("Unknown, kept", "unknown");
  section("Keep: customized managed", "customized");
  for (const w of a.warnings) out.push(`> ${w}`, "");
  return out.join("\n");
}

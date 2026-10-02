import type { SolutionInfo } from "./types";

export interface DiffEntry {
  category: string;
  name: string;
  change: "added" | "removed" | "changed";
  /** "changed": the changed fields as `Label: before → after`, joined with "; " */
  detail?: string;
  /** "changed": only the fields that differ */
  fields?: FieldChange[];
  /** "changed": every compared field, labelled (`Label: value · …`), before and after */
  before?: string;
  after?: string;
}

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export interface SolutionDiff {
  a: { name: string; version: string; managed: boolean };
  b: { name: string; version: string; managed: boolean };
  sameSolution: boolean;
  versionOrder: "upgrade" | "downgrade" | "same" | "unknown";
  entries: DiffEntry[];
  counts: { added: number; removed: number; changed: number };
}

/** Compare dotted versions numerically segment by segment. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  if (pa.some(isNaN) || pb.some(isNaN) || !a || !b) return NaN;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** A compared property: label + display value ("—" when empty, yes/no for flags). */
interface Field {
  label: string;
  value: string;
}

/** stable key -> { display name, compared fields } */
type Keyed = Map<string, { name: string; fields: Field[] }>;

type Raw = string | number | boolean | null | undefined;

function show(v: Raw): string {
  if (v == null || v === "") return "—";
  return typeof v === "boolean" ? (v ? "yes" : "no") : String(v);
}

const BEHAVIOR: Record<number, string> = { 0: "include subcomponents", 1: "no subcomponents", 2: "shell only" };

const labelled = (fields: Field[]): string => fields.map((f) => `${f.label}: ${f.value}`).join(" · ");

function categories(s: SolutionInfo): Record<string, Keyed> {
  const out: Record<string, Keyed> = {};
  /** key defaults to the display name; pass a stable id-based key when names are not unique */
  const put = (cat: string, name: string, fields: [string, Raw][] = [], key = name) => {
    (out[cat] ??= new Map()).set(key, { name, fields: fields.map(([label, v]) => ({ label, value: show(v) })) });
  };

  for (const e of s.entities) {
    put("Table", e.name, [["Display name", e.displayName], ["Forms", e.forms], ["Views", e.views], ["Charts", e.charts], ["Ribbon", e.hasRibbon]]);
    for (const a of e.attributes) put("Column", `${e.name}.${a.name}`, [["Type", a.type]]);
  }
  for (const r of s.relationships) put("Relationship", r.name, [["Type", r.type], ["Referencing", r.referencing], ["Referenced", r.referenced]]);
  for (const o of s.optionSets) put("Global choice", o.name);
  for (const r of s.roles) put("Security role", r.name);
  for (const w of s.workflows) {
    // Same-named processes (e.g. business rules) exist on different tables: key by workflow id, else table + name.
    const entity = w.primaryEntity && w.primaryEntity !== "none" ? w.primaryEntity : null;
    const id = w.id?.replace(/[{}]/g, "").toLowerCase();
    const key = id ? `id:${id}` : `name:${(entity ?? "").toLowerCase()}/${w.name}`;
    put("Process / flow", entity ? `${w.name} (${entity})` : w.name, [["Category", w.categoryName], ["Primary table", w.primaryEntity], ["Connection references", w.connectionReferences.join(", ")]], key);
  }
  for (const w of s.webResources) put("Web resource", w.name, [["Type", w.detail]]);
  for (const a of s.appModules) put("Model-driven app", a.name);
  for (const c of s.canvasApps) put("Canvas app", c.name);
  for (const c of s.connectionReferences) put("Connection reference", c.logicalName, [["Connector", c.connector]]);
  for (const e of s.environmentVariables) put("Environment variable", e.schemaName, [["Type", e.type], ["Has default", e.hasDefault], ["Has value", e.hasValue]]);
  for (const p of s.pluginAssemblies) put("Plugin assembly", p.name, [["Full name", p.detail]]);
  for (const p of s.pluginSteps) put("Plugin step", p.name, [["Plugin type", p.pluginType], ["Message", p.message], ["Table", p.entity], ["Stage", p.stage]]);
  for (const c of s.customControls) put("Custom control", c.name);
  for (const f of s.fieldSecurityProfiles) put("Column security profile", f.name);
  for (const rc of s.rootComponents) put("Root component", `${rc.typeName}: ${rc.schemaName ?? rc.id ?? "?"}`, [["Behavior", `${rc.behavior}${BEHAVIOR[rc.behavior] ? ` (${BEHAVIOR[rc.behavior]})` : ""}`]]);
  return out;
}

export function diffSolutions(a: SolutionInfo, b: SolutionInfo): SolutionDiff {
  const ca = categories(a);
  const cb = categories(b);
  const entries: DiffEntry[] = [];
  const cats = new Set([...Object.keys(ca), ...Object.keys(cb)]);

  for (const cat of cats) {
    const ma: Keyed = ca[cat] ?? new Map();
    const mb: Keyed = cb[cat] ?? new Map();
    for (const [key, { name, fields }] of mb) {
      const prev = ma.get(key);
      if (!prev) {
        entries.push({ category: cat, name, change: "added" });
        continue;
      }
      const changed: FieldChange[] = fields
        .map((f, i) => ({ field: f.label, before: prev.fields[i]?.value ?? "—", after: f.value }))
        .filter((f) => f.before !== f.after);
      if (changed.length)
        entries.push({
          category: cat,
          name,
          change: "changed",
          detail: changed.map((f) => `${f.field}: ${f.before} → ${f.after}`).join("; "),
          fields: changed,
          before: labelled(prev.fields),
          after: labelled(fields),
        });
    }
    for (const [key, { name }] of ma) if (!mb.has(key)) entries.push({ category: cat, name, change: "removed" });
  }

  const order = { removed: 0, changed: 1, added: 2 };
  entries.sort((x, y) => x.category.localeCompare(y.category) || order[x.change] - order[y.change] || x.name.localeCompare(y.name));

  const cmp = compareVersions(a.version, b.version);
  return {
    a: { name: a.uniqueName, version: a.version, managed: a.managed },
    b: { name: b.uniqueName, version: b.version, managed: b.managed },
    sameSolution: a.uniqueName === b.uniqueName,
    versionOrder: isNaN(cmp) ? "unknown" : cmp < 0 ? "upgrade" : cmp > 0 ? "downgrade" : "same",
    entries,
    counts: {
      added: entries.filter((e) => e.change === "added").length,
      removed: entries.filter((e) => e.change === "removed").length,
      changed: entries.filter((e) => e.change === "changed").length,
    },
  };
}

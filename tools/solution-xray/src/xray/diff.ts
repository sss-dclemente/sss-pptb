import type { SolutionInfo } from "./types";

export interface DiffEntry {
  category: string;
  name: string;
  change: "added" | "removed" | "changed";
  detail?: string;
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

/** stable key -> { display name, fingerprint } */
type Keyed = Map<string, { name: string; fp: string }>;

function fingerprint(parts: (string | number | boolean | null | undefined)[]): string {
  return parts.map((p) => (p == null ? "" : String(p))).join("|");
}

function categories(s: SolutionInfo): Record<string, Keyed> {
  const out: Record<string, Keyed> = {};
  /** key defaults to the display name; pass a stable id-based key when names are not unique */
  const put = (cat: string, name: string, fp = "", key = name) => {
    (out[cat] ??= new Map()).set(key, { name, fp });
  };

  for (const e of s.entities) {
    put("Table", e.name, fingerprint([e.displayName, e.forms, e.views, e.charts, e.hasRibbon]));
    for (const a of e.attributes) put("Column", `${e.name}.${a.name}`, a.type);
  }
  for (const r of s.relationships) put("Relationship", r.name, fingerprint([r.type, r.referencing, r.referenced]));
  for (const o of s.optionSets) put("Global choice", o.name);
  for (const r of s.roles) put("Security role", r.name);
  for (const w of s.workflows) {
    // Same-named processes (e.g. business rules) exist on different tables: key by workflow id, else table + name.
    const entity = w.primaryEntity && w.primaryEntity !== "none" ? w.primaryEntity : null;
    const id = w.id?.replace(/[{}]/g, "").toLowerCase();
    const key = id ? `id:${id}` : `name:${(entity ?? "").toLowerCase()}/${w.name}`;
    put("Process / flow", entity ? `${w.name} (${entity})` : w.name, fingerprint([w.category, w.primaryEntity, w.connectionReferences.join(",")]), key);
  }
  for (const w of s.webResources) put("Web resource", w.name, w.detail ?? "");
  for (const a of s.appModules) put("Model-driven app", a.name);
  for (const c of s.canvasApps) put("Canvas app", c.name);
  for (const c of s.connectionReferences) put("Connection reference", c.logicalName, c.connector ?? "");
  for (const e of s.environmentVariables) put("Environment variable", e.schemaName, fingerprint([e.type, e.hasDefault, e.hasValue]));
  for (const p of s.pluginAssemblies) put("Plugin assembly", p.name, p.detail ?? "");
  for (const p of s.pluginSteps) put("Plugin step", p.name, fingerprint([p.pluginType, p.message, p.entity, p.stage]));
  for (const c of s.customControls) put("Custom control", c.name);
  for (const f of s.fieldSecurityProfiles) put("Column security profile", f.name);
  for (const rc of s.rootComponents) put("Root component", `${rc.typeName}: ${rc.schemaName ?? rc.id ?? "?"}`, String(rc.behavior));
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
    for (const [key, { name, fp }] of mb) {
      const prev = ma.get(key);
      if (!prev) entries.push({ category: cat, name, change: "added" });
      else if (prev.fp !== fp) entries.push({ category: cat, name, change: "changed", detail: `${prev.fp} → ${fp}` });
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

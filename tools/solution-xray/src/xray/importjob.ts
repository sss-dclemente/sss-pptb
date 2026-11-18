/**
 * Import job log parser: the `importjob.data` XML (`<importexportxml>`) Dataverse writes for every solution import.
 * Pure: no DOM beyond DOMParser, no host calls. The UI lives in ../postimport.ts.
 *
 * Shape (both forms occur, so both are read):
 *   <importexportxml progress="100" processed="true">
 *     <solutionManifests><solutionManifest id="Contoso" ...><UniqueName/>…<result result="success" errorcode="0" errortext=""/></solutionManifest></solutionManifests>
 *     <entities><entity id="contoso_project" LocalizedName="Project"><result result="failure" errorcode="0x80044339" errortext="…"/></entity></entities>
 *     <workflows><workflow id="{guid}" name="Notify" result="warning" errorcode="…" errortext="…"/></workflows>
 *   </importexportxml>
 * A component is any element that carries a `result` attribute or owns `<result>` children (directly or in `<results>`).
 */
import type { SolutionInfo } from "./types";

export type ImportResult = "failure" | "warning" | "success" | "unknown";

export interface ImportComponent {
  /** Display label of the collection, e.g. "Table", "Process". */
  type: string;
  /** Raw collection element name, e.g. "entities". */
  collection: string;
  /** Best display name: LocalizedName, name, id. */
  name: string;
  /** Schema / logical name used to match the zip's inventory (id unless it is a guid, else name). */
  key: string;
  id: string | null;
  result: ImportResult;
  /** Raw result attribute value as written by Dataverse. */
  rawResult: string;
  errorCode: string;
  errorText: string;
  /** Number of `<result>` entries merged into this row (worst wins). */
  results: number;
}

export interface ImportJob {
  solution: {
    uniqueName: string;
    displayName: string;
    version: string;
    managed: boolean | null;
    result: ImportResult;
    errorCode: string;
    errorText: string;
  } | null;
  progress: string | null;
  components: ImportComponent[];
  warnings: string[];
}

export interface TypeCount {
  type: string;
  total: number;
  failure: number;
  warning: number;
  success: number;
  unknown: number;
}

export interface ErrorCodeCount {
  code: string;
  count: number;
  /** First error text seen with this code. */
  sample: string;
}

const RANK: Record<ImportResult, number> = { failure: 0, warning: 1, unknown: 2, success: 3 };

/** Collection element (lower-cased) → display type. Unknown collections show their element name. */
const TYPE_LABELS: Record<string, string> = {
  entities: "Table",
  optionsets: "Choice",
  workflows: "Process",
  webresources: "Web resource",
  roles: "Security role",
  securityroles: "Security role",
  connectionreferences: "Connection reference",
  environmentvariabledefinitions: "Environment variable",
  environmentvariablevalues: "Environment variable value",
  appmodules: "Model-driven app",
  canvasapps: "Canvas app",
  sitemaps: "Site map",
  pluginassemblies: "Plugin assembly",
  solutionpluginassemblies: "Plugin assembly",
  sdkmessageprocessingsteps: "Plugin step",
  customcontrols: "PCF control",
  entityrelationships: "Relationship",
  fieldsecurityprofiles: "Column security profile",
  dashboards: "Dashboard",
  reports: "Report",
  templates: "Template",
  entitymaps: "Column mapping",
  customapis: "Custom API",
  nodes: "Node",
  languages: "Language",
};

export const normalizeResult = (v: string | null | undefined): ImportResult => {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "failure" || s === "failed" || s === "error") return "failure";
  if (s === "warning") return "warning";
  if (s === "success") return "success";
  return "unknown";
};

/** "0", "0x0", "0x00000000" and blanks are no error code. */
const cleanCode = (v: string | null | undefined): string => {
  const s = (v ?? "").trim();
  return /^(0|0x0+)$/i.test(s) ? "" : s;
};

const isGuid = (s: string): boolean => /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i.test(s);

/** Case-insensitive attribute read (the log mixes LocalizedName / localizedname). */
function attr(el: Element, name: string): string | null {
  const direct = el.getAttribute(name);
  if (direct !== null) return direct;
  const lower = name.toLowerCase();
  for (const a of Array.from(el.attributes)) if (a.name.toLowerCase() === lower) return a.value;
  return null;
}

const childText = (el: Element, tag: string): string | null => {
  for (const c of Array.from(el.children)) if (c.localName.toLowerCase() === tag.toLowerCase()) return c.textContent?.trim() || null;
  return null;
};

interface RawResult {
  result: string;
  errorCode: string;
  errorText: string;
}

const readResult = (el: Element): RawResult => ({ result: attr(el, "result") ?? "", errorCode: cleanCode(attr(el, "errorcode")), errorText: (attr(el, "errortext") ?? "").trim() });

/** Worst of several results; on a tie the first with an error code or text. */
function worst(list: RawResult[]): RawResult {
  return list.reduce((a, b) => {
    const ra = RANK[normalizeResult(a.result)];
    const rb = RANK[normalizeResult(b.result)];
    if (rb < ra) return b;
    if (rb === ra && !(a.errorCode || a.errorText) && (b.errorCode || b.errorText)) return b;
    return a;
  });
}

/** Element that owns a `<result>`: its parent, or the grandparent when the parent is a `<results>` wrapper. */
function ownerOf(resultEl: Element): Element | null {
  const p = resultEl.parentElement;
  if (!p) return null;
  return p.localName.toLowerCase() === "results" ? p.parentElement : p;
}

/** Parse the import job XML. Throws on text that is not XML or not an import job log. */
export function parseImportJob(xml: string): ImportJob {
  const text = xml.replace(/^﻿/, "").trim();
  if (!text) throw new Error("The import job log is empty.");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) {
    // Chromium wraps the message in "This page contains the following errors: … Below is a rendering …"
    const msg = (err.textContent ?? "").replace(/^[\s\S]*?(error on line)/i, "$1").replace(/Below is a rendering[\s\S]*$/i, "").trim();
    throw new Error(`Not valid XML: ${msg.slice(0, 200)}`);
  }
  const root = doc.documentElement;
  const rootName = root.localName.toLowerCase();
  if (rootName === "workbook") throw new Error("This is the formatted (Excel XML) import log. Open the import job's data XML (<importexportxml>) instead.");
  if (rootName !== "importexportxml") throw new Error(`Not an import job log: root element is <${root.localName}>, expected <importexportxml>.`);

  const warnings: string[] = [];
  const owners = new Map<Element, RawResult[]>();
  const add = (owner: Element | null, r: RawResult) => {
    if (!owner || owner === root) return;
    (owners.get(owner) ?? owners.set(owner, []).get(owner)!).push(r);
  };
  for (const el of Array.from(root.getElementsByTagName("*"))) {
    const tag = el.localName.toLowerCase();
    if (tag === "result") {
      if (attr(el, "result") !== null) add(ownerOf(el), readResult(el));
    } else if (tag !== "results" && attr(el, "result") !== null) add(el, readResult(el));
  }

  let solution: ImportJob["solution"] = null;
  const components: ImportComponent[] = [];
  for (const [el, list] of owners) {
    const r = worst(list);
    const result = normalizeResult(r.result);
    if (el.localName.toLowerCase() === "solutionmanifest") {
      if (solution) {
        warnings.push("More than one solution manifest in the log; the first is shown in the summary.");
        continue;
      }
      const uniqueName = childText(el, "UniqueName") ?? attr(el, "id") ?? "";
      const managed = childText(el, "Managed");
      solution = {
        uniqueName,
        displayName: attr(el, "LocalizedName") ?? uniqueName,
        version: childText(el, "Version") ?? "",
        managed: managed === null ? null : managed !== "0",
        result,
        errorCode: r.errorCode,
        errorText: r.errorText,
      };
      continue;
    }
    const parent = el.parentElement;
    const collection = parent && parent !== root ? parent.localName : el.localName;
    const id = attr(el, "id");
    const named = attr(el, "name") ?? attr(el, "schemaname") ?? childText(el, "UniqueName");
    const key = id && !isGuid(id) ? id : named ?? id ?? el.localName;
    components.push({
      type: TYPE_LABELS[collection.toLowerCase()] ?? collection,
      collection,
      name: attr(el, "LocalizedName") || named || id || el.localName,
      key,
      id,
      result,
      rawResult: r.result,
      errorCode: r.errorCode,
      errorText: r.errorText,
      results: list.length,
    });
  }
  if (!solution) warnings.push("No solution manifest result in the log.");
  if (!components.length) warnings.push("No component results in the log.");
  return { solution, progress: attr(root, "progress"), components: sortComponents(components), warnings };
}

/** Failures, then warnings, then unknown, then successes; by type and name within each. */
export function sortComponents(list: ImportComponent[]): ImportComponent[] {
  return [...list].sort((a, b) => RANK[a.result] - RANK[b.result] || a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

export const isProblem = (c: ImportComponent): boolean => c.result === "failure" || c.result === "warning";

export function countByType(list: ImportComponent[]): TypeCount[] {
  const m = new Map<string, TypeCount>();
  for (const c of list) {
    const t = m.get(c.type) ?? m.set(c.type, { type: c.type, total: 0, failure: 0, warning: 0, success: 0, unknown: 0 }).get(c.type)!;
    t.total++;
    t[c.result]++;
  }
  return [...m.values()].sort((a, b) => b.failure - a.failure || b.warning - a.warning || b.total - a.total || a.type.localeCompare(b.type));
}

/** Error codes on failures and warnings, most frequent first. */
export function topErrorCodes(list: ImportComponent[], limit = 10): ErrorCodeCount[] {
  const m = new Map<string, ErrorCodeCount>();
  for (const c of list) {
    if (!c.errorCode || !isProblem(c)) continue;
    const e = m.get(c.errorCode) ?? m.set(c.errorCode, { code: c.errorCode, count: 0, sample: c.errorText }).get(c.errorCode)!;
    e.count++;
    if (!e.sample) e.sample = c.errorText;
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, limit);
}

/** RFC 4180 quoting; cells a spreadsheet would read as a formula get a leading apostrophe. */
function csvCell(v: string | number | null | undefined): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function importJobCsv(list: ImportComponent[]): string {
  const rows = [["component", "key", "type", "result", "error code", "error text"], ...list.map((c) => [c.name, c.key, c.type, c.result, c.errorCode, c.errorText])];
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export interface InventoryLink {
  solution: SolutionInfo;
  /** Name as the Inventory tab shows it (search for it there). */
  name: string;
}

const stripBraces = (s: string): string => s.replace(/[{}]/g, "").toLowerCase();

/** Names (lower-cased) a loaded zip defines, mapped to the spelling its Inventory shows. Guids for processes. */
function inventoryNames(s: SolutionInfo): Map<string, string> {
  const m = new Map<string, string>();
  const put = (k: string | null | undefined, shown: string) => {
    if (k && !m.has(k.toLowerCase())) m.set(k.toLowerCase(), shown);
  };
  for (const e of s.entities) put(e.name, e.name);
  for (const w of s.workflows) {
    put(w.id ? stripBraces(w.id) : null, w.name);
    put(w.name, w.name);
  }
  for (const c of s.connectionReferences) put(c.logicalName, c.logicalName);
  for (const v of s.environmentVariables) put(v.schemaName, v.schemaName);
  for (const list of [s.optionSets, s.roles, s.webResources, s.appModules, s.canvasApps, s.pluginAssemblies, s.customControls, s.fieldSecurityProfiles]) for (const n of list) put(n.name, n.name);
  for (const p of s.pluginSteps) put(p.name, p.name);
  for (const r of s.relationships) put(r.name, r.name);
  return m;
}

/**
 * Link each component to the loaded zip that defines the same schema name (the job's own solution first).
 * Keyed by the component object.
 */
export function linkToInventory(job: ImportJob, solutions: SolutionInfo[]): Map<ImportComponent, InventoryLink> {
  const out = new Map<ImportComponent, InventoryLink>();
  if (!solutions.length) return out;
  const wanted = job.solution?.uniqueName.toLowerCase();
  const ordered = [...solutions].sort((a, b) => Number(b.uniqueName.toLowerCase() === wanted) - Number(a.uniqueName.toLowerCase() === wanted));
  const indexes = ordered.map((s) => [s, inventoryNames(s)] as const);
  for (const c of job.components) {
    const probes = [c.key, c.id ? stripBraces(c.id) : null].filter((p): p is string => !!p).map((p) => p.toLowerCase());
    for (const [s, names] of indexes) {
      const hit = probes.map((p) => names.get(p)).find(Boolean);
      if (hit) {
        out.set(c, { solution: s, name: hit });
        break;
      }
    }
  }
  return out;
}

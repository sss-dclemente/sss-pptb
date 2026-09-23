/**
 * Offline diagnosis: read solution.xml <MissingDependencies> from an exported solution zip.
 * That is the exact list `pac solution import` checks. No connection needed.
 */
import JSZip from "jszip";
import { matchesFilter } from "./classify";
import { typeName } from "./types";

export interface OfflineRef {
  type: number;
  typeName: string;
  schemaName: string | null;
  displayName: string | null;
  id: string | null;
  /** solution unique name without the trailing "(1.2.3.4)" */
  solution: string | null;
  parentSchemaName: string | null;
}

export interface OfflineGroup {
  key: string;
  dependent: OfflineRef;
  required: (OfflineRef & { safe: boolean })[];
  status: "blocker" | "safe";
}

export interface OfflineResult {
  fileName: string;
  uniqueName: string;
  version: string;
  managed: boolean;
  total: number;
  groups: OfflineGroup[];
}

const attr = (el: Element | null, n: string): string | null => {
  const v = el?.getAttribute(n);
  return v == null || v === "" ? null : v;
};

function ref(el: Element | null): OfflineRef {
  const type = Number(attr(el, "type") ?? 0);
  const sol = attr(el, "solution");
  return {
    type,
    typeName: typeName(type),
    schemaName: attr(el, "schemaName"),
    displayName: attr(el, "displayName"),
    id: attr(el, "id"),
    solution: sol ? sol.replace(/\s*\([\d.]+\)\s*$/, "").trim() || null : null,
    parentSchemaName: attr(el, "parentSchemaName"),
  };
}

export const refName = (r: OfflineRef): string => r.schemaName ?? r.displayName ?? r.id ?? "(unnamed)";

/** Parse solution.xml text. Exported for tests. */
export function parseSolutionXml(xml: string): { uniqueName: string; version: string; managed: boolean; missing: { required: OfflineRef; dependent: OfflineRef }[] } {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("solution.xml: invalid XML");
  const m = doc.querySelector("ImportExportXml > SolutionManifest");
  if (!m) throw new Error("solution.xml: SolutionManifest not found");
  const txt = (sel: string) => m.querySelector(sel)?.textContent?.trim() ?? "";
  const missing = Array.from(m.querySelectorAll(":scope > MissingDependencies > MissingDependency")).map((md) => ({
    required: ref(md.querySelector(":scope > Required")),
    dependent: ref(md.querySelector(":scope > Dependent")),
  }));
  return { uniqueName: txt(":scope > UniqueName"), version: txt(":scope > Version"), managed: txt(":scope > Managed") !== "0" && txt(":scope > Managed") !== "", missing };
}

/**
 * Group by dependent, keep required components in scope of the filter (solution name or component prefix).
 * With a target, a required solution present there is marked safe.
 */
export function groupMissing(missing: { required: OfflineRef; dependent: OfflineRef }[], filter: string[], targetSolutions: Set<string> | null): OfflineGroup[] {
  const groups = new Map<string, OfflineGroup>();
  for (const md of missing) {
    const r = md.required;
    const inFilter = matchesFilter(filter, null, refName(r)) || (!!r.solution && matchesFilter(filter, { uniqueName: r.solution, prefix: "" }, refName(r)));
    const present = !!r.solution && !!targetSolutions?.has(r.solution.toLowerCase());
    if (!inFilter && !(targetSolutions && r.solution && !present)) continue;
    const d = md.dependent;
    const key = `${d.type}:${(d.id ?? refName(d)).toLowerCase()}:${d.parentSchemaName ?? ""}`;
    const g = groups.get(key) ?? { key, dependent: d, required: [], status: "safe" as const };
    if (!g.required.some((x) => x.type === r.type && refName(x) === refName(r))) g.required.push({ ...r, safe: present });
    if (!present) g.status = "blocker";
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.status === b.status ? 0 : a.status === "blocker" ? -1 : 1) || a.dependent.type - b.dependent.type || refName(a.dependent).localeCompare(refName(b.dependent)));
}

export async function readSolutionZip(fileName: string, data: Uint8Array, filter: string[], targetSolutions: Set<string> | null): Promise<OfflineResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error(`${fileName}: not a zip file`);
  }
  const entry = zip.file(/^solution\.xml$/i)[0];
  if (!entry) throw new Error(`${fileName}: solution.xml not found (is this a solution export?)`);
  const parsed = parseSolutionXml(await entry.async("string"));
  return { fileName, uniqueName: parsed.uniqueName, version: parsed.version, managed: parsed.managed, total: parsed.missing.length, groups: groupMissing(parsed.missing, filter, targetSolutions) };
}

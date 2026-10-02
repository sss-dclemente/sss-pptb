/**
 * Power Platform API calls (window.powerplatformAPI, ToolBox ≥ 1.2.6), api-version 2024-10-01:
 *   EnvironmentManagement  GET environments
 *   AppManagement          GET environments/{id}/applicationPackages?appInstallState=Installed|NotInstalled
 *                          POST environments/{id}/applicationPackages/{uniqueName}/install
 *                          GET environments/{id}/operations/{operationId}
 * The host prefixes the category base URL (https://api.powerplatform.com/<category>/) and returns the body only.
 * Response shapes are read defensively: see docs/D365-APPS-PLAN.md §1 and §5 (probe).
 */
import type { Environment, Package } from "./types";

export const API_VERSION = "2024-10-01";
const MAX_PAGES = 50;

type Obj = Record<string, unknown>;

export interface CategoryLike {
  Get: (path?: string, target?: "primary" | "secondary", headers?: Record<string, string>) => Promise<Obj>;
  Post: (path?: string, body?: unknown, target?: "primary" | "secondary", headers?: Record<string, string>) => Promise<Obj>;
}

export interface PpLike {
  EnvironmentManagement: CategoryLike;
  AppManagement: CategoryLike;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

/** The host wraps errors as "Error invoking remote method 'powerplatform.request': Error: Power Platform request failed: HTTP 400". */
export const errText = (e: unknown): string =>
  String((e as Error)?.message ?? e)
    .replace(/^.*Power Platform request failed:\s*/is, "")
    .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/i, "");

/** Failures that mean the connection is not set up for the Power Platform API (or lacks a permission). */
export function isSetupError(e: unknown): boolean {
  return /\b40[13]\b|unauthori[sz]ed|forbidden|no access token|not enabled|consent|aadsts|insufficient (privileges|scope)|authentication expired/i.test(String((e as Error)?.message ?? e));
}

/** `https://api.powerplatform.com/<category>/x?y` → `x?y` (what the host expects after the category base). */
export function relativePath(link: string, category: string): string {
  const m = link.match(new RegExp(`^https?://[^/]+/${category}/(.*)$`, "i"));
  return m ? m[1] : link;
}

async function getAll(cat: CategoryLike, category: string, path: string): Promise<Obj[]> {
  const out: Obj[] = [];
  const seen = new Set<string>();
  let next: string | null = path;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const r = obj(await cat.Get(next));
    if (Array.isArray(r.value)) out.push(...(r.value as Obj[]));
    const link = str(r["@odata.nextLink"]) ?? str(r["@odata.nextlink"]) ?? str(r.nextLink);
    next = link ? relativePath(link, category) : null;
    if (next && seen.has(next)) throw new Error(`paging loop at ${next}`);
    if (next) seen.add(next);
  }
  return out;
}

// ---------- environments ----------

export function normalizeEnvironment(r: Obj): Environment | null {
  const p = obj(r.properties);
  const id = str(r.id) ?? str(r.name);
  if (!id) return null;
  const linked = obj(p.linkedEnvironmentMetadata);
  const url = str(r.url) ?? str(linked.instanceUrl);
  return {
    // BAP-style ids look like /providers/…/environments/<id>
    id: id.split("/").pop() ?? id,
    name: str(r.displayName) ?? str(p.displayName) ?? id,
    type: str(r.type) ?? str(p.environmentSku) ?? "",
    state: str(r.state) ?? str(obj(p.states).management) ?? "",
    url,
    geo: str(r.geo) ?? str(r.azureRegion) ?? str(p.azureRegion),
    hasDataverse: !!(str(r.dataverseId) ?? url ?? str(linked.resourceId)),
  };
}

export async function listEnvironments(pp: PpLike): Promise<Environment[]> {
  const rows = await getAll(pp.EnvironmentManagement, "environmentmanagement", `environments?api-version=${API_VERSION}`);
  return rows
    .map(normalizeEnvironment)
    .filter((e): e is Environment => !!e)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- packages ----------

export function normalizePackage(r: Obj): Package | null {
  const uniqueName = str(r.uniqueName) ?? str(r.packageUniqueName) ?? str(r.applicationUniqueName);
  if (!uniqueName) return null;
  const last = obj(r.lastOperation);
  return {
    uniqueName,
    name: str(r.localizedName) ?? str(r.applicationName) ?? uniqueName,
    version: str(r.version) ?? str(r.packageVersion),
    state: str(r.state) ?? str(last.state) ?? "",
    publisher: str(r.publisherName),
    customHandleUpgrade: r.customHandleUpgrade === true,
    // list entries carry `errorDetails` (seen on a real tenant); `lastError` is the documented name
    error: str(obj(r.errorDetails).message) ?? str(obj(r.lastError).message) ?? str(obj(last.errorDetails).message),
    learnMoreUrl: str(r.learnMoreUrl),
  };
}

const packagesPath = (envId: string, state: "Installed" | "NotInstalled") =>
  `environments/${encodeURIComponent(envId)}/applicationPackages?appInstallState=${state}&api-version=${API_VERSION}`;

export async function listPackages(pp: PpLike, envId: string): Promise<{ installed: Package[]; available: Package[] }> {
  const [inst, avail] = await Promise.all([getAll(pp.AppManagement, "appmanagement", packagesPath(envId, "Installed")), getAll(pp.AppManagement, "appmanagement", packagesPath(envId, "NotInstalled"))]);
  const norm = (rows: Obj[]) => rows.map(normalizePackage).filter((p): p is Package => !!p);
  return { installed: norm(inst), available: norm(avail) };
}

// ---------- install ----------

/** Starts an install (also update and retry). Returns the operation id when the response carries one. */
export async function startInstall(pp: PpLike, envId: string, uniqueName: string): Promise<string | null> {
  const r = obj(await pp.AppManagement.Post(`environments/${encodeURIComponent(envId)}/applicationPackages/${encodeURIComponent(uniqueName)}/install?api-version=${API_VERSION}`, {}));
  return str(obj(r.lastOperation).operationId) ?? str(r.operationId);
}

export type OperationStatus = "NotStarted" | "Running" | "Succeeded" | "Failed" | "Canceled" | "Unknown";

export async function operationStatus(pp: PpLike, envId: string, operationId: string): Promise<{ status: OperationStatus; message: string | null }> {
  const r = obj(await pp.AppManagement.Get(`environments/${encodeURIComponent(envId)}/operations/${encodeURIComponent(operationId)}?api-version=${API_VERSION}`));
  const s = str(r.status) ?? "";
  const known: OperationStatus[] = ["NotStarted", "Running", "Succeeded", "Failed", "Canceled"];
  const status = known.find((k) => k.toLowerCase() === s.toLowerCase()) ?? "Unknown";
  return { status, message: str(obj(r.error).message) ?? str(r.statusMessage) };
}

/** Fallback when an install returned no operation id: the package's state in the environment. */
export async function packageState(pp: PpLike, envId: string, uniqueName: string): Promise<{ status: OperationStatus; message: string | null; version: string | null }> {
  const { installed } = await listPackages(pp, envId);
  const p = installed.find((x) => x.uniqueName.toLowerCase() === uniqueName.toLowerCase());
  if (!p) return { status: "Running", message: null, version: null };
  const s = p.state.toLowerCase();
  if (s === "installed") return { status: "Succeeded", message: null, version: p.version };
  if (s.endsWith("failed")) return { status: "Failed", message: p.error, version: p.version };
  return { status: "Running", message: p.state, version: p.version };
}

// ---------- versions ----------

/** Dotted version compare: numeric per part, missing parts count as 0. Negative when a < b. */
export function compareVersions(a: string | null, b: string | null): number {
  if (!a || !b) return a ? 1 : b ? -1 : 0;
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    const d = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

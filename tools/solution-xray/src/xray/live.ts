/**
 * Live mode: pull a deployed solution out of the connected environment with ExportSolution and hand the zip bytes to
 * the same parser the offline path uses. Read-only for the environment: ExportSolution and the solution list only.
 *
 * UNVERIFIED: the shape `dataverseAPI.execute` returns for ExportSolution has not been checked against a live
 * environment. Dataverse answers `{ "@odata.context": ..., "ExportSolutionFile": "<base64>" }`; the host may hand that
 * back as is, wrapped (`data` / `body` / `value`), as JSON text, or with the file already as bytes. All are accepted.
 */

import { toUint8 } from "../../../_shared/host";
import type { SolutionInfo } from "./types";

// ---------- solution list ----------

export interface EnvSolution {
  id: string;
  uniqueName: string;
  friendlyName: string;
  version: string;
  managed: boolean;
}

export const SOLUTION_COLUMNS = ["solutionid", "uniquename", "friendlyname", "version", "ismanaged", "isvisible"];

/** Internal solutions every environment has, plus Microsoft first-party (msdyn*): never the subject of a pre-import check. */
const HIDDEN = new Set(["system", "active", "default", "basic"]);
export const isHiddenSolution = (uniqueName: string): boolean => HIDDEN.has(uniqueName.toLowerCase()) || /^msdyn/i.test(uniqueName);

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Rows from getSolutions → picker entries: hidden and invisible solutions dropped, sorted by display name. */
export function toEnvSolutions(rows: Record<string, unknown>[] | undefined): EnvSolution[] {
  return (rows ?? [])
    .map((r) => ({
      id: str(r.solutionid),
      uniqueName: str(r.uniquename),
      friendlyName: str(r.friendlyname) || str(r.uniquename),
      version: str(r.version),
      managed: r.ismanaged === true || r.ismanaged === "true",
      visible: r.isvisible !== false && r.isvisible !== "false",
    }))
    .filter((s) => s.uniqueName && s.visible && !isHiddenSolution(s.uniqueName))
    .map(({ visible: _v, ...s }) => s)
    .sort((a, b) => a.friendlyName.localeCompare(b.friendlyName) || a.uniqueName.localeCompare(b.uniqueName));
}

// ---------- ExportSolution ----------

/** The action call. Actions go as a JSON body, so the function-parameter quoting quirk (PPTB-NOTES §12) does not apply. */
export const exportRequest = (solutionName: string, managed: boolean): DataverseAPI.ExecuteRequest => ({
  operationName: "ExportSolution",
  operationType: "action",
  parameters: { SolutionName: solutionName, Managed: managed },
});

const FILE_KEY = "exportsolutionfile";
const WRAPPERS = ["data", "body", "value", "result", "response"];

function isBinaryLike(v: unknown): boolean {
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return true;
  if (Array.isArray(v)) return v.length > 0 && typeof v[0] === "number";
  const o = v as { type?: unknown; data?: unknown };
  return !!o && typeof o === "object" && o.type === "Buffer" && Array.isArray(o.data);
}

/** Find the file payload: the ExportSolutionFile key (any case) at the top or inside a known wrapper, JSON text parsed. */
function findFile(v: unknown, depth = 0): unknown {
  if (v == null || depth > 4) return undefined;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{")) {
      try {
        return findFile(JSON.parse(t), depth + 1);
      } catch {
        return undefined;
      }
    }
    return t;
  }
  if (isBinaryLike(v)) return v;
  if (typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  for (const [k, x] of Object.entries(o)) if (k.toLowerCase() === FILE_KEY) return x;
  for (const k of WRAPPERS) if (k in o) {
    const r = findFile(o[k], depth + 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** A short, data-free description of a result for errors and the debug log (key names and types, never values). */
export function describeShape(v: unknown, depth = 0): string {
  if (v === null) return "null";
  if (typeof v === "string") return `string(${v.length})`;
  if (typeof v !== "object") return typeof v;
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return `binary(${v.byteLength})`;
  if (Array.isArray(v)) return `array(${v.length})`;
  if (depth >= 2) return "object";
  const entries = Object.entries(v as Record<string, unknown>).slice(0, 12);
  return `{${entries.map(([k, x]) => `${k}: ${describeShape(x, depth + 1)}`).join(", ")}}`;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64
    .replace(/^data:[^,]*,/, "")
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    throw new Error("ExportSolutionFile is not valid base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** ExportSolution result → zip bytes. Throws with the result's shape (no data) when no zip can be found. */
export function decodeExportResult(res: unknown): Uint8Array {
  const file = findFile(res);
  let bytes: Uint8Array;
  if (typeof file === "string" && file) bytes = base64ToBytes(file);
  else if (file !== undefined && isBinaryLike(file)) bytes = toUint8(file);
  else throw new Error(`ExportSolution returned no ExportSolutionFile (got ${describeShape(res)})`);
  // every zip starts with a local file header "PK\x03\x04" (or "PK\x05\x06" when empty)
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`ExportSolutionFile is not a zip (${bytes.length} bytes, got ${describeShape(res)})`);
  return bytes;
}

// ---------- environment tag ----------

export interface EnvTag {
  connectionId: string;
  connectionName: string;
  url: string;
  managedExport: boolean;
}

/** Solutions loaded from an environment carry a tag; offline zips do not. Kept off SolutionInfo so exports stay unchanged. */
const tags = new WeakMap<SolutionInfo, EnvTag>();
export const envTag = (s: SolutionInfo): EnvTag | undefined => tags.get(s);
export const setEnvTag = (s: SolutionInfo, t: EnvTag): void => void tags.set(s, t);

/** Above this, warn: parsing tens of MB in the tool's page takes a while. */
export const LARGE_EXPORT_BYTES = 20 * 1024 * 1024;
/** After this long, the spinner says large solutions can take minutes. */
export const SLOW_EXPORT_MS = 15_000;

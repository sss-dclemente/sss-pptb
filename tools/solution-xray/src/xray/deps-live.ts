/**
 * Live mode: resolve the MissingDependencies a zip declares against the connected environment, so "missing in the
 * source export" becomes "missing here" / "present here". Read-only: one GET per distinct required component.
 *
 * UNVERIFIED against a live environment: the queries follow the Web API docs; a 404 from a metadata key lookup is read
 * as "missing" and is detected from the host's error text. Component types without a lookup below are "unchecked".
 */

import type { DependencyRef, MissingDependency } from "./types";

export type DepStatus = "present" | "missing" | "unchecked" | "error";

export interface DepResult {
  status: DepStatus;
  /** Error text for "error". */
  detail?: string;
}

const GUID = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;
/** OData string literal body: quotes doubled, then URL-encoded (queryData appends the path verbatim, PPTB-NOTES §12). */
const lit = (v: string): string => encodeURIComponent(v.replace(/'/g, "''"));
const byName = (set: string, idCol: string, nameCol: string, v: string) => `${set}?$select=${idCol}&$filter=${nameCol} eq '${lit(v)}'&$top=1`;

/** queryData path that returns a row (or a non-empty value[]) when the component exists; null = no lookup for this type. */
export function depQuery(r: DependencyRef): string | null {
  const name = r.schemaName?.trim();
  if (name) {
    const ln = name.toLowerCase();
    switch (r.type) {
      case 1:
        return `EntityDefinitions?$select=LogicalName&$filter=LogicalName eq '${lit(ln)}'`;
      case 2:
        return r.parentSchemaName ? `EntityDefinitions(LogicalName='${lit(r.parentSchemaName.toLowerCase())}')/Attributes?$select=LogicalName&$filter=LogicalName eq '${lit(ln)}'` : null;
      case 3:
      case 10:
        return `RelationshipDefinitions?$select=SchemaName&$filter=SchemaName eq '${lit(name)}'`;
      case 9:
        return `GlobalOptionSetDefinitions(Name='${lit(name)}')?$select=Name`;
      case 61:
        return byName("webresourceset", "webresourceid", "name", name);
      case 66:
        return byName("customcontrols", "customcontrolid", "name", name);
      case 80:
        return byName("appmodules", "appmoduleid", "uniquename", name);
      case 300:
        return byName("canvasapps", "canvasappid", "name", name);
      case 380:
        return byName("environmentvariabledefinitions", "environmentvariabledefinitionid", "schemaname", name);
    }
  }
  // ponytail: id fallback trusts that every component has a solutioncomponent row (Default/System); unverified per type.
  const g = r.id?.match(GUID)?.[1];
  return g ? `solutioncomponents?$select=solutioncomponentid&$filter=componenttype eq ${r.type} and objectid eq ${g}&$top=1` : null;
}

/** Same required component in several MissingDependency rows → one lookup. */
export const depKey = (r: DependencyRef): string => [r.type, r.schemaName?.toLowerCase(), r.parentSchemaName?.toLowerCase(), r.id?.toLowerCase()].join("|");

const NOT_FOUND = /\b404\b|not ?found|does not exist|could not find|0x80040217/i;

/** A query result → present/missing. A single-object answer (key lookup) is present; value[] decides otherwise. */
export function readResult(res: unknown): DepStatus {
  const v = (res as { value?: unknown } | null)?.value;
  if (Array.isArray(v)) return v.length ? "present" : "missing";
  return res && typeof res === "object" ? "present" : "missing";
}

export function readError(e: unknown): DepResult {
  const msg = (e as Error)?.message ?? String(e);
  return NOT_FOUND.test(msg) ? { status: "missing" } : { status: "error", detail: msg };
}

/** Resolve every distinct required component, 4 lookups at a time. Result keyed by depKey. */
export async function resolveDeps(
  deps: MissingDependency[],
  query: (path: string) => Promise<unknown>,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, DepResult>> {
  const out = new Map<string, DepResult>();
  const todo = new Map<string, DependencyRef>();
  for (const d of deps) todo.set(depKey(d.required), d.required);
  const queue = [...todo];
  let done = 0;
  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [key, ref] = next;
      const path = depQuery(ref);
      if (!path) out.set(key, { status: "unchecked" });
      else {
        try {
          out.set(key, { status: readResult(await query(path)) });
        } catch (e) {
          out.set(key, readError(e));
        }
      }
      onProgress?.(++done, todo.size);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return out;
}

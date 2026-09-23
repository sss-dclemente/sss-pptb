import { ENV_VAR_TYPE, type ColumnData, type ColumnMeta, type ConnRefRecord, type EnvVarRecord, type Target } from "./types";

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

export interface DataverseLike {
  queryData: (odata: string, target?: Target) => Promise<{ value: Row[] }>;
  getSolutions: (cols: string[], target?: Target) => Promise<{ value: Row[] }>;
}

const MAX_PAGES = 500;

/** Relative query path of an absolute `@odata.nextLink` ("https://org/api/data/v9.2/x?..." → "x?..."). */
export function relativeNextLink(link: string): string {
  const m = link.match(/\/api\/data\/v\d+(?:\.\d+)*\/(.*)$/i);
  return m ? m[1] : link;
}

/** queryData that follows `@odata.nextLink` until the last page. */
export async function queryAll(api: DataverseLike, odata: string, target: Target): Promise<Row[]> {
  const out: Row[] = [];
  const seen = new Set<string>();
  let q: string | null = odata;
  for (let page = 0; q && page < MAX_PAGES; page++) {
    const r: Record<string, unknown> & { value: Row[] } = await api.queryData(q, target);
    out.push(...(r.value ?? []));
    const next = r["@odata.nextLink"];
    q = typeof next === "string" && next ? relativeNextLink(next) : null;
    if (q && seen.has(q)) throw new Error(`paging loop at ${q}`);
    if (q) seen.add(q);
  }
  if (q) throw new Error(`more than ${MAX_PAGES} pages for ${odata.split("?")[0]}`);
  return out;
}

export async function fetchEnvVars(api: DataverseLike, target: Target): Promise<EnvVarRecord[]> {
  const [defs, vals] = await Promise.all([
    queryAll(api, "environmentvariabledefinitions?$select=environmentvariabledefinitionid,schemaname,displayname,type,defaultvalue,ismanaged&$orderby=schemaname", target),
    queryAll(api, "environmentvariablevalues?$select=environmentvariablevalueid,value,ismanaged,_environmentvariabledefinitionid_value", target),
  ]);
  // Normally one value row per definition. More than one is surfaced (valueCount), not silently collapsed.
  const valuesByDef = new Map<string, Row[]>();
  for (const v of vals) {
    const d = s(v._environmentvariabledefinitionid_value)?.toLowerCase();
    if (!d) continue;
    const list = valuesByDef.get(d);
    if (list) list.push(v);
    else valuesByDef.set(d, [v]);
  }
  return defs.map((d) => {
    const id = String(d.environmentvariabledefinitionid);
    const list = valuesByDef.get(id.toLowerCase()) ?? [];
    const v = list[list.length - 1];
    const typeCode = Number(d.type ?? 0);
    return {
      definitionId: id,
      schemaName: String(d.schemaname ?? ""),
      displayName: s(d.displayname) ?? String(d.schemaname ?? ""),
      typeCode,
      type: ENV_VAR_TYPE[typeCode] ?? String(typeCode),
      defaultValue: s(d.defaultvalue),
      value: v ? s(v.value) : null,
      valueId: v ? s(v.environmentvariablevalueid) : null,
      isManaged: !!d.ismanaged,
      valueIsManaged: v ? !!v.ismanaged : false,
      valueCount: list.length,
    };
  });
}

export async function fetchConnRefs(api: DataverseLike, target: Target): Promise<ConnRefRecord[]> {
  const rows = await queryAll(
    api,
    "connectionreferences?$select=connectionreferenceid,connectionreferencelogicalname,connectionreferencedisplayname,connectorid,connectionid,ismanaged&$orderby=connectionreferencelogicalname",
    target,
  );
  return rows.map((c) => {
    const connectorId = s(c.connectorid);
    return {
      id: String(c.connectionreferenceid),
      logicalName: String(c.connectionreferencelogicalname ?? ""),
      displayName: s(c.connectionreferencedisplayname) ?? String(c.connectionreferencelogicalname ?? ""),
      connectorId,
      connector: connectorId ? connectorId.split("/").pop() ?? null : null,
      connectionId: s(c.connectionid),
      isManaged: !!c.ismanaged,
    };
  });
}

export async function fetchColumn(api: DataverseLike, meta: ColumnMeta): Promise<ColumnData> {
  if (!meta.target) throw new Error("fetchColumn needs a live target");
  const [envVars, connRefs] = await Promise.all([fetchEnvVars(api, meta.target), fetchConnRefs(api, meta.target)]);
  return { meta: { ...meta, takenAt: new Date().toISOString() }, envVars, connRefs };
}

export interface SolutionInfo {
  id: string;
  uniqueName: string;
  friendlyName: string;
  version: string;
  isManaged: boolean;
}

export async function fetchSolutions(api: DataverseLike, target: Target): Promise<SolutionInfo[]> {
  const r = await api.getSolutions(["solutionid", "uniquename", "friendlyname", "version", "ismanaged", "isvisible"], target);
  return r.value
    .filter((x) => x.isvisible !== false)
    .map((x) => ({
      id: String(x.solutionid),
      uniqueName: String(x.uniquename ?? ""),
      friendlyName: s(x.friendlyname) ?? String(x.uniquename ?? ""),
      version: String(x.version ?? ""),
      isManaged: !!x.ismanaged,
    }))
    .sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
}

/** Component type of environment variable definitions (fixed platform value). */
export const ENV_VAR_DEFINITION_COMPONENT = 380;
const OBJECTID_CHUNK = 20;

/** connectionreference ObjectTypeCode per connection (target + org url). Never 371: that is the Connector component type. */
const connRefTypeCache = new Map<string, number>();

/**
 * Solution component type of connection references in this org. connectionreference is a solution-aware table, so its
 * componenttype is the table's ObjectTypeCode, which differs per org. Returns null when metadata can't be read.
 */
export async function connRefComponentType(api: DataverseLike, target: Target, orgUrl: string): Promise<number | null> {
  const key = `${target}|${orgUrl.toLowerCase().replace(/\/+$/, "")}`;
  const hit = connRefTypeCache.get(key);
  if (hit != null) return hit;
  try {
    const r = (await api.queryData("EntityDefinitions(LogicalName='connectionreference')?$select=ObjectTypeCode", target)) as unknown as Row;
    const code = Number(r.ObjectTypeCode ?? (Array.isArray(r.value) ? (r.value[0] as Row | undefined)?.ObjectTypeCode : undefined));
    if (!Number.isInteger(code) || code <= 0) return null;
    connRefTypeCache.set(key, code);
    return code;
  } catch {
    return null;
  }
}

/** Schema/logical names (lowercase) of env var definitions (380) and connection references (org-specific type) in a solution. */
export async function fetchSolutionScope(api: DataverseLike, target: Target, solutionId: string, column: ColumnData): Promise<Set<string>> {
  const base = `solutioncomponents?$select=objectid,componenttype&$filter=_solutionid_value eq ${solutionId} and `;
  const crType = await connRefComponentType(api, target, column.meta.url);
  let rows: Row[];
  if (crType != null) {
    rows = await queryAll(api, `${base}(componenttype eq ${ENV_VAR_DEFINITION_COMPONENT} or componenttype eq ${crType})`, target);
  } else {
    // Fallback without the type code: match the solution's components against the known connection reference ids.
    rows = await queryAll(api, `${base}componenttype eq ${ENV_VAR_DEFINITION_COMPONENT}`, target);
    const ids = column.connRefs.map((c) => c.id);
    for (let i = 0; i < ids.length; i += OBJECTID_CHUNK) {
      const chunk = ids.slice(i, i + OBJECTID_CHUNK);
      rows.push(...(await queryAll(api, `${base}(${chunk.map((id) => `objectid eq ${id}`).join(" or ")})`, target)));
    }
  }
  const ids = new Set(rows.map((x) => String(x.objectid).toLowerCase()));
  const out = new Set<string>();
  for (const e of column.envVars) if (ids.has(e.definitionId.toLowerCase())) out.add(e.schemaName.toLowerCase());
  for (const c of column.connRefs) if (ids.has(c.id.toLowerCase())) out.add(c.logicalName.toLowerCase());
  return out;
}

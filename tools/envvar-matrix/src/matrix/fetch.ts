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

/** Schema/logical names (lowercase) of env var definitions (380) and connection references (371) in a solution. */
export async function fetchSolutionScope(api: DataverseLike, target: Target, solutionId: string, column: ColumnData): Promise<Set<string>> {
  const rows = await queryAll(
    api,
    `solutioncomponents?$select=objectid,componenttype&$filter=_solutionid_value eq ${solutionId} and (componenttype eq 380 or componenttype eq 371)`,
    target,
  );
  const ids = new Set(rows.map((x) => String(x.objectid).toLowerCase()));
  const out = new Set<string>();
  for (const e of column.envVars) if (ids.has(e.definitionId.toLowerCase())) out.add(e.schemaName.toLowerCase());
  for (const c of column.connRefs) if (ids.has(c.id.toLowerCase())) out.add(c.logicalName.toLowerCase());
  return out;
}

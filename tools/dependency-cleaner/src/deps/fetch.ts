/**
 * Dataverse reads. Collections go through queryData and follow @odata.nextLink.
 * RetrieveRequiredComponents takes an Edm.Guid, so it goes through queryData, never execute
 * (docs/PPTB-NOTES.md §12): the guid is validated, then interpolated unquoted.
 */
import { CT, type Component, type NamedComponent, type Row, type SolutionInfo, type Target } from "./types";

export interface DataverseLike {
  queryData: (odata: string, target?: Target) => Promise<{ value: Row[] }>;
  getSolutions: (cols: string[], target?: Target) => Promise<{ value: Row[] }>;
  getAllEntitiesMetadata: (props?: string[], target?: Target) => Promise<{ value: Row[] }>;
  getEntityRelatedMetadata: (entity: string, path: "Attributes", props?: string[], target?: Target) => Promise<{ value: Row[] }>;
  execute: (req: DataverseAPI.ExecuteRequest, target?: Target) => Promise<Row>;
  update: (entity: string, id: string, record: Record<string, unknown>, target?: Target) => Promise<void>;
}

const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
export const lid = (v: unknown): string => String(v ?? "").toLowerCase();

export const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertGuid(v: string, what = "id"): string {
  if (!GUID_RE.test(v)) throw new Error(`${what} is not a guid: ${v}`);
  return v.toLowerCase();
}

/** Relative query path of an absolute @odata.nextLink. */
export function relativeNextLink(link: string): string {
  const m = link.match(/\/api\/data\/v\d+(?:\.\d+)*\/(.*)$/i);
  return m ? m[1] : link;
}

const MAX_PAGES = 500;
export async function queryAll(api: DataverseLike, odata: string, target: Target = "primary"): Promise<Row[]> {
  const out: Row[] = [];
  const seen = new Set<string>();
  let q: string | null = odata;
  for (let page = 0; q && page < MAX_PAGES; page++) {
    const r = (await api.queryData(q, target)) as { value?: Row[]; "@odata.nextLink"?: string };
    out.push(...(r.value ?? []));
    const next = r["@odata.nextLink"];
    q = typeof next === "string" && next ? relativeNextLink(next) : null;
    if (q && seen.has(q)) throw new Error(`paging loop at ${q}`);
    if (q) seen.add(q);
  }
  if (q) throw new Error(`more than ${MAX_PAGES} pages for ${odata.split("?")[0]}`);
  return out;
}

/** Ids per `or` filter: `x eq <guid>` is ~52 chars, 40 of them stay well inside URL limits. */
export const OR_CHUNK = 40;
export async function queryByIds(api: DataverseLike, ids: string[], field: string, build: (filter: string) => string, target: Target = "primary"): Promise<Row[]> {
  const uniq = [...new Set(ids.map((x) => x.toLowerCase()))].filter((x) => GUID_RE.test(x));
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += OR_CHUNK) chunks.push(uniq.slice(i, i + OR_CHUNK));
  const pages = await Promise.all(chunks.map((c) => queryAll(api, build(c.map((x) => `${field} eq ${x}`).join(" or ")), target)));
  return pages.flat();
}

/** Run `fn` over `items` with at most `limit` in flight. Stops starting new work once `cancelled()` is true. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, cancelled: () => boolean = () => false): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length && !cancelled()) {
      const item = items[i++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------- solutions ----------

export async function fetchSolutions(api: DataverseLike, target: Target = "primary"): Promise<SolutionInfo[]> {
  const [sols, pubs] = await Promise.all([
    api.getSolutions(["solutionid", "uniquename", "friendlyname", "version", "ismanaged", "_publisherid_value"], target),
    queryAll(api, "publishers?$select=publisherid,uniquename,customizationprefix", target).catch(() => [] as Row[]),
  ]);
  const prefixById = new Map(pubs.map((p) => [lid(p.publisherid), String(p.customizationprefix ?? "").toLowerCase()]));
  return sols.value
    .map((x) => {
      const publisherId = x._publisherid_value ? lid(x._publisherid_value) : null;
      return {
        id: lid(x.solutionid),
        uniqueName: String(x.uniquename ?? ""),
        friendlyName: s(x.friendlyname) ?? String(x.uniquename ?? ""),
        version: String(x.version ?? ""),
        isManaged: !!x.ismanaged,
        publisherId,
        prefix: publisherId ? (prefixById.get(publisherId) ?? "") : "",
      };
    })
    .sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
}

/** Fresh read of one solution's managed flag, right before a write. */
export async function fetchSolutionManaged(api: DataverseLike, solutionId: string): Promise<{ isManaged: boolean; uniqueName: string } | null> {
  const r = await api.queryData(`solutions?$select=solutionid,uniquename,ismanaged&$filter=solutionid eq ${assertGuid(solutionId, "solution id")}`);
  const row = r.value[0];
  return row ? { isManaged: !!row.ismanaged, uniqueName: String(row.uniquename ?? "") } : null;
}

export async function fetchComponents(api: DataverseLike, solutionId: string): Promise<Component[]> {
  const rows = await queryAll(
    api,
    `solutioncomponents?$select=solutioncomponentid,objectid,componenttype,rootcomponentbehavior,_rootsolutioncomponentid_value&$filter=_solutionid_value eq ${assertGuid(solutionId, "solution id")}`,
  );
  return rows.map((r) => ({
    rowId: lid(r.solutioncomponentid),
    objectId: lid(r.objectid),
    type: Number(r.componenttype ?? 0),
    behavior: r.rootcomponentbehavior == null ? null : Number(r.rootcomponentbehavior),
    rootRowId: r._rootsolutioncomponentid_value ? lid(r._rootsolutioncomponentid_value) : null,
  }));
}

// ---------- required components ----------

export interface DependencyRow {
  requiredId: string;
  requiredType: number;
  requiredParentId: string | null;
  requiredBaseSolutionId: string | null;
}

/** RetrieveRequiredComponentsResponse.EntityCollection: the host returns the body unchanged, so accept every plausible shape. */
function dependencyRows(body: unknown): Row[] {
  const b = body as Record<string, unknown> | null;
  if (!b) return [];
  const ec = b.EntityCollection as unknown;
  if (Array.isArray(ec)) return ec as Row[];
  if (ec && typeof ec === "object") {
    const e = (ec as Record<string, unknown>).Entities ?? (ec as Record<string, unknown>).value;
    if (Array.isArray(e)) return e as Row[];
  }
  if (Array.isArray(b.value)) return b.value as Row[];
  return [];
}

const pick = (r: Row, name: string): unknown => r[name] ?? r[`_${name}_value`];

export async function retrieveRequired(api: DataverseLike, objectId: string, componentType: number): Promise<DependencyRow[]> {
  const id = assertGuid(objectId, "component id");
  if (!Number.isInteger(componentType)) throw new Error(`bad component type ${componentType}`);
  const body = await api.queryData(`RetrieveRequiredComponents(ObjectId=${id},ComponentType=${componentType})`);
  return dependencyRows(body).map((r) => ({
    requiredId: lid(pick(r, "requiredcomponentobjectid")),
    requiredType: Number(pick(r, "requiredcomponenttype") ?? 0),
    requiredParentId: pick(r, "requiredcomponentparentid") ? lid(pick(r, "requiredcomponentparentid")) : null,
    requiredBaseSolutionId: pick(r, "requiredcomponentbasesolutionid") ? lid(pick(r, "requiredcomponentbasesolutionid")) : null,
  }));
}

/** objectid → solution ids that contain it. */
export async function fetchOwningSolutions(api: DataverseLike, ids: string[]): Promise<Map<string, string[]>> {
  const rows = await queryByIds(api, ids, "objectid", (f) => `solutioncomponents?$select=objectid,componenttype,_solutionid_value&$filter=${f}`);
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const k = lid(r.objectid);
    const list = out.get(k) ?? [];
    const sid = lid(r._solutionid_value);
    if (sid && !list.includes(sid)) list.push(sid);
    out.set(k, list);
  }
  return out;
}

// ---------- names ----------

export interface EntityMeta {
  id: string;
  logicalName: string;
  primaryName: string | null;
}
export interface AttributeMeta {
  id: string;
  logicalName: string;
  requiredLevel: string;
}

/** Session cache of metadata per environment url. */
export class MetaCache {
  entities: Map<string, EntityMeta> | null = null;
  attributes = new Map<string, AttributeMeta[]>();
  names = new Map<string, NamedComponent>();

  async entitiesById(api: DataverseLike): Promise<Map<string, EntityMeta>> {
    if (this.entities) return this.entities;
    const r = await api.getAllEntitiesMetadata(["LogicalName", "MetadataId", "PrimaryNameAttribute"]);
    this.entities = new Map(
      r.value.map((e) => [lid(e.MetadataId), { id: lid(e.MetadataId), logicalName: String(e.LogicalName ?? ""), primaryName: s(e.PrimaryNameAttribute) }]),
    );
    return this.entities;
  }

  async entityByName(api: DataverseLike, logicalName: string): Promise<EntityMeta | undefined> {
    const all = await this.entitiesById(api);
    for (const e of all.values()) if (e.logicalName === logicalName) return e;
    return undefined;
  }

  async attributesOf(api: DataverseLike, table: string): Promise<AttributeMeta[]> {
    const hit = this.attributes.get(table);
    if (hit) return hit;
    const r = await api.getEntityRelatedMetadata(table, "Attributes", ["LogicalName", "MetadataId", "RequiredLevel"]);
    const list = r.value.map((a) => ({
      id: lid(a.MetadataId),
      logicalName: String(a.LogicalName ?? ""),
      requiredLevel: String((a.RequiredLevel as { Value?: string } | undefined)?.Value ?? a.RequiredLevel ?? "None"),
    }));
    this.attributes.set(table, list);
    return list;
  }

  /** Primary name + ApplicationRequired / SystemRequired columns of a table. These never leave a form. */
  async protectedColumns(api: DataverseLike, table: string): Promise<string[]> {
    const ent = await this.entityByName(api, table);
    const attrs = await this.attributesOf(api, table).catch(() => [] as AttributeMeta[]);
    const out = new Set<string>();
    if (ent?.primaryName) out.add(ent.primaryName);
    for (const a of attrs) if (a.requiredLevel === "ApplicationRequired" || a.requiredLevel === "SystemRequired") out.add(a.logicalName);
    return [...out];
  }
}

/** entity set, id column, name column, table column per component type (record-backed components). */
const RECORD_TYPES: Record<number, [string, string, string, string?]> = {
  [CT.View]: ["savedqueries", "savedqueryid", "name", "returnedtypecode"],
  [CT.Form]: ["systemforms", "formid", "name", "objecttypecode"],
  [CT.Chart]: ["savedqueryvisualizations", "savedqueryvisualizationid", "name", "primaryentitytypecode"],
  [CT.WebResource]: ["webresourceset", "webresourceid", "name"],
  [CT.Workflow]: ["workflows", "workflowid", "name", "primaryentity"],
  [CT.SiteMap]: ["sitemaps", "sitemapid", "sitemapname"],
  [CT.AppModule]: ["appmodules", "appmoduleid", "name"],
  [CT.PluginStep]: ["sdkmessageprocessingsteps", "sdkmessageprocessingstepid", "name"],
  20: ["roles", "roleid", "name"],
  300: ["canvasapps", "canvasappid", "name"],
  372: ["connectionreferences", "connectionreferenceid", "connectionreferencelogicalname"],
  380: ["environmentvariabledefinitions", "environmentvariabledefinitionid", "schemaname"],
};

export interface NameRequest {
  type: number;
  id: string;
  /** entity metadata id this column belongs to (dependency parent or the solution root row) */
  parentId?: string | null;
}

/** Resolve display names. Best effort: anything unresolved keeps its id as the name. */
export async function resolveNames(api: DataverseLike, cache: MetaCache, reqs: NameRequest[]): Promise<Map<string, NamedComponent>> {
  const key = (t: number, id: string) => `${t}:${id}`;
  const out = new Map<string, NamedComponent>();
  const todo = reqs.filter((r) => {
    const hit = cache.names.get(key(r.type, r.id));
    if (hit) out.set(key(r.type, r.id), hit);
    return !hit;
  });
  if (!todo.length) return out;
  const put = (n: NamedComponent) => {
    out.set(key(n.type, n.id), n);
    cache.names.set(key(n.type, n.id), n);
  };
  const entities = await cache.entitiesById(api).catch(() => new Map<string, EntityMeta>());

  // tables
  for (const r of todo.filter((x) => x.type === CT.Entity)) {
    const e = entities.get(r.id);
    if (e) put({ type: r.type, id: r.id, name: e.logicalName, table: e.logicalName });
  }
  // columns: by parent table
  const byParent = new Map<string, NameRequest[]>();
  for (const r of todo.filter((x) => x.type === CT.Attribute)) {
    const p = r.parentId ?? "";
    byParent.set(p, [...(byParent.get(p) ?? []), r]);
  }
  for (const [parent, list] of byParent) {
    const table = entities.get(parent)?.logicalName;
    if (!table) continue;
    const attrs = await cache.attributesOf(api, table).catch(() => [] as AttributeMeta[]);
    for (const r of list) {
      const a = attrs.find((x) => x.id === r.id);
      if (a) put({ type: r.type, id: r.id, name: a.logicalName, table });
    }
  }
  // record-backed components
  const byType = new Map<number, string[]>();
  for (const r of todo) if (RECORD_TYPES[r.type]) byType.set(r.type, [...(byType.get(r.type) ?? []), r.id]);
  await Promise.all(
    [...byType].map(async ([type, ids]) => {
      const [set, idCol, nameCol, tableCol] = RECORD_TYPES[type];
      const rows = await queryByIds(api, ids, idCol, (f) => `${set}?$select=${[idCol, nameCol, tableCol].filter(Boolean).join(",")}&$filter=${f}`).catch(() => [] as Row[]);
      for (const row of rows) put({ type, id: lid(row[idCol]), name: s(row[nameCol]) ?? lid(row[idCol]), table: tableCol ? (s(row[tableCol]) ?? undefined) : undefined });
    }),
  );
  // relationships: one metadata read each
  for (const r of todo.filter((x) => x.type === CT.EntityRelationship || x.type === CT.Relationship)) {
    try {
      const row = (await api.queryData(`RelationshipDefinitions(${assertGuid(r.id)})?$select=SchemaName`)) as unknown as Row;
      if (row?.SchemaName) put({ type: r.type, id: r.id, name: String(row.SchemaName) });
    } catch {
      /* keep id */
    }
  }
  for (const r of todo) if (!out.has(key(r.type, r.id))) out.set(key(r.type, r.id), { type: r.type, id: r.id, name: r.id });
  return out;
}

// ---------- forms / views ----------

export interface FormRecord {
  id: string;
  name: string;
  table: string;
  formxml: string;
}
export interface ViewRecord {
  id: string;
  name: string;
  table: string;
  fetchxml: string;
  layoutxml: string;
}

export async function fetchForms(api: DataverseLike, ids: string[]): Promise<FormRecord[]> {
  const rows = await queryByIds(api, ids, "formid", (f) => `systemforms?$select=formid,name,objecttypecode,formxml&$filter=${f}`);
  return rows.map((r) => ({ id: lid(r.formid), name: String(r.name ?? ""), table: String(r.objecttypecode ?? ""), formxml: String(r.formxml ?? "") }));
}

export async function fetchViews(api: DataverseLike, ids: string[]): Promise<ViewRecord[]> {
  const rows = await queryByIds(api, ids, "savedqueryid", (f) => `savedqueries?$select=savedqueryid,name,returnedtypecode,fetchxml,layoutxml&$filter=${f}`);
  return rows.map((r) => ({
    id: lid(r.savedqueryid),
    name: String(r.name ?? ""),
    table: String(r.returnedtypecode ?? ""),
    fetchxml: String(r.fetchxml ?? ""),
    layoutxml: String(r.layoutxml ?? ""),
  }));
}

/** Power Platform environment id for maker-portal links. Best effort (enum parameter, safe through execute). */
export async function fetchEnvironmentId(api: DataverseLike): Promise<string | null> {
  try {
    const r = await api.execute({ operationName: "RetrieveCurrentOrganization", operationType: "function", parameters: { AccessType: "Microsoft.Dynamics.CRM.EndpointAccessType'Default'" } });
    const id = (r?.Detail as Row | undefined)?.EnvironmentId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

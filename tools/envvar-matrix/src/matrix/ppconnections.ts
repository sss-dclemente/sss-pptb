/**
 * Connections of an environment through the Power Platform API (ToolBox ≥ 1.2.6, `window.powerplatformAPI`):
 *   GET connectivity/environments/{environmentId}/connections?api-version=2024-10-01
 * The connection needs the Power Platform API enabled in ToolBox (custom Entra client id with delegated
 * Connectivity.Connections.Read). The documented response schema is thin, so every field is read defensively:
 * see docs/PP-API-SPIKE.md. The environment id comes from Dataverse RetrieveCurrentOrganization.
 */
import type { ConnRefRow, Target } from "./types";

type Row = Record<string, unknown>;

export const CONNECTIONS_API_VERSION = "2024-10-01";
const MAX_PAGES = 50;

export interface PpConnection {
  /** connection name: the value `connectionreference.connectionid` holds */
  id: string;
  /** connector name, lowercase (e.g. shared_office365), or null when the response does not say */
  connector: string | null;
  displayName: string;
  account: string | null;
  status: string | null;
  /** status reads as an error / expired / unauthenticated connection */
  broken: boolean;
}

export interface ExecLike {
  execute: (req: DataverseAPI.ExecuteRequest, target?: Target) => Promise<Record<string, unknown>>;
}

export interface ConnectivityLike {
  Get: (path?: string, target?: Target, headers?: Record<string, string>) => Promise<Record<string, unknown>>;
}

/** Power Platform environment id of the Dataverse org behind `target`. */
export async function environmentId(api: ExecLike, target: Target): Promise<string> {
  const r = await api.execute({ operationName: "RetrieveCurrentOrganization", operationType: "function", parameters: { AccessType: "Microsoft.Dynamics.CRM.EndpointAccessType'Default'" } }, target);
  const id = (r?.Detail as Row | undefined)?.EnvironmentId;
  if (typeof id !== "string" || !id) throw new Error("RetrieveCurrentOrganization returned no EnvironmentId");
  return id;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const lastSeg = (v: string | null): string | null => (v ? (v.split("/").filter(Boolean).pop() ?? null) : null);

/** One connection from the list response. Returns null when it has no usable id. */
export function normalizeConnection(c: Row): PpConnection | null {
  const p = (c.properties ?? {}) as Row;
  const rid = str(c.id) ?? "";
  // /providers/Microsoft.PowerApps/apis/<connector>/connections/<name>
  const m = rid.match(/\/apis\/([^/]+)\/connections\/([^/?]+)/i);
  const id = str(c.name) ?? (m ? m[2] : null);
  if (!id) return null;
  const api = p.api as Row | undefined;
  const connector = (m?.[1] ?? lastSeg(str(p.apiId)) ?? lastSeg(str(api?.id)) ?? str(api?.name) ?? lastSeg(str(p.connectorId)))?.toLowerCase() ?? null;
  const createdBy = p.createdBy as Row | undefined;
  const account = str(p.accountName) ?? str(createdBy?.email) ?? str(createdBy?.userPrincipalName) ?? str(createdBy?.displayName);
  const statuses = Array.isArray(p.statuses) ? (p.statuses as Row[]) : [];
  const status = str(statuses[0]?.status) ?? str(p.connectionStatus) ?? str(p.status);
  return {
    id,
    connector,
    displayName: str(p.displayName) ?? id,
    account,
    status,
    broken: !!status && /error|expired|unauthenticated|invalid/i.test(status),
  };
}

/** Relative path of an absolute Power Platform API next link (".../connectivity/<path>" → "<path>"). */
export function relativePpLink(link: string): string {
  const m = link.match(/api\.powerplatform\.com\/connectivity\/(.*)$/i);
  return m ? m[1] : link;
}

/** All connections of the environment, following next links. */
export async function listConnections(pp: ConnectivityLike, envId: string, target: Target): Promise<PpConnection[]> {
  const out: PpConnection[] = [];
  let path: string | null = `environments/${encodeURIComponent(envId)}/connections?api-version=${CONNECTIONS_API_VERSION}`;
  const seen = new Set<string>();
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const r: Row = await pp.Get(path, target);
    const value = Array.isArray(r.value) ? (r.value as Row[]) : [];
    for (const c of value) {
      const n = normalizeConnection(c);
      if (n) out.push(n);
    }
    const next = str(r.nextLink) ?? str(r["@odata.nextLink"]);
    path = next ? relativePpLink(next) : null;
    if (path && seen.has(path)) break;
    if (path) seen.add(path);
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Connector name of a matrix row in column `key` (from the reference's connectorId). */
export const rowConnector = (r: ConnRefRow, key: string): string | null => lastSeg(r.cells[key]?.record?.connectorId ?? null)?.toLowerCase() ?? null;

/** Connections offered for a row: same connector only. Connections whose connector is unknown are never offered. */
export function connectionsFor(conns: PpConnection[], connector: string | null): PpConnection[] {
  if (!connector) return [];
  return conns.filter((c) => c.connector === connector);
}

/** Readable reason for a failed Power Platform API call, with what to do about it. */
export function explainPpError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (/403|forbidden|insufficient|consent|AADSTS65001/i.test(msg))
    return `${msg}. The connection's app registration needs the delegated Power Platform API permission Connectivity.Connections.Read with admin consent.`;
  if (/401|authentication expired|no access token|token refresh/i.test(msg))
    return `${msg}. Enable the Power Platform API on this ToolBox connection (custom Client ID) and reconnect.`;
  return msg;
}

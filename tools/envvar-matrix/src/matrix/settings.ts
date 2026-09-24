/**
 * deploymentSettings.json (the `pac solution import --settings-file` shape) loaded as a read-only column, so its
 * values can be compared with and copied into a live environment through the normal preview.
 * An empty Value / ConnectionId means "not set", as pac writes it.
 */
import type { ColumnData } from "./types";

interface Settings {
  EnvironmentVariables?: { SchemaName?: unknown; Value?: unknown }[];
  ConnectionReferences?: { LogicalName?: unknown; ConnectionId?: unknown; ConnectorId?: unknown }[];
}

let counter = 0;
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

/** True when the parsed JSON looks like a deployment settings file. */
export const isDeploymentSettings = (o: unknown): boolean =>
  !!o && typeof o === "object" && (Array.isArray((o as Settings).EnvironmentVariables) || Array.isArray((o as Settings).ConnectionReferences));

export function parseDeploymentSettings(json: string, fileName: string): ColumnData {
  let o: Settings;
  try {
    o = JSON.parse(json) as Settings;
  } catch {
    throw new Error("not valid JSON");
  }
  if (!isDeploymentSettings(o)) throw new Error("not a deploymentSettings file (no EnvironmentVariables / ConnectionReferences)");
  counter++;
  const envVars = (o.EnvironmentVariables ?? []).filter((e) => str(e?.SchemaName));
  const refs = (o.ConnectionReferences ?? []).filter((c) => str(c?.LogicalName));
  return {
    meta: { key: `settings:${counter}`, kind: "snapshot", name: fileName.replace(/\.json$/i, ""), url: "", environment: "Settings file", takenAt: "" },
    envVars: envVars.map((e, i) => ({
      definitionId: `settings-${counter}-${i}`,
      schemaName: String(e.SchemaName),
      displayName: String(e.SchemaName),
      typeCode: 0,
      type: "",
      defaultValue: null,
      value: str(e.Value),
      valueId: null,
      isManaged: false,
    })),
    connRefs: refs.map((c, i) => {
      const connectorId = str(c.ConnectorId);
      return {
        id: `settings-${counter}-${i}`,
        logicalName: String(c.LogicalName),
        displayName: String(c.LogicalName),
        connectorId,
        connector: connectorId ? (connectorId.split("/").pop() ?? null) : null,
        connectionId: str(c.ConnectionId),
        isManaged: false,
      };
    }),
  };
}

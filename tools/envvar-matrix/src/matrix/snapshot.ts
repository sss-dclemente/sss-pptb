import { ENV_VAR_TYPE, type ColumnData } from "./types";

interface SnapEnvVar {
  schemaName: string;
  displayName?: string;
  typeCode?: number;
  type?: string;
  defaultValue?: string | null;
  value?: string | null;
  isManaged?: boolean;
}
interface SnapConnRef {
  logicalName: string;
  displayName?: string;
  connectorId?: string | null;
  connectionId?: string | null;
  isManaged?: boolean;
}
interface Snap {
  kind: string;
  version: number;
  environment?: { name?: string; url?: string; environment?: string; takenAt?: string };
  environmentVariables?: SnapEnvVar[];
  connectionReferences?: SnapConnRef[];
}

let counter = 0;

export function parseSnapshot(json: string, fileName: string): ColumnData {
  let obj: Snap;
  try {
    obj = JSON.parse(json) as Snap;
  } catch {
    throw new Error("not valid JSON");
  }
  if (obj?.kind !== "sss-envvar-matrix-snapshot") throw new Error("not a matrix snapshot (kind mismatch)");
  if (!Array.isArray(obj.environmentVariables) || !Array.isArray(obj.connectionReferences)) throw new Error("snapshot missing arrays");
  counter++;
  const env = obj.environment ?? {};
  return {
    meta: {
      key: `snap:${counter}`,
      kind: "snapshot",
      name: env.name ?? fileName.replace(/\.json$/i, ""),
      url: env.url ?? "",
      environment: env.environment ?? "Snapshot",
      takenAt: env.takenAt ?? "",
    },
    envVars: obj.environmentVariables.map((e, i) => {
      const typeCode = Number(e.typeCode ?? 0);
      return {
        definitionId: `snapshot-${counter}-${i}`,
        schemaName: String(e.schemaName),
        displayName: e.displayName ?? String(e.schemaName),
        typeCode,
        type: e.type ?? ENV_VAR_TYPE[typeCode] ?? "",
        defaultValue: e.defaultValue ?? null,
        value: e.value ?? null,
        valueId: null,
        isManaged: !!e.isManaged,
      };
    }),
    connRefs: obj.connectionReferences.map((c, i) => ({
      id: `snapshot-${counter}-${i}`,
      logicalName: String(c.logicalName),
      displayName: c.displayName ?? String(c.logicalName),
      connectorId: c.connectorId ?? null,
      connector: c.connectorId ? c.connectorId.split("/").pop() ?? null : null,
      connectionId: c.connectionId ?? null,
      isManaged: !!c.isManaged,
    })),
  };
}

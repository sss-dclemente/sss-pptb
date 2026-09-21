import type { ColumnData, Matrix } from "./types";

/** Shape consumed by `pac solution import --settings-file`. */
export function deploymentSettings(col: ColumnData): string {
  const doc = {
    EnvironmentVariables: col.envVars.map((e) => ({ SchemaName: e.schemaName, Value: e.value ?? e.defaultValue ?? "" })),
    ConnectionReferences: col.connRefs.map((c) => ({ LogicalName: c.logicalName, ConnectionId: c.connectionId ?? "", ConnectorId: c.connectorId ?? "" })),
  };
  return JSON.stringify(doc, null, 2);
}

export function snapshot(col: ColumnData): string {
  return JSON.stringify(
    {
      kind: "sss-envvar-matrix-snapshot",
      version: 1,
      environment: { name: col.meta.name, url: col.meta.url, environment: col.meta.environment, takenAt: col.meta.takenAt },
      environmentVariables: col.envVars.map((e) => ({
        schemaName: e.schemaName,
        displayName: e.displayName,
        typeCode: e.typeCode,
        type: e.type,
        defaultValue: e.defaultValue,
        value: e.typeCode === 100000005 ? (e.value == null ? null : "<secret>") : e.value,
        isManaged: e.isManaged,
      })),
      connectionReferences: col.connRefs.map((c) => ({
        logicalName: c.logicalName,
        displayName: c.displayName,
        connectorId: c.connectorId,
        connectionId: c.connectionId,
        isManaged: c.isManaged,
      })),
    },
    null,
    2,
  );
}

function csvCell(v: string | null | undefined): string {
  const s = v ?? "";
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function matrixCsv(m: Matrix): string {
  const cols = m.columns.map((c) => c.name);
  const lines: string[] = [];
  lines.push(["kind", "name", "display name", "type / connector", ...cols.flatMap((c) => [`${c} value`, `${c} state`])].map(csvCell).join(","));
  for (const r of m.envVars) {
    lines.push(
      ["envvar", r.schemaName, r.displayName, r.type, ...m.columns.flatMap((c) => [r.isSecret ? "" : (r.cells[c.key].effective ?? ""), r.cells[c.key].source])]
        .map(csvCell)
        .join(","),
    );
  }
  for (const r of m.connRefs) {
    lines.push(
      ["connref", r.logicalName, r.displayName, r.connector ?? "", ...m.columns.flatMap((c) => [r.cells[c.key].connectionId ?? "", r.cells[c.key].state])]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function safeFileName(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "environment";
}

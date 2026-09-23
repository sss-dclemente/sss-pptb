import { SECRET_TYPE, type ColumnData, type Matrix } from "./types";

export const SECRET_PLACEHOLDER = "<secret>";

/**
 * Shape consumed by `pac solution import --settings-file`.
 * `scope` (lowercase schema/logical names) limits the file to one solution's components.
 * Value is the current value row only: a definition default is not a value, and secrets are never exported
 * (empty Value, like `pac solution create-settings`).
 */
export function deploymentSettings(col: ColumnData, scope: Set<string> | null = null): string {
  const inScope = (name: string) => !scope || scope.has(name.toLowerCase());
  const value = (e: ColumnData["envVars"][number]): string => (e.typeCode === SECRET_TYPE || e.value == null || (col.meta.kind === "snapshot" && e.value === SECRET_PLACEHOLDER) ? "" : e.value);
  const doc = {
    EnvironmentVariables: col.envVars.filter((e) => inScope(e.schemaName)).map((e) => ({ SchemaName: e.schemaName, Value: value(e) })),
    ConnectionReferences: col.connRefs
      .filter((c) => inScope(c.logicalName))
      .map((c) => ({ LogicalName: c.logicalName, ConnectionId: c.connectionId ?? "", ConnectorId: c.connectorId ?? "" })),
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
        value: e.typeCode === SECRET_TYPE ? (e.value == null ? null : SECRET_PLACEHOLDER) : e.value,
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

/** RFC 4180 quoting; cells that a spreadsheet would read as a formula get a leading apostrophe. */
export function csvCell(v: string | null | undefined): string {
  let s = v ?? "";
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function matrixCsv(m: Matrix): string {
  const cols = m.columns.map((c) => c.name);
  const lines: string[] = [];
  lines.push(["kind", "name", "display name", "type / connector", ...cols.flatMap((c) => [`${c} value`, `${c} state`])].map(csvCell).join(","));
  for (const r of m.envVars) {
    lines.push(
      ["envvar", r.schemaName, r.displayName, r.type, ...m.columns.flatMap((c) => [r.isSecret ? "" : (r.cells[c.key].effective ?? ""), c.error ? "error" : r.cells[c.key].source])]
        .map(csvCell)
        .join(","),
    );
  }
  for (const r of m.connRefs) {
    lines.push(
      ["connref", r.logicalName, r.displayName, r.connector ?? "", ...m.columns.flatMap((c) => [r.cells[c.key].connectionId ?? "", c.error ? "error" : r.cells[c.key].state])]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export function safeFileName(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "environment";
}

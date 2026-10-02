/** Findings export: JSON and CSV. */
import { typeName, type Diagnosis } from "./types";

/** RFC 4180 quoting; cells that a spreadsheet would read as a formula get a leading apostrophe. */
export function csvCell(v: string | number | null | undefined): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function findingsCsv(d: Diagnosis): string {
  const lines = [
    ["status", "dependent type", "dependent", "table", "cause", "required type", "required", "required solution", "fixes"].map(csvCell).join(","),
  ];
  for (const f of d.findings)
    for (const r of f.required)
      lines.push(
        [
          f.status,
          typeName(f.dependent.type),
          f.dependent.name,
          f.dependent.table ?? f.dependent.rootTable ?? "",
          f.cause,
          typeName(r.type),
          r.name,
          r.solution?.uniqueName ?? "",
          f.fixes.map((x) => x.kind).join(" | "),
        ]
          .map(csvCell)
          .join(","),
      );
  return lines.join("\n") + "\n";
}

export function findingsJson(d: Diagnosis): string {
  return JSON.stringify(
    {
      kind: "sss-dependency-cleaner-findings",
      version: 1,
      takenAt: d.takenAt,
      environment: d.environment,
      target: d.target,
      solution: { uniqueName: d.solution.uniqueName, friendlyName: d.solution.friendlyName, version: d.solution.version },
      filter: d.filter,
      findings: d.findings,
      errors: d.errors,
      warnings: d.warnings,
    },
    null,
    2,
  );
}

export const safeFileName = (s: string): string => s.replace(/[^a-z0-9._-]+/gi, "_").replace(/^_+|_+$/g, "") || "solution";

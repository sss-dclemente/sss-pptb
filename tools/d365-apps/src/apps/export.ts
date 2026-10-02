/** Exports: matrix CSV, results CSV, pac script for a plan (plan D9). */
import type { Matrix, PlannedInstall, RunItem } from "./types";

/** RFC 4180 quoting; cells a spreadsheet would read as a formula get a leading apostrophe. */
export function csvCell(v: string | number | null | undefined): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const line = (cells: (string | number | null | undefined)[]) => cells.map(csvCell).join(",");

export function matrixCsv(m: Matrix): string {
  const out = [line(["app", "unique name", "publisher", ...m.envs.map((e) => `${e.name} (${e.type})`)])];
  for (const r of m.rows)
    out.push(
      line([
        r.name,
        r.uniqueName,
        r.publisher,
        ...m.envs.map((e) => {
          const c = r.cells.get(e.id);
          if (!c) return "";
          switch (c.kind) {
            case "current":
              return c.installed?.version ?? "installed";
            case "update":
              return `${c.installed?.version ?? "?"} -> ${c.target?.version ?? "?"}`;
            case "failed":
              return `failed: ${c.note ?? ""}`;
            case "busy":
              return c.note ?? "busy";
            case "available":
              return `available ${c.target?.version ?? ""}`.trim();
            case "absent":
              return "";
          }
        }),
      ]),
    );
  return out.join("\n") + "\n";
}

export function resultsCsv(items: RunItem[]): string {
  const out = [line(["environment", "type", "app", "unique name", "action", "from", "to", "status", "operation id", "message", "started", "ended"])];
  for (const i of items) out.push(line([i.env.name, i.env.type, i.name, i.uniqueName, i.action, i.from, i.to, i.status, i.operationId, i.message, i.startedAt, i.endedAt]));
  return out.join("\n") + "\n";
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** PowerShell script running the same plan through pac (`pac application install`), one environment block each. */
export function pacScript(plan: PlannedInstall[], at = new Date()): string {
  const out = [
    `# SSS D365 Apps Matrix: ${plan.length} install(s), generated ${at.toISOString()}`,
    "# Needs the Power Platform CLI and an auth profile with admin rights on each environment: pac auth create",
    "# Installs run one after another; pac waits for each to finish.",
    "$ErrorActionPreference = 'Continue'",
  ];
  const byEnv = new Map<string, PlannedInstall[]>();
  for (const p of plan) byEnv.set(p.env.id, [...(byEnv.get(p.env.id) ?? []), p]);
  for (const list of byEnv.values()) {
    const env = list[0].env;
    out.push("", `# ${env.name} (${env.type || "unknown type"})`);
    for (const p of list) {
      const what = p.action === "update" ? `update ${p.from ?? "?"} -> ${p.to ?? "?"}` : p.action === "retry" ? "retry failed install" : `install ${p.to ?? ""}`.trim();
      out.push(`pac application install --environment ${psQuote(env.id)} --application-name ${psQuote(p.uniqueName)}  # ${p.name}: ${what}`);
    }
  }
  return out.join("\n") + "\n";
}

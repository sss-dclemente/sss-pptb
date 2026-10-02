/** "Unused apps" panel: read-only report for the connection's environment (src/apps/unused.ts). */
import { $, badge, emptyState, h, type BadgeKind } from "../../_shared/dom";
import { errText, listPackages, type PpLike } from "./apps/api";
import type { Environment, Package } from "./apps/types";
import { analyzeUnused, LIGHT_MAX_ROWS, unusedCsv, VERDICT_LABEL, type DvLike, type PackageUse, type UnusedReport, type Verdict } from "./apps/unused";

export interface UnusedDeps {
  pp: () => PpLike | undefined;
  dv: () => DvLike | undefined;
  /** environment of the ToolBox connection (RetrieveCurrentOrganization), null when unknown */
  envId: () => Promise<string | null>;
  envs: () => Environment[];
  /** installed list already read for that environment, if any */
  cached: (envId: string) => Package[] | null;
  notify: (title: string, body: string, type: "success" | "error" | "info" | "warning") => Promise<void>;
  save: (name: string, content: string, mime: string) => Promise<void>;
}

const TONE: Record<Verdict, BadgeKind> = { unused: "ok", light: "warn", "in-use": "neutral", "no-signal": "neutral", "not-found": "neutral", platform: "neutral" };
const QUIET: Verdict[] = ["in-use", "platform"];

let report: UnusedReport | null = null;
let env: Environment | null = null;
let busy = false;

export function initUnused(d: UnusedDeps): void {
  $("#btn-unused").addEventListener("click", () => void open(d));
  $("#btn-unused-close").addEventListener("click", () => {
    $("#unused").hidden = true;
  });
  $("#unused-all").addEventListener("change", render);
  $("#btn-unused-csv").addEventListener("click", () => {
    if (report && env) void d.save(`d365-apps-unused-${env.name.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.csv`, unusedCsv(report, env.name), "text/csv");
  });
}

/** Enabled with a Dataverse connection and the Power Platform API. */
export function unusedAvailable(on: boolean): void {
  $<HTMLButtonElement>("#btn-unused").disabled = !on || busy;
}

async function open(d: UnusedDeps): Promise<void> {
  const pp = d.pp();
  const dv = d.dv();
  if (!pp || !dv || busy) return;
  busy = true;
  $<HTMLButtonElement>("#btn-unused").disabled = true;
  $("#unused").hidden = false;
  report = null;
  const say = (msg: string) => $("#unused-body").replaceChildren(h("p", { class: "caption", id: "unused-progress" }, msg));
  try {
    say("Finding the connection's environment…");
    const id = await d.envId();
    env = d.envs().find((e) => e.id === id) ?? null;
    if (!id || !env) throw new Error("The connection's environment is not in the Power Platform API environment list");
    $("#unused-env").textContent = env.name;
    let installed = d.cached(id);
    if (!installed) {
      say("Reading installed apps…");
      installed = (await listPackages(pp, id)).installed;
    }
    report = await analyzeUnused({ dv, installed, onProgress: say });
    render();
  } catch (e) {
    $("#unused-body").replaceChildren(h("div", { class: "setup", id: "unused-error" }, h("strong", {}, "Report failed. "), errText(e)));
    await d.notify("Unused apps failed", errText(e), "error");
  } finally {
    busy = false;
    $<HTMLButtonElement>("#btn-unused").disabled = false;
    $<HTMLButtonElement>("#btn-unused-csv").disabled = !report;
  }
}

function tablesCell(p: PackageUse): HTMLElement {
  const used = p.tables.filter((t) => (t.rows ?? 0) > 0);
  const failed = p.tables.filter((t) => t.rows === null).length;
  const td = h("td", { class: "caption" }, p.tables.length ? `${used.length} of ${p.tables.length} with rows` : "—");
  if (used.length) td.append(h("span", { class: "note" }, used.slice(0, 3).map((t) => `${t.logicalName}: ${t.atLeast ? "≥" : ""}${t.rows!.toLocaleString()}`).join(", ") + (used.length > 3 ? ` +${used.length - 3}` : "")));
  if (failed) td.append(h("span", { class: "note" }, `${failed} not countable`));
  return td;
}

function detail(p: PackageUse): HTMLElement {
  const list = (title: string, items: string[]) => (items.length ? h("div", {}, h("strong", {}, title), h("ul", {}, ...items.map((x) => h("li", {}, x)))) : null);
  return h(
    "details",
    {},
    h("summary", {}, `${p.solutions.length} own solution${p.solutions.length === 1 ? "" : "s"}${p.shared.length ? `, ${p.shared.length} shared` : ""}`),
    list("Own solutions (uninstall order is yours to work out: anchor first)", p.solutions.map((s) => `${s.uniqueName} ${s.version ?? ""}`)),
    list("Shared with other installed apps (not counted)", p.shared.map((s) => s.uniqueName)),
    list("Own tables", p.tables.map((t) => `${t.logicalName}: ${t.rows === null ? "?" : `${t.atLeast ? "≥" : ""}${t.rows.toLocaleString()}`}`)),
    p.sharedTables.length ? h("p", { class: "caption" }, `${p.sharedTables.length} shared table(s) not counted: ${p.sharedTables.slice(0, 12).join(", ")}${p.sharedTables.length > 12 ? "…" : ""}`) : null,
  );
}

function render(): void {
  const body = $("#unused-body");
  if (!report) return;
  const all = $<HTMLInputElement>("#unused-all").checked;
  const rows = report.packages.filter((p) => all || !QUIET.includes(p.verdict));
  const n = (v: Verdict) => report!.packages.filter((p) => p.verdict === v).length;
  const head = h(
    "div",
    { class: "summary-line", id: "unused-counts" },
    badge(`${n("unused")} probably unused`, n("unused") ? "ok" : "neutral"),
    badge(`${n("light")} seed data only?`, n("light") ? "warn" : "neutral"),
    badge(`${n("in-use")} in use`, "neutral"),
    n("no-signal") + n("not-found") ? badge(`${n("no-signal") + n("not-found")} no signal`, "neutral") : null,
    badge(`${n("platform")} platform`, "neutral"),
  );
  const notes = h(
    "p",
    { class: "caption" },
    `Read-only. Verdicts come from row counts in tables that only this app's solutions contain (RetrieveTotalRecordCount, a snapshot under 24 h old; every zero is re-checked live). "Seed data only?" means no such table has more than ${LIGHT_MAX_ROWS} rows. There is no usage telemetry here: "probably unused" is a lead to check, not a verdict to act on. There is no uninstall in the Power Platform API; remove an app by deleting its solutions in the environment, anchor first.`,
    report.history ? "" : " Solution history was not readable, so only anchor solutions were mapped.",
  );
  const warn = report.warnings.length ? h("div", { class: "warnings" }, ...report.warnings.map((w) => h("div", {}, w))) : null;
  const tbl = rows.length
    ? h(
        "table",
        { id: "unused-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "App"), h("th", {}, "Verdict"), h("th", {}, "Own tables"), h("th", {}, "Model-driven apps"), h("th", {}, "Solutions"))),
        h(
          "tbody",
          {},
          ...rows.map((p) =>
            h(
              "tr",
              { "data-app": p.pkg.uniqueName, "data-verdict": p.verdict },
              h("td", { class: "name" }, h("span", {}, p.pkg.name), h("span", { class: "uname" }, `${p.pkg.uniqueName} ${p.pkg.version ?? ""}`)),
              h("td", {}, badge(VERDICT_LABEL[p.verdict], TONE[p.verdict])),
              tablesCell(p),
              h("td", { class: "caption" }, p.apps.length ? p.apps.map((a) => `${a.name} (${a.roles === null ? "?" : a.roles} role${a.roles === 1 ? "" : "s"})`).join(", ") : "—"),
              h("td", { class: "caption" }, p.mappedBy ? detail(p) : "not found"),
            ),
          ),
        ),
      )
    : emptyState("Nothing to show", all ? "No installed apps." : "Every app is in use or a platform app (tick Show all).");
  body.replaceChildren(head, notes, warn ?? "", tbl);
}

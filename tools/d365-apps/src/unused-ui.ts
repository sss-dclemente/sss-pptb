/** "Unused apps" panel: read-only report for the connection's environment (src/apps/unused.ts). Hide keeps the report; Re-run reads it again. */
import { $, badge, emptyState, filteredEmpty, foldAllButtons, h, keepFold, shownOf, type BadgeKind } from "../../_shared/dom";
import { loadView, persistControls, saveView, type PersistedControls } from "../../_shared/view-state";
import { errText, listPackages, type PpLike } from "./apps/api";
import type { Environment, Package } from "./apps/types";
import { analyzeUnused, LIGHT_MAX_ROWS, unusedCsv, unusedShown, verdictGroup, VERDICT_LABEL, type DvLike, type PackageUse, type UnusedReport, type Verdict } from "./apps/unused";
import { toggleBadge } from "./toggle";

export interface UnusedDeps {
  /** view-state key (filters persisted per viewer) */
  tool: string;
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
const GROUPS: Verdict[] = ["unused", "light", "in-use", "no-signal", "platform"];

let report: UnusedReport | null = null;
let env: Environment | null = null;
let busy = false;
let available = false;
/** bumped by resetUnused: a report still running for the previous connection is dropped */
let gen = 0;
let tool = "";
let nameFilter: PersistedControls | null = null;
/** pressed verdict badges (groups, any of them); persisted per viewer */
const verdicts = new Set<Verdict>();

export function initUnused(d: UnusedDeps): void {
  tool = d.tool;
  nameFilter = persistControls(tool, ["unused-filter"]);
  const saved = loadView<unknown>(tool, "unusedVerdicts", []);
  if (Array.isArray(saved)) for (const v of saved) if (GROUPS.includes(v as Verdict)) verdicts.add(v as Verdict);
  $("#btn-unused").addEventListener("click", () => void show(d));
  $("#btn-unused-hide").addEventListener("click", () => {
    $("#unused").hidden = true;
  });
  $("#btn-unused-rerun").addEventListener("click", () => void runReport(d));
  $("#unused-all").addEventListener("change", render);
  $("#unused-filter").addEventListener("input", render);
  $("#btn-unused-csv").addEventListener("click", () => {
    if (report && env) void d.save(`d365-apps-unused-${env.name.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.csv`, unusedCsv(report, env.name), "text/csv");
  });
}

function syncButtons(): void {
  $<HTMLButtonElement>("#btn-unused").disabled = !available || busy;
  $<HTMLButtonElement>("#btn-unused-rerun").disabled = !available || busy;
  $<HTMLButtonElement>("#btn-unused-csv").disabled = !report;
}

/** Enabled with a Dataverse connection and the Power Platform API. */
export function unusedAvailable(on: boolean): void {
  available = on;
  syncButtons();
}

/** New connection: the kept report belongs to the previous environment. */
export function resetUnused(): void {
  gen++;
  busy = false;
  report = null;
  env = null;
  $("#unused").hidden = true;
  $("#unused-body").replaceChildren();
  syncButtons();
}

/** Unused apps…: shows the kept report (no reads), or reads it the first time / after a failed attempt. */
async function show(d: UnusedDeps): Promise<void> {
  $("#unused").hidden = false;
  if (report || busy) return;
  await runReport(d);
}

async function runReport(d: UnusedDeps): Promise<void> {
  const pp = d.pp();
  const dv = d.dv();
  if (!pp || !dv || busy) return;
  const g = ++gen;
  busy = true;
  report = null;
  syncButtons();
  $("#unused").hidden = false;
  const say = (msg: string) => {
    if (g === gen) $("#unused-body").replaceChildren(h("p", { class: "caption", id: "unused-progress" }, msg));
  };
  try {
    say("Finding the connection's environment…");
    const id = await d.envId();
    if (g !== gen) return;
    env = d.envs().find((e) => e.id === id) ?? null;
    if (!id || !env) throw new Error("The connection's environment is not in the Power Platform API environment list");
    $("#unused-env").textContent = env.name;
    let installed = d.cached(id);
    if (!installed) {
      say("Reading installed apps…");
      installed = (await listPackages(pp, id)).installed;
    }
    const r = await analyzeUnused({ dv, installed, onProgress: say });
    if (g !== gen) return;
    report = r;
    render();
  } catch (e) {
    if (g !== gen) return;
    $("#unused-body").replaceChildren(h("div", { class: "setup", id: "unused-error" }, h("strong", {}, "Report failed. "), errText(e)));
    await d.notify("Unused apps failed", errText(e), "error");
  } finally {
    if (g === gen) {
      busy = false;
      syncButtons();
    }
  }
}

const filtersActive = (): boolean => !!nameFilter?.active() || verdicts.size > 0;
function saveVerdicts(): void {
  saveView(tool, "unusedVerdicts", verdicts.size ? [...verdicts] : undefined);
}
/** Clear the name filter and the pressed verdict badges (Show all stays: a view preference). */
function clearFilters(): void {
  nameFilter?.reset();
  verdicts.clear();
  saveVerdicts();
  render();
}
function toggleVerdict(v: Verdict): void {
  if (!verdicts.delete(v)) verdicts.add(v);
  saveVerdicts();
  render();
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
  const el = h(
    "details",
    { class: "sol-fold" },
    h("summary", { class: "chev" }, `${p.solutions.length} own solution${p.solutions.length === 1 ? "" : "s"}${p.shared.length ? `, ${p.shared.length} shared` : ""}`),
    list("Own solutions (uninstall order is yours to work out: anchor first)", p.solutions.map((s) => `${s.uniqueName} ${s.version ?? ""}`)),
    list("Shared with other installed apps (not counted)", p.shared.map((s) => s.uniqueName)),
    list("Own tables", p.tables.map((t) => `${t.logicalName}: ${t.rows === null ? "?" : `${t.atLeast ? "≥" : ""}${t.rows.toLocaleString()}`}`)),
    p.sharedTables.length ? h("p", { class: "caption" }, `${p.sharedTables.length} shared table(s) not counted: ${p.sharedTables.slice(0, 12).join(", ")}${p.sharedTables.length > 12 ? "…" : ""}`) : null,
  );
  // stays open across filter changes and Re-run
  return keepFold(el, `unused:${p.pkg.uniqueName.toLowerCase()}`);
}

function render(): void {
  const body = $("#unused-body");
  if (!report) return;
  const all = $<HTMLInputElement>("#unused-all").checked;
  const rows = unusedShown(report.packages, { all, verdicts, query: $<HTMLInputElement>("#unused-filter").value });
  const n = (v: Verdict) => report!.packages.filter((p) => verdictGroup(p.verdict) === v).length;
  /** a verdict count that filters the report to that verdict; shown while it counts something or is pressed (in use and platform always) */
  const vb = (v: Verdict, text: string, kind: BadgeKind, always = false) => {
    const c = n(v);
    const on = verdicts.has(v);
    if (!c && !on && !always) return null;
    return toggleBadge(text, kind, on, () => toggleVerdict(v), { "data-verdict": v, title: `Show only "${VERDICT_LABEL[v]}" apps. Pressed badges combine (any of them) and override Show all.`, disabled: !c && !on });
  };
  let clear: HTMLElement | null = null;
  if (filtersActive()) {
    clear = h("button", { class: "btn btn-ghost btn-sm", type: "button", id: "btn-unused-clear" }, "Clear filters");
    clear.addEventListener("click", clearFilters);
  }
  const head = h(
    "div",
    { class: "summary-line", id: "unused-counts" },
    h("span", { class: "count-caption", id: "unused-shown" }, shownOf(rows.length, report.packages.length, "apps")),
    vb("unused", `${n("unused")} probably unused`, n("unused") ? "ok" : "neutral", true),
    vb("light", `${n("light")} seed data only?`, n("light") ? "warn" : "neutral", true),
    vb("in-use", `${n("in-use")} in use`, "neutral", true),
    vb("no-signal", `${n("no-signal")} no signal`, "neutral"),
    vb("platform", `${n("platform")} platform`, "neutral", true),
    clear,
    foldAllButtons(() => document.querySelector("#unused-table"), "details.sol-fold"),
  );
  const how = keepFold(
    h(
      "details",
      { class: "how", id: "unused-how" },
      h("summary", { class: "chev" }, "How verdicts work"),
      h(
        "p",
        {},
        `Read-only. Verdicts come from row counts in tables that only this app's solutions contain (RetrieveTotalRecordCount, a snapshot under 24 h old; every zero is re-checked live). "Seed data only?" means no such table has more than ${LIGHT_MAX_ROWS} rows. There is no usage telemetry here: "probably unused" is a lead to check, not a verdict to act on. There is no uninstall in the Power Platform API; remove an app by deleting its solutions in the environment, anchor first.`,
      ),
    ),
    "unused:how",
  );
  const noHistory = report.history ? null : h("p", { class: "caption", id: "unused-no-history" }, "Solution history was not readable, so only anchor solutions were mapped.");
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
    : !report.packages.length
      ? emptyState("Nothing to show", "No installed apps.")
      : filtersActive()
        ? filteredEmpty("Nothing to show", "No app matches the filters.", clearFilters)
        : emptyState("Nothing to show", "Every app is in use or a platform app (tick Show all).");
  body.replaceChildren(head, how, noHistory ?? "", warn ?? "", tbl);
}

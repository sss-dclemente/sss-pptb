import { $, badge, card, emptyState, h, showDialog, table as domTable, wireTabs } from "../../_shared/dom";
import { dataverse, getConnections, initTheme, inToolbox, notify, onConnectionChange, openText, saveText } from "../../_shared/host";
import { matrixCsv, planCsv, planScript, safeFileName } from "./audit/export";
import { fetchColumns, fetchEnv, type DataverseLike } from "./audit/fetch";
import { buildMatrix, filterRows, visibleColumns } from "./audit/matrix";
import { parseSnapshot, serializeSnapshot } from "./audit/snapshot";
import type { EnvData, EnvMeta, Filters, FlagState, Matrix, MatrixTableRow, OrgAudit } from "./audit/types";
import { applyPlan, planMatchOther, planSet, publishTables, tablesToPublish, type Plan, type PlanBuild, type PlanItem, type PlanResult } from "./audit/write";

// ---------- state ----------
let primary: EnvData | null = null;
let others: EnvData[] = [];
let matrix: Matrix = { primary: null, other: null, rows: [], counts: { tables: 0, tablesAudited: 0, tablesDiffer: 0, loadedTables: 0, columnsAudited: 0, columnsDiffer: 0, columnsInert: 0 },
  orgAuditEnabled: null,
  inertTables: 0,
};
const expanded = new Set<string>();
const selected = new Set<string>();
let plan: PlanItem[] = [];
let cancelRun = false;
/** Comparison column to select on the next render (a snapshot just loaded). */
let preferCompare: string | null = null;

const api = (): DataverseLike | null => (dataverse() as unknown as DataverseLike) ?? null;
const otherEnv = (): EnvData | null => others.find((o) => o.meta.key === $<HTMLSelectElement>("#compare").value) ?? null;

function filters(): Filters {
  return {
    text: $<HTMLInputElement>("#filter-text").value,
    audit: $<HTMLSelectElement>("#filter-audit").value as Filters["audit"],
    onlyDiff: $<HTMLInputElement>("#filter-diff").checked,
    managed: $<HTMLSelectElement>("#filter-managed").value as Filters["managed"],
    withColumns: $<HTMLInputElement>("#filter-cols").checked,
  };
}

function setStatus(msg: string | null, onCancel?: () => void): void {
  const el = $("#status");
  el.hidden = !msg;
  el.replaceChildren();
  if (!msg) return;
  el.append(msg);
  if (onCancel) {
    const b = h("button", { class: "btn btn-sm", type: "button", style: "margin-left:8px" }, "Cancel");
    b.addEventListener("click", onCancel);
    el.append(b);
  }
}

// ---------- header ----------
function colChip(meta: EnvMeta, removable: boolean): HTMLElement {
  const dot = h("span", { class: "dot" });
  if (meta.color) dot.style.background = meta.color;
  const chip = h(
    "span",
    { class: "colchip", title: meta.url },
    dot,
    h("span", { class: "env" }, meta.name),
    h("span", { class: "kind" }, meta.kind === "live" ? `${meta.target} · ${meta.environment}` : `snapshot${meta.takenAt ? ` · ${meta.takenAt.slice(0, 10)}` : ""}`),
  );
  if (removable) {
    const x = h("button", { class: "btn-icon", type: "button", "aria-label": `Remove ${meta.name}` }, "×");
    x.addEventListener("click", () => {
      others = others.filter((o) => o.meta.key !== meta.key);
      rebuild();
    });
    chip.append(x);
  }
  return chip;
}

function renderHeader(): void {
  const wrap = $("#columns");
  wrap.replaceChildren();
  if (primary) wrap.append(colChip(primary.meta, false));
  else wrap.append(h("span", { class: "caption" }, inToolbox() ? "No connection. Pick a primary connection in ToolBox." : "Not running inside ToolBox."));
  for (const o of others) wrap.append(colChip(o.meta, o.meta.kind === "snapshot"));

  const sel = $<HTMLSelectElement>("#compare");
  const want = preferCompare ?? sel.value;
  preferCompare = null;
  sel.replaceChildren(h("option", { value: "" }, "none"), ...others.map((o) => h("option", { value: o.meta.key }, `${o.meta.name} (${o.meta.kind === "live" ? o.meta.target : "snapshot"})`)));
  sel.value = others.some((o) => o.meta.key === want) ? want : (others[0]?.meta.key ?? "");

  $("#btn-refresh").toggleAttribute("disabled", !inToolbox());
  $("#btn-plan-match").toggleAttribute("disabled", !otherEnv() || !primary);
  for (const id of ["#btn-export-csv", "#btn-export-snap"]) $(id).toggleAttribute("disabled", !primary);
  $("#host-mode").textContent = inToolbox() ? "Running inside Power Platform ToolBox" : "Not running inside ToolBox — connect a ToolBox environment to load data";
}

function renderCounts(): void {
  const c = matrix.counts;
  const metric = (value: string, label: string, title?: string) => h("span", { class: "metric", title }, h("strong", {}, value), h("span", {}, label));
  const items: HTMLElement[] = [
    metric(`${c.tablesAudited} / ${c.tables}`, "tables audited"),
    metric(String(c.tablesDiffer), matrix.other ? `table differences vs ${matrix.other.name}` : "table differences (no comparison)"),
    metric(String(c.columnsAudited), `columns audited in ${c.loadedTables} expanded table${c.loadedTables === 1 ? "" : "s"}`, "Column flags are read when a row is expanded, so this counts expanded tables only."),
    metric(String(c.columnsDiffer), "column differences"),
  ];
  if (c.columnsInert) items.push(metric(String(c.columnsInert), "audited columns capturing nothing", "Their table, or the organization, has auditing off."));
  $("#counts").replaceChildren(...items);
  renderOrgBanner();
}

/**
 * Auditing is an AND across three levels: organization, table, column. A matrix full of green
 * table flags in an environment whose organization switch is off records nothing at all, and that
 * is exactly the situation someone opens this tool to discover — so it is said on the matrix
 * itself, not left on another tab.
 */
function renderOrgBanner(): void {
  const el = document.querySelector("#org-banner");
  if (!el) return;
  const on = matrix.orgAuditEnabled;
  if (on !== false || !matrix.primary) {
    el.replaceChildren();
    (el as HTMLElement).hidden = true;
    return;
  }
  (el as HTMLElement).hidden = false;
  el.replaceChildren(
    badge("auditing off", "bad"),
    h(
      "span",
      {},
      `Auditing is switched off for ${matrix.primary.name} at the organization level, so nothing in this matrix is being captured` +
        (matrix.inertTables ? `, including the ${matrix.inertTables} table${matrix.inertTables === 1 ? "" : "s"} whose flag reads on` : "") +
        ". Turn it on in the Power Platform admin centre; these flags decide what is captured only once it is.",
    ),
  );
}

// ---------- matrix ----------
const flagBadge = (s: FlagState, locked = false): HTMLElement =>
  h("span", { class: "flag" }, s === "absent" ? badge("—", "neutral") : badge(s, s === "on" ? "ok" : "neutral"), locked ? badge("locked", "warn") : null);

function tableRow(r: MatrixTableRow, f: Filters): HTMLElement[] {
  const open = expanded.has(r.logicalName);
  const cb = h("input", { type: "checkbox", "aria-label": `Select table ${r.logicalName}` }) as HTMLInputElement;
  cb.checked = selected.has(`t:${r.key}`);
  cb.disabled = r.locked;
  cb.title = r.locked ? "Audit flag locked by the managing solution" : "";
  cb.addEventListener("change", () => {
    if (cb.checked) selected.add(`t:${r.key}`);
    else selected.delete(`t:${r.key}`);
    renderBulkbar();
  });
  const exp = h("button", { class: "expander", type: "button", "aria-label": `${open ? "Collapse" : "Expand"} ${r.logicalName}`, "aria-expanded": open ? "true" : "false" }, open ? "▾" : "▸");
  exp.addEventListener("click", () => void toggleRow(r));

  const rows: HTMLElement[] = [
    h(
      "tr",
      { class: [r.differs ? "differs" : "", r.locked ? "locked" : ""].filter(Boolean).join(" ") || undefined },
      h("td", { class: "sel" }, cb),
      h("td", { class: "name" }, exp, h("span", { class: "mono" }, r.logicalName), h("span", { class: "display" }, r.displayName)),
      h("td", {}, badge(r.isManaged ? "managed" : "custom", "neutral"), " ", badge(r.ownership, "neutral")),
      h("td", { class: "cell" }, flagBadge(r.state, r.locked)),
      h("td", { class: "cell" }, matrix.other ? flagBadge(r.otherState) : h("span", { class: "caption" }, "—")),
      h("td", {}, r.differs ? h("span", { class: "diffmark", title: "Differs from the comparison environment" }, "≠") : ""),
      h(
        "td",
        { class: "caption" },
        r.stats
          ? `${r.stats.audited} / ${r.stats.total} audited${r.stats.inert ? ` (${r.stats.inert} capturing nothing)` : ""}${r.stats.differs ? ` · ${r.stats.differs} ≠` : ""}${r.stats.secured ? ` · ${r.stats.secured} secured` : ""}`
          : "expand to load",
      ),
    ),
  ];
  if (!open || !r.columns) return rows;

  const cols = visibleColumns(r, f);
  const body = cols.length
    ? h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Column"), h("th", {}, "Type"), h("th", {}, matrix.primary?.name ?? "primary"), h("th", {}, matrix.other?.name ?? "other"), h("th", {}, ""))),
        h(
          "tbody",
          {},
          ...cols.map((c) => {
            const ccb = h("input", { type: "checkbox", "aria-label": `Select column ${c.tableLogicalName}.${c.logicalName}` }) as HTMLInputElement;
            ccb.checked = selected.has(`c:${c.key}`);
            ccb.disabled = c.locked;
            ccb.addEventListener("change", () => {
              if (ccb.checked) selected.add(`c:${c.key}`);
              else selected.delete(`c:${c.key}`);
              renderBulkbar();
            });
            return h(
              "tr",
              { class: c.differs ? "differs" : undefined },
              h("td", { class: "sel" }, ccb),
              h("td", { class: "name" }, h("span", { class: "mono" }, c.logicalName), h("span", { class: "display" }, c.displayName), c.isSecured ? badge("secured", "warn") : null),
              h("td", { class: "caption" }, c.attributeType),
              h(
                "td",
                {
                  class: c.inert ? "cell col-inert" : "cell",
                  title: c.inert ? (matrix.orgAuditEnabled === false ? "On, but auditing is off for the organization: nothing is captured." : "On, but this table's audit flag is off: nothing is captured for this column.") : undefined,
                },
                flagBadge(c.state, c.locked),
                c.inert ? badge("inert", "warn") : null,
              ),
              h("td", { class: "cell" }, matrix.other ? flagBadge(c.otherState) : h("span", { class: "caption" }, "—")),
              h("td", {}, c.differs ? h("span", { class: "diffmark" }, "≠") : ""),
            );
          }),
        ),
      )
    : h("span", { class: "caption" }, "No columns match the filters.");
  rows.push(h("tr", { class: "colrow" }, h("td", { colspan: "7" }, body)));
  return rows;
}

function renderMatrix(): void {
  const body = $("#matrix-body");
  body.replaceChildren();
  renderCounts();
  if (!matrix.rows.length) {
    body.append(
      emptyState(
        primary ? "No tables" : "Nothing loaded",
        inToolbox() ? "Pick a primary connection in ToolBox, then Refresh." : "This tool reads Dataverse through ToolBox. Load a snapshot to inspect one offline.",
      ),
    );
    renderBulkbar();
    return;
  }
  const f = filters();
  const rows = filterRows(matrix.rows, f);
  if (!rows.length) {
    body.append(emptyState("No tables match", "Adjust the filters."));
    renderBulkbar();
    return;
  }
  body.append(
    h(
      "table",
      { class: "matrix" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { class: "sel" }, ""),
          h("th", {}, "Table"),
          h("th", {}, "Layer"),
          h("th", { class: "col" }, "primary", h("span", { class: "env" }, matrix.primary?.name ?? "—")),
          h("th", { class: "col" }, matrix.other ? (matrix.other.kind === "live" ? "secondary" : "snapshot") : "comparison", h("span", { class: "env" }, matrix.other?.name ?? "none")),
          h("th", {}, "Diff"),
          h("th", {}, "Columns"),
        ),
      ),
      h("tbody", {}, ...rows.flatMap((r) => tableRow(r, f))),
    ),
  );
  renderBulkbar();
}

function renderBulkbar(): void {
  $("#bulkbar").hidden = selected.size === 0 || !primary;
  $("#sel-count").textContent = String(selected.size);
}

// ---------- org tab ----------
function orgCard(env: EnvData): HTMLElement {
  const o: OrgAudit | null = env.org;
  const row = (k: string, v: boolean | number | string | null): (string | Node)[] => [k, v == null ? badge("unknown", "neutral") : typeof v === "boolean" ? badge(v ? "on" : "off", v ? "ok" : "neutral") : String(v)];
  const body = o
    ? h(
        "div",
        {},
        domTable(
          ["Setting", "Value"],
          [
            row("Auditing (isauditenabled)", o.isAuditEnabled),
            row("User access auditing (isuseraccessauditenabled)", o.isUserAccessAuditEnabled),
            row("Read auditing (isreadauditenabled)", o.isReadAuditEnabled),
            row(
              `Retention, days${o.retentionSource ? ` (${o.retentionSource === "v2" ? "auditretentionperiodv2" : "auditretentionperiod, legacy"})` : ""}`,
              o.retentionDays === -1 ? "forever (-1)" : o.retentionDays,
            ),
          ],
        ),
        o.unavailable.length ? h("p", { class: "caption", style: "margin-top:8px" }, `Not returned by this environment: ${o.unavailable.join(", ")}`) : null,
      )
    : h("span", { class: "caption" }, "Org settings could not be read.");
  return card(`${env.meta.name} · ${env.meta.environment}`, body, badge(env.meta.kind, "neutral"));
}

function renderOrg(): void {
  const body = $("#org-body");
  body.replaceChildren();
  const envs = [primary, otherEnv()].filter((e): e is EnvData => !!e);
  if (!envs.length) {
    body.append(emptyState("No environment loaded", "Connect in ToolBox and Refresh, or load a snapshot."));
    return;
  }
  body.append(
    h("div", { class: "orggrid" }, ...envs.map(orgCard)),
    h(
      "p",
      { class: "caption" },
      "Read-only in v1. Org-level auditing is environment-wide: turning it off stops all audit capture and turning it on starts billing storage, so this tool does not write it. Change it in the Power Platform admin centre, then Refresh.",
    ),
  );
}

// ---------- plan / apply ----------
function renderApply(): void {
  $("#plan-count").textContent = String(plan.length);
  $("#plan-count").hidden = plan.length === 0;
  for (const id of ["#btn-apply", "#btn-export-plan-csv", "#btn-export-plan-ps", "#btn-clear-plan"]) $(id).toggleAttribute("disabled", plan.length === 0 || (id === "#btn-apply" && !primary));
  $("#apply-target").textContent = primary ? `Target: ${primary.meta.name} (${primary.meta.environment}) — every change goes to the primary connection` : "No primary connection";
  const body = $("#apply-body");
  body.replaceChildren();
  if (!plan.length) {
    body.append(emptyState("No plan yet", "Select tables or columns in the Matrix tab and use “Plan: audit on / off”, or build one with “Plan: match other env”."));
    return;
  }
  body.append(card(`${plan.length} pending change${plan.length === 1 ? "" : "s"}`, planTable(plan)));
}

function planTable(items: PlanItem[]): HTMLElement {
  return domTable(
    ["Level", "Table", "Column", "Current", "Planned", "Why"],
    items.map((i) => [
      badge(i.level, "neutral"),
      h("span", { class: "mono" }, i.table),
      i.column ? h("span", { class: "mono" }, i.column) : "—",
      badge(i.current ? "on" : "off", i.current ? "ok" : "neutral"),
      badge(i.next ? "on" : "off", i.next ? "ok" : "neutral"),
      h("span", { class: "caption" }, i.reason),
    ]),
  );
}

function addToPlan(build: PlanBuild, label: string): void {
  const seen = new Set(plan.map((i) => `${i.level}:${i.table}:${i.column ?? ""}`));
  let added = 0;
  for (const i of build.items) {
    const k = `${i.level}:${i.table}:${i.column ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    plan.push(i);
    added++;
  }
  renderApply();
  const skippedNote = build.skipped.length ? `, ${build.skipped.length} skipped (${build.skipped[0].reason}${build.skipped.length > 1 ? ", …" : ""})` : "";
  void notify(label, `${added} change${added === 1 ? "" : "s"} added to the plan${skippedNote}`, added ? "success" : "warning");
}

async function runPlan(): Promise<void> {
  const a = api();
  if (!a || !primary || !plan.length) return;
  const current: Plan = { target: primary.meta, items: plan };
  const isProd = /prod/i.test(primary.meta.environment);
  const ok = await showDialog({
    title: "Preview changes",
    target: h("span", {}, "Target:", colChip(primary.meta, false)),
    body: h(
      "div",
      {},
      h("p", { class: "caption" }, `${plan.length} metadata write${plan.length === 1 ? "" : "s"} to ${primary.meta.name} (${primary.meta.environment}). Each one re-reads the current definition and changes only IsAuditEnabled.`),
      isProd ? h("div", { class: "warnings" }, "Target is a Production environment.") : null,
      // Turning a flag on is not the same as capturing anything: the organization switch gates both
      // other levels, so a plan that switches things on there changes metadata and nothing else.
      primary.org?.isAuditEnabled === false && plan.some((i) => i.next)
        ? h(
            "div",
            { class: "warnings" },
            `Auditing is off for ${primary.meta.name} at the organization level. These writes will set the flags, but nothing will be captured until auditing is switched on in the Power Platform admin centre.`,
          )
        : null,
      planTable(plan),
    ),
    okLabel: `Apply ${plan.length}`,
    danger: isProd,
  });
  if (!ok) return;

  cancelRun = false;
  setStatus(`Writing 0/${plan.length}…`, () => {
    cancelRun = true;
    setStatus("Cancelling…");
  });
  const results = await applyPlan(a, current, {
    concurrency: 3,
    cancelled: () => cancelRun,
    onProgress: (done, total, name) => setStatus(`Writing ${done}/${total} — ${name}`, () => (cancelRun = true)),
  });
  setStatus(null);
  const failed = results.filter((r) => !r.ok);
  await notify(failed.length ? "Some writes failed" : "Audit flags updated", `${results.length - failed.length} ok, ${failed.length} failed`, failed.length ? "warning" : "success");
  plan = plan.filter((i) => !results.some((r) => r.ok && r.level === i.level && r.table === i.table && r.column === i.column));
  renderApply();
  await showResults(results);
  const publishable = tablesToPublish(results);
  if (publishable.length) await offerPublish(a, publishable);
  await refresh();
}

async function showResults(results: PlanResult[]): Promise<void> {
  await showDialog({
    title: "Results",
    body: domTable(
      ["Level", "Table", "Column", "Result"],
      results.map((r) => [badge(r.level, "neutral"), h("span", { class: "mono" }, r.table), r.column ? h("span", { class: "mono" }, r.column) : "—", r.ok ? badge("ok", "ok") : badge(r.error ?? "failed", "bad")]),
    ),
  });
}

async function offerPublish(a: DataverseLike, tables: string[]): Promise<void> {
  const ok = await showDialog({
    title: "Publish customizations",
    body: h(
      "div",
      {},
      h("p", {}, `Audit metadata changes only take effect after publishing. Publish ${tables.length} table${tables.length === 1 ? "" : "s"}?`),
      h("p", { class: "caption" }, tables.join(", ")),
    ),
    okLabel: "Publish",
  });
  if (!ok || !primary?.meta.target) return;
  setStatus("Publishing…");
  const results = await publishTables(a, tables, primary.meta.target);
  setStatus(null);
  const failed = results.filter((r) => !r.ok);
  await notify(failed.length ? "Publish partly failed" : "Published", `${results.length - failed.length} of ${results.length} tables`, failed.length ? "warning" : "success");
}

// ---------- data ----------
async function refresh(): Promise<void> {
  const a = api();
  const conns = await getConnections();
  if (!a || !conns.length) {
    primary = null;
    others = others.filter((o) => o.meta.kind === "snapshot");
    rebuild();
    return;
  }
  setStatus("Loading tables…");
  try {
    const loaded = await Promise.all(
      conns.map((c) =>
        fetchEnv(a, { key: c.target, kind: "live", target: c.target, name: c.conn.name, url: c.conn.url, environment: c.conn.environment, color: c.conn.environmentColor, takenAt: "" }),
      ),
    );
    primary = loaded.find((l) => l.meta.target === "primary") ?? null;
    const secondary = loaded.find((l) => l.meta.target === "secondary");
    others = [...(secondary ? [secondary] : []), ...others.filter((o) => o.meta.kind === "snapshot")];
    expanded.clear();
    setStatus(null);
  } catch (e) {
    setStatus(null);
    await notify("Load failed", (e as Error).message, "error");
  }
  rebuild();
}

async function toggleRow(r: MatrixTableRow): Promise<void> {
  if (expanded.has(r.logicalName)) {
    expanded.delete(r.logicalName);
    renderMatrix();
    return;
  }
  expanded.add(r.logicalName);
  const a = api();
  const other = otherEnv();
  const needs = [primary, other?.meta.kind === "live" ? other : null].filter((e): e is EnvData => !!e && !e.columns[r.logicalName] && !!e.meta.target);
  if (a && needs.length) {
    setStatus(`Loading columns of ${r.logicalName}…`);
    try {
      await Promise.all(needs.map(async (e) => (e.columns[r.logicalName] = await fetchColumns(a, r.logicalName, e.meta.target!))));
    } catch (e) {
      await notify("Columns failed", `${r.logicalName}: ${(e as Error).message}`, "error");
    }
    setStatus(null);
  }
  rebuild();
}

async function loadSnapshot(): Promise<void> {
  const f = await openText({ title: "Open audit matrix snapshot", extensions: ["json"] });
  if (!f) return;
  try {
    const env = parseSnapshot(f.text, f.name);
    others.push(env);
    preferCompare = env.meta.key;
    rebuild();
  } catch (e) {
    await notify("Snapshot rejected", `${f.name}: ${(e as Error).message}`, "error");
  }
}

function rebuild(): void {
  renderHeader();
  matrix = buildMatrix(primary, otherEnv());
  for (const k of [...selected]) {
    const [kind, ...rest] = k.split(":");
    const id = rest.join(":");
    const ok = kind === "t" ? matrix.rows.some((r) => r.key === id) : matrix.rows.some((r) => r.columns?.some((c) => c.key === id));
    if (!ok) selected.delete(k);
  }
  renderMatrix();
  renderOrg();
  renderApply();
}

// ---------- exports ----------
async function exportFile(name: string, content: string, mime = "application/json"): Promise<void> {
  if (await saveText(name, content, mime)) await notify("Exported", name, "success");
}

// ---------- wiring ----------
function wire(): void {
  wireTabs(() => undefined);
  for (const id of ["#filter-text", "#filter-diff", "#filter-audit", "#filter-managed", "#filter-cols"]) $(id).addEventListener("input", renderMatrix);
  $("#compare").addEventListener("change", rebuild);
  $("#btn-refresh").addEventListener("click", () => void refresh());
  $("#btn-load-snap").addEventListener("click", () => void loadSnapshot());
  $("#btn-plan-on").addEventListener("click", () => addToPlan(planSet(matrix.rows, selected, true), "Plan: audit on"));
  $("#btn-plan-off").addEventListener("click", () => addToPlan(planSet(matrix.rows, selected, false), "Plan: audit off"));
  $("#btn-plan-match").addEventListener("click", () => addToPlan(planMatchOther(matrix), "Plan: match other env"));
  $("#btn-clear-sel").addEventListener("click", () => {
    selected.clear();
    renderMatrix();
  });
  $("#btn-clear-plan").addEventListener("click", () => {
    plan = [];
    renderApply();
  });
  $("#btn-apply").addEventListener("click", () => void runPlan());
  $("#btn-export-csv").addEventListener("click", () => void exportFile("audit-matrix.csv", matrixCsv(matrix), "text/csv"));
  $("#btn-export-snap").addEventListener("click", () => {
    if (primary) void exportFile(`audit-snapshot.${safeFileName(primary.meta.name)}.${new Date().toISOString().slice(0, 10)}.json`, serializeSnapshot(primary));
  });
  $("#btn-export-plan-csv").addEventListener("click", () => {
    if (primary) void exportFile("audit-plan.csv", planCsv({ target: primary.meta, items: plan }), "text/csv");
  });
  $("#btn-export-plan-ps").addEventListener("click", () => {
    if (primary) void exportFile("audit-plan.ps1", planScript({ target: primary.meta, items: plan }), "text/plain");
  });
  onConnectionChange(() => void refresh());
}

async function main(): Promise<void> {
  await initTheme((t) => document.documentElement.setAttribute("data-theme", t));
  wire();
  rebuild();
  await refresh();
}

void main();

import { mountDebug } from "../../_shared/debug-ui";
import { $, badge, card, emptyState, filteredEmpty, h, showDialog, shownOf, table as domTable, wireTabs } from "../../_shared/dom";
import { dataverse, getConnections, initTheme, inToolbox, notify, onConnectionChange, openText, saveText } from "../../_shared/host";
import { loadView, persistControls, saveView, type PersistedControls } from "../../_shared/view-state";
import { matrixCsv, planCsv, planScript, safeFileName } from "./audit/export";
import { fetchColumns, fetchEnv, type DataverseLike } from "./audit/fetch";
import { buildMatrix, filterRows, originDefault, visibleColumns } from "./audit/matrix";
import { parseSnapshot, serializeSnapshot } from "./audit/snapshot";
import type { EnvData, EnvMeta, Filters, FlagState, Matrix, MatrixTableRow, OrgAudit, TableAudit } from "./audit/types";
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
/** Set while "Load columns for N tables" runs; its Cancel sets cancelCols. */
let loadingCols = false;
let cancelCols = false;
/** Comparison column to select on the next render (a snapshot just loaded). */
let preferCompare: string | null = null;
/** Saved toolbar filters (wired in wire()). */
let view: PersistedControls | null = null;
/** Selection keys whose checkbox is on screen: table rows passing the filters, visible columns of expanded rows. */
let visibleKeys = new Set<string>();
/** Selectable (unlocked) table keys on screen, for the select-all header checkbox. */
let visibleTableKeys: string[] = [];

const api = (): DataverseLike | null => (dataverse() as unknown as DataverseLike) ?? null;
const otherEnv = (): EnvData | null => others.find((o) => o.meta.key === $<HTMLSelectElement>("#compare").value) ?? null;

const TOOL = "audit-matrix";
/**
 * Set once the origin filter has been decided for this viewer: by the first-load default, by
 * choosing an origin, or by clearing filters while one was set. persistControls drops a value equal
 * to the HTML default, so "chose all" and "never chose" look alike without this marker.
 */
const ORIGIN_DECIDED = "origin-decided";

const filtersActive = (): boolean => view?.active() ?? false;

function clearFilters(): void {
  if ($<HTMLSelectElement>("#filter-origin").value !== "all") saveView(TOOL, ORIGIN_DECIDED, true);
  view?.reset();
  renderMatrix();
}

/**
 * First load ever of a large environment: start on custom tables, since hundreds of Microsoft tables
 * bury the handful someone built. The count caption then reads "N of M tables shown" with Clear
 * filters next to it, so nothing is hidden silently. A saved choice, any choice, always wins.
 */
function applyOriginDefault(env: EnvData | null): void {
  if (!env || loadView(TOOL, ORIGIN_DECIDED, false)) return;
  const want = originDefault(env.tables);
  if (!want) return;
  const sel = $<HTMLSelectElement>("#filter-origin");
  sel.value = want;
  sel.dispatchEvent(new Event("change")); // persistControls saves it like a choice
  saveView(TOOL, ORIGIN_DECIDED, true);
}

function filters(): Filters {
  return {
    text: $<HTMLInputElement>("#filter-text").value,
    audit: $<HTMLSelectElement>("#filter-audit").value as Filters["audit"],
    onlyDiff: $<HTMLInputElement>("#filter-diff").checked,
    managed: $<HTMLSelectElement>("#filter-managed").value as Filters["managed"],
    origin: $<HTMLSelectElement>("#filter-origin").value as Filters["origin"],
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
  for (const id of ["#btn-export-csv", "#btn-export-snap"]) $(id).toggleAttribute("disabled", !primary);
  $("#host-mode").textContent = inToolbox() ? "Running inside Power Platform ToolBox" : "Not running inside ToolBox — connect a ToolBox environment to load data";
}

function renderCounts(shown: number): void {
  const c = matrix.counts;
  const metric = (value: string, label: string, title?: string) => h("span", { class: "metric", title }, h("strong", {}, value), h("span", {}, label));
  const clear = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Clear filters");
  clear.addEventListener("click", clearFilters);
  const items: HTMLElement[] = [
    h("span", { class: "metric" }, h("span", { class: "count-caption", id: "shown-count" }, `${shownOf(shown, c.tables, "tables")} shown`), filtersActive() ? clear : null),
    metric(`${c.tablesAudited} / ${c.tables}`, "tables audited"),
    metric(String(c.tablesDiffer), matrix.other ? `table differences vs ${matrix.other.name}` : "table differences (no comparison)"),
    metric(String(c.columnsAudited), `columns audited in ${c.loadedTables} loaded table${c.loadedTables === 1 ? "" : "s"}`, "Column flags are read when a row is expanded or its columns are loaded, so this counts loaded tables only."),
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
      h(
        "td",
        {},
        r.isCustom === null ? null : badge(r.isCustom ? "custom" : "Microsoft", "neutral"),
        r.isCustom === null ? null : " ",
        badge(r.isManaged ? "managed" : "unmanaged", "neutral"),
        " ",
        badge(r.ownership, "neutral"),
      ),
      h("td", { class: "cell" }, flagBadge(r.state, r.locked)),
      h("td", { class: "cell" }, matrix.other ? flagBadge(r.otherState) : h("span", { class: "caption" }, "—")),
      h("td", {}, r.differs ? h("span", { class: "diffmark", title: "Differs from the comparison environment" }, "≠") : ""),
      h(
        "td",
        { class: "caption" },
        r.stats
          ? `${r.stats.audited} / ${r.stats.total} audited${r.stats.inert ? ` (${r.stats.inert} capturing nothing)` : ""}${r.stats.differs ? ` · ${r.stats.differs} ≠` : ""}${r.stats.secured ? ` · ${r.stats.secured} secured` : ""}`
          : r.state === "absent" ? "" : "expand to load",
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
  const f = filters();
  const rows = filterRows(matrix.rows, f);
  visibleKeys = new Set(rows.flatMap((r) => [`t:${r.key}`, ...(expanded.has(r.logicalName) && r.columns ? visibleColumns(r, f).map((c) => `c:${c.key}`) : [])]));
  visibleTableKeys = rows.filter((r) => !r.locked).map((r) => `t:${r.key}`);
  $("#filter-text-hint").hidden = !f.text.trim();
  renderLoadColumns(f, rows);
  const planMatch = $("#btn-plan-match");
  planMatch.textContent = filtersActive() ? `Plan: match (visible ${rows.length})` : "Plan: match other env";
  planMatch.toggleAttribute("disabled", !otherEnv() || !primary || !rows.length);
  renderCounts(rows.length);
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
  if (!rows.length) {
    body.append(filteredEmpty("No tables match", "No table passes the current filters.", clearFilters));
    renderBulkbar();
    return;
  }
  const all = h("input", { type: "checkbox", id: "sel-all", "aria-label": "Select all visible tables" }) as HTMLInputElement;
  all.disabled = !visibleTableKeys.length;
  all.addEventListener("change", () => {
    for (const k of visibleTableKeys) {
      if (all.checked) selected.add(k);
      else selected.delete(k);
    }
    renderMatrix();
  });
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
          h("th", { class: "sel" }, all),
          h("th", {}, "Table"),
          h("th", {}, "Origin · layer"),
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
  const hidden = [...selected].filter((k) => !visibleKeys.has(k)).length;
  $("#bulkbar").hidden = selected.size === 0 || !primary;
  $("#sel-count").textContent = String(selected.size);
  const hid = $("#sel-hidden");
  hid.hidden = !hidden;
  hid.textContent = hidden ? ` (${hidden} hidden)` : "";
  for (const id of ["#btn-plan-on", "#btn-plan-off"]) $(id).toggleAttribute("disabled", selected.size === hidden);
  const all = document.querySelector<HTMLInputElement>("#sel-all");
  if (all) {
    const n = visibleTableKeys.filter((k) => selected.has(k)).length;
    all.checked = n > 0 && n === visibleTableKeys.length;
    all.indeterminate = n > 0 && n < visibleTableKeys.length;
  }
}

/** Plan the selection that is on screen; selections hidden by the filters or a collapsed row are left out, and said so. */
function planSelected(next: boolean): void {
  const visible = new Set([...selected].filter((k) => visibleKeys.has(k)));
  const hidden = selected.size - visible.size;
  addToPlan(planSet(matrix.rows, visible, next), `Plan: audit ${next ? "on" : "off"}`, hidden ? `${hidden} hidden selection${hidden === 1 ? "" : "s"} not planned` : "");
}

/** "Match other env" over the whole matrix, or only the rows and columns the filters show while any filter is on. */
function planMatch(): void {
  if (!filtersActive()) {
    addToPlan(planMatchOther(matrix), "Plan: match other env");
    return;
  }
  const f = filters();
  const rows = filterRows(matrix.rows, f).map((r) => (r.columns ? { ...r, columns: visibleColumns(r, f) } : r));
  addToPlan(planMatchOther({ ...matrix, rows }), `Plan: match (visible ${rows.length})`);
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

function addToPlan(build: PlanBuild, label: string, note = ""): void {
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
  void notify(label, `${added} change${added === 1 ? "" : "s"} added to the plan${skippedNote}${note ? `; ${note}` : ""}`, added ? "success" : "warning");
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
    applyOriginDefault(primary);
    setStatus(null);
  } catch (e) {
    setStatus(null);
    await notify("Load failed", (e as Error).message, "error");
  }
  rebuild();
}

/** Logical names per environment, so "does this env have the table" is not a scan per row. */
const tableNames = new WeakMap<TableAudit[], Set<string>>();
function hasTable(e: EnvData, name: string): boolean {
  let names = tableNames.get(e.tables);
  if (!names) tableNames.set(e.tables, (names = new Set(e.tables.map((t) => t.logicalName))));
  return names.has(name);
}

/** Live environments (primary, live comparison) that have this table but not its columns yet. */
function needsColumns(name: string): EnvData[] {
  const other = otherEnv();
  return [primary, other?.meta.kind === "live" ? other : null].filter((e): e is EnvData => !!e && !!e.meta.target && !e.columns[name] && hasTable(e, name));
}

/** Read a table's columns into every live environment that lacks them. Throws on the first failure. */
async function loadColumns(a: DataverseLike, name: string): Promise<void> {
  await Promise.all(needsColumns(name).map(async (e) => (e.columns[name] = await fetchColumns(a, name, e.meta.target!))));
}

/** A row whose column flags are still to be read, so the column filters cannot judge it yet. */
const columnsPending = (r: MatrixTableRow): boolean => !!api() && r.state !== "absent" && needsColumns(r.logicalName).length > 0;

/**
 * Tables the "Load columns" button would read: those passing every filter once the column tests are
 * taken as unknown. Under "Has audited / secured columns" none of them is on screen yet.
 */
const loadCandidates = (f: Filters): MatrixTableRow[] => (primary ? filterRows(matrix.rows, f, columnsPending).filter(columnsPending) : []);

function renderLoadColumns(f: Filters, shownRows: MatrixTableRow[]): void {
  const todo = loadingCols ? [] : loadCandidates(f);
  const btn = $<HTMLButtonElement>("#btn-load-cols");
  btn.hidden = !todo.length;
  const shown = new Set(shownRows);
  const allShown = todo.every((r) => shown.has(r));
  const n = todo.length;
  btn.textContent = `Load columns for ${n} ${allShown ? "visible " : ""}table${n === 1 ? "" : "s"}${allShown ? "" : " to check"}`;
  btn.title = allShown
    ? "Reads the column flags of these tables without expanding them, so the column filters and counts cover them."
    : "These tables pass the other filters, but the column filters can only judge a table once its columns are loaded.";
  $("#filter-loaded-hint").hidden = !((f.onlyDiff || f.withColumns) && (todo.length || loadingCols));
}

/** Load the columns of every table the filters leave in play, three at a time; rows stay collapsed. */
async function loadVisibleColumns(): Promise<void> {
  const a = api();
  if (!a || loadingCols) return;
  const queue = loadCandidates(filters()).map((r) => r.logicalName);
  const total = queue.length;
  if (!total) return;
  loadingCols = true;
  cancelCols = false;
  let done = 0;
  const failed: string[] = [];
  const cancel = () => {
    cancelCols = true;
    setStatus("Cancelling…");
  };
  const progress = () => setStatus(`Loading columns ${done} / ${total}…`, cancel);
  progress();
  renderMatrix();
  const worker = async (): Promise<void> => {
    for (let name = queue.shift(); name && !cancelCols; name = queue.shift()) {
      try {
        await loadColumns(a, name);
      } catch {
        failed.push(name);
      }
      done++;
      if (!cancelCols) progress();
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, total) }, worker));
  loadingCols = false;
  setStatus(null);
  if (failed.length) await notify("Some columns failed", `${failed.length} table${failed.length === 1 ? "" : "s"}: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? ", …" : ""}`, "warning");
  else if (cancelCols) await notify("Loading cancelled", `Columns loaded for ${done} of ${total} tables`, "warning");
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
  if (a && needsColumns(r.logicalName).length) {
    setStatus(`Loading columns of ${r.logicalName}…`);
    try {
      await loadColumns(a, r.logicalName);
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
  view = persistControls(TOOL, ["filter-text", "filter-audit", "filter-diff", "filter-origin", "filter-managed", "filter-cols"]);
  for (const id of ["#filter-text", "#filter-diff", "#filter-audit", "#filter-origin", "#filter-managed", "#filter-cols"]) $(id).addEventListener("input", renderMatrix);
  $("#filter-origin").addEventListener("change", () => saveView(TOOL, ORIGIN_DECIDED, true));
  $("#btn-load-cols").addEventListener("click", () => void loadVisibleColumns());
  $("#compare").addEventListener("change", rebuild);
  $("#btn-refresh").addEventListener("click", () => void refresh());
  $("#btn-load-snap").addEventListener("click", () => void loadSnapshot());
  $("#btn-plan-on").addEventListener("click", () => planSelected(true));
  $("#btn-plan-off").addEventListener("click", () => planSelected(false));
  $("#btn-plan-match").addEventListener("click", planMatch);
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

mountDebug(document.querySelector("footer"), "audit-matrix");
void main();

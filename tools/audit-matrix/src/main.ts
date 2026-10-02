import { mountDebug } from "../../_shared/debug-ui";
import { $, badge, card, emptyState, filteredEmpty, foldAllButtons, foldCard, h, showDialog, shownOf, table as domTable, wireTabs, type Child } from "../../_shared/dom";
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
    onlyChangeable: $<HTMLInputElement>("#filter-changeable").checked,
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
  const cb = h("input", { type: "checkbox", "aria-label": `Select table ${r.logicalName}`, "data-focus": `sel:t:${r.key}` }) as HTMLInputElement;
  cb.checked = selected.has(`t:${r.key}`);
  cb.disabled = r.locked;
  cb.title = r.locked ? "Audit flag locked by the managing solution" : "";
  cb.addEventListener("change", () => {
    if (cb.checked) selected.add(`t:${r.key}`);
    else selected.delete(`t:${r.key}`);
    renderBulkbar();
  });
  const exp = h(
    "button",
    { class: "expander", type: "button", "aria-label": `${open ? "Collapse" : "Expand"} ${r.logicalName}`, "aria-expanded": open ? "true" : "false", "data-focus": `exp:${r.logicalName}` },
    open ? "▾" : "▸",
  );
  exp.addEventListener("click", () => void toggleRow(r));
  let colsCell: Child = "";
  if (r.stats)
    colsCell = `${r.stats.audited} / ${r.stats.total} audited${r.stats.inert ? ` (${r.stats.inert} capturing nothing)` : ""}${r.stats.differs ? ` · ${r.stats.differs} ≠` : ""}${r.stats.secured ? ` · ${r.stats.secured} secured` : ""}`;
  else if (r.state !== "absent") {
    // the expander is a small glyph: the caption is a second, larger way to open the row and read its columns
    const label = open ? "load columns" : "expand to load";
    const load = h("button", { class: "load-link", type: "button", "aria-label": `${open ? "Load columns of" : "Expand to load"} ${r.logicalName}`, "data-focus": `load:${r.logicalName}` }, label);
    load.addEventListener("click", () => void expandRow(r));
    colsCell = load;
  }

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
      h("td", { class: "caption" }, colsCell),
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
            const ccb = h("input", { type: "checkbox", "aria-label": `Select column ${c.tableLogicalName}.${c.logicalName}`, "data-focus": `sel:c:${c.key}` }) as HTMLInputElement;
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

/**
 * The control in the matrix that has keyboard focus, by logical key (`exp:account`, `sel:t:account`, …),
 * so a re-render can hand focus back to its replacement instead of dropping it on <body>.
 */
function focusedKey(body: HTMLElement): string | null {
  const el = document.activeElement;
  return el instanceof HTMLElement && body.contains(el) ? (el.dataset.focus ?? null) : null;
}

/** Focus the control with this key, else (a load link that became stats) the expander of the same table. */
function restoreFocus(body: HTMLElement, key: string | null): void {
  if (!key) return;
  const find = (k: string) => body.querySelector<HTMLElement>(`[data-focus="${CSS.escape(k)}"]`);
  const name = /^(?:exp|load):(.+)$/.exec(key)?.[1];
  (find(key) ?? (name ? find(`exp:${name}`) : null))?.focus();
}

function renderMatrix(): void {
  const body = $("#matrix-body");
  const focus = focusedKey(body);
  renderMatrixBody(body);
  restoreFocus(body, focus);
}

function renderMatrixBody(body: HTMLElement): void {
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
  const all = h("input", { type: "checkbox", id: "sel-all", "aria-label": "Select all visible tables", "data-focus": "sel-all" }) as HTMLInputElement;
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
  const groups = planGroups(plan, { keyPrefix: "audit-matrix:plan:", open: false, remove: removeFromPlan });
  body.append(
    h(
      "div",
      { class: "plan-head" },
      h("strong", { id: "plan-summary" }, `${plural(plan.length, "pending change")}: ${planSummary(plan)}`),
      foldAllButtons(() => document.querySelector("#apply-body"), "details.card"),
    ),
    groups,
  );
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
const flagWord = (on: boolean): HTMLElement => badge(on ? "on" : "off", on ? "ok" : "neutral");

/** "2 tables on / 1 off, 3 columns (2 on / 1 off)": what a plan does, before the per-table detail. */
function planSummary(items: PlanItem[]): string {
  const tables = items.filter((i) => i.level === "table");
  const cols = items.filter((i) => i.level === "column");
  const tOn = tables.filter((i) => i.next).length;
  const cOn = cols.filter((i) => i.next).length;
  return `${plural(tOn, "table")} on / ${tables.length - tOn} off, ${plural(cols.length, "column")}${cols.length ? ` (${cOn} on / ${cols.length - cOn} off)` : ""}`;
}

/** Plan items per table, in plan order. */
function byTable(items: PlanItem[]): PlanItem[][] {
  const groups = new Map<string, PlanItem[]>();
  for (const i of items) {
    const g = groups.get(i.table);
    if (g) g.push(i);
    else groups.set(i.table, [i]);
  }
  return [...groups.values()];
}

interface GroupOptions {
  /** Remember each table's fold under this prefix + table name (see keepFold). */
  keyPrefix?: string;
  open: boolean;
  /** Adds a × per item that takes it out of the plan. */
  remove?: (item: PlanItem) => void;
}

/** One fold card per table: its own change (if any) and its columns', with what each sets. */
function planGroups(items: PlanItem[], o: GroupOptions): HTMLElement {
  return h(
    "div",
    { class: "plan-groups" },
    ...byTable(items).map((group) => {
      const first = group[0];
      const own = group.find((i) => i.level === "table");
      const cols = group.length - (own ? 1 : 0);
      const note = [first.tableDisplay, own ? `table → ${own.next ? "on" : "off"}` : "", cols ? plural(cols, "column") : ""].filter(Boolean).join(" · ");
      const rows = group.map((i): Child[] => {
        const cells: Child[] = [
          badge(i.level, "neutral"),
          i.column ? h("span", { class: "mono" }, i.column) : "—",
          flagWord(i.current),
          flagWord(i.next),
          h("span", { class: "caption" }, i.reason),
        ];
        if (o.remove) {
          const what = i.column ? `${i.table}.${i.column}` : `table ${i.table}`;
          const x = h("button", { class: "btn-icon", type: "button", title: "Remove from the plan", "aria-label": `Remove ${what} from the plan`, "data-remove": i.table }, "×");
          x.addEventListener("click", () => o.remove?.(i));
          cells.push(x);
        }
        return cells;
      });
      const headers = ["Level", "Column", "Current", "Planned", "Why", ...(o.remove ? [""] : [])];
      const fold = foldCard(first.table, group.length, domTable(headers, rows, undefined, "plan-items"), o.open, {
        key: o.keyPrefix ? `${o.keyPrefix}${first.table}` : undefined,
        extra: h("span", { class: "caption" }, note),
      });
      fold.dataset.table = first.table;
      return fold;
    }),
  );
}

/** Take one item out of the plan; focus stays in its table's card (next ×, else the card) so a keyboard user can go on removing. */
function removeFromPlan(item: PlanItem): void {
  const group = plan.filter((i) => i.table === item.table);
  const at = group.indexOf(item);
  plan = plan.filter((i) => i !== item);
  renderApply();
  const body = $("#apply-body");
  const card = [...body.querySelectorAll<HTMLElement>("details.card")].find((d) => d.dataset.table === item.table);
  const xs = card ? [...card.querySelectorAll<HTMLElement>("button[data-remove]")] : [];
  (xs[Math.min(at, xs.length - 1)] ?? card?.querySelector<HTMLElement>("summary") ?? body.querySelector<HTMLElement>("summary") ?? $("#btn-clear-plan"))?.focus();
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
      previewBody(plan),
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

/** Above this many writes the preview starts with every table folded: the summary line says what is in them. */
const PREVIEW_OPEN_MAX = 10;

/** The plan in the preview dialog: summary first, then a fold per table (open while the plan is short). */
function previewBody(items: PlanItem[]): HTMLElement {
  const body = h("div", { class: "plan-preview" });
  body.append(
    h("div", { class: "plan-head" }, h("strong", { id: "preview-summary" }, planSummary(items)), foldAllButtons(body, "details.card")),
    planGroups(items, { open: items.length <= PREVIEW_OPEN_MAX }),
  );
  return body;
}

/**
 * The results with failures first and an "Only failures" switch, on whenever anything failed: one
 * failure among hundreds of writes would otherwise be a needle in plan order.
 */
function resultsBody(results: PlanResult[]): HTMLElement {
  const failed = results.filter((r) => !r.ok);
  const sorted = [...failed, ...results.filter((r) => r.ok)];
  const only = h("input", { type: "checkbox", id: "results-only-failed" }) as HTMLInputElement;
  only.checked = failed.length > 0;
  const caption = h("span", { class: "count-caption", id: "results-count" });
  const list = h("div", { class: "results-list" });
  const show = () => {
    const rows = only.checked ? failed : sorted;
    caption.textContent = shownOf(rows.length, results.length, "writes");
    list.replaceChildren(
      domTable(
        ["Level", "Table", "Column", "Result"],
        rows.map((r) => [
          badge(r.level, "neutral"),
          h("span", { class: "mono" }, r.table),
          r.column ? h("span", { class: "mono" }, r.column) : "—",
          r.ok ? badge("ok", "ok") : h("span", { class: "result-err" }, badge("failed", "bad"), h("span", { class: "caption" }, r.error ?? "")),
        ]),
        (i) => (rows[i].ok ? undefined : "is-failed"),
      ),
    );
  };
  only.addEventListener("change", show);
  show();
  return h(
    "div",
    {},
    h(
      "div",
      { class: "plan-head" },
      h("strong", { id: "results-summary" }, `${results.length - failed.length} ok · ${failed.length} failed`),
      failed.length ? h("label", { class: "check" }, only, " Only failures") : null,
      caption,
    ),
    list,
  );
}

async function showResults(results: PlanResult[]): Promise<void> {
  await showDialog({ title: "Results", body: resultsBody(results) });
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
  // a column read still going would write into the environments about to be replaced
  if (loadingCols && colRun) {
    cancelCols = true;
    await colRun;
  }
  const wrap = document.querySelector(".matrix-wrap");
  const scroll = wrap?.scrollTop ?? 0;
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
    // expanded rows stay expanded (their columns are read again below); drop tables that are gone
    for (const n of [...expanded]) if (![primary, ...others].some((e) => e && hasTable(e, n))) expanded.delete(n);
    applyOriginDefault(primary);
    setStatus(null);
  } catch (e) {
    setStatus(null);
    await notify("Load failed", (e as Error).message, "error");
  }
  rebuild();
  await reloadExpandedColumns();
  // the first rebuild, without columns, is shorter and can clamp the scroll: put the user back where they were
  if (wrap) wrap.scrollTop = scroll;
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

interface ColumnRun {
  done: number;
  total: number;
  failed: string[];
  cancelled: boolean;
}
/** The column read in progress (loadingCols), so a refresh can cancel it and wait for it to stop. */
let colRun: Promise<ColumnRun> | null = null;

/**
 * Read the columns of `names` into every live environment that lacks them, three tables at a time,
 * with progress and Cancel in the status line. One run at a time: null when one is already going.
 */
async function loadColumnsQueued(names: string[], label: string): Promise<ColumnRun | null> {
  const a = api();
  if (!a || loadingCols || !names.length) return null;
  const queue = [...names];
  const total = queue.length;
  loadingCols = true;
  cancelCols = false;
  const res: ColumnRun = { done: 0, total, failed: [], cancelled: false };
  const cancel = () => {
    cancelCols = true;
    setStatus("Cancelling…");
  };
  const progress = () => setStatus(`${label} ${res.done} / ${total}…`, cancel);
  progress();
  renderMatrix();
  const worker = async (): Promise<void> => {
    for (let name = queue.shift(); name && !cancelCols; name = queue.shift()) {
      try {
        await loadColumns(a, name);
      } catch {
        res.failed.push(name);
      }
      res.done++;
      if (!cancelCols) progress();
    }
  };
  colRun = Promise.all(Array.from({ length: Math.min(3, total) }, worker)).then(() => {
    // cleared before any awaiter resumes, so a refresh waiting on this run can start its own
    loadingCols = false;
    colRun = null;
    res.cancelled = cancelCols;
    return res;
  });
  await colRun;
  setStatus(null);
  return res;
}

const tablesNote = (names: string[]): string => `${names.length} table${names.length === 1 ? "" : "s"}: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}`;

/** Load the columns of every table the filters leave in play, three at a time; rows stay collapsed. */
async function loadVisibleColumns(): Promise<void> {
  const res = await loadColumnsQueued(
    loadCandidates(filters()).map((r) => r.logicalName),
    "Loading columns",
  );
  if (!res) return;
  if (res.failed.length) await notify("Some columns failed", tablesNote(res.failed), "warning");
  else if (res.cancelled) await notify("Loading cancelled", `Columns loaded for ${res.done} of ${res.total} tables`, "warning");
  rebuild();
}

/**
 * After a refresh (or the reload that follows Apply) the environments are read afresh, without columns:
 * read them again for the rows the user had expanded, so they come back open with their columns.
 */
async function reloadExpandedColumns(): Promise<void> {
  const names = [...expanded].filter((n) => needsColumns(n).length);
  const res = await loadColumnsQueued(names, "Reloading columns of expanded tables");
  if (!res) return;
  if (res.failed.length) await notify("Some columns failed", tablesNote(res.failed), "warning");
  rebuild();
}

async function toggleRow(r: MatrixTableRow): Promise<void> {
  if (expanded.has(r.logicalName)) {
    expanded.delete(r.logicalName);
    renderMatrix();
    return;
  }
  await expandRow(r);
}

/** Expand a row and read its columns where they are missing (also a retry for an expanded row whose read failed). */
async function expandRow(r: MatrixTableRow): Promise<void> {
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
    // a column selection under a table whose columns are being read again (after a refresh) is kept
    const row = kind === "c" ? matrix.rows.find((r) => r.logicalName === id.split(":")[0]) : undefined;
    const ok = kind === "t" ? matrix.rows.some((r) => r.key === id) : !!row && (!row.columns || row.columns.some((c) => c.key === id));
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
  const ids = ["filter-text", "filter-audit", "filter-diff", "filter-origin", "filter-managed", "filter-cols", "filter-changeable"];
  view = persistControls(TOOL, ids);
  for (const id of ids) $(`#${id}`).addEventListener("input", renderMatrix);
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

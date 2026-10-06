import { mountDebug } from "../../_shared/debug-ui";
import { $, badge, card, emptyState, filteredEmpty, foldAllButtons, foldCard, h, showDialog, shownOf, wireTabs, type BadgeKind } from "../../_shared/dom";
import { loadView, persistControls, saveView } from "../../_shared/view-state";
import { dataverse, getConnections, initTheme, inToolbox, notify, onConnectionChange, openText, powerplatform, saveText } from "./host";
import { deploymentSettings, matrixCsv, safeFileName, snapshot } from "./matrix/export";
import { fetchColumn, fetchSolutionScope, fetchSolutions, type SolutionInfo } from "./matrix/fetch";
import { buildMatrix, connRefDiffCells, envVarDiffCells, filterConnRefs, filterEnvVars } from "./matrix/matrix";
import {
  applyMerge,
  addRefsToSolution,
  applyRestore,
  buildMergeBackup,
  connectorGroups,
  fetchFlows,
  fetchSolutionFlowIds,
  filterOffFlows,
  markDependents,
  mergeBackupFileName,
  offFlows,
  parseMergeBackup,
  planCleanup,
  planMerge,
  planRestore,
  solutionFit,
  turnOnFlows,
  unusedConnRefs,
  usageByConnRef,
  type DeleteResult,
  type FlowRecord,
  type FlowResult,
  type MergePlan,
  type MergeSpec,
  type PlannedFlow,
} from "./matrix/consolidate";
import { applyBind, applyBindRestore, bindBackupFileName, buildBindBackup, parseBindBackup, planBind, planBindRestore, type BindBackup, type BindPlan } from "./matrix/bind";
import { filterRunLog, RunLog, runLogFacets, type RunLogFilter, type StoreLike } from "./matrix/runlog";
import { connectionsFor, environmentId, explainPpError, listConnections, rowConnector, type PpConnection } from "./matrix/ppconnections";
import { isDeploymentSettings, parseDeploymentSettings } from "./matrix/settings";
import { parseSnapshot } from "./matrix/snapshot";
import type { ColumnData, ColumnMeta, ConnRefRecord, EnvVarRow, Filters, Matrix, Target } from "./matrix/types";
import { applyPlan, connectionChangedMessage, planCopy, planSet, sameConnection, stampOf, type ConnectionStamp, type WritePlan, type WriteResult } from "./matrix/write";

// ---------- state ----------
let live: ColumnData[] = [];
const snaps: ColumnData[] = [];
let matrix: Matrix = { columns: [], envVars: [], connRefs: [] };
let activeTab: "envvars" | "connrefs" = "envvars";
const selected = new Set<string>();
/** selected connection reference rows (lowercase logical names) on the matrix tab */
const crSelected = new Set<string>();
let solutions: SolutionInfo[] = [];
/** selected solution id ("" = all). Source of truth for the dropdown; `scope` is always derived from it. */
let selectedSolution = "";
let scope: Set<string> | null = null;
/** connection references tab: consolidate view instead of the matrix */
let consolidating = false;
/** live column the consolidate view works on */
let consKey = "primary";
/** flows of `consKey`, stamped with the org they were read from */
let flowCache: { key: string; url: string; flows: FlowRecord[] } | null = null;
let flowError: string | null = null;
let scanning: Promise<void> | null = null;
/** lowercase connector id → logical name kept */
const keepBy = new Map<string, string>();
/** lowercase logical names selected to merge into their group's keep target */
const mergeSel = new Set<string>();
/** lowercase logical names of unused references selected for delete */
const cleanupSel = new Set<string>();
/** flow ids selected to turn on */
const turnOnSel = new Set<string>();
/** flow ids of the selected solution (solution fit check, Flows that are off), stamped with solution + primary org */
let fitCache: { solutionId: string; url: string; flowIds: Set<string> } | null = null;
let fitLoading: Promise<void> | null = null;
/** `<solution id>|<org url>` whose flow ids could not be read: not retried until Rescan flows or another solution */
let fitFailed: string | null = null;

const columns = (): ColumnData[] => [...live, ...snaps];

// ---------- persisted view (per viewer, localStorage) ----------
const VIEW = "envvar-matrix";
/** toolbar filters, saved on change and restored now; the Solution filter is restored once its options load */
const view = persistControls(VIEW, ["filter-text", "filter-diff", "filter-missing", "filter-absent", "filter-solution"]);
/** the saved Solution filter still has to be applied (first load with solutions listed) */
let restoreSolution = true;
/** view options, saved apart from the filters so Clear filters leaves them as they are */
persistControls(VIEW, ["view-compact"]);
/** Compact: cells show only the badges that need attention (see OK_BADGES); a class on the matrix, no re-render. */
const syncCompact = (): void => void $("#matrix-body").classList.toggle("compact", $<HTMLInputElement>("#view-compact").checked);
/** Flows that are off: hide the blocked ones (per viewer, off by default) */
let offOnlyReady = loadView<unknown>(VIEW, "offOnlyReady", false) === true;

/**
 * Column keys the user hid (Columns menu). Live keys ("primary" / "secondary") are stable across reloads and saved;
 * snapshot / settings keys ("snap:<n>", "settings:<n>") are numbered per page load, so their hiding lasts the session.
 */
const isLiveKey = (k: string): boolean => k === "primary" || k === "secondary";
const hiddenCols = new Set<string>(((): string[] => {
  const v = loadView<unknown>(VIEW, "hiddenCols", []);
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string" && isLiveKey(k)) : [];
})());
function saveHidden(): void {
  const live = [...hiddenCols].filter(isLiveKey).sort();
  saveView(VIEW, "hiddenCols", live.length ? live : undefined);
}
/** Hidden keys among the loaded columns; never all of them (the first stays visible, e.g. a reload with fewer columns). */
function hiddenKeys(): Set<string> {
  const all = columns().map((c) => c.meta.key);
  const out = new Set(all.filter((k) => hiddenCols.has(k)));
  if (all.length && out.size === all.length) out.delete(all[0]);
  return out;
}

/** Back to the default filters (all solutions) and re-render. */
function clearFilters(): void {
  view.reset();
  selectedSolution = "";
  scope = null;
  renderHeader();
  renderTable();
}

// ---------- run log ----------
function safeStorage(): StoreLike | null {
  try {
    const st = window.localStorage;
    st.getItem("x");
    return st;
  } catch {
    return null;
  }
}
const runLog = new RunLog(safeStorage());
interface LogItem {
  item: string;
  detail: string;
  ok: boolean;
  error?: string;
}
/** Record the writes of one run (skipped rows are not writes and are left out by the callers). */
function logRun(action: string, target: ColumnMeta, items: LogItem[]): void {
  for (const i of items) runLog.add({ action, environment: target.name, url: target.url, item: i.item, detail: i.detail, ok: i.ok, error: i.error });
  renderRunLogButton();
}
function renderRunLogButton(): void {
  $("#btn-runlog").textContent = `Run log (${runLog.all.length})`;
}
/** Run log filters, kept while the page is open (reopening the dialog shows the same slice). */
const logFilter: RunLogFilter = { action: "", url: "", onlyFailures: false };
const LOG_SHOWN = 300;

async function openRunLog(): Promise<void> {
  const entries = [...runLog.all].reverse();
  const exportJson = h("button", { class: "btn btn-sm", type: "button" }, "Export JSON");
  exportJson.addEventListener("click", () => void exportFile(`envvar-matrix-runlog-${new Date().toISOString().slice(0, 10)}.json`, runLog.json()));
  const exportCsv = h("button", { class: "btn btn-sm", type: "button" }, "Export CSV");
  exportCsv.addEventListener("click", () => void exportFile(`envvar-matrix-runlog-${new Date().toISOString().slice(0, 10)}.csv`, runLog.csv(), "text/csv"));
  const clear = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Clear log");
  let armed = false;
  clear.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      clear.textContent = "Click again to clear";
      return;
    }
    runLog.clear();
    renderRunLogButton();
    $<HTMLDialogElement>("#dlg").close();
  });
  const facets = runLogFacets(entries);
  // a saved choice the log no longer holds (cleared, capped) falls back to all
  if (!facets.actions.includes(logFilter.action)) logFilter.action = "";
  if (!facets.environments.some((e) => e.url === logFilter.url)) logFilter.url = "";
  const actionSel = h("select", { id: "runlog-action", "aria-label": "Action" }, h("option", { value: "" }, "all"), ...facets.actions.map((a) => h("option", { value: a }, a))) as HTMLSelectElement;
  actionSel.value = logFilter.action;
  const envSel = h("select", { id: "runlog-env", "aria-label": "Environment" }, h("option", { value: "" }, "all"), ...facets.environments.map((e) => h("option", { value: e.url, title: e.url }, e.label))) as HTMLSelectElement;
  envSel.value = logFilter.url;
  const failures = h("input", { type: "checkbox", id: "runlog-failures" }) as HTMLInputElement;
  failures.checked = logFilter.onlyFailures;
  const caption = h("p", { class: "caption" });
  const list = h("div", {});
  const render = () => {
    const rows = filterRunLog(entries, logFilter);
    const shown = rows.slice(0, LOG_SHOWN);
    const filtered = rows.length !== entries.length;
    caption.textContent = `${filtered ? `${rows.length} of ` : ""}${entries.length} write${entries.length === 1 ? "" : "s"} recorded by this tool on this machine (newest first${rows.length > shown.length ? `, ${shown.length} shown` : ""}${filtered || rows.length > shown.length ? "; the export has all" : ""}). Kept across reloads in local storage, up to 2000.`;
    list.replaceChildren(
      shown.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Action"), h("th", {}, "Environment"), h("th", {}, "Item"), h("th", {}, "Detail"), h("th", {}, "Result"))),
            h(
              "tbody",
              {},
              ...shown.map((e) =>
                h(
                  "tr",
                  {},
                  h("td", { class: "caption" }, e.at.replace("T", " ").slice(0, 19)),
                  h("td", {}, e.action),
                  h("td", { title: e.url }, e.environment),
                  h("td", { class: "mono" }, e.item),
                  h("td", { class: "changes" }, e.detail),
                  h("td", {}, e.ok ? badge("ok", "ok") : h("span", {}, badge("failed", "bad"), " ", h("span", { class: "caption" }, e.error ?? ""))),
                ),
              ),
            ),
          )
        : entries.length
          ? filteredEmpty("No writes match", "The run log filters hide every entry.", () => {
              Object.assign(logFilter, { action: "", url: "", onlyFailures: false });
              actionSel.value = envSel.value = "";
              failures.checked = false;
              render();
            })
          : emptyState("Nothing yet", "Writes from copy, set, bind, merge, cleanup, restore, add to solution and turn on are recorded here."),
    );
  };
  actionSel.addEventListener("change", () => {
    logFilter.action = actionSel.value;
    render();
  });
  envSel.addEventListener("change", () => {
    logFilter.url = envSel.value;
    render();
  });
  failures.addEventListener("change", () => {
    logFilter.onlyFailures = failures.checked;
    render();
  });
  render();
  const body = h(
    "div",
    {},
    caption,
    h("div", { style: "display:flex; gap: var(--s-2); margin-bottom: var(--s-2)" }, exportJson, exportCsv, clear),
    entries.length
      ? h("div", { class: "dlg-tools" }, h("label", {}, "Action ", actionSel), h("label", {}, "Environment ", envSel), h("label", { class: "check" }, failures, " Only failures"))
      : null,
    list,
  );
  await showDialog({ title: "Run log", body });
}

/** label of a non-live column: deploymentSettings file or snapshot */
const fileKind = (m: ColumnMeta): string => (m.key.startsWith("settings:") ? "settings" : "snapshot");
/** columns with data (a live column whose load failed has none) */
const okColumns = (): ColumnData[] => columns().filter((c) => !c.meta.error);
const liveCols = (): ColumnMeta[] => live.filter((c) => !c.meta.error).map((c) => c.meta);
/** shown in the matrix (not hidden through the Columns menu) */
const isShown = (m: ColumnMeta): boolean => matrix.columns.some((c) => c.key === m.key);
/** live columns that can be written and are shown: copy / bind targets */
const writableCols = (): ColumnMeta[] => liveCols().filter(isShown);

function colChip(meta: ColumnMeta, removable: boolean): HTMLElement {
  const dot = h("span", { class: "dot" });
  if (meta.color) dot.style.background = meta.color;
  const chip = h(
    "span",
    { class: "colchip", title: meta.url },
    dot,
    h("span", { class: "env" }, meta.name),
    h("span", { class: "kind" }, meta.kind === "live" ? `${meta.target} · ${meta.environment}` : `${fileKind(meta)}${meta.takenAt ? ` · ${meta.takenAt.slice(0, 10)}` : ""}`),
  );
  if (meta.error) {
    const b = badge("load failed", "bad");
    b.title = meta.error;
    chip.append(b);
  }
  if (removable) {
    const x = h("button", { class: "btn-icon", type: "button", "aria-label": `Remove ${meta.name}` }, "×");
    x.addEventListener("click", () => {
      const i = snaps.findIndex((s) => s.meta.key === meta.key);
      if (i >= 0) snaps.splice(i, 1);
      hiddenCols.delete(meta.key);
      rebuild();
    });
    chip.append(x);
  }
  return chip;
}

function setStatus(msg: string | null): void {
  const el = $("#status");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

function filters(): Filters {
  return {
    text: $<HTMLInputElement>("#filter-text").value,
    onlyDiff: $<HTMLInputElement>("#filter-diff").checked,
    onlyMissing: $<HTMLInputElement>("#filter-missing").checked,
    onlyAbsent: $<HTMLInputElement>("#filter-absent").checked,
    scope,
  };
}

// ---------- header + selects ----------
const solutionOptions = (): HTMLOptionElement[] => [
  h("option", { value: "" }, "all"),
  ...solutions.map((s) => h("option", { value: s.id }, `${s.friendlyName} ${s.version}${s.isManaged ? " (managed)" : ""}`)),
];

function renderHeader(): void {
  const wrap = $("#columns");
  wrap.replaceChildren();
  if (!columns().length) wrap.append(h("span", { class: "caption" }, inToolbox() ? "No connection. Pick a primary connection in ToolBox." : "Standalone mode: load snapshots to compare."));
  for (const c of columns()) {
    const chip = colChip(c.meta, c.meta.kind === "snapshot");
    if (!isShown(c.meta)) {
      chip.classList.add("is-hidden");
      const b = badge("hidden", "neutral");
      b.title = "Hidden through Columns: not shown or compared";
      chip.insertBefore(b, chip.querySelector(".btn-icon"));
    }
    wrap.append(chip);
  }

  const fill = (id: string, metas: ColumnMeta[], keep = true) => {
    const sel = $<HTMLSelectElement>(id);
    const prev = sel.value;
    sel.replaceChildren(...metas.map((m) => h("option", { value: m.key }, `${m.name} (${m.kind === "live" ? m.target : fileKind(m)})`)));
    if (keep && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  };
  // Hidden columns are left out of copy, bind and export: act only on what is on screen.
  const shownOk = okColumns().map((c) => c.meta).filter(isShown);
  fill("#export-col", shownOk);
  fill("#copy-from", shownOk);
  fill("#copy-to", writableCols());
  const writable = writableCols();
  if (writable.length > 1 && $<HTMLSelectElement>("#copy-to").value === $<HTMLSelectElement>("#copy-from").value) $<HTMLSelectElement>("#copy-to").value = writable[1].key;

  const solSel = $<HTMLSelectElement>("#filter-solution");
  solSel.replaceChildren(...solutionOptions());
  // Dropdown and scope stay in sync: a selection that is no longer listed means "all", never an empty scope.
  if (!solutions.some((s) => s.id === selectedSolution)) {
    selectedSolution = "";
    scope = null;
  }
  solSel.value = selectedSolution;
  solSel.disabled = !live.length;

  const canWrite = writable.length > 0;
  $("#btn-refresh").toggleAttribute("disabled", !inToolbox());
  for (const id of ["#btn-export-settings", "#btn-export-snap", "#btn-export-csv"]) $(id).toggleAttribute("disabled", !shownOk.length);
  $("#copy-to").toggleAttribute("disabled", !canWrite);
  renderColMenu();
}

const inConsolidate = (): boolean => activeTab === "connrefs" && consolidating;

/**
 * Matrix-only toolbar controls are hidden in the consolidate view, which ignores them: the Columns menu (one
 * environment, its own picker), the difference / gap filters and the exports. Their values are kept for the matrix.
 */
function syncColMenu(): void {
  const cons = inConsolidate();
  const menu = $<HTMLDetailsElement>("#colmenu");
  menu.hidden = !columns().length || cons;
  if (menu.hidden) menu.open = false;
  document.querySelectorAll<HTMLElement>(".toolbar .matrix-only").forEach((el) => (el.hidden = cons));
}

/** Columns menu: one checkbox per loaded column; the last visible one cannot be unchecked. */
function renderColMenu(): void {
  const menu = $<HTMLDetailsElement>("#colmenu");
  const all = columns().map((c) => c.meta);
  const shown = all.filter(isShown).length;
  syncColMenu();
  menu.classList.toggle("is-filtered", shown < all.length);
  $("#colmenu-sum").textContent = shown < all.length ? `Columns (${shown} of ${all.length})` : "Columns";
  const focused = (document.activeElement as HTMLElement | null)?.dataset?.colKey;
  const boxes = all.map((m) => {
    const on = isShown(m);
    const cb = h("input", { type: "checkbox", "data-col-key": m.key, checked: on, disabled: on && shown === 1 }) as HTMLInputElement;
    if (cb.disabled) cb.title = "At least one column stays visible";
    cb.addEventListener("change", () => {
      if (cb.checked) hiddenCols.delete(m.key);
      else hiddenCols.add(m.key);
      saveHidden();
      rebuild();
      // the menu was re-rendered: keep keyboard focus on the same checkbox
      document.querySelector<HTMLInputElement>(`#colmenu-list input[data-col-key="${CSS.escape(m.key)}"]`)?.focus();
    });
    return h(
      "label",
      { class: "check" },
      cb,
      m.name,
      h("span", { class: "kind" }, ` · ${m.kind === "live" ? m.target : fileKind(m)}${m.error ? " (load failed)" : ""}`),
    );
  });
  const note = all.some((m) => m.kind === "snapshot") ? h("span", { class: "caption" }, "Hidden snapshot columns show again when the tool reloads.") : null;
  $("#colmenu-list").replaceChildren(...boxes, ...(note ? [note] : []));
  if (focused) document.querySelector<HTMLInputElement>(`#colmenu-list input[data-col-key="${CSS.escape(focused)}"]`)?.focus();
}

// ---------- tables ----------
function colHead(c: ColumnMeta): HTMLElement {
  const th = h("th", { class: "col" }, c.kind === "live" ? c.target! : fileKind(c), h("span", { class: "env" }, c.name));
  if (c.error) {
    th.title = c.error;
    th.append(h("span", { class: "col-error" }, badge("load failed", "bad"), h("span", { class: "caption" }, c.error)));
  }
  return th;
}

/** Cells whose full value the user expanded (`ev|cr:<row key>:<column key>`), kept across re-renders. */
const expandedCells = new Set<string>();
/** Values shorter than this on one line never reach 3 lines in a cell: no toggle, nothing to measure. */
const CLAMP_MIN = 40;

/**
 * Cell value, clamped to 3 lines by CSS with the full value in its tooltip. A long value also gets a toggle in the
 * cell's meta row, hidden until markOverflow() finds the value actually cut off. Secrets pass `full = null`.
 */
function cellValue(td: HTMLElement, id: string, shown: string, full: string | null, label: string): { val: HTMLElement; toggle: HTMLElement | null } {
  const val = h("span", { class: "val", title: full || undefined }, shown);
  if (full === null || (full.length < CLAMP_MIN && !full.includes("\n"))) return { val, toggle: null };
  const open = expandedCells.has(id);
  td.classList.toggle("is-expanded", open);
  const toggle = h("button", { class: "val-more", type: "button", "aria-expanded": String(open), "aria-label": `Full value of ${label}`, hidden: !open }, open ? "less" : "more");
  toggle.addEventListener("click", () => {
    const on = !td.classList.contains("is-expanded");
    td.classList.toggle("is-expanded", on);
    if (on) expandedCells.add(id);
    else expandedCells.delete(id);
    toggle.setAttribute("aria-expanded", String(on));
    toggle.textContent = on ? "less" : "more";
  });
  return { val, toggle };
}

/** Show the toggle of each clamped value that is cut off: all reads first, then all writes (one layout pass). */
function markOverflow(root: ParentNode): void {
  const toggles = [...root.querySelectorAll<HTMLElement>("td.cell:not(.is-expanded) .val-more")];
  const cut = toggles.map((b) => {
    const v = b.closest("td")?.querySelector<HTMLElement>(".val");
    return !!v && v.scrollHeight > v.clientHeight + 1;
  });
  toggles.forEach((b, i) => (b.hidden = !cut[i]));
}

/** What a cell badge means, as its tooltip. */
const BADGE_HELP: Record<string, string> = {
  value: "value: this environment has its own value (an environmentvariablevalue row)",
  default: "default: no value row here; the definition's default value applies",
  missing: "missing: deployed, but no value and no default value",
  absent: "absent: not deployed in this environment",
  bound: "bound: set to a connection in this environment",
  unbound: "unbound: no connection set; flows using it cannot be turned on",
};
/** Badges that say nothing needs attention: Compact hides them (the value itself still shows). */
const OK_BADGES = new Set(["value", "bound", "managed"]);

function cellBadge(text: string, kind: BadgeKind, help = BADGE_HELP[text]): HTMLElement {
  const b = badge(text, kind);
  if (help) b.title = help;
  if (OK_BADGES.has(text)) b.classList.add("is-ok");
  return b;
}

/**
 * Header checkbox of a matrix table: selects or clears the rows shown (rows the filters hide keep their selection),
 * checked when all of them are selected, indeterminate when some are. Updates the row checkboxes in place.
 */
function selectAllBox(rows: { key: string }[], sel: Set<string>, boxes: HTMLInputElement[], what: string): { box: HTMLInputElement; sync: () => void } {
  const box = h("input", { type: "checkbox", class: "sel-all", "aria-label": `Select all shown ${what}`, title: `Select all ${what} shown` }) as HTMLInputElement;
  const sync = () => {
    const n = rows.filter((r) => sel.has(r.key)).length;
    box.checked = n > 0 && n === rows.length;
    box.indeterminate = n > 0 && n < rows.length;
  };
  box.addEventListener("change", () => {
    rows.forEach((r, i) => {
      if (box.checked) sel.add(r.key);
      else sel.delete(r.key);
      boxes[i].checked = box.checked;
    });
    sync();
    renderBulkbar();
  });
  sync();
  return { box, sync };
}

/** Cell of a live column whose load failed. */
const errorCell = (c: ColumnMeta): HTMLElement => h("td", { class: "cell error", title: c.error ?? "" }, h("span", { class: "val" }, "—"), h("div", { class: "meta" }, badge("error", "bad")));

function envVarTable(rows: EnvVarRow[]): HTMLElement {
  const cols = matrix.columns;
  const boxes = rows.map((r) => h("input", { type: "checkbox", "aria-label": `Select ${r.schemaName}` }) as HTMLInputElement);
  const all = selectAllBox(rows, selected, boxes, "variables");
  const head = h(
    "tr",
    {},
    h("th", { class: "sel sticky-col" }, all.box),
    h("th", { class: "name sticky-col" }, "Variable"),
    h("th", {}, "Type"),
    ...cols.map(colHead),
  );
  const body = rows.map((r, i) => {
    const cb = boxes[i];
    cb.checked = selected.has(r.key);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(r.key);
      else selected.delete(r.key);
      all.sync();
      renderBulkbar();
    });
    // cells whose value differs from the first visible column get a tint (the row marker says only "somewhere")
    const diff = envVarDiffCells(r, cols);
    return h(
      "tr",
      { class: r.anyMissing || r.anyAbsent ? "missing" : r.differs ? "differs" : undefined },
      h("td", { class: "sel sticky-col" }, cb),
      h("td", { class: "name sticky-col" }, h("span", { class: "mono" }, r.schemaName), h("span", { class: "display" }, r.displayName)),
      h("td", {}, badge(r.type, r.isSecret ? "warn" : "neutral")),
      ...cols.map((c) => {
        if (c.error) return errorCell(c);
        const cell = r.cells[c.key];
        const td = h("td", { class: `cell ${cell.source}${diff.has(c.key) ? " differs" : ""}` });
        if (cell.source === "absent") {
          td.append(h("span", { class: "val" }, "—"), h("div", { class: "meta" }, cellBadge("absent", "neutral", "absent: the variable is not deployed in this environment")));
          return td;
        }
        const v = cellValue(td, `ev:${r.key}:${c.key}`, r.isSecret ? "••••••" : (cell.effective ?? ""), r.isSecret ? null : (cell.effective ?? ""), `${r.schemaName} in ${c.name}`);
        td.append(v.val);
        const dupes = cell.record?.valueCount ?? 0;
        const dupeBadge = dupes > 1 ? badge(`${dupes} value rows`, "bad") : null;
        if (dupeBadge) dupeBadge.title = "More than one environmentvariablevalue row for this definition; the one shown may not be the one the platform uses. Remove the extras.";
        const managed = cell.record?.isManaged ? cellBadge("managed", "neutral", "managed: the definition comes from a managed solution; a value can still be set here") : null;
        const meta = h("div", { class: "meta" }, cellBadge(cell.source, cell.source === "value" ? "ok" : cell.source === "default" ? "warn" : "bad"), managed, dupeBadge, v.toggle);
        if (c.kind === "live" && !r.isSecret) {
          const edit = h("button", { class: "btn-icon", type: "button", title: `Set value in ${c.name}`, "aria-label": `Set ${r.schemaName} in ${c.name}` }, "✎");
          edit.addEventListener("click", () => openSetDialog(r, c));
          meta.append(edit);
        }
        td.append(meta);
        return td;
      }),
    );
  });
  return h("table", { class: "matrix" }, h("thead", {}, head), h("tbody", {}, ...body));
}

function connRefTable(rows: Matrix["connRefs"]): HTMLElement {
  const cols = matrix.columns;
  const boxes = rows.map((r) => h("input", { type: "checkbox", "aria-label": `Select ${r.logicalName}` }) as HTMLInputElement);
  const all = selectAllBox(rows, crSelected, boxes, "connection references");
  const head = h("tr", {}, h("th", { class: "sel sticky-col" }, all.box), h("th", { class: "name sticky-col" }, "Connection reference"), h("th", {}, "Connector"), ...cols.map(colHead));
  const body = rows.map((r, i) => {
    const cb = boxes[i];
    cb.checked = crSelected.has(r.key);
    cb.addEventListener("change", () => {
      if (cb.checked) crSelected.add(r.key);
      else crSelected.delete(r.key);
      all.sync();
      renderBulkbar();
    });
    const diff = connRefDiffCells(r, cols);
    return h(
      "tr",
      { class: r.anyUnbound || r.anyAbsent ? "missing" : r.differs ? "differs" : undefined },
      h("td", { class: "sel sticky-col" }, cb),
      h("td", { class: "name sticky-col" }, h("span", { class: "mono" }, r.logicalName), h("span", { class: "display" }, r.displayName)),
      h("td", {}, r.connector ?? "—"),
      ...cols.map((c) => {
        if (c.error) return errorCell(c);
        const cell = r.cells[c.key];
        const td = h("td", { class: `cell ${cell.state}${diff.has(c.key) ? " differs" : ""}` });
        const otherConnector = cell.connector && r.connector && cell.connector.toLowerCase() !== r.connector.toLowerCase() ? badge(cell.connector, "warn") : null;
        if (otherConnector) otherConnector.title = `Connector differs: ${cell.record?.connectorId ?? cell.connector}`;
        const v = cellValue(td, `cr:${r.key}:${c.key}`, cell.state === "absent" ? "—" : (cell.connectionId ?? "(no connection)"), cell.connectionId, `${r.logicalName} in ${c.name}`);
        td.append(
          v.val,
          h(
            "div",
            { class: "meta" },
            cellBadge(cell.state, cell.state === "bound" ? "ok" : cell.state === "unbound" ? "bad" : "neutral", cell.state === "absent" ? "absent: the connection reference is not deployed in this environment" : undefined),
            cell.record?.isManaged ? cellBadge("managed", "neutral", "managed: the connection reference comes from a managed solution; it can still be bound here") : null,
            otherConnector,
            v.toggle,
          ),
        );
        return td;
      }),
    );
  });
  return h("table", { class: "matrix" }, h("thead", {}, head), h("tbody", {}, ...body));
}

function renderTable(): void {
  const body = $("#matrix-body");
  body.replaceChildren();
  const caption = $("#count-caption");
  caption.textContent = "";
  if (!matrix.columns.length) {
    body.append(emptyState("Nothing to show", inToolbox() ? "Select a primary (and optionally secondary) connection in ToolBox, then Refresh." : "Load one or more snapshot files."));
    return;
  }
  const f = filters();
  if (activeTab === "connrefs" && consolidating) {
    renderConsolidate(body, f);
    renderBulkbar();
    return;
  }
  if (activeTab === "envvars") {
    const rows = filterEnvVars(matrix.envVars, f);
    const total = matrix.envVars.length;
    caption.textContent = shownOf(rows.length, total, "variables");
    body.append(
      rows.length
        ? envVarTable(rows)
        : total
          ? filteredEmpty("No environment variables match", `The filters hide every variable.${hiddenNote()}`, clearFilters)
          : emptyState("No environment variables", "None in the loaded columns."),
    );
  } else {
    const rows = filterConnRefs(matrix.connRefs, f);
    const total = matrix.connRefs.length;
    caption.textContent = shownOf(rows.length, total, "connection references");
    body.append(
      rows.length
        ? connRefTable(rows)
        : total
          ? filteredEmpty("No connection references match", `The filters hide every connection reference.${hiddenNote()}`, clearFilters)
          : emptyState("No connection references", "None in the loaded columns."),
    );
  }
  markOverflow(body);
  renderBulkbar();
}

/** Appended to a filtered-empty hint: differences are computed over the visible columns only. */
const hiddenNote = (): string => (matrix.columns.length < columns().length ? " Hidden columns are not compared (Columns)." : "");

function renderBulkbar(): void {
  const bar = $("#bulkbar");
  const bind = activeTab === "connrefs";
  const n = bind ? crSelected.size : selected.size;
  bar.hidden = (bind && consolidating) || n === 0 || writableCols().length === 0;
  $("#sel-count").textContent = String(n);
  $("#btn-copy").textContent = bind ? "Preview bind…" : "Preview copy…";
  $("#bind-restart-wrap").hidden = !bind;
  $("#btn-pick").hidden = !bind;
  const cons = $("#btn-consolidate");
  cons.hidden = activeTab !== "connrefs";
  cons.textContent = consolidating ? "Back to matrix" : "Consolidate…";
  cons.toggleAttribute("disabled", !consolidating && !liveCols().length);
  syncColMenu();
  renderMergebar();
}

function rebuild(): void {
  matrix = buildMatrix(columns(), hiddenKeys());
  for (const k of [...selected]) if (!matrix.envVars.some((r) => r.key === k)) selected.delete(k);
  for (const k of [...crSelected]) if (!matrix.connRefs.some((r) => r.key === k)) crSelected.delete(k);
  renderHeader();
  renderTable();
}

// ---------- consolidate ----------
const consColumn = (): ColumnData | undefined => live.find((c) => c.meta.key === consKey && !c.meta.error) ?? live.find((c) => !c.meta.error);
const lcase = (v: string): string => v.toLowerCase();

function consFlows(): FlowRecord[] | null {
  const col = consColumn();
  return col && flowCache && flowCache.key === col.meta.key && flowCache.url === col.meta.url ? flowCache.flows : null;
}

/** Reads the flows of the consolidate column. Coalesces overlapping calls. */
function scanFlows(): Promise<void> {
  if (scanning) return scanning;
  scanning = (async () => {
    const api = dataverse();
    const col = consColumn();
    if (!api || !col?.meta.target) return;
    flowError = null;
    setStatus(`Reading cloud flows in ${col.meta.name}…`);
    try {
      const flows = await fetchFlows(api, col.meta.target);
      // Selections name references of the org they were made in: a different org starts clean.
      if (flowCache && (flowCache.key !== col.meta.key || flowCache.url !== col.meta.url)) {
        keepBy.clear();
        mergeSel.clear();
        cleanupSel.clear();
        turnOnSel.clear();
      }
      flowCache = { key: col.meta.key, url: col.meta.url, flows };
    } catch (e) {
      flowCache = null;
      flowError = (e as Error).message;
    }
    setStatus(null);
  })().finally(() => {
    scanning = null;
    renderTable();
  });
  return scanning;
}

/** Selected merges, one spec per connector group with at least one source. */
function mergeSpecs(refs: ConnRefRecord[]): MergeSpec[] {
  const flows = consFlows();
  if (!flows) return [];
  const specs: MergeSpec[] = [];
  for (const g of connectorGroups(refs, usageByConnRef(flows))) {
    const keep = keepBy.get(lcase(g.connectorId)) ?? g.suggested;
    const sources = g.refs.filter((r) => lcase(r.logicalName) !== lcase(keep) && mergeSel.has(lcase(r.logicalName))).map((r) => r.logicalName);
    if (sources.length) specs.push({ target: keep, sources });
  }
  return specs;
}

function renderMergebar(): void {
  const bar = $("#mergebar");
  const col = consColumn();
  const specs = activeTab === "connrefs" && consolidating && col ? mergeSpecs(col.connRefs) : [];
  const n = specs.reduce((a, s) => a + s.sources.length, 0);
  bar.hidden = !n;
  $("#merge-count").textContent = `${n} reference${n === 1 ? "" : "s"} → ${specs.length} target${specs.length === 1 ? "" : "s"}`;
}

function renderConsolidate(body: HTMLElement, f: Filters): void {
  const col = consColumn();
  const head = h("div", { class: "cons-head" });
  const sel = h("select", { id: "cons-col", "aria-label": "Environment" }) as HTMLSelectElement;
  sel.replaceChildren(...liveCols().map((m) => h("option", { value: m.key }, `${m.name} (${m.target})`)));
  if (col) sel.value = col.meta.key;
  sel.addEventListener("change", () => {
    consKey = sel.value;
    keepBy.clear();
    mergeSel.clear();
    renderTable();
    if (!consFlows()) void scanFlows();
  });
  const rescan = h("button", { class: "btn btn-sm", type: "button" }, "Rescan flows");
  rescan.addEventListener("click", () => {
    fitFailed = null;
    void scanFlows();
  });
  const restore = h("button", { class: "btn btn-ghost btn-sm", type: "button", title: "Merge, cleanup or bind backup" }, "Restore from backup…");
  restore.addEventListener("click", () => void restoreFromBackup());
  head.append(h("label", {}, "Environment ", sel), rescan, h("span", { class: "spacer" }), restore);
  body.append(head);
  if (!col) {
    body.append(emptyState("No live connection", "Consolidation writes to a live environment. Pick a connection in ToolBox."));
    return;
  }
  const flows = consFlows();
  if (!flows) {
    if (flowError) body.append(emptyState("Could not read cloud flows", flowError));
    else {
      body.append(emptyState("Reading cloud flows…", "Usage per connection reference comes from each flow's definition."));
      if (!scanning) void scanFlows();
    }
    return;
  }
  head.insertBefore(foldAllButtons(() => document.querySelector(".cons-groups"), "details.card"), restore);
  const usage = usageByConnRef(flows);
  const t = f.text.trim().toLowerCase();
  const refs = col.connRefs.filter((r) => (!f.scope || f.scope.has(lcase(r.logicalName))) && (!t || lcase(r.logicalName).includes(t) || lcase(r.displayName).includes(t) || lcase(r.connector ?? "").includes(t)));
  const groups = connectorGroups(refs, usage);
  const bad = flows.filter((x) => x.parseError).length;
  const total = col.connRefs.length;
  const reducible = groups.reduce((a, g) => a + g.refs.length - 1, 0);
  body.append(
    h(
      "p",
      { class: "caption", style: "padding: var(--s-2) var(--s-5) 0" },
      `${flows.length} cloud flow${flows.length === 1 ? "" : "s"} scanned, ${total} connection reference${total === 1 ? "" : "s"}. ${groups.length} connector${groups.length === 1 ? "" : "s"} with more than one reference: up to ${reducible} can be merged away.${bad ? ` ${bad} flow${bad === 1 ? "" : "s"} with unreadable clientdata (skipped).` : ""}`,
    ),
  );
  const wrap = h("div", { class: "cons-groups" });
  const fit = fitCard(col, flows);
  if (fit) wrap.append(fit);
  if (!groups.length) wrap.append(emptyState("Nothing to consolidate", "Every connector has at most one connection reference (within the current filters)."));
  for (const g of groups) {
    const gk = lcase(g.connectorId);
    const keep = keepBy.get(gk) ?? g.suggested;
    const rows = g.refs.map((r) => {
      const name = lcase(r.logicalName);
      const isKeep = name === lcase(keep);
      const radio = h("input", { type: "radio", name: `keep-${gk}`, "aria-label": `Keep ${r.logicalName}` }) as HTMLInputElement;
      radio.checked = isKeep;
      radio.addEventListener("change", () => {
        keepBy.set(gk, r.logicalName);
        mergeSel.delete(name);
        renderTable();
      });
      const cb = h("input", { type: "checkbox", "aria-label": `Merge ${r.logicalName}` }) as HTMLInputElement;
      cb.checked = !isKeep && mergeSel.has(name);
      cb.disabled = isKeep;
      cb.addEventListener("change", () => {
        if (cb.checked) mergeSel.add(name);
        else mergeSel.delete(name);
        renderTable();
      });
      const users = usage.get(name) ?? [];
      const count = badge(`${users.length} flow${users.length === 1 ? "" : "s"}`, users.length ? "neutral" : "warn");
      count.title = users.map((u) => u.name).join("\n") || "not used by any cloud flow";
      return h(
        "tr",
        { class: isKeep ? "keep" : cb.checked ? "merge" : undefined },
        h("td", { class: "pick" }, radio),
        h("td", { class: "pick" }, cb),
        h("td", { class: "name" }, h("span", { class: "mono" }, r.logicalName), h("span", { class: "display" }, r.displayName)),
        h("td", { class: "mono" }, r.connectionId ?? "", " ", badge(r.connectionId ? "bound" : "unbound", r.connectionId ? "ok" : "bad")),
        h("td", {}, count, " ", r.isManaged ? badge("managed", "neutral") : null, isKeep && lcase(g.suggested) === name ? badge("suggested", "ok") : null),
      );
    });
    const all = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Merge all into kept");
    all.addEventListener("click", () => {
      for (const r of g.refs) if (lcase(r.logicalName) !== lcase(keep)) mergeSel.add(lcase(r.logicalName));
      renderTable();
    });
    const table = h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", {}, "Keep"), h("th", {}, "Merge"), h("th", {}, "Connection reference"), h("th", {}, "Connection"), h("th", {}, "Usage"))),
      h("tbody", {}, ...rows),
    );
    // open while there is something to act on (a merge picked, a keep target changed, an unbound reference)
    const picked = g.refs.filter((r) => lcase(r.logicalName) !== lcase(keep) && mergeSel.has(lcase(r.logicalName))).length;
    const unbound = g.refs.filter((r) => !r.connectionId).length;
    const flags = h("span", { class: "cons-flags" }, picked ? badge(`${picked} to merge`, "warn") : null, unbound ? badge(`${unbound} unbound`, "bad") : null);
    wrap.append(
      foldCard(g.connector, g.refs.length, h("div", {}, h("div", { class: "cons-actions" }, all), table), picked > 0 || keepBy.has(gk) || unbound > 0, {
        key: `cons:${col.meta.key}:group:${gk}`,
        extra: flags.childElementCount ? flags : null,
      }),
    );
  }
  wrap.append(cleanupCard(col, unusedConnRefs(refs, usage)));
  wrap.append(offFlowsCard(col, flows, t));
  body.append(wrap);
}

function cleanupCard(col: ColumnData, unused: ConnRefRecord[]): HTMLElement {
  const title = "Unused connection references";
  const key = `cons:${col.meta.key}:unused`;
  if (!unused.length) return foldCard(title, 0, emptyState("None", "Every connection reference is used by at least one cloud flow (within the current filters)."), false, { key });
  const deletable = unused.filter((r) => !r.isManaged);
  const rows = unused.map((r) => {
    const name = lcase(r.logicalName);
    const cb = h("input", { type: "checkbox", "aria-label": `Delete ${r.logicalName}` }) as HTMLInputElement;
    cb.checked = cleanupSel.has(name);
    cb.disabled = r.isManaged;
    cb.addEventListener("change", () => {
      if (cb.checked) cleanupSel.add(name);
      else cleanupSel.delete(name);
      renderTable();
    });
    return h(
      "tr",
      { class: cb.checked ? "merge" : undefined },
      h("td", { class: "pick" }, cb),
      h("td", { class: "name" }, h("span", { class: "mono" }, r.logicalName), h("span", { class: "display" }, r.displayName)),
      h("td", {}, r.connector ?? "—"),
      h("td", {}, badge(r.connectionId ? "bound" : "unbound", r.connectionId ? "ok" : "bad"), " ", r.isManaged ? badge("managed", "neutral") : null),
    );
  });
  const n = unused.filter((r) => cleanupSel.has(lcase(r.logicalName)) && !r.isManaged).length;
  const actions = h("div", { class: "cons-actions" });
  const all = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Select all unmanaged");
  all.addEventListener("click", () => {
    for (const r of deletable) cleanupSel.add(lcase(r.logicalName));
    renderTable();
  });
  const go = h("button", { class: "btn btn-primary btn-sm", type: "button", id: "btn-cleanup-preview", style: "flex:none" }, `Preview delete (${n})…`);
  go.toggleAttribute("disabled", !n);
  go.addEventListener("click", () => void previewCleanup(col));
  actions.append(all, go);
  const table = h(
    "table",
    {},
    h("thead", {}, h("tr", {}, h("th", {}, "Delete"), h("th", {}, "Connection reference"), h("th", {}, "Connector"), h("th", {}, "State"))),
    h("tbody", {}, ...rows),
  );
  return foldCard(title, unused.length, h("div", {}, actions, table), true, { key });
}

const cleanupSummary = (n: number): string => `${n} unused reference${n === 1 ? "" : "s"} to delete`;

async function previewCleanup(col: ColumnData): Promise<void> {
  const flows = consFlows();
  const api = dataverse();
  if (!flows || !api) return;
  const names = col.connRefs.filter((r) => cleanupSel.has(lcase(r.logicalName))).map((r) => r.logicalName);
  if (!names.length) return;
  const plan = planCleanup(col.meta, col.connRefs, flows, names);
  setStatus("Checking dependencies…");
  await markDependents(api, plan);
  setStatus(null);
  await runMergePlan(
    col,
    plan,
    `${cleanupSummary(plan.deletes.filter((d) => d.action === "delete").length)} in ${col.meta.name}. A backup file is saved first (cancelling the save cancels the delete); Restore from backup… recreates them with the same name, connector and connection, but a new id and outside any solution.`,
  );
  cleanupSel.clear();
}

function offFlowsCard(col: ColumnData, flows: FlowRecord[], text: string): HTMLElement {
  const title = "Flows that are off";
  const key = `cons:${col.meta.key}:off`;
  // the solution filter scopes this card to the solution's flows, as it scopes the other cards to its references
  const ids = solutionFlowIds();
  if (ids === "loading") return foldCard(title, null, h("p", { class: "caption" }, "Reading the solution's cloud flows…"), true, { key });
  const { scoped: all, shown } = filterOffFlows(offFlows(flows, col.connRefs), { text, flowIds: ids === "failed" ? null : ids, onlyReady: offOnlyReady });
  const note = ids === "failed" ? h("p", { class: "caption" }, "The solution's cloud flows could not be read: flows of every solution are listed.") : null;
  if (!all.length) return foldCard(title, 0, h("div", {}, note, emptyState("None", "Every solution cloud flow is on (within the current filters).")), false, { key });
  const ready = all.filter((f) => f.ready);
  const rows = shown.map((f) => {
    const cb = h("input", { type: "checkbox", "aria-label": `Turn on ${f.name}` }) as HTMLInputElement;
    cb.checked = f.ready && turnOnSel.has(f.flowId);
    cb.disabled = !f.ready;
    cb.addEventListener("change", () => {
      if (cb.checked) turnOnSel.add(f.flowId);
      else turnOnSel.delete(f.flowId);
      renderTable();
    });
    return h(
      "tr",
      { class: cb.checked ? "keep" : undefined },
      h("td", { class: "pick" }, cb),
      h("td", {}, f.name, f.isManaged ? h("span", {}, " ", badge("managed", "neutral")) : null),
      h("td", { class: "changes" }, f.refs.join(", ") || "—"),
      h("td", {}, badge(f.ready ? "ready" : "blocked", f.ready ? "ok" : "bad"), " ", h("span", { class: "caption" }, f.reason)),
    );
  });
  const n = ready.filter((f) => turnOnSel.has(f.flowId)).length;
  const actions = h("div", { class: "cons-actions" });
  const onlyReady = h("input", { type: "checkbox", id: "off-only-ready" }) as HTMLInputElement;
  onlyReady.checked = offOnlyReady;
  onlyReady.addEventListener("change", () => {
    offOnlyReady = onlyReady.checked;
    saveView(VIEW, "offOnlyReady", offOnlyReady || undefined);
    renderTable();
    document.querySelector<HTMLInputElement>("#off-only-ready")?.focus();
  });
  const selAll = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Select all ready");
  selAll.toggleAttribute("disabled", !ready.length);
  selAll.addEventListener("click", () => {
    for (const f of ready) turnOnSel.add(f.flowId);
    renderTable();
  });
  const go = h("button", { class: "btn btn-primary btn-sm", type: "button", id: "btn-turnon-preview", style: "flex:none" }, `Turn on (${n})…`);
  go.toggleAttribute("disabled", !n);
  go.addEventListener("click", () => void previewTurnOn(col, ready.filter((f) => turnOnSel.has(f.flowId))));
  actions.append(h("label", { class: "check cons-only-ready", title: "Hide flows that are blocked by an unbound or missing reference" }, onlyReady, " Only ready"), selAll, go);
  const table = rows.length
    ? h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "On"), h("th", {}, "Flow"), h("th", {}, "Connection references"), h("th", {}, "State"))),
        h("tbody", {}, ...rows),
      )
    : filteredEmpty("No flow is ready", `All ${all.length} flow${all.length === 1 ? " that is off is" : "s that are off are"} blocked: bind or add their references first.`, () => {
        offOnlyReady = false;
        saveView(VIEW, "offOnlyReady", undefined);
        renderTable();
      }, "Show blocked flows");
  return foldCard(title, shown.length === all.length ? all.length : `${shown.length} of ${all.length}`, h("div", {}, note, actions, table), true, { key });
}

async function previewTurnOn(col: ColumnData, picked: { flowId: string; name: string; refs: string[] }[]): Promise<void> {
  const api = dataverse();
  if (!api || !picked.length) return;
  const isProd = /prod/i.test(col.meta.environment);
  const body = h(
    "div",
    {},
    h("p", { class: "caption" }, `${picked.length} flow${picked.length === 1 ? "" : "s"} to turn on in ${col.meta.name}. Every connection reference they use is bound.`),
    h("div", { class: "warnings" }, "Turned-on flows start running on their triggers (schedules, Dataverse and connector events). Turn on only flows that are meant to run in this environment."),
    isProd ? h("div", { class: "warnings" }, "Target is a Production environment.") : null,
    h("ul", {}, ...picked.map((f) => h("li", {}, f.name, h("span", { class: "caption" }, ` — ${f.refs.join(", ") || "no connection references"}`)))),
    h("p", { class: "caption" }, "No backup applies: only the flow state changes. This tool does not turn flows off again; turn a flow off in Power Automate if needed. Runs that have started cannot be undone."),
  );
  const ok = await showDialog({ title: "Turn on flows", target: targetChip(col.meta), body, okLabel: `Turn on ${picked.length}`, danger: isProd });
  if (!ok) return;
  const res = await turnOnFlows(api, col.meta, stampOf(col.meta), picked, currentConnection, (m) => setStatus(m || null));
  setStatus(null);
  logRun("turn on flow", col.meta, res.map((f) => ({ item: f.name, detail: "off → on", ok: f.ok, error: f.error })));
  await showMergeResults("Flows turned on", col.meta, res, { label: "", rows: [] });
  turnOnSel.clear();
  flowCache = null;
  await refresh();
}

/** Selected solution, when the solution filter is set (its scope loaded from the primary). */
function selectedSol(): SolutionInfo | null {
  if (!selectedSolution || !scope) return null;
  return solutions.find((x) => x.id === selectedSolution) ?? null;
}

/** Solution of the fit check: the solution filter, when it is set and the view works on the primary. */
const fitSolution = (col: ColumnData): SolutionInfo | null => (col.meta.target === "primary" ? selectedSol() : null);

/**
 * Cloud flow ids of the selected solution, read in the primary like the solution scope. Solution import keeps
 * workflow ids, so they name the solution's flows in the secondary too. null: no solution filter.
 */
function solutionFlowIds(): Set<string> | null | "loading" | "failed" {
  const sol = selectedSol();
  const primary = live.find((c) => c.meta.target === "primary" && !c.meta.error);
  if (!sol || !primary) return null;
  if (fitCache && fitCache.solutionId === sol.id && fitCache.url === primary.meta.url) return fitCache.flowIds;
  if (fitFailed === `${sol.id}|${primary.meta.url}`) return "failed";
  loadFit(primary, sol);
  return "loading";
}

function loadFit(col: ColumnData, sol: SolutionInfo): void {
  const api = dataverse();
  if (!api || fitLoading) return;
  fitLoading = (async () => {
    try {
      const flowIds = await fetchSolutionFlowIds(api, "primary", sol.id);
      fitCache = { solutionId: sol.id, url: col.meta.url, flowIds };
      fitFailed = null;
    } catch (e) {
      fitCache = null;
      // remembered, so the re-render below does not read (and notify) again in a loop
      fitFailed = `${sol.id}|${col.meta.url}`;
      await notify("Solution check failed", (e as Error).message, "warning");
    }
  })().finally(() => {
    fitLoading = null;
    renderTable();
  });
}

function fitCard(col: ColumnData, flows: FlowRecord[]): HTMLElement | null {
  const sol = fitSolution(col);
  if (!sol) return null;
  const ids = solutionFlowIds();
  if (ids === "loading" || ids === null) return card(`Solution check · ${sol.friendlyName}`, h("p", { class: "caption" }, "Reading the solution's cloud flows…"));
  if (ids === "failed") return card(`Solution check · ${sol.friendlyName}`, h("p", { class: "caption" }, "The solution's cloud flows could not be read. Rescan flows to try again."));
  const issues = solutionFit(flows, ids, col.connRefs, scope!);
  const title = `Solution check · ${sol.friendlyName}`;
  if (!issues.length)
    return card(title, h("p", { class: "caption" }, `All connection references used by the solution's ${ids.size} cloud flow${ids.size === 1 ? "" : "s"} are in the solution.`));
  const addable = issues.filter((i) => i.ref).map((i) => i.ref!);
  const table = h(
    "table",
    {},
    h("thead", {}, h("tr", {}, h("th", {}, "Connection reference"), h("th", {}, "Used by (in solution)"), h("th", {}, "Note"))),
    h(
      "tbody",
      {},
      ...issues.map((i) =>
        h(
          "tr",
          { class: i.ref ? "merge" : undefined },
          h("td", { class: "mono" }, i.logicalName),
          h("td", {}, i.flows.join(", ")),
          h("td", { class: "caption" }, i.ref ? "not in the solution: an export would miss it" : h("span", {}, badge("missing", "bad"), " does not exist in this environment: the flow is broken")),
        ),
      ),
    ),
  );
  let extra: HTMLElement | undefined;
  if (sol.isManaged) extra = h("span", { class: "caption" }, "managed solution: fix it in the source environment");
  else if (addable.length) {
    extra = h("button", { class: "btn btn-primary btn-sm", type: "button", id: "btn-fit-add", style: "flex:none" }, `Add ${addable.length} to solution…`);
    extra.addEventListener("click", () => void addToSolution(col, sol, addable));
  }
  return card(title, table, extra);
}

async function addToSolution(col: ColumnData, sol: SolutionInfo, refs: ConnRefRecord[]): Promise<void> {
  const api = dataverse();
  if (!api) return;
  const body = h(
    "div",
    {},
    h(
      "p",
      { class: "caption" },
      `${refs.length} connection reference${refs.length === 1 ? "" : "s"} to add to ${sol.friendlyName} (${sol.uniqueName}) in ${col.meta.name}, with AddSolutionComponent, without required components:`,
    ),
    h("ul", {}, ...refs.map((r) => h("li", { class: "mono" }, r.logicalName))),
    h("p", { class: "caption" }, "No backup applies: the references themselves are not changed. This tool does not remove solution components; to undo, remove them from the solution in the maker portal."),
  );
  const ok = await showDialog({ title: "Add to solution", target: targetChip(col.meta), body, okLabel: `Add ${refs.length}` });
  if (!ok) return;
  setStatus("Adding to solution…");
  let res: DeleteResult[];
  try {
    res = await addRefsToSolution(api, col.meta, stampOf(col.meta), sol.uniqueName, refs, currentConnection);
  } catch (e) {
    setStatus(null);
    await notify("Add to solution failed", (e as Error).message, "error");
    return;
  }
  setStatus(null);
  logRun("add to solution", col.meta, res.map((r) => ({ item: r.logicalName, detail: `AddSolutionComponent → ${sol.uniqueName}`, ok: r.ok, error: r.error })));
  await showMergeResults("Added to solution", col.meta, [], { label: "Connection reference", rows: res });
  fitCache = null;
  await refresh();
}

function flowPlanTable(items: PlannedFlow[]): HTMLElement {
  return h(
    "table",
    {},
    h("thead", {}, h("tr", {}, h("th", {}, "Flow"), h("th", {}, "State"), h("th", {}, "Action"), h("th", {}, "Changes"), h("th", {}, "Note"))),
    h(
      "tbody",
      {},
      ...items.map((i) =>
        h(
          "tr",
          {},
          h("td", {}, i.name, i.isManaged ? h("span", {}, " ", badge("managed", "neutral")) : null),
          h("td", {}, badge(i.wasOn ? "on" : "off", i.wasOn ? "ok" : "neutral")),
          h("td", {}, badge(i.action, i.action === "update" ? "warn" : "neutral")),
          h(
            "td",
            { class: "changes" },
            ...i.changes.map((c) => h("div", {}, `${c.key}: ${c.from} → ${c.to}`)),
            ...(i.collapsed ?? []).map((c) => h("div", {}, `key ${c.drop} → ${c.into} (${c.uses} use${c.uses === 1 ? "" : "s"})`)),
          ),
          h("td", { class: "caption" }, i.reason, i.warning ? h("div", {}, badge("caution", "warn"), " ", i.warning) : null),
        ),
      ),
    ),
  );
}

const resultBadge = (r: { ok: boolean; skipped?: boolean; leftOff?: boolean; error?: string }): HTMLElement => {
  const b = r.skipped ? badge("skipped", "neutral") : r.ok ? badge("ok", "ok") : badge(r.leftOff ? "left off" : "failed", "bad");
  return r.error ? h("span", {}, b, " ", h("span", { class: "caption" }, r.error)) : b;
};

async function showMergeResults(title: string, target: ColumnMeta, flows: FlowResult[], others: { label: string; rows: DeleteResult[] }): Promise<void> {
  const failed = flows.filter((f) => !f.ok).length + others.rows.filter((d) => !d.ok).length;
  const body = h(
    "div",
    {},
    flows.length
      ? h(
          "table",
          {},
          h("thead", {}, h("tr", {}, h("th", {}, "Flow"), h("th", {}, "Result"))),
          h("tbody", {}, ...flows.map((f) => h("tr", {}, h("td", {}, f.name), h("td", {}, resultBadge(f))))),
        )
      : null,
    others.rows.length
      ? h(
          "table",
          {},
          h("thead", {}, h("tr", {}, h("th", {}, others.label), h("th", {}, "Result"))),
          h("tbody", {}, ...others.rows.map((d) => h("tr", {}, h("td", { class: "mono" }, d.logicalName), h("td", {}, resultBadge(d))))),
        )
      : null,
  );
  const okCount = flows.filter((f) => f.ok).length + others.rows.filter((d) => d.ok && !d.skipped).length;
  await notify(failed ? `${title}: some steps failed` : title, `${okCount} ok, ${failed} failed`, failed ? "warning" : "success");
  await showDialog({ title: "Results", target: targetChip(target), body });
}

async function previewMerge(): Promise<void> {
  const col = consColumn();
  const flows = consFlows();
  const api = dataverse();
  if (!col || !flows || !api) return;
  const specs = mergeSpecs(col.connRefs);
  if (!specs.length) return;
  const plan: MergePlan = planMerge(col.meta, col.connRefs, flows, specs, { deleteSources: $<HTMLInputElement>("#merge-delete").checked, collapseKeys: $<HTMLInputElement>("#merge-collapse").checked });
  const summary = `${specs.map((s) => `${s.sources.join(", ")} → ${s.target}`).join(" · ")}. ${plan.flows.filter((f) => f.action === "update").length} flows to update in ${col.meta.name}; ${plan.deletes.filter((d) => d.action === "delete").length} references to delete. A backup file of every touched flow and reference is saved first (cancelling the save cancels the merge); Restore from backup… puts each flow's clientdata back and recreates deleted references (new id, outside any solution).`;
  await runMergePlan(col, plan, summary);
  mergeSel.clear();
}

/** Preview → backup → apply → results for a merge or cleanup plan. */
async function runMergePlan(col: ColumnData, plan: MergePlan, summary: string): Promise<void> {
  const api = dataverse();
  if (!api) return;
  const updates = plan.flows.filter((f) => f.action === "update");
  const dels = plan.deletes.filter((d) => d.action === "delete");
  const isProd = /prod/i.test(col.meta.environment);
  const body = h(
    "div",
    {},
    h("p", { class: "caption" }, summary),
    isProd ? h("div", { class: "warnings" }, "Target is a Production environment.") : null,
    ...plan.errors.map((e) => h("div", { class: "warnings" }, badge("blocked", "bad"), " ", e)),
    ...plan.warnings.map((w) => h("div", { class: "warnings" }, badge("caution", "warn"), " ", w)),
    updates.some((u) => u.wasOn) ? h("p", { class: "caption" }, "Flows that are on are turned off, updated and turned back on. Turning on re-validates the connection; a flow that fails is reported and left off.") : null,
    plan.flows.length ? flowPlanTable(plan.flows) : plan.specs.length ? h("p", { class: "caption" }, "No cloud flow uses the selected references.") : null,
    plan.deletes.length
      ? h(
          "table",
          {},
          h("thead", {}, h("tr", {}, h("th", {}, "Connection reference"), h("th", {}, "Action"), h("th", {}, "Note"))),
          h("tbody", {}, ...plan.deletes.map((d) => h("tr", {}, h("td", { class: "mono" }, d.logicalName), h("td", {}, badge(d.action, d.action === "delete" ? "bad" : "neutral")), h("td", { class: "caption" }, d.reason)))),
        )
      : null,
  );
  const n = updates.length + dels.length;
  const ok = await showDialog({ title: plan.specs.length ? "Preview merge" : "Preview delete", target: targetChip(col.meta), body, okLabel: !plan.errors.length && n ? `Save backup & apply` : "", danger: isProd || dels.length > 0 });
  if (!ok || plan.errors.length || !n) return;
  const cur = await currentConnection(col.meta.target!).catch(() => null);
  if (!sameConnection(plan.stamp, cur)) {
    await notify("Connection changed", `The preview was built for ${col.meta.name} (${col.meta.url}). Nothing written; refresh and preview again.`, "error");
    await refresh();
    return;
  }
  const backup = buildMergeBackup(plan, col.connRefs);
  if (!(await saveText(mergeBackupFileName(col.meta.name), JSON.stringify(backup, null, 2)))) {
    await notify("Backup not saved", "Nothing written: the backup must be saved before the merge runs.", "warning");
    return;
  }
  const res = await applyMerge(plan, { api, currentConnection, onStep: (m) => setStatus(m || null) });
  setStatus(null);
  const planned = new Map(plan.flows.map((f) => [f.flowId, f]));
  logRun(
    "merge: update flow",
    col.meta,
    res.flows.map((f) => {
      const p = planned.get(f.flowId);
      const detail = [...(p?.changes ?? []).map((c) => `${c.key}: ${c.from} → ${c.to}`), ...(p?.collapsed ?? []).map((c) => `key ${c.drop} → ${c.into}`)].join("; ");
      return { item: f.name, detail, ok: f.ok, error: f.error };
    }),
  );
  logRun(plan.specs.length ? "merge: delete reference" : "cleanup: delete reference", col.meta, res.deletes.filter((d) => !d.skipped).map((d) => ({ item: d.logicalName, detail: "deleted", ok: d.ok, error: d.error })));
  await showMergeResults(plan.specs.length ? "Merge applied" : "Cleanup applied", col.meta, res.flows, { label: "Deleted reference", rows: res.deletes });
  flowCache = null;
  await refresh();
}

async function restoreBindings(col: ColumnData, b: BindBackup): Promise<void> {
  const api = dataverse();
  if (!api) return;
  const plan = planBindRestore(col.meta, b, matrix.connRefs);
  const writes = plan.items.filter((i) => i.action === "update");
  const body = h(
    "div",
    {},
    h(
      "p",
      { class: "caption" },
      `Bind backup taken ${b.takenAt.replace("T", " ").slice(0, 19)} in ${b.environment.name}. ${writes.length} binding${writes.length === 1 ? "" : "s"} to put back in ${col.meta.name}; flows are not restarted. The current bindings are not backed up first: they are listed under Current and recorded in the Run log.`,
    ),
    ...plan.errors.map((e) => h("div", { class: "warnings" }, badge("blocked", "bad"), " ", e)),
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", {}, "Connection reference"), h("th", {}, "Action"), h("th", {}, "Current"), h("th", {}, "Restore to"), h("th", {}, "Note"))),
      h(
        "tbody",
        {},
        ...plan.items.map((i) =>
          h(
            "tr",
            {},
            h("td", { class: "mono" }, i.logicalName),
            h("td", {}, badge(i.action, i.action === "update" ? "warn" : "neutral")),
            h("td", { class: "mono" }, i.current ?? "unbound"),
            h("td", { class: "mono" }, i.restore ?? "unbound"),
            h("td", { class: "caption" }, i.reason),
          ),
        ),
      ),
    ),
  );
  const ok = await showDialog({ title: "Restore bindings", target: targetChip(col.meta), body, okLabel: !plan.errors.length && writes.length ? `Restore ${writes.length}` : "", danger: true });
  if (!ok || plan.errors.length || !writes.length) return;
  const res = await applyBindRestore(api, plan, currentConnection);
  const byName = new Map(plan.items.map((i) => [i.logicalName, i]));
  logRun("restore binding", col.meta, res.map((r) => ({ item: r.logicalName, detail: `${byName.get(r.logicalName)?.current ?? "unbound"} → ${byName.get(r.logicalName)?.restore ?? "unbound"} (bind backup)`, ok: r.ok, error: r.error })));
  await showMergeResults("Bindings restored", col.meta, [], { label: "Connection reference", rows: res });
  await refresh();
}

async function restoreFromBackup(): Promise<void> {
  const col = consColumn();
  const api = dataverse();
  if (!col || !api) return;
  const file = await openText({ title: "Open a merge, cleanup or bind backup", extensions: ["json"] });
  if (!file) return;
  let bindBackup: BindBackup | null = null;
  try {
    bindBackup = parseBindBackup(JSON.parse(file.text));
  } catch (e) {
    if (!(e instanceof SyntaxError)) {
      await notify("Backup rejected", `${file.name}: ${(e as Error).message}`, "error");
      return;
    }
  }
  if (bindBackup) {
    await restoreBindings(col, bindBackup);
    return;
  }
  let plan;
  let takenAt = "";
  try {
    const b = parseMergeBackup(file.text);
    takenAt = `${String(b.takenAt ?? "").replace("T", " ").slice(0, 19)} in ${b.environment.name}`;
    setStatus("Reading cloud flows…");
    const flows = await fetchFlows(api, col.meta.target!);
    plan = planRestore(col.meta, b, col.connRefs, flows);
  } catch (e) {
    await notify("Backup rejected", `${file.name}: ${(e as Error).message}`, "error");
    return;
  } finally {
    setStatus(null);
  }
  const updates = plan.flows.filter((f) => f.action === "update");
  const body = h(
    "div",
    {},
    h(
      "p",
      { class: "caption" },
      `Backup taken ${takenAt}. In ${col.meta.name}: ${plan.recreate.length} reference${plan.recreate.length === 1 ? "" : "s"} to recreate (new id, outside any solution), ${updates.length} flow${updates.length === 1 ? "" : "s"} whose clientdata is put back. The current flow definitions are not backed up first: this restore cannot be undone from this tool.`,
    ),
    ...plan.errors.map((e) => h("div", { class: "warnings" }, badge("blocked", "bad"), " ", e)),
    plan.recreate.length ? h("p", { class: "caption" }, `Recreated first: ${plan.recreate.map((r) => r.logicalName).join(", ")}.`) : null,
    plan.missing.length ? h("div", { class: "warnings" }, `Flows in the backup that no longer exist (not restored): ${plan.missing.join(", ")}`) : null,
    plan.flows.length ? flowPlanTable(plan.flows) : null,
  );
  const n = updates.length + plan.recreate.length;
  const ok = await showDialog({ title: "Preview restore", target: targetChip(col.meta), body, okLabel: !plan.errors.length && n ? `Restore ${n}` : "", danger: true });
  if (!ok || plan.errors.length || !n) return;
  const res = await applyRestore(plan, { api, currentConnection, onStep: (m) => setStatus(m || null) });
  setStatus(null);
  logRun("restore: recreate reference", col.meta, res.created.map((d) => ({ item: d.logicalName, detail: "recreated from backup", ok: d.ok, error: d.error })));
  logRun("restore: flow clientdata", col.meta, res.flows.map((f) => ({ item: f.name, detail: "clientdata restored from backup", ok: f.ok, error: f.error })));
  await showMergeResults("Restore applied", col.meta, res.flows, { label: "Recreated reference", rows: res.created });
  flowCache = null;
  await refresh();
}

// ---------- data loading ----------
let refreshing: Promise<void> | null = null;
let refreshQueued = false;

/** Overlapping calls (connection events, button, post-write) coalesce: one in flight, at most one queued rerun. */
function refresh(): Promise<void> {
  if (refreshing) {
    refreshQueued = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshQueued = false;
      await loadLive();
    } while (refreshQueued);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function loadLive(): Promise<void> {
  const api = dataverse();
  const conns = await getConnections();
  if (!api || !conns.length) {
    live = [];
    solutions = [];
    selectedSolution = "";
    scope = null;
    rebuild();
    return;
  }
  setStatus("Loading…");
  const metas: ColumnMeta[] = conns.map((c) => ({
    key: c.target,
    kind: "live",
    target: c.target,
    connectionId: c.conn.id,
    name: c.conn.name,
    url: c.conn.url,
    environment: c.conn.environment,
    color: c.conn.environmentColor,
    takenAt: "",
  }));
  // allSettled: one failing connection must not blank the other column.
  const results = await Promise.allSettled(metas.map((m) => fetchColumn(api, m)));
  live = results.map((r, i) =>
    r.status === "fulfilled" ? r.value : { meta: { ...metas[i], error: (r.reason as Error)?.message ?? String(r.reason) }, envVars: [], connRefs: [] },
  );
  const failed = live.filter((c) => c.meta.error);
  const primaryOk = live.some((c) => c.meta.target === "primary" && !c.meta.error);
  solutions = primaryOk ? await fetchSolutions(api, "primary").catch(() => []) : [];
  if (restoreSolution && solutions.length) {
    // the saved Solution filter can only be selected once its option exists
    restoreSolution = false;
    const solSel = $<HTMLSelectElement>("#filter-solution");
    solSel.replaceChildren(...solutionOptions());
    view.restore();
    selectedSolution = solSel.value;
  }
  // The primary may be a different org now: a solution id it doesn't list is reset to "all" (scope null), not queried.
  if (!solutions.some((s) => s.id === selectedSolution)) selectedSolution = "";
  await applySolutionFilter();
  setStatus(null);
  if (failed.length) await notify("Load failed", failed.map((c) => `${c.meta.name}: ${c.meta.error}`).join("\n"), "error");
  rebuild();
}

async function applySolutionFilter(): Promise<void> {
  const id = selectedSolution;
  const api = dataverse();
  const primary = live.find((c) => c.meta.target === "primary" && !c.meta.error);
  if (!id || !api || !primary || !solutions.some((s) => s.id === id)) {
    selectedSolution = "";
    scope = null;
    return;
  }
  try {
    const next = await fetchSolutionScope(api, "primary", id, primary);
    // ignore a stale result if the selection or the primary changed meanwhile
    if (selectedSolution === id && live.includes(primary)) scope = next;
  } catch (e) {
    if (selectedSolution === id) {
      selectedSolution = "";
      scope = null;
    }
    await notify("Solution filter failed", (e as Error).message, "warning");
  }
}

/** The host's current connection for `t`, as a stamp comparable with a plan's. */
async function currentConnection(t: Target): Promise<ConnectionStamp | null> {
  const c = (await getConnections()).find((x) => x.target === t);
  return c ? { connectionId: c.conn.id ?? null, url: c.conn.url } : null;
}

/** Refuses (with an error notification) when the plan's target connection is no longer the one it was built for. */
async function checkPlanConnection(plan: WritePlan): Promise<boolean> {
  const t = plan.target.target;
  const cur = t ? await currentConnection(t).catch(() => null) : null;
  if (t && sameConnection(plan.stamp, cur)) return true;
  await notify("Connection changed", connectionChangedMessage(plan, cur), "error");
  return false;
}

async function loadSnapshot(): Promise<void> {
  const f = await openText({ title: "Open matrix snapshot", extensions: ["json"] });
  if (!f) return;
  try {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(f.text);
    } catch {
      /* parseSnapshot reports it */
    }
    snaps.push(isDeploymentSettings(parsed) ? parseDeploymentSettings(f.text, f.name) : parseSnapshot(f.text, f.name));
    rebuild();
  } catch (e) {
    await notify("Snapshot rejected", `${f.name}: ${(e as Error).message}`, "error");
  }
}

// ---------- dialogs ----------
const targetChip = (m: ColumnMeta): Node => h("span", {}, "Target:", colChip(m, false));

/** Previews with more rows than this hide their skipped rows by default. */
const HIDE_SKIPPED_OVER = 10;

/**
 * "Hide skipped (n)" for a copy / bind preview table: hides the rows that are not written (`tr.is-skip`); the
 * counts and what Apply writes do not change. On by default for a long plan that writes something; a plan that
 * writes nothing shows every row, since the reasons are then the whole answer.
 */
function hideSkippedToggle(table: HTMLElement, total: number, skipped: number, writes: number): HTMLElement | null {
  if (!skipped) return null;
  const cb = h("input", { type: "checkbox", id: "hide-skipped" }) as HTMLInputElement;
  cb.checked = total > HIDE_SKIPPED_OVER && writes > 0;
  const apply = () => table.querySelectorAll<HTMLElement>("tbody tr.is-skip").forEach((tr) => (tr.hidden = cb.checked));
  cb.addEventListener("change", apply);
  apply();
  return h("div", { class: "dlg-tools" }, h("label", { class: "check", title: "Rows that are not written: already equal, not deployed in the target, secret…" }, cb, ` Hide skipped (${skipped})`));
}

function planTable(items: WritePlan["items"]): HTMLElement {
  return h(
    "table",
    {},
    h("thead", {}, h("tr", {}, h("th", {}, "Variable"), h("th", {}, "Action"), h("th", {}, "Current"), h("th", {}, "New"), h("th", {}, "Note"))),
    h(
      "tbody",
      {},
      ...items.map((i) =>
        h(
          "tr",
          { class: i.action === "skip" ? "is-skip" : undefined },
          h("td", {}, h("span", { class: "mono" }, i.schemaName)),
          h("td", {}, badge(i.action, i.action === "skip" ? "neutral" : i.action === "create" ? "ok" : i.action === "invalid" ? "bad" : "warn")),
          h("td", { class: "mono" }, `${i.currentValue ?? "—"} `, badge(i.currentSource, "neutral")),
          h("td", { class: "mono" }, i.action === "skip" ? "—" : (i.newValue ?? "")),
          h("td", { class: "caption" }, i.reason, i.warning ? h("div", {}, badge("caution", "warn"), " ", i.warning) : null),
        ),
      ),
    ),
  );
}

async function runPlan(plan: WritePlan): Promise<void> {
  if (!(await checkPlanConnection(plan))) return;
  const writes = plan.items.filter((i) => i.action === "create" || i.action === "update");
  const invalid = plan.items.filter((i) => i.action === "invalid");
  const cautions = writes.filter((i) => i.warning);
  const isProd = /prod/i.test(plan.target.environment);
  const table = planTable(plan.items);
  const body = h(
    "div",
    {},
    h(
      "p",
      { class: "caption" },
      `${writes.length} write${writes.length === 1 ? "" : "s"} to ${plan.target.name} (${plan.target.environment}). ${plan.items.length - writes.length - invalid.length} skipped.${invalid.length ? ` ${invalid.length} invalid (not written).` : ""}`,
    ),
    isProd && writes.length ? h("div", { class: "warnings" }, "Target is a Production environment.") : null,
    invalid.length ? h("div", { class: "warnings" }, `${invalid.length} value${invalid.length === 1 ? " does" : "s do"} not match the variable type and will not be written.`) : null,
    cautions.length ? h("div", { class: "warnings" }, `${cautions.length} write${cautions.length === 1 ? "" : "s"} with a caution: see Note.`) : null,
    writes.length
      ? h(
          "p",
          { class: "caption" },
          "This cannot be undone from this tool: no backup file is saved for values. The old values are in the Current column above and in the Run log (before → after); to undo an update, set the old value back. A created value row stays until it is deleted in the maker portal. For a file copy first, use Export → Snapshot.",
        )
      : null,
    hideSkippedToggle(table, plan.items.length, plan.items.filter((i) => i.action === "skip").length, writes.length),
    table,
  );
  const ok = await showDialog({ title: "Preview changes", target: targetChip(plan.target), body, okLabel: writes.length ? `Apply ${writes.length}` : "", danger: isProd });
  if (!ok || !writes.length) return;
  const api = dataverse();
  if (!api) return;
  // Re-check at Apply: the connection may have changed while the preview was open (applyPlan checks again per write).
  if (!(await checkPlanConnection(plan))) {
    await refresh();
    return;
  }
  setStatus("Writing…");
  const results = await applyPlan(api, plan, currentConnection);
  setStatus(null);
  logRun(
    "set env var",
    plan.target,
    results.filter((r) => r.action === "create" || r.action === "update").map((r) => ({ item: r.schemaName, detail: `${r.action}: ${r.currentValue ?? "—"} → ${r.newValue ?? ""}`, ok: r.ok, error: r.error })),
  );
  await showResults(results, plan.target);
  await refresh();
}

async function showResults(results: WriteResult[], target: ColumnMeta): Promise<void> {
  const failed = results.filter((r) => !r.ok && r.action !== "invalid");
  const notWritten = results.filter((r) => r.action === "skip" || r.action === "invalid").length;
  const body = h(
    "table",
    {},
    h("thead", {}, h("tr", {}, h("th", {}, "Variable"), h("th", {}, "Action"), h("th", {}, "Result"))),
    h(
      "tbody",
      {},
      ...results.map((r) => h("tr", {}, h("td", {}, h("span", { class: "mono" }, r.schemaName)), h("td", {}, r.action), h("td", {}, r.action === "skip" ? badge("skipped", "neutral") : r.action === "invalid" ? badge("invalid, not written", "bad") : r.ok ? badge("ok", "ok") : badge(r.error ?? "failed", "bad")))),
    ),
  );
  await notify(failed.length ? "Some writes failed" : "Values written", `${results.length - failed.length - notWritten} ok, ${failed.length} failed`, failed.length ? "warning" : "success");
  await showDialog({ title: "Results", target: targetChip(target), body });
}

async function openSetDialog(row: EnvVarRow, target: ColumnMeta): Promise<void> {
  const current = row.cells[target.key];
  const input = h("textarea", { rows: "4", "aria-label": "New value" }) as HTMLTextAreaElement;
  input.value = current.effective ?? "";
  const body = h("div", {}, h("p", {}, h("span", { class: "mono" }, row.schemaName), " ", badge(row.type, "neutral"), " ", h("span", { class: "caption" }, `current: ${current.source}`)), input);
  const ok = await showDialog({ title: "Set value", target: targetChip(target), body, okLabel: "Preview" });
  if (!ok) return;
  await runPlan(planSet(row, target, input.value));
}

async function copySelected(): Promise<void> {
  const fromKey = $<HTMLSelectElement>("#copy-from").value;
  const toKey = $<HTMLSelectElement>("#copy-to").value;
  const target = liveCols().find((m) => m.key === toKey);
  if (!target) return;
  if (fromKey === toKey) {
    await notify("Same column", "Pick a different source and target.", "warning");
    return;
  }
  if (activeTab === "connrefs") {
    const source = okColumns().find((c) => c.meta.key === fromKey)?.meta;
    if (source) await runBind(planBind(matrix.connRefs.filter((r) => crSelected.has(r.key)), source, target));
    return;
  }
  const rows = matrix.envVars.filter((r) => selected.has(r.key));
  await runPlan(planCopy(rows, fromKey, target));
}

/** Environment ids per org url (RetrieveCurrentOrganization), for Power Platform API paths. */
const envIds = new Map<string, string>();

/** Bind by picking connections listed through the Power Platform API (experimental). */
async function pickConnections(): Promise<void> {
  const toKey = $<HTMLSelectElement>("#copy-to").value;
  const target = liveCols().find((m) => m.key === toKey);
  const api = dataverse();
  const pp = powerplatform();
  if (!target?.target || !api) return;
  const rows = matrix.connRefs.filter((r) => crSelected.has(r.key) && r.cells[target.key]?.record);
  if (!rows.length) {
    await notify("Nothing to bind", `None of the selected references exist in ${target.name}.`, "warning");
    return;
  }
  const fail = (reason: string) =>
    showDialog({
      title: "Connections unavailable",
      target: targetChip(target),
      body: h(
        "div",
        {},
        h("div", { class: "warnings" }, reason),
        h(
          "p",
          { class: "caption" },
          "Listing connections uses the Power Platform API: ToolBox 1.2.6 or later, and a connection with the Power Platform API enabled (Edit connection → custom Client ID with delegated Connectivity.Connections.Read). Without it, bind from a deploymentSettings.json: Load snapshot…, then Preview bind.",
        ),
      ),
    });
  if (!pp?.Connectivity) {
    await fail("This ToolBox version does not expose the Power Platform API.");
    return;
  }
  let conns: PpConnection[];
  setStatus(`Reading connections in ${target.name}…`);
  try {
    const url = target.url.toLowerCase();
    let envId = envIds.get(url);
    if (!envId) {
      envId = await environmentId(api, target.target);
      envIds.set(url, envId);
    }
    conns = await listConnections(pp.Connectivity, envId, target.target);
  } catch (e) {
    setStatus(null);
    await fail(explainPpError(e));
    return;
  } finally {
    setStatus(null);
  }
  const unknown = conns.filter((c) => !c.connector).length;
  const picks = new Map<string, HTMLSelectElement>();
  const body = h(
    "div",
    {},
    h(
      "p",
      { class: "caption" },
      `${conns.length} connection${conns.length === 1 ? "" : "s"} in ${target.name}; only those of each reference's connector are offered. Experimental: the list comes from the Power Platform API as the signed-in user sees it; a connection the flow owner cannot use makes turning the flow on fail (reported, flow left off).${unknown ? ` ${unknown} connection${unknown === 1 ? " has" : "s have"} no readable connector and ${unknown === 1 ? "is" : "are"} not offered.` : ""}`,
    ),
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", {}, "Connection reference"), h("th", {}, "Connector"), h("th", {}, "Current"), h("th", {}, "Bind to"))),
      h(
        "tbody",
        {},
        ...rows.map((r) => {
          const connector = rowConnector(r, target.key);
          const current = r.cells[target.key]?.connectionId ?? null;
          const options = connectionsFor(conns, connector);
          const sel = h("select", { "aria-label": `Connection for ${r.logicalName}` }) as HTMLSelectElement;
          sel.append(h("option", { value: "" }, options.length ? "— keep current —" : "— no connection of this connector —"));
          for (const c of options)
            sel.append(h("option", { value: c.id }, `${c.displayName}${c.account ? ` · ${c.account}` : ""}${c.status ? ` · ${c.status}` : ""}${c.broken ? " ⚠" : ""}${current && c.id.toLowerCase() === current.toLowerCase() ? " (current)" : ""}`));
          sel.disabled = !options.length;
          picks.set(r.key, sel);
          return h("tr", {}, h("td", { class: "mono" }, r.logicalName), h("td", {}, connector ?? "—"), h("td", { class: "mono" }, current ?? "—"), h("td", {}, sel));
        }),
      ),
    ),
  );
  const ok = await showDialog({ title: "Pick connections", target: targetChip(target), body, okLabel: "Preview bind" });
  if (!ok) return;
  // Picks become a synthetic source column of the target's own org, so planBind's checks apply unchanged.
  const source: ColumnMeta = { key: "picker", kind: "snapshot", name: "Picked connections", url: target.url, environment: target.environment, takenAt: "" };
  const picked = rows
    .map((r) => ({ r, id: picks.get(r.key)?.value ?? "" }))
    .filter((x) => x.id)
    .map(({ r, id }) => {
      const rec = r.cells[target.key]!.record!;
      return { ...r, cells: { ...r.cells, picker: { state: "bound" as const, connector: rec.connector, connectionId: id, record: { ...rec, connectionId: id } } } };
    });
  if (!picked.length) {
    await notify("Nothing picked", "Every reference was left on its current binding.", "info");
    return;
  }
  const broken = picked.filter((x) => conns.find((c) => c.id === x.cells.picker.connectionId)?.broken).map((x) => x.logicalName);
  const plan = planBind(picked, source, target);
  for (const i of plan.items)
    if (broken.includes(i.logicalName) && i.action === "update") i.warning = [i.warning, "the picked connection reports an error status; fix it in the maker portal first"].filter(Boolean).join("; ");
  await runBind(plan);
}

async function runBind(plan: BindPlan): Promise<void> {
  const api = dataverse();
  if (!api) return;
  const writes = plan.items.filter((i) => i.action === "update");
  const invalid = plan.items.filter((i) => i.action === "invalid");
  const restart = $<HTMLInputElement>("#bind-restart").checked;
  const isProd = /prod/i.test(plan.target.environment);
  const table = h(
    "table",
    {},
    h("thead", {}, h("tr", {}, h("th", {}, "Connection reference"), h("th", {}, "Action"), h("th", {}, "Current"), h("th", {}, "New"), h("th", {}, "Note"))),
    h(
      "tbody",
      {},
      ...plan.items.map((i) =>
        h(
          "tr",
          { class: i.action === "skip" ? "is-skip" : undefined },
          h("td", { class: "mono" }, i.logicalName),
          h("td", {}, badge(i.action, i.action === "update" ? "warn" : i.action === "invalid" ? "bad" : "neutral")),
          h("td", { class: "mono" }, i.current ?? "—"),
          h("td", { class: "mono" }, i.action === "skip" ? "—" : (i.next ?? "")),
          h("td", { class: "caption" }, i.reason, i.warning ? h("div", {}, badge("caution", "warn"), " ", i.warning) : null),
        ),
      ),
    ),
  );
  const body = h(
    "div",
    {},
    h(
      "p",
      { class: "caption" },
      `${writes.length} binding${writes.length === 1 ? "" : "s"} from ${plan.source.name} into ${plan.target.name}. ${plan.items.length - writes.length - invalid.length} skipped.${invalid.length ? ` ${invalid.length} invalid (not written).` : ""}${restart && writes.length ? " Flows that are on and use a rebound reference are turned off and on afterwards." : ""}`,
    ),
    plan.source.key === "picker" ? h("p", { class: "caption" }, "Connections picked from the Power Platform API list.") : null,
    writes.length ? h("p", { class: "caption" }, "The current bindings are saved to a backup file first (cancelling the save cancels the bind); undo with Consolidate → Restore from backup…. Flow restarts are not undone.") : null,
    !plan.source.url ? h("p", { class: "caption" }, "Settings file: connection ids are taken as written for this environment. Check the file targets it.") : null,
    isProd && writes.length ? h("div", { class: "warnings" }, "Target is a Production environment.") : null,
    hideSkippedToggle(table, plan.items.length, plan.items.filter((i) => i.action === "skip").length, writes.length),
    table,
  );
  const ok = await showDialog({ title: "Preview bind", target: targetChip(plan.target), body, okLabel: writes.length ? `Bind ${writes.length}` : "", danger: isProd });
  if (!ok || !writes.length) return;
  const cur = await currentConnection(plan.target.target!).catch(() => null);
  if (!sameConnection(plan.stamp, cur)) {
    await notify("Connection changed", `The preview was built for ${plan.target.name} (${plan.target.url}). Nothing written; refresh and preview again.`, "error");
    await refresh();
    return;
  }
  const backup = buildBindBackup(plan, matrix.connRefs);
  if (!(await saveText(bindBackupFileName(plan.target.name), JSON.stringify(backup, null, 2)))) {
    await notify("Backup not saved", "Nothing written: the backup of the current bindings must be saved before binding.", "warning");
    return;
  }
  const res = await applyBind(api, plan, currentConnection, restart, (m) => setStatus(m || null));
  setStatus(null);
  const byName = new Map(plan.items.map((i) => [i.logicalName, i]));
  logRun(
    "bind",
    plan.target,
    res.refs.map((r) => ({ item: r.logicalName, detail: `${byName.get(r.logicalName)?.current ?? "unbound"} → ${byName.get(r.logicalName)?.next ?? ""} (from ${plan.source.name})`, ok: r.ok, error: r.error })),
  );
  logRun("restart flow", plan.target, res.flows.map((f) => ({ item: f.name, detail: "off → on after rebinding", ok: f.ok, error: f.error })));
  await showMergeResults("Bindings written", plan.target, res.flows, { label: "Connection reference", rows: res.refs });
  flowCache = null;
  await refresh();
}

// ---------- exports ----------
function exportCol(): ColumnData | undefined {
  const key = $<HTMLSelectElement>("#export-col").value;
  return okColumns().find((c) => c.meta.key === key);
}
async function exportFile(name: string, content: string, mime = "application/json"): Promise<void> {
  if (await saveText(name, content, mime)) await notify("Exported", name, "success");
}

// ---------- wiring ----------
function wire(): void {
  wireTabs((name) => {
    activeTab = name as typeof activeTab;
    saveView(VIEW, "tab", name === "envvars" ? undefined : name);
    renderTable();
  });
  if (loadView<string>(VIEW, "tab", "envvars") === "connrefs") $<HTMLButtonElement>('.tab[data-tab="connrefs"]').click();
  $("#btn-consolidate").addEventListener("click", () => {
    consolidating = !consolidating;
    renderTable();
  });
  // Columns menu: closes on Escape (focus back on its button) and on a click outside it
  const colMenu = $<HTMLDetailsElement>("#colmenu");
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !colMenu.open) return;
    e.preventDefault();
    colMenu.open = false;
    $("#colmenu-sum").focus();
  });
  document.addEventListener("click", (e) => {
    if (colMenu.open && !colMenu.contains(e.target as Node)) colMenu.open = false;
  });
  // column widths follow the window: which clamped values are cut off may change
  let resizeFrame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => markOverflow($("#matrix-body")));
  });
  $("#btn-merge-preview").addEventListener("click", () => void previewMerge());
  $("#btn-merge-clear").addEventListener("click", () => {
    mergeSel.clear();
    renderTable();
  });
  for (const id of ["#filter-text", "#filter-diff", "#filter-missing", "#filter-absent"]) $(id).addEventListener("input", renderTable);
  $("#view-compact").addEventListener("change", syncCompact);
  syncCompact();
  $("#filter-solution").addEventListener("change", async () => {
    selectedSolution = $<HTMLSelectElement>("#filter-solution").value;
    scope = null;
    setStatus("Loading solution scope…");
    await applySolutionFilter();
    setStatus(null);
    renderHeader();
    renderTable();
  });
  $("#btn-refresh").addEventListener("click", () => void refresh());
  $("#btn-load-snap").addEventListener("click", () => void loadSnapshot());
  $("#btn-runlog").addEventListener("click", () => void openRunLog());
  renderRunLogButton();
  $("#btn-copy").addEventListener("click", () => void copySelected());
  $("#btn-pick").addEventListener("click", () => void pickConnections());
  $("#btn-clear-sel").addEventListener("click", () => {
    if (activeTab === "connrefs") crSelected.clear();
    else selected.clear();
    renderTable();
  });
  $("#btn-export-settings").addEventListener("click", () => {
    const c = exportCol();
    if (c) void exportFile(`deploymentSettings.${safeFileName(c.meta.name)}.json`, deploymentSettings(c, scope));
  });
  $("#btn-export-snap").addEventListener("click", () => {
    const c = exportCol();
    if (c) void exportFile(`matrix-snapshot.${safeFileName(c.meta.name)}.${new Date().toISOString().slice(0, 10)}.json`, snapshot(c));
  });
  $("#btn-export-csv").addEventListener("click", () => void exportFile("envvar-matrix.csv", matrixCsv(matrix), "text/csv"));

  onConnectionChange(() => {
    // An open dialog (set value, preview, results) belongs to the previous connection: close it, never apply it.
    const dlg = $<HTMLDialogElement>("#dlg");
    if (dlg.open) dlg.close();
    void refresh();
  });
  $("#host-mode").textContent = inToolbox() ? "Running inside Power Platform ToolBox" : "Standalone mode (snapshots only)";
}

mountDebug(document.querySelector("footer"), "envvar-matrix");
void initTheme((t) => document.documentElement.setAttribute("data-theme", t));
wire();
void refresh();

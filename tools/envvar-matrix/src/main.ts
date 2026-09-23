import { $, badge, emptyState, h, showDialog, wireTabs } from "../../_shared/dom";
import { dataverse, getConnections, initTheme, inToolbox, notify, onConnectionChange, openText, saveText } from "./host";
import { deploymentSettings, matrixCsv, safeFileName, snapshot } from "./matrix/export";
import { fetchColumn, fetchSolutionScope, fetchSolutions, type SolutionInfo } from "./matrix/fetch";
import { buildMatrix, filterConnRefs, filterEnvVars } from "./matrix/matrix";
import { parseSnapshot } from "./matrix/snapshot";
import type { ColumnData, ColumnMeta, EnvVarRow, Filters, Matrix, Target } from "./matrix/types";
import { applyPlan, connectionChangedMessage, planCopy, planSet, sameConnection, type ConnectionStamp, type WritePlan, type WriteResult } from "./matrix/write";

// ---------- state ----------
let live: ColumnData[] = [];
const snaps: ColumnData[] = [];
let matrix: Matrix = { columns: [], envVars: [], connRefs: [] };
let activeTab: "envvars" | "connrefs" = "envvars";
const selected = new Set<string>();
let solutions: SolutionInfo[] = [];
/** selected solution id ("" = all). Source of truth for the dropdown; `scope` is always derived from it. */
let selectedSolution = "";
let scope: Set<string> | null = null;

const columns = (): ColumnData[] => [...live, ...snaps];
/** columns with data (a live column whose load failed has none) */
const okColumns = (): ColumnData[] => columns().filter((c) => !c.meta.error);
const liveCols = (): ColumnMeta[] => live.filter((c) => !c.meta.error).map((c) => c.meta);

function colChip(meta: ColumnMeta, removable: boolean): HTMLElement {
  const dot = h("span", { class: "dot" });
  if (meta.color) dot.style.background = meta.color;
  const chip = h(
    "span",
    { class: "colchip", title: meta.url },
    dot,
    h("span", { class: "env" }, meta.name),
    h("span", { class: "kind" }, meta.kind === "live" ? `${meta.target} · ${meta.environment}` : `snapshot${meta.takenAt ? ` · ${meta.takenAt.slice(0, 10)}` : ""}`),
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
    scope,
  };
}

// ---------- header + selects ----------
function renderHeader(): void {
  const wrap = $("#columns");
  wrap.replaceChildren();
  if (!columns().length) wrap.append(h("span", { class: "caption" }, inToolbox() ? "No connection. Pick a primary connection in ToolBox." : "Standalone mode: load snapshots to compare."));
  for (const c of columns()) wrap.append(colChip(c.meta, c.meta.kind === "snapshot"));

  const fill = (id: string, metas: ColumnMeta[], keep = true) => {
    const sel = $<HTMLSelectElement>(id);
    const prev = sel.value;
    sel.replaceChildren(...metas.map((m) => h("option", { value: m.key }, `${m.name} (${m.kind === "live" ? m.target : "snapshot"})`)));
    if (keep && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  };
  fill("#export-col", okColumns().map((c) => c.meta));
  fill("#copy-from", okColumns().map((c) => c.meta));
  fill("#copy-to", liveCols());
  const writable = liveCols();
  if (writable.length > 1 && $<HTMLSelectElement>("#copy-to").value === $<HTMLSelectElement>("#copy-from").value) $<HTMLSelectElement>("#copy-to").value = writable[1].key;

  const solSel = $<HTMLSelectElement>("#filter-solution");
  solSel.replaceChildren(h("option", { value: "" }, "all"), ...solutions.map((s) => h("option", { value: s.id }, `${s.friendlyName} ${s.version}${s.isManaged ? " (managed)" : ""}`)));
  // Dropdown and scope stay in sync: a selection that is no longer listed means "all", never an empty scope.
  if (!solutions.some((s) => s.id === selectedSolution)) {
    selectedSolution = "";
    scope = null;
  }
  solSel.value = selectedSolution;
  solSel.disabled = !live.length;

  const canWrite = liveCols().length > 0;
  $("#btn-refresh").toggleAttribute("disabled", !inToolbox());
  for (const id of ["#btn-export-settings", "#btn-export-snap", "#btn-export-csv"]) $(id).toggleAttribute("disabled", !okColumns().length);
  $("#copy-to").toggleAttribute("disabled", !canWrite);
}

// ---------- tables ----------
function colHead(c: ColumnMeta): HTMLElement {
  const th = h("th", { class: "col" }, c.kind === "live" ? c.target! : "snapshot", h("span", { class: "env" }, c.name));
  if (c.error) {
    th.title = c.error;
    th.append(h("span", { class: "col-error" }, badge("load failed", "bad"), h("span", { class: "caption" }, c.error)));
  }
  return th;
}

/** Cell of a live column whose load failed. */
const errorCell = (c: ColumnMeta): HTMLElement => h("td", { class: "cell error", title: c.error ?? "" }, h("span", { class: "val" }, "—"), h("div", { class: "meta" }, badge("error", "bad")));

function envVarTable(rows: EnvVarRow[]): HTMLElement {
  const cols = matrix.columns;
  const head = h(
    "tr",
    {},
    h("th", { class: "sel" }, ""),
    h("th", {}, "Variable"),
    h("th", {}, "Type"),
    ...cols.map(colHead),
  );
  const body = rows.map((r) => {
    const cb = h("input", { type: "checkbox", "aria-label": `Select ${r.schemaName}` }) as HTMLInputElement;
    cb.checked = selected.has(r.key);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(r.key);
      else selected.delete(r.key);
      renderBulkbar();
    });
    return h(
      "tr",
      { class: r.anyMissing || r.anyAbsent ? "missing" : r.differs ? "differs" : undefined },
      h("td", { class: "sel" }, cb),
      h("td", { class: "name" }, h("span", { class: "mono" }, r.schemaName), h("span", { class: "display" }, r.displayName)),
      h("td", {}, badge(r.type, r.isSecret ? "warn" : "neutral")),
      ...cols.map((c) => {
        if (c.error) return errorCell(c);
        const cell = r.cells[c.key];
        const td = h("td", { class: `cell ${cell.source}` });
        if (cell.source === "absent") {
          td.append(h("span", { class: "val" }, "—"), h("div", { class: "meta" }, badge("absent", "neutral")));
          return td;
        }
        td.append(h("span", { class: "val" }, r.isSecret ? "••••••" : (cell.effective ?? "")));
        const dupes = cell.record?.valueCount ?? 0;
        const dupeBadge = dupes > 1 ? badge(`${dupes} value rows`, "bad") : null;
        if (dupeBadge) dupeBadge.title = "More than one environmentvariablevalue row for this definition; the one shown may not be the one the platform uses. Remove the extras.";
        const meta = h("div", { class: "meta" }, badge(cell.source, cell.source === "value" ? "ok" : cell.source === "default" ? "warn" : "bad"), cell.record?.isManaged ? badge("managed", "neutral") : null, dupeBadge);
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
  const head = h("tr", {}, h("th", {}, "Connection reference"), h("th", {}, "Connector"), ...cols.map(colHead));
  const body = rows.map((r) =>
    h(
      "tr",
      { class: r.anyUnbound || r.anyAbsent ? "missing" : r.differs ? "differs" : undefined },
      h("td", { class: "name" }, h("span", { class: "mono" }, r.logicalName), h("span", { class: "display" }, r.displayName)),
      h("td", {}, r.connector ?? "—"),
      ...cols.map((c) => {
        if (c.error) return errorCell(c);
        const cell = r.cells[c.key];
        const td = h("td", { class: `cell ${cell.state}` });
        const otherConnector = cell.connector && r.connector && cell.connector.toLowerCase() !== r.connector.toLowerCase() ? badge(cell.connector, "warn") : null;
        if (otherConnector) otherConnector.title = `Connector differs: ${cell.record?.connectorId ?? cell.connector}`;
        td.append(
          h("span", { class: "val" }, cell.state === "absent" ? "—" : (cell.connectionId ?? "(no connection)")),
          h("div", { class: "meta" }, badge(cell.state, cell.state === "bound" ? "ok" : cell.state === "unbound" ? "bad" : "neutral"), cell.record?.isManaged ? badge("managed", "neutral") : null, otherConnector),
        );
        return td;
      }),
    ),
  );
  return h("table", { class: "matrix" }, h("thead", {}, head), h("tbody", {}, ...body));
}

function renderTable(): void {
  const body = $("#matrix-body");
  body.replaceChildren();
  if (!matrix.columns.length) {
    body.append(emptyState("Nothing to show", inToolbox() ? "Select a primary (and optionally secondary) connection in ToolBox, then Refresh." : "Load one or more snapshot files."));
    return;
  }
  const f = filters();
  if (activeTab === "envvars") {
    const rows = filterEnvVars(matrix.envVars, f);
    body.append(rows.length ? envVarTable(rows) : emptyState("No environment variables match", "Adjust the filters."));
  } else {
    const rows = filterConnRefs(matrix.connRefs, f);
    body.append(rows.length ? connRefTable(rows) : emptyState("No connection references match", "Adjust the filters."));
  }
  renderBulkbar();
}

function renderBulkbar(): void {
  const bar = $("#bulkbar");
  bar.hidden = activeTab !== "envvars" || selected.size === 0 || liveCols().length === 0;
  $("#sel-count").textContent = String(selected.size);
}

function rebuild(): void {
  matrix = buildMatrix(columns());
  for (const k of [...selected]) if (!matrix.envVars.some((r) => r.key === k)) selected.delete(k);
  renderHeader();
  renderTable();
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
    snaps.push(parseSnapshot(f.text, f.name));
    rebuild();
  } catch (e) {
    await notify("Snapshot rejected", `${f.name}: ${(e as Error).message}`, "error");
  }
}

// ---------- dialogs ----------
const targetChip = (m: ColumnMeta): Node => h("span", {}, "Target:", colChip(m, false));

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
          {},
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
    planTable(plan.items),
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
  const rows = matrix.envVars.filter((r) => selected.has(r.key));
  await runPlan(planCopy(rows, fromKey, target));
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
    renderTable();
  });
  for (const id of ["#filter-text", "#filter-diff", "#filter-missing"]) $(id).addEventListener("input", renderTable);
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
  $("#btn-copy").addEventListener("click", () => void copySelected());
  $("#btn-clear-sel").addEventListener("click", () => {
    selected.clear();
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

void initTheme((t) => document.documentElement.setAttribute("data-theme", t));
wire();
void refresh();

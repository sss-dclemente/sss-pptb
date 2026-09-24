import { $, badge, card, emptyState, h, showDialog, wireTabs } from "../../_shared/dom";
import { dataverse, getConnections, initTheme, inToolbox, notify, onConnectionChange, openText, powerplatform, saveText } from "./host";
import { deploymentSettings, matrixCsv, safeFileName, snapshot } from "./matrix/export";
import { fetchColumn, fetchSolutionScope, fetchSolutions, type SolutionInfo } from "./matrix/fetch";
import { buildMatrix, filterConnRefs, filterEnvVars } from "./matrix/matrix";
import {
  applyMerge,
  addRefsToSolution,
  applyRestore,
  buildMergeBackup,
  connectorGroups,
  fetchFlows,
  fetchSolutionFlowIds,
  markDependents,
  mergeBackupFileName,
  parseMergeBackup,
  planCleanup,
  planMerge,
  planRestore,
  solutionFit,
  unusedConnRefs,
  usageByConnRef,
  type DeleteResult,
  type FlowRecord,
  type FlowResult,
  type MergePlan,
  type MergeSpec,
  type PlannedFlow,
} from "./matrix/consolidate";
import { applyBind, planBind, type BindPlan } from "./matrix/bind";
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
/** flow ids of the selected solution (solution fit check), stamped with solution + org */
let fitCache: { solutionId: string; url: string; flowIds: Set<string> } | null = null;
let fitLoading: Promise<void> | null = null;

const columns = (): ColumnData[] => [...live, ...snaps];
/** label of a non-live column: deploymentSettings file or snapshot */
const fileKind = (m: ColumnMeta): string => (m.key.startsWith("settings:") ? "settings" : "snapshot");
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
    sel.replaceChildren(...metas.map((m) => h("option", { value: m.key }, `${m.name} (${m.kind === "live" ? m.target : fileKind(m)})`)));
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
  const th = h("th", { class: "col" }, c.kind === "live" ? c.target! : fileKind(c), h("span", { class: "env" }, c.name));
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
  const head = h("tr", {}, h("th", { class: "sel" }, ""), h("th", {}, "Connection reference"), h("th", {}, "Connector"), ...cols.map(colHead));
  const body = rows.map((r) => {
    const cb = h("input", { type: "checkbox", "aria-label": `Select ${r.logicalName}` }) as HTMLInputElement;
    cb.checked = crSelected.has(r.key);
    cb.addEventListener("change", () => {
      if (cb.checked) crSelected.add(r.key);
      else crSelected.delete(r.key);
      renderBulkbar();
    });
    return h(
      "tr",
      { class: r.anyUnbound || r.anyAbsent ? "missing" : r.differs ? "differs" : undefined },
      h("td", { class: "sel" }, cb),
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
    );
  });
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
  if (activeTab === "connrefs" && consolidating) {
    renderConsolidate(body, f);
    renderBulkbar();
    return;
  }
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
  const bind = activeTab === "connrefs";
  const n = bind ? crSelected.size : selected.size;
  bar.hidden = (bind && consolidating) || n === 0 || liveCols().length === 0;
  $("#sel-count").textContent = String(n);
  $("#btn-copy").textContent = bind ? "Preview bind…" : "Preview copy…";
  $("#bind-restart-wrap").hidden = !bind;
  $("#btn-pick").hidden = !bind;
  const cons = $("#btn-consolidate");
  cons.hidden = activeTab !== "connrefs";
  cons.textContent = consolidating ? "Back to matrix" : "Consolidate…";
  cons.toggleAttribute("disabled", !consolidating && !liveCols().length);
  renderMergebar();
}

function rebuild(): void {
  matrix = buildMatrix(columns());
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
  rescan.addEventListener("click", () => void scanFlows());
  const restore = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Restore from backup…");
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
    wrap.append(card(`${g.connector} · ${g.refs.length} references`, table, all));
  }
  wrap.append(cleanupCard(col, unusedConnRefs(refs, usage)));
  body.append(wrap);
}

function cleanupCard(col: ColumnData, unused: ConnRefRecord[]): HTMLElement {
  if (!unused.length) return card("Unused connection references", emptyState("None", "Every connection reference is used by at least one cloud flow (within the current filters)."));
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
  const actions = h("span", { style: "display:inline-flex; gap: var(--s-2); margin-left:auto" });
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
  return card(`Unused connection references · ${unused.length}`, table, actions);
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
  await runMergePlan(col, plan, `${cleanupSummary(plan.deletes.filter((d) => d.action === "delete").length)} in ${col.meta.name}. A backup is saved first; Restore from backup recreates them.`);
  cleanupSel.clear();
}

/** Solution of the fit check: the solution filter, when it is set and the view works on the primary. */
function fitSolution(col: ColumnData): SolutionInfo | null {
  if (!selectedSolution || !scope || col.meta.target !== "primary") return null;
  return solutions.find((x) => x.id === selectedSolution) ?? null;
}

function loadFit(col: ColumnData, sol: SolutionInfo): void {
  const api = dataverse();
  if (!api || fitLoading) return;
  fitLoading = (async () => {
    try {
      const flowIds = await fetchSolutionFlowIds(api, "primary", sol.id);
      fitCache = { solutionId: sol.id, url: col.meta.url, flowIds };
    } catch (e) {
      fitCache = null;
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
  if (!fitCache || fitCache.solutionId !== sol.id || fitCache.url !== col.meta.url) {
    loadFit(col, sol);
    return card(`Solution check · ${sol.friendlyName}`, h("p", { class: "caption" }, "Reading the solution's cloud flows…"));
  }
  const issues = solutionFit(flows, fitCache.flowIds, col.connRefs, scope!);
  const title = `Solution check · ${sol.friendlyName}`;
  if (!issues.length)
    return card(title, h("p", { class: "caption" }, `All connection references used by the solution's ${fitCache.flowIds.size} cloud flow${fitCache.flowIds.size === 1 ? "" : "s"} are in the solution.`));
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
    h("p", { class: "caption" }, `AddSolutionComponent into ${sol.friendlyName} (${sol.uniqueName}), without required components:`),
    h("ul", {}, ...refs.map((r) => h("li", { class: "mono" }, r.logicalName))),
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
  const summary = `${specs.map((s) => `${s.sources.join(", ")} → ${s.target}`).join(" · ")}. ${plan.flows.filter((f) => f.action === "update").length} flows to update in ${col.meta.name}; ${plan.deletes.filter((d) => d.action === "delete").length} references to delete. A backup of every touched flow is saved first.`;
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
  await showMergeResults(plan.specs.length ? "Merge applied" : "Cleanup applied", col.meta, res.flows, { label: "Deleted reference", rows: res.deletes });
  flowCache = null;
  await refresh();
}

async function restoreFromBackup(): Promise<void> {
  const col = consColumn();
  const api = dataverse();
  if (!col || !api) return;
  const file = await openText({ title: "Open connection reference merge backup", extensions: ["json"] });
  if (!file) return;
  let plan;
  try {
    const b = parseMergeBackup(file.text);
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
  const body = h(
    "div",
    {},
    h(
      "p",
      { class: "caption" },
      `${writes.length} binding${writes.length === 1 ? "" : "s"} from ${plan.source.name} into ${plan.target.name}. ${plan.items.length - writes.length - invalid.length} skipped.${invalid.length ? ` ${invalid.length} invalid (not written).` : ""}${restart && writes.length ? " Flows that are on and use a rebound reference are turned off and on afterwards." : ""}`,
    ),
    plan.source.key === "picker" ? h("p", { class: "caption" }, "Connections picked from the Power Platform API list.") : null,
    !plan.source.url ? h("p", { class: "caption" }, "Settings file: connection ids are taken as written for this environment. Check the file targets it.") : null,
    isProd && writes.length ? h("div", { class: "warnings" }, "Target is a Production environment.") : null,
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", {}, "Connection reference"), h("th", {}, "Action"), h("th", {}, "Current"), h("th", {}, "New"), h("th", {}, "Note"))),
      h(
        "tbody",
        {},
        ...plan.items.map((i) =>
          h(
            "tr",
            {},
            h("td", { class: "mono" }, i.logicalName),
            h("td", {}, badge(i.action, i.action === "update" ? "warn" : i.action === "invalid" ? "bad" : "neutral")),
            h("td", { class: "mono" }, i.current ?? "—"),
            h("td", { class: "mono" }, i.action === "skip" ? "—" : (i.next ?? "")),
            h("td", { class: "caption" }, i.reason, i.warning ? h("div", {}, badge("caution", "warn"), " ", i.warning) : null),
          ),
        ),
      ),
    ),
  );
  const ok = await showDialog({ title: "Preview bind", target: targetChip(plan.target), body, okLabel: writes.length ? `Bind ${writes.length}` : "", danger: isProd });
  if (!ok || !writes.length) return;
  const cur = await currentConnection(plan.target.target!).catch(() => null);
  if (!sameConnection(plan.stamp, cur)) {
    await notify("Connection changed", `The preview was built for ${plan.target.name} (${plan.target.url}). Nothing written; refresh and preview again.`, "error");
    await refresh();
    return;
  }
  const res = await applyBind(api, plan, currentConnection, restart, (m) => setStatus(m || null));
  setStatus(null);
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
    renderTable();
  });
  $("#btn-consolidate").addEventListener("click", () => {
    consolidating = !consolidating;
    renderTable();
  });
  $("#btn-merge-preview").addEventListener("click", () => void previewMerge());
  $("#btn-merge-clear").addEventListener("click", () => {
    mergeSel.clear();
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

void initTheme((t) => document.documentElement.setAttribute("data-theme", t));
wire();
void refresh();

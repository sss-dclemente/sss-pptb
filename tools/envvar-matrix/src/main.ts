import { dataverse, getConnections, initTheme, inToolbox, notify, onConnectionChange, openText, saveText } from "./host";
import { deploymentSettings, matrixCsv, safeFileName, snapshot } from "./matrix/export";
import { fetchColumn, fetchSolutionScope, fetchSolutions, type SolutionInfo } from "./matrix/fetch";
import { buildMatrix, filterConnRefs, filterEnvVars } from "./matrix/matrix";
import { parseSnapshot } from "./matrix/snapshot";
import type { ColumnData, ColumnMeta, EnvVarRow, Filters, Matrix } from "./matrix/types";
import { applyPlan, planCopy, planSet, type WritePlan, type WriteResult } from "./matrix/write";

// ---------- state ----------
let live: ColumnData[] = [];
const snaps: ColumnData[] = [];
let matrix: Matrix = { columns: [], envVars: [], connRefs: [] };
let activeTab: "envvars" | "connrefs" = "envvars";
const selected = new Set<string>();
let solutions: SolutionInfo[] = [];
let scope: Set<string> | null = null;

const columns = (): ColumnData[] => [...live, ...snaps];
const liveCols = (): ColumnMeta[] => live.map((c) => c.meta);

// ---------- DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}
const badge = (text: string, kind: "" | "ok" | "warn" | "bad" | "neutral" = ""): HTMLElement => h("span", { class: `badge${kind ? ` badge-${kind}` : ""}` }, text);
const emptyState = (title: string, hint: string): HTMLElement => h("div", { class: "empty-state" }, h("strong", {}, title), hint);

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
  fill("#export-col", columns().map((c) => c.meta));
  fill("#copy-from", columns().map((c) => c.meta));
  fill("#copy-to", liveCols());
  if (live.length > 1 && $<HTMLSelectElement>("#copy-to").value === $<HTMLSelectElement>("#copy-from").value) $<HTMLSelectElement>("#copy-to").value = live[1].meta.key;

  const solSel = $<HTMLSelectElement>("#filter-solution");
  const prev = solSel.value;
  solSel.replaceChildren(h("option", { value: "" }, "all"), ...solutions.map((s) => h("option", { value: s.id }, `${s.friendlyName} ${s.version}${s.isManaged ? " (managed)" : ""}`)));
  if ([...solSel.options].some((o) => o.value === prev)) solSel.value = prev;
  solSel.disabled = !live.length;

  const canWrite = live.length > 0;
  $("#btn-refresh").toggleAttribute("disabled", !inToolbox());
  for (const id of ["#btn-export-settings", "#btn-export-snap", "#btn-export-csv"]) $(id).toggleAttribute("disabled", !columns().length);
  $("#copy-to").toggleAttribute("disabled", !canWrite);
}

// ---------- tables ----------
function envVarTable(rows: EnvVarRow[]): HTMLElement {
  const cols = matrix.columns;
  const head = h(
    "tr",
    {},
    h("th", { class: "sel" }, ""),
    h("th", {}, "Variable"),
    h("th", {}, "Type"),
    ...cols.map((c) => h("th", { class: "col" }, c.kind === "live" ? c.target! : "snapshot", h("span", { class: "env" }, c.name))),
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
        const cell = r.cells[c.key];
        const td = h("td", { class: `cell ${cell.source}` });
        if (cell.source === "absent") {
          td.append(h("span", { class: "val" }, "—"), h("div", { class: "meta" }, badge("absent", "neutral")));
          return td;
        }
        td.append(h("span", { class: "val" }, r.isSecret ? "••••••" : (cell.effective ?? "")));
        const meta = h("div", { class: "meta" }, badge(cell.source, cell.source === "value" ? "ok" : cell.source === "default" ? "warn" : "bad"), cell.record?.isManaged ? badge("managed", "neutral") : null);
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
  const head = h("tr", {}, h("th", {}, "Connection reference"), h("th", {}, "Connector"), ...cols.map((c) => h("th", { class: "col" }, c.kind === "live" ? c.target! : "snapshot", h("span", { class: "env" }, c.name))));
  const body = rows.map((r) =>
    h(
      "tr",
      { class: r.anyUnbound || r.anyAbsent ? "missing" : r.differs ? "differs" : undefined },
      h("td", { class: "name" }, h("span", { class: "mono" }, r.logicalName), h("span", { class: "display" }, r.displayName)),
      h("td", {}, r.connector ?? "—"),
      ...cols.map((c) => {
        const cell = r.cells[c.key];
        const td = h("td", { class: `cell ${cell.state}` });
        td.append(
          h("span", { class: "val" }, cell.state === "absent" ? "—" : (cell.connectionId ?? "(no connection)")),
          h("div", { class: "meta" }, badge(cell.state, cell.state === "bound" ? "ok" : cell.state === "unbound" ? "bad" : "neutral"), cell.record?.isManaged ? badge("managed", "neutral") : null),
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
  bar.hidden = activeTab !== "envvars" || selected.size === 0 || live.length === 0;
  $("#sel-count").textContent = String(selected.size);
}

function rebuild(): void {
  matrix = buildMatrix(columns());
  for (const k of [...selected]) if (!matrix.envVars.some((r) => r.key === k)) selected.delete(k);
  renderHeader();
  renderTable();
}

// ---------- data loading ----------
async function refresh(): Promise<void> {
  const api = dataverse();
  const conns = await getConnections();
  if (!api || !conns.length) {
    live = [];
    solutions = [];
    scope = null;
    rebuild();
    return;
  }
  setStatus("Loading…");
  try {
    live = await Promise.all(
      conns.map((c) =>
        fetchColumn(api, {
          key: c.target,
          kind: "live",
          target: c.target,
          name: c.conn.name,
          url: c.conn.url,
          environment: c.conn.environment,
          color: c.conn.environmentColor,
          takenAt: "",
        }),
      ),
    );
    solutions = await fetchSolutions(api, "primary").catch(() => []);
    await applySolutionFilter();
    setStatus(null);
  } catch (e) {
    setStatus(null);
    await notify("Load failed", (e as Error).message, "error");
  }
  rebuild();
}

async function applySolutionFilter(): Promise<void> {
  const id = $<HTMLSelectElement>("#filter-solution").value;
  const api = dataverse();
  const primary = live.find((c) => c.meta.target === "primary");
  if (!id || !api || !primary) {
    scope = null;
    return;
  }
  try {
    scope = await fetchSolutionScope(api, "primary", id, primary);
  } catch (e) {
    scope = null;
    await notify("Solution filter failed", (e as Error).message, "warning");
  }
}

async function loadSnapshot(): Promise<void> {
  const f = await openText();
  if (!f) return;
  try {
    snaps.push(parseSnapshot(f.text, f.name));
    rebuild();
  } catch (e) {
    await notify("Snapshot rejected", `${f.name}: ${(e as Error).message}`, "error");
  }
}

// ---------- dialogs ----------
function showDialog(title: string, target: ColumnMeta | null, body: Node, okLabel: string, danger: boolean): Promise<boolean> {
  const dlg = $<HTMLDialogElement>("#dlg");
  $("#dlg-title").textContent = title;
  const t = $("#dlg-target");
  t.replaceChildren();
  if (target) t.append("Target:", colChip(target, false));
  $("#dlg-body").replaceChildren(body);
  const ok = $<HTMLButtonElement>("#dlg-ok");
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? "btn-danger" : "btn-primary"}`;
  ok.style.flex = "none";
  ok.hidden = !okLabel;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      ok.onclick = null;
      $("#dlg-cancel").onclick = null;
      dlg.onclose = null;
      // The close event fires asynchronously; resolve only after it so a dialog opened
      // by the caller right away is not closed by this one's stale close event.
      if (dlg.open) {
        dlg.addEventListener("close", () => resolve(v), { once: true });
        dlg.close();
      } else resolve(v);
    };
    ok.onclick = () => done(true);
    $("#dlg-cancel").onclick = () => done(false);
    dlg.onclose = () => done(false);
    dlg.showModal();
  });
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
          {},
          h("td", {}, h("span", { class: "mono" }, i.schemaName)),
          h("td", {}, badge(i.action, i.action === "skip" ? "neutral" : i.action === "create" ? "ok" : "warn")),
          h("td", { class: "mono" }, `${i.currentValue ?? "—"} `, badge(i.currentSource, "neutral")),
          h("td", { class: "mono" }, i.action === "skip" ? "—" : (i.newValue ?? "")),
          h("td", { class: "caption" }, i.reason),
        ),
      ),
    ),
  );
}

async function runPlan(plan: WritePlan): Promise<void> {
  const writes = plan.items.filter((i) => i.action !== "skip");
  const isProd = /prod/i.test(plan.target.environment);
  const body = h(
    "div",
    {},
    h("p", { class: "caption" }, `${writes.length} write${writes.length === 1 ? "" : "s"} to ${plan.target.name} (${plan.target.environment}). ${plan.items.length - writes.length} skipped.`),
    isProd && writes.length ? h("div", { class: "warnings" }, "Target is a Production environment.") : null,
    planTable(plan.items),
  );
  const ok = await showDialog("Preview changes", plan.target, body, writes.length ? `Apply ${writes.length}` : "", isProd);
  if (!ok || !writes.length) return;
  const api = dataverse();
  if (!api) return;
  setStatus("Writing…");
  const results = await applyPlan(api, plan);
  setStatus(null);
  await showResults(results, plan.target);
  await refresh();
}

async function showResults(results: WriteResult[], target: ColumnMeta): Promise<void> {
  const failed = results.filter((r) => !r.ok);
  const body = h(
    "table",
    {},
    h("thead", {}, h("tr", {}, h("th", {}, "Variable"), h("th", {}, "Action"), h("th", {}, "Result"))),
    h(
      "tbody",
      {},
      ...results.map((r) => h("tr", {}, h("td", {}, h("span", { class: "mono" }, r.schemaName)), h("td", {}, r.action), h("td", {}, r.action === "skip" ? badge("skipped", "neutral") : r.ok ? badge("ok", "ok") : badge(r.error ?? "failed", "bad")))),
    ),
  );
  await notify(failed.length ? "Some writes failed" : "Values written", `${results.length - failed.length - results.filter((r) => r.action === "skip").length} ok, ${failed.length} failed`, failed.length ? "warning" : "success");
  await showDialog("Results", target, body, "", false);
}

async function openSetDialog(row: EnvVarRow, target: ColumnMeta): Promise<void> {
  const current = row.cells[target.key];
  const input = h("textarea", { rows: "4", "aria-label": "New value" }) as HTMLTextAreaElement;
  input.value = current.effective ?? "";
  const body = h("div", {}, h("p", {}, h("span", { class: "mono" }, row.schemaName), " ", badge(row.type, "neutral"), " ", h("span", { class: "caption" }, `current: ${current.source}`)), input);
  const ok = await showDialog("Set value", target, body, "Preview", false);
  if (!ok) return;
  await runPlan(planSet(row, target, input.value));
}

async function copySelected(): Promise<void> {
  const fromKey = $<HTMLSelectElement>("#copy-from").value;
  const toKey = $<HTMLSelectElement>("#copy-to").value;
  const target = live.find((c) => c.meta.key === toKey)?.meta;
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
  return columns().find((c) => c.meta.key === key);
}
async function exportFile(name: string, content: string, mime = "application/json"): Promise<void> {
  if (await saveText(name, content, mime)) await notify("Exported", name, "success");
}

// ---------- wiring ----------
function wire(): void {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) =>
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab as typeof activeTab;
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === btn));
      renderTable();
    }),
  );
  for (const id of ["#filter-text", "#filter-diff", "#filter-missing"]) $(id).addEventListener("input", renderTable);
  $("#filter-solution").addEventListener("change", async () => {
    setStatus("Loading solution scope…");
    await applySolutionFilter();
    setStatus(null);
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
    if (c) void exportFile(`deploymentSettings.${safeFileName(c.meta.name)}.json`, deploymentSettings(c));
  });
  $("#btn-export-snap").addEventListener("click", () => {
    const c = exportCol();
    if (c) void exportFile(`matrix-snapshot.${safeFileName(c.meta.name)}.${new Date().toISOString().slice(0, 10)}.json`, snapshot(c));
  });
  $("#btn-export-csv").addEventListener("click", () => void exportFile("envvar-matrix.csv", matrixCsv(matrix), "text/csv"));

  onConnectionChange(() => void refresh());
  $("#host-mode").textContent = inToolbox() ? "Running inside Power Platform ToolBox" : "Standalone mode (snapshots only)";
}

void initTheme((t) => document.documentElement.setAttribute("data-theme", t));
wire();
void refresh();

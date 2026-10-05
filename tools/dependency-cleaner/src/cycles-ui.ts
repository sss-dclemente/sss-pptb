/** "Cycles" tab: docs/CYCLES-PLAN.md. Several unmanaged solutions, the cycles between them, fixes through a base solution. */
import { $, badge, emptyState, foldAllButtons, foldCard, h, type Child } from "../../_shared/dom";
import { persistControls, type PersistedControls } from "../../_shared/view-state";
import { backupFileName } from "./deps/backup";
import { ACTIVE_SOLUTION_ID, analyzeCycles, buildCyclesBackup, cycleOpLabel, cyclesCsv, cyclesMarkdown, executeCycles, parseCyclesBackup, planCycles, undoOps, type CycleOp, type CycleOpResult, type CyclePlan, type CyclesAnalysis, type FixChoice, type FixKind, type FixRow } from "./deps/cycles";
import { Cancelled } from "./deps/diagnose";
import { csvCell } from "./deps/export";
import { fetchSolutionManaged, MetaCache, type DataverseLike, type DependencyRow } from "./deps/fetch";
import { typeName, type SolutionInfo } from "./deps/types";
import { errorList } from "./error-list";
import { notify, openText, saveText, type LiveConnection } from "./host";

export interface CyclesContext {
  api: () => DataverseLike | undefined;
  primary: () => LiveConnection | undefined;
  currentPrimary: () => Promise<LiveConnection | undefined>;
  devSolutions: () => SolutionInfo[];
  reqCache: () => Map<string, DependencyRow[]>;
  isProd: (c: LiveConnection | undefined) => boolean;
  sameUrl: (a: string | null | undefined, b: string | null | undefined) => boolean;
  setStatus: (msg: string | null) => void;
}

let ctx: CyclesContext;
let analysis: CyclesAnalysis | null = null;
const choices = new Map<string, FixChoice>();
const orphanToBase = new Set<string>();
let plan: CyclePlan | null = null;
let planConn: { id: string; url: string } | null = null;
let backupDone = false;
let running = false;
let applying = false;
let cancelFlag = false;
let gen = 0;
let meta = new MetaCache();
/** solution ids ticked in the picker, kept across re-renders */
const picked = new Set<string>();
let ctl: PersistedControls;

const SYSTEM = new Set(["default", "active", "basic"]);
const key = (type: number, id: string): string => `${type}:${id}`;

function clearPlan(): void {
  plan = null;
  planConn = null;
  backupDone = false;
}

function pickable(): SolutionInfo[] {
  return ctx.devSolutions().filter((x) => !x.isManaged && !SYSTEM.has(x.uniqueName.toLowerCase()));
}

/** Connections changed: drop everything read from the previous one and refill the pickers. */
export function cyclesOnConnections(changed: boolean): void {
  if (changed) {
    gen++;
    analysis = null;
    choices.clear();
    orphanToBase.clear();
    picked.clear();
    clearPlan();
    meta = new MetaCache();
    $("#cy-results").replaceChildren();
  }
  const list = pickable();
  const wrap = $("#cy-solutions");
  wrap.replaceChildren(
    ...(list.length
      ? list.map((s) => {
          const box = h("input", { type: "checkbox", value: s.id }) as HTMLInputElement;
          box.checked = picked.has(s.id);
          box.addEventListener("change", () => {
            if (box.checked) picked.add(s.id);
            else picked.delete(s.id);
            updateRun();
          });
          return h("label", { class: "check" }, box, `${s.friendlyName} (${s.uniqueName}) ${s.version}`);
        })
      : [h("span", { class: "caption" }, ctx.primary() ? "No unmanaged solutions" : "No connection")]),
  );
  const base = $<HTMLSelectElement>("#cy-base");
  const prev = base.value;
  base.replaceChildren(h("option", { value: "" }, "— none (report only) —"), ...list.map((s) => h("option", { value: s.id }, `${s.friendlyName} (${s.uniqueName})`)));
  if ([...base.options].some((o) => o.value === prev)) base.value = prev;
  else ctl.restore(); // the saved base, now that its option exists
  updateRun();
  render();
}

function updateRun(): void {
  $("#cy-picked").textContent = `${picked.size} selected`;
  $<HTMLButtonElement>("#cy-run").disabled = picked.size < 2;
}

async function run(): Promise<void> {
  const a = ctx.api();
  const p = ctx.primary();
  const sols = ctx.devSolutions().filter((s) => picked.has(s.id));
  const base = ctx.devSolutions().find((s) => s.id === $<HTMLSelectElement>("#cy-base").value) ?? null;
  if (!a || !p || sols.length < 2 || running) return;
  running = true;
  cancelFlag = false;
  const g = gen;
  $("#cy-cancel").hidden = false;
  $<HTMLButtonElement>("#cy-run").disabled = true;
  $("#cy-progress").hidden = false;
  const bar = $<HTMLProgressElement>("#cy-progress-bar");
  try {
    const r = await analyzeCycles({
      api: a,
      meta,
      reqCache: ctx.reqCache(),
      solutions: sols,
      base,
      allSolutions: ctx.devSolutions(),
      environment: { name: p.conn.name, url: p.conn.url },
      onProgress: (phase, done, total) => {
        bar.max = Math.max(total, 1);
        bar.value = done;
        $("#cy-progress-text").textContent = total > 1 ? `${phase} ${done} / ${total}` : `${phase}…`;
      },
      cancelled: () => cancelFlag,
    });
    if (g !== gen) return;
    analysis = r;
    clearPlan();
    for (const k of [...choices.keys()]) if (!r.fixRows.some((x) => x.key === k)) choices.delete(k);
    for (const k of [...orphanToBase]) if (!r.orphans.some((x) => key(x.required.type, x.required.id) === k)) orphanToBase.delete(k);
    // defaults: every cycle edge → base (when there is one); every orphan → base
    if (!r.base) {
      for (const [k, c] of [...choices]) if (c.kind === "base") choices.delete(k);
      orphanToBase.clear();
    }
    if (r.base) {
      for (const row of r.fixRows) if (row.inCycle && !choices.has(row.key)) choices.set(row.key, { kind: "base" });
      for (const o of r.orphans) orphanToBase.add(key(o.required.type, o.required.id));
    }
  } catch (e) {
    if (e instanceof Cancelled) await notify("Cancelled", "Analysis cancelled. Finished calls stay cached.", "info");
    else await notify("Analysis failed", (e as Error).message, "error");
  } finally {
    running = false;
    $("#cy-cancel").hidden = true;
    updateRun();
    $("#cy-progress").hidden = true;
  }
  render();
}

// ---------- render ----------

const solName = (id: string): string => [...(analysis?.solutions ?? []), ...(analysis?.base ? [analysis.base] : [])].find((s) => s.id === id)?.uniqueName ?? id;
const cLabel = (c: { type: number; name: string; table?: string }): string => `${typeName(c.type)} ${c.name}${c.table && c.table !== c.name ? ` (${c.table})` : ""}`;

function fixRowEl(r: FixRow): HTMLElement {
  const a = analysis!;
  const sel = h("select", { class: "fix", "aria-label": `Fix for ${r.required.name}` }) as HTMLSelectElement;
  const opts: [FixKind, string, boolean][] = [
    ["none", "No action", true],
    ["base", a.base ? `Add to base ${a.base.uniqueName}` : "Add to base (pick a base solution)", !!a.base],
    ["copy", `Copy into ${solName(r.from)}`, true],
    ["move", `Move ${r.dependents.length === 1 ? "the dependent" : `${r.dependents.length} dependents`} to ${solName(r.to)}`, r.movable],
  ];
  sel.append(...opts.map(([v, label, enabled]) => h("option", { value: v, disabled: !enabled }, label)));
  const cur = choices.get(r.key)?.kind ?? "none";
  sel.value = cur;
  const alsoBox = h("input", { type: "checkbox" }) as HTMLInputElement;
  alsoBox.checked = !!choices.get(r.key)?.alsoRemove;
  const alsoWrap = h("label", { class: "check cy-also", title: r.required.rootInTo ? `Remove it from ${solName(r.to)} after adding it to the base (move instead of copy)` : `Included by its table in ${solName(r.to)}: cannot leave alone` }, alsoBox, ` also remove from ${solName(r.to)}`);
  alsoWrap.hidden = cur !== "base";
  alsoBox.disabled = !r.required.rootInTo;
  const onChange = () => {
    const kind = sel.value as FixKind;
    if (kind === "none") choices.delete(r.key);
    else choices.set(r.key, { kind, alsoRemove: kind === "base" && alsoBox.checked });
    alsoWrap.hidden = kind !== "base";
    clearPlan();
    renderSelection();
    renderPlan();
  };
  sel.addEventListener("change", onChange);
  alsoBox.addEventListener("change", onChange);
  return h(
    "li",
    { class: "finding cy-row", "data-key": r.key, "data-cycle": String(r.inCycle) },
    h("div", { class: "head" }, badge(solName(r.from), r.inCycle ? "bad" : "neutral"), h("span", { class: "caption" }, "needs"), badge(typeName(r.required.type), "neutral"), h("span", { class: "name mono" }, r.required.name), r.required.table && r.required.table !== r.required.name ? h("span", { class: "caption" }, r.required.table) : null, h("span", { class: "caption" }, "from"), badge(solName(r.to), r.inCycle ? "bad" : "neutral"), sel, alsoWrap),
    h("div", { class: "cause" }, `Needed by ${r.dependents.map(cLabel).join(", ")}`),
  );
}

function orphanEl(o: CyclesAnalysis["orphans"][number]): HTMLElement {
  const k = key(o.required.type, o.required.id);
  const box = h("input", { type: "checkbox", "aria-label": `Add ${o.required.name} to the base` }) as HTMLInputElement;
  box.checked = orphanToBase.has(k);
  box.disabled = !analysis?.base;
  box.addEventListener("change", () => {
    if (box.checked) orphanToBase.add(k);
    else orphanToBase.delete(k);
    clearPlan();
    renderSelection();
    renderPlan();
  });
  return h(
    "li",
    { class: "finding cy-orphan", "data-key": k },
    h("div", { class: "head" }, h("label", { class: "check" }, box, analysis?.base ? ` add to ${analysis.base.uniqueName}` : " (no base)"), badge(typeName(o.required.type), "neutral"), h("span", { class: "name mono" }, o.required.name), o.required.table && o.required.table !== o.required.name ? h("span", { class: "caption" }, o.required.table) : null),
    h("div", { class: "cause" }, `Needed by ${o.dependents.map((d) => `${solName(d.solution)}: ${cLabel(d.component)}`).join(", ")}; carried by no selected solution`),
  );
}

function orderLine(order: string[] | null, cycles: string[][], base: SolutionInfo | null, id: string): HTMLElement {
  if (order) {
    const list = [...(base && !order.includes(base.id) ? [base.uniqueName] : []), ...order.map(solName)];
    return h("div", { class: "summary", id }, h("strong", {}, "Import order:"), ...list.flatMap((n, i) => [i ? h("span", { class: "caption" }, "→") : null, badge(n, "ok")]));
  }
  return h("div", { class: "summary", id }, h("strong", {}, "No import order:"), ...cycles.map((c) => badge(c.map(solName).join(" ⇄ "), "bad")));
}

function render(): void {
  const sum = $("#cy-summary");
  const body = $("#cy-body");
  sum.replaceChildren();
  body.replaceChildren();
  $("#cy-actions").hidden = !analysis;
  for (const id of ["#cy-export-md", "#cy-export-csv"]) $(id).toggleAttribute("disabled", !analysis);
  if (!ctx.primary()) {
    body.append(emptyState("No connection", "Pick the Dev environment as the primary connection in ToolBox."));
    renderPlan();
    return;
  }
  if (!analysis) {
    body.append(emptyState("No analysis yet", "Tick two or more unmanaged solutions, pick the base solution that is always imported first, and Analyze. Reads only; nothing is written until you confirm."));
    renderPlan();
    return;
  }
  const a = analysis;
  const cycleRows = a.fixRows.filter((r) => r.inCycle);
  const otherRows = a.fixRows.filter((r) => !r.inCycle);
  sum.append(
    h(
      "div",
      { class: "summary", id: "cy-counts" },
      h("strong", {}, `${a.solutions.length} solutions · base ${a.base?.uniqueName ?? "none"}`),
      badge(`${a.cycles.length} cycle${a.cycles.length === 1 ? "" : "s"}`, a.cycles.length ? "bad" : "ok"),
      badge(`${a.edges.length} cross-solution edge${a.edges.length === 1 ? "" : "s"}`, "neutral"),
      badge(`${a.orphans.length} orphan${a.orphans.length === 1 ? "" : "s"}`, a.orphans.length ? "warn" : "neutral"),
      badge(`${a.viaBase} via base`, "neutral"),
      badge(`${a.managedRequired} managed`, "neutral", "required components from managed solutions: see Diagnose"),
    ),
    orderLine(a.order, a.cycles, a.base, "cy-order"),
  );
  for (const w of a.warnings) sum.append(h("div", { class: "warnings" }, w));
  if (a.errors.length) sum.append(errorList(`RetrieveRequiredComponents failed for ${a.errors.length} component(s)`, a.errors, "cy-errors"));
  const folds: HTMLElement[] = [];
  const section = (id: string, title: string, rows: Child[], hint: string, open: boolean) => {
    if (!rows.length) return;
    const el = foldCard(title, rows.length, h("div", { class: "ub-section" }, h("p", { class: "caption" }, hint), h("ul", { class: "findings" }, ...rows)), open, { key: `cy:${id}` });
    el.id = `cy-${id}`;
    folds.push(el);
  };
  section("cycles", "Cycle edges", cycleRows.map(fixRowEl), "Each row is one component a solution needs from another inside a cycle. Pick a fix per row; adding to the base solution (imported first) is the default.", true);
  section("orphans", "Required, carried by no selected solution", a.orphans.map(orphanEl), "Unmanaged components a selected solution needs that none of them ships: the export reports them as missing dependencies. Tick to add them to the base.", true);
  section("edges", "Cross-solution dependencies outside cycles", otherRows.map(fixRowEl), "Fine as long as the import order is kept. A fix here is optional.", false);
  if (!cycleRows.length && !a.orphans.length) body.append(emptyState("No cycles", a.order ? "An import order exists; see it above." : "Nothing to fix."));
  if (folds.length >= 2) body.append(h("div", { class: "ub-folds-head", id: "cy-folds-head" }, foldAllButtons(body, "details.card[data-fold-key^='cy:']")));
  body.append(...folds);
  renderSelection();
  renderPlan();
}

function renderSelection(): void {
  if (!analysis) return;
  const n = [...choices.values()].filter((c) => c.kind !== "none").length + orphanToBase.size;
  $("#cy-sel-count").textContent = `${n} fix${n === 1 ? "" : "es"} selected`;
  $<HTMLButtonElement>("#cy-preview").disabled = n === 0;
}

// ---------- plan ----------

function updateConfirm(): void {
  const prodOk = !ctx.isProd(ctx.primary()) || $<HTMLInputElement>("#cy-prod-ack").checked;
  $<HTMLButtonElement>("#cy-confirm").disabled = applying || !(plan?.ops.length && backupDone && planConn && prodOk);
  $("#cy-backup").textContent = backupDone ? "1. Backup saved ✓" : "1. Download backup";
}

function renderPlan(): void {
  const wrap = $("#cy-plan");
  wrap.replaceChildren();
  $("#cy-fix-actions").hidden = !plan;
  $("#cy-prod-ack-wrap").hidden = !ctx.isProd(ctx.primary());
  if (plan && analysis) {
    if (ctx.isProd(ctx.primary())) wrap.append(h("div", { class: "danger-banner" }, `The primary connection (${ctx.primary()!.conn.name}) looks like Production. Solution surgery belongs in Dev.`));
    if (plan.skipped.length) wrap.append(h("div", { class: "warnings" }, "Not changed: ", plan.skipped.map((x) => `${x.what} (${x.reason})`).join("; ")));
    wrap.append(
      h("h3", {}, `${plan.ops.length} operation${plan.ops.length === 1 ? "" : "s"}`),
      h("div", { class: "summary", id: "cy-after" }, h("strong", {}, "After these fixes:"), badge(`${plan.after.cycles.length} cycle${plan.after.cycles.length === 1 ? "" : "s"}`, plan.after.cycles.length ? "bad" : "ok"), badge(`${plan.after.edges.length} edges`, "neutral"), badge(`${plan.after.orphans.length} orphans`, plan.after.orphans.length ? "warn" : "ok")),
      orderLine(plan.after.order, plan.after.cycles, analysis.base, "cy-after-order"),
      plan.ops.length ? h("ol", { class: "ops", id: "cy-ops" }, ...plan.ops.map((op) => h("li", { class: "op", "data-kind": op.kind }, h("span", { class: "mono" }, cycleOpLabel(op)), h("span", { class: "caption" }, ` · ${op.reason}`)))) : emptyState("No operations", "The selected fixes change nothing."),
    );
  }
  updateConfirm();
}

function isManagedBase(bid: string | null): boolean {
  return !!bid && bid !== ACTIVE_SOLUTION_ID && (ctx.devSolutions().find((s) => s.id === bid)?.isManaged ?? false);
}

function preview(): void {
  const p = ctx.primary();
  if (!p || !analysis) return;
  clearPlan();
  $<HTMLInputElement>("#cy-prod-ack").checked = false;
  $("#cy-results").replaceChildren();
  if (!ctx.sameUrl(p.conn.url, analysis.environment.url)) {
    void notify("Preview refused", `The analysis was run on ${analysis.environment.url}, the connection is now ${p.conn.url}. Analyze again.`, "error");
    renderPlan();
    return;
  }
  plan = planCycles(analysis, choices, orphanToBase, ctx.reqCache(), isManagedBase);
  planConn = { id: p.conn.id, url: p.conn.url };
  renderPlan();
  $("#cy-plan").scrollIntoView({ block: "start" });
}

async function downloadBackup(): Promise<void> {
  if (!analysis || !plan) return;
  const ok = await saveText(backupFileName("cycles"), JSON.stringify(buildCyclesBackup(analysis.environment, plan.ops), null, 2));
  if (ok) {
    backupDone = true;
    await notify("Backup saved", "Keep it: Undo… on this tab reverses the operations.", "success");
  }
  updateConfirm();
}

function resultsTable(results: CycleOpResult[], id: string): HTMLElement {
  return h(
    "table",
    { id },
    h("thead", {}, h("tr", {}, h("th", {}, "Operation"), h("th", {}, "Result"))),
    h("tbody", {}, ...results.map((r) => h("tr", {}, h("td", { class: "mono" }, cycleOpLabel(r.op)), h("td", {}, r.ok ? badge("ok", "ok") : badge(r.error ?? "failed", "bad"))))),
  );
}

async function guardWrite(ops: CycleOp[]): Promise<boolean> {
  const a = ctx.api();
  const now = await ctx.currentPrimary();
  if (!a || !now || !planConn || now.conn.id !== planConn.id || !ctx.sameUrl(now.conn.url, planConn.url)) {
    await notify("Refused", `The plan was made on ${planConn?.url ?? "?"}, the connection is now ${now?.conn.url ?? "none"}. Nothing was written.`, "error");
    return false;
  }
  for (const sol of new Map(ops.map((op) => [op.solution.id, op.solution])).values()) {
    const fresh = await fetchSolutionManaged(a, sol.id).catch(() => null);
    if (!fresh || fresh.isManaged) {
      await notify("Refused", `${sol.uniqueName} is managed (or could not be read). Nothing was written.`, "error");
      return false;
    }
  }
  return true;
}

async function confirm(): Promise<void> {
  const a = ctx.api();
  if (applying || !a || !analysis || !plan?.ops.length || !backupDone || !planConn) return;
  applying = true;
  updateConfirm();
  try {
    if (!(await guardWrite(plan.ops))) {
      clearPlan();
      renderPlan();
      return;
    }
    const before = analysis.cycles.length;
    const results = await executeCycles(a, plan.ops, (i, n) => ctx.setStatus(i < n ? `Applying ${i + 1} / ${n}…` : null));
    ctx.setStatus(null);
    const failed = results.filter((r) => !r.ok).length;
    await notify(failed ? "Some operations failed" : "Applied", failed ? `${failed} failed; the rest ran. Undo from the backup if needed.` : `${results.length} operations done. Analyzing again…`, failed ? "error" : "success");
    clearPlan();
    choices.clear();
    orphanToBase.clear();
    renderPlan();
    const res = $("#cy-results");
    res.replaceChildren(h("h3", {}, "Results"), resultsTable(results, "cy-results-table"));
    await run();
    const after = analysis?.cycles.length ?? 0;
    res.append(h("div", { class: "summary", id: "cy-rerun" }, h("strong", {}, "Analyzed again:"), badge(`${before} → ${after} cycles`, after ? "bad" : "ok")));
  } finally {
    applying = false;
    updateConfirm();
  }
}

async function undo(): Promise<void> {
  const a = ctx.api();
  const p = ctx.primary();
  if (!a || !p || applying) return;
  const f = await openText({ title: "Open Cycles backup", extensions: ["json"] });
  if (!f) return;
  try {
    const b = parseCyclesBackup(f.text);
    if (!ctx.sameUrl(b.environment.url, p.conn.url)) throw new Error(`backup was taken in ${b.environment.name} (${b.environment.url}), not this environment (${p.conn.url}): undo refused`);
    const { ops, notes } = undoOps(b, ctx.devSolutions());
    if (!ops.length) throw new Error(`nothing to undo${notes.length ? `: ${notes.join(" ")}` : ""}`);
    const res = $("#cy-results");
    res.replaceChildren(h("h3", {}, `Undo ${f.name}: ${ops.length} operation${ops.length === 1 ? "" : "s"}`), ...notes.map((n) => h("div", { class: "warnings" }, n)), h("ol", { class: "ops", id: "cy-undo-ops" }, ...ops.map((op) => h("li", { class: "op" }, h("span", { class: "mono" }, cycleOpLabel(op))))));
    const go = h("button", { class: "btn btn-primary btn-sm", id: "cy-undo-apply", type: "button" }, "Apply undo");
    res.append(h("div", { class: "actionbar" }, go));
    go.addEventListener("click", async () => {
      go.disabled = true;
      applying = true;
      planConn = { id: p.conn.id, url: p.conn.url };
      try {
        if (!(await guardWrite(ops))) return;
        const results = await executeCycles(a, ops, (i, n) => ctx.setStatus(i < n ? `Undoing ${i + 1} / ${n}…` : null));
        ctx.setStatus(null);
        const failed = results.filter((r) => !r.ok).length;
        res.append(resultsTable(results, "cy-undo-results"));
        await notify(failed ? "Undo: some operations failed" : "Undone", failed ? `${failed} failed.` : `${results.length} operations reversed.`, failed ? "error" : "success");
      } finally {
        applying = false;
        planConn = null;
        updateConfirm();
      }
    });
  } catch (e) {
    await notify("Undo refused", (e as Error).message, "error");
  }
}

// ---------- wiring ----------

async function exportFile(name: string, content: string, mime: string): Promise<void> {
  if (await saveText(name, content, mime)) await notify("Exported", name, "success");
}

export function initCycles(c: CyclesContext): void {
  ctx = c;
  ctl = persistControls("dependency-cleaner", ["cy-base"]);
  $("#cy-run").addEventListener("click", () => void run());
  $("#cy-cancel").addEventListener("click", () => {
    cancelFlag = true;
  });
  $("#cy-preview").addEventListener("click", preview);
  $("#cy-backup").addEventListener("click", () => void downloadBackup());
  $("#cy-prod-ack").addEventListener("change", updateConfirm);
  $("#cy-confirm").addEventListener("click", () => void confirm());
  $("#cy-undo").addEventListener("click", () => void undo());
  $("#cy-export-md").addEventListener("click", () => {
    if (analysis) void exportFile("import-order.md", cyclesMarkdown(analysis), "text/markdown");
  });
  $("#cy-export-csv").addEventListener("click", () => {
    if (analysis) void exportFile("cross-solution-dependencies.csv", cyclesCsv(analysis, csvCell), "text/csv");
  });
  render();
}

/** "Slim" tab: docs/SOLUTION-SLIMMER-PLAN.md. Removes from an unmanaged solution what is neither yours nor customized. */
import { noSolutionsText } from "./solutions-state";
import { $, badge, emptyState, filteredEmpty, foldAllButtons, foldCard, h, keepFold, shownOf, type Child } from "../../_shared/dom";
import { persistControls, type PersistedControls } from "../../_shared/view-state";
import { backupFileName, buildMembershipBackup } from "./deps/backup";
import { Cancelled } from "./deps/diagnose";
import { csvCell, safeFileName } from "./deps/export";
import { fetchSolutionManaged, MetaCache, type DataverseLike } from "./deps/fetch";
import { analyzeSlim, executeSlim, ORIGIN_LABEL, planSlim, slimCsv, slimMarkdown, slimOpLabel, VERDICT_LABEL, type SlimAnalysis, type SlimOpResult, type SlimPlan, type SlimRow, type SlimVerdict } from "./deps/slim";
import { typeName, type SolutionInfo } from "./deps/types";
import { confirmWrite, plural } from "./confirm-write";
import { errorList } from "./error-list";
import { notify, saveText, type LiveConnection } from "./host";

export interface SlimContext {
  api: () => DataverseLike | undefined;
  primary: () => LiveConnection | undefined;
  currentPrimary: () => Promise<LiveConnection | undefined>;
  devSolutions: () => SolutionInfo[];
  isProd: (c: LiveConnection | undefined) => boolean;
  sameUrl: (a: string | null | undefined, b: string | null | undefined) => boolean;
  setStatus: (msg: string | null) => void;
}

let ctx: SlimContext;
let analysis: SlimAnalysis | null = null;
/** row key → true remove / false keep; absent = the verdict's default */
const overrides = new Map<string, boolean>();
let plan: SlimPlan | null = null;
let planConn: { id: string; url: string } | null = null;
let backupDone = false;
let running = false;
let applying = false;
let cancelFlag = false;
let gen = 0;
let meta = new MetaCache();
let ctl: PersistedControls;
/** the analysis the type select was filled from */
let typesOf: SlimAnalysis | null = null;

const SYSTEM = new Set(["default", "active", "basic"]);
/** sections in display order: the actionable ones open, the kept ones folded */
const SECTIONS: { verdict: SlimVerdict; open: boolean; hint: string }[] = [
  { verdict: "remove", open: true, hint: "Managed or platform (System) components you did not customize: no Active layer, or one that changes nothing but bookkeeping. Untick a row to keep it." },
  { verdict: "shell", open: true, hint: "Managed or platform tables added with all assets: removed and re-added without subcomponents, then the kept subcomponents are added back. Untick to leave a table as it is." },
  { verdict: "unknown", open: true, hint: "State could not be read: kept. Fix the read (Debug log) or remove by hand." },
  { verdict: "customized", open: false, hint: "Managed or platform components whose Active layer changes something real (open Layers to see what): the export carries those changes. The layer is environment-wide, so a component also in other unmanaged solutions may belong to them: tick to remove anyway." },
  { verdict: "parent", open: false, hint: "Pristine managed parents whose children stay. Untick “Keep parents of kept components” to list them under Remove." },
  { verdict: "included", open: false, hint: "Subcomponents of your own tables included with all assets: implicit members." },
  { verdict: "unmanaged", open: false, hint: "Created in this environment and not the platform's: yours." },
];

function clearPlan(): void {
  plan = null;
  planConn = null;
  backupDone = false;
}

/** Connections changed: drop everything read from the previous one and refill the solution picker. */
export function slimOnConnections(changed: boolean): void {
  if (changed) {
    gen++;
    analysis = null;
    overrides.clear();
    clearPlan();
    meta = new MetaCache();
    $("#sl-results").replaceChildren();
  }
  const sel = $<HTMLSelectElement>("#sl-solution");
  const prev = sel.value;
  const pickable = ctx.devSolutions().filter((x) => !x.isManaged && !SYSTEM.has(x.uniqueName.toLowerCase()));
  sel.replaceChildren(...(pickable.length ? pickable.map((x) => h("option", { value: x.id }, `${x.friendlyName} (${x.uniqueName}) ${x.version}`)) : [h("option", { value: "" }, noSolutionsText(!!ctx.primary()))]));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  $<HTMLButtonElement>("#sl-run").disabled = !pickable.length;
  render();
}

async function run(solutionId?: string): Promise<void> {
  const a = ctx.api();
  const p = ctx.primary();
  const sol = ctx.devSolutions().find((x) => x.id === (solutionId ?? $<HTMLSelectElement>("#sl-solution").value));
  if (!a || !p || !sol || running) return;
  running = true;
  cancelFlag = false;
  const g = gen;
  $("#sl-cancel").hidden = false;
  $<HTMLButtonElement>("#sl-run").disabled = true;
  $("#sl-progress").hidden = false;
  const bar = $<HTMLProgressElement>("#sl-progress-bar");
  try {
    const r = await analyzeSlim({
      api: a,
      meta,
      solution: sol,
      keepParents: $<HTMLInputElement>("#sl-parents").checked,
      environment: { name: p.conn.name, url: p.conn.url },
      onProgress: (phase, done, total) => {
        bar.max = Math.max(total, 1);
        bar.value = done;
        $("#sl-progress-text").textContent = total > 1 ? `${phase} ${done} / ${total}` : `${phase}…`;
      },
      cancelled: () => cancelFlag,
    });
    if (g !== gen) return; // connection changed while this ran
    analysis = r;
    clearPlan();
    // an override survives only while its row still exists
    for (const k of [...overrides.keys()]) if (!r.rows.some((x) => x.key === k)) overrides.delete(k);
  } catch (e) {
    if (e instanceof Cancelled) await notify("Cancelled", "Analysis cancelled.", "info");
    else await notify("Analysis failed", (e as Error).message, "error");
  } finally {
    running = false;
    $("#sl-cancel").hidden = true;
    $<HTMLButtonElement>("#sl-run").disabled = false;
    $("#sl-progress").hidden = true;
  }
  render();
}

// ---------- render ----------

const removes = (r: SlimRow): boolean => overrides.get(r.key) ?? (r.verdict === "remove" || r.verdict === "shell");

function rowEl(r: SlimRow): HTMLElement {
  const box = h("input", { type: "checkbox", "aria-label": `Remove ${typeName(r.component.type)} ${r.name.name}` }) as HTMLInputElement;
  box.checked = removes(r);
  box.addEventListener("change", () => {
    const def = r.verdict === "remove" || r.verdict === "shell";
    if (box.checked === def) overrides.delete(r.key);
    else overrides.set(r.key, box.checked);
    clearPlan();
    renderSelection();
    renderPlan();
  });
  const sub = r.component.rootRowId && r.verdict !== "shell" ? h("span", { class: "caption" }, "↳") : null;
  const flags: Child[] = [];
  if (r.origin && r.origin !== "custom") flags.push(badge(ORIGIN_LABEL[r.origin], "neutral", r.origin === "platform" ? "System's: ismanaged false but not custom" : "from a managed solution"));
  if (r.owner && r.owner !== "System") flags.push(badge(r.owner, "neutral", "owning managed solution (base layer)"));
  if (r.alsoIn.length) flags.push(badge(`also in ${r.alsoIn.join(", ")}`, "warn", "other unmanaged solutions that contain this component"));
  if (r.verdict === "unknown") flags.push(badge("unknown", "warn", r.error));
  const layers = r.layers.length
    ? keepFold(h("details", { class: "layers-fold" }, h("summary", { class: "chev" }, "Layers"), h("div", { class: "caption" }, `Top first: ${r.layers.join(" › ")}${r.changes.length ? ` · Active changes: ${r.changes.join(", ")}` : r.layers.some((l) => l.toLowerCase() === "active") ? " · Active layer changes nothing" : ""}`)), `sl-layers:${r.key}`)
    : null;
  return h(
    "li",
    { class: "finding slim-row", "data-key": r.key, "data-verdict": r.verdict },
    h("div", { class: "head" }, h("label", { class: "check" }, box), sub, badge(typeName(r.component.type), "neutral"), h("span", { class: "name mono" }, r.name.name), r.name.table && r.name.table !== r.name.name ? h("span", { class: "caption" }, r.name.table) : null, ...flags),
    h("div", { class: "cause" }, r.reason),
    layers,
  );
}

function matches(r: SlimRow, q: string, type: string): boolean {
  if (type && String(r.component.type) !== type) return false;
  if (!q) return true;
  return [r.name.name, r.name.table ?? "", typeName(r.component.type), r.owner ?? "", ...r.alsoIn, r.reason].some((s) => s.toLowerCase().includes(q));
}

function fillTypes(a: SlimAnalysis): void {
  if (typesOf === a) return;
  typesOf = a;
  const sel = $<HTMLSelectElement>("#sl-type");
  const prev = sel.value;
  const types = [...new Set(a.rows.map((r) => r.component.type))].sort((x, y) => typeName(x).localeCompare(typeName(y)));
  sel.replaceChildren(h("option", { value: "" }, "All types"), ...types.map((t) => h("option", { value: String(t) }, typeName(t))));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else ctl.restore();
}

function render(): void {
  const sum = $("#sl-summary");
  const body = $("#sl-body");
  sum.replaceChildren();
  body.replaceChildren();
  $("#sl-tools").hidden = !analysis;
  $("#sl-actions").hidden = !analysis;
  for (const id of ["#sl-export-md", "#sl-export-csv"]) $(id).toggleAttribute("disabled", !analysis);
  if (!ctx.primary()) {
    body.append(emptyState("No connection", "Pick the Dev environment as the primary connection in ToolBox."));
    renderPlan();
    return;
  }
  if (!analysis) {
    body.append(emptyState("No analysis yet", "Pick an unmanaged solution and run Analyze. Reads only; nothing is written until you confirm. Removing a component from a solution never changes the environment."));
    renderPlan();
    return;
  }
  const a = analysis;
  const c = a.counts;
  fillTypes(a);
  sum.append(
    h(
      "div",
      { class: "summary", id: "sl-counts" },
      h("strong", {}, `${a.solution.uniqueName} ${a.solution.version} · ${c.total} components`),
      badge(`${c.remove} to remove`, c.remove ? "warn" : "ok"),
      badge(`${c.shell} table${c.shell === 1 ? "" : "s"} → shell`, c.shell ? "warn" : "neutral"),
      badge(`${c.customized} customized`, "neutral"),
      badge(`${c.unmanaged} yours`, "neutral"),
      c.parent ? badge(`${c.parent} parent${c.parent === 1 ? "" : "s"} kept`, "neutral") : null,
      c.included ? badge(`${c.included} included`, "neutral") : null,
      c.unknown ? badge(`${c.unknown} unknown`, "bad") : null,
    ),
  );
  for (const w of a.warnings) sum.append(h("div", { class: "warnings" }, w));
  if (a.errors.length) sum.append(errorList(`State could not be read for ${a.errors.length} component(s)`, a.errors, "sl-errors"));
  if (!c.remove && !c.shell && !c.unknown) body.append(emptyState("Nothing to remove", "Every component is unmanaged or carries a customization of yours."));

  const q = $<HTMLInputElement>("#sl-find").value.trim().toLowerCase();
  const type = $<HTMLSelectElement>("#sl-type").value;
  const folds: HTMLElement[] = [];
  let shownTotal = 0;
  for (const s of SECTIONS) {
    const all = a.rows.filter((r) => r.verdict === s.verdict);
    if (!all.length) continue;
    const shown = all.filter((r) => matches(r, q, type));
    shownTotal += shown.length;
    const el = foldCard(VERDICT_LABEL[s.verdict], shown.length === all.length ? all.length : `${shown.length} of ${all.length}`, h("div", { class: "ub-section" }, h("p", { class: "caption" }, s.hint), shown.length ? h("ul", { class: "findings" }, ...shown.map(rowEl)) : h("p", { class: "caption" }, "No rows match the search or type filter.")), s.open, { key: `sl:${s.verdict}` });
    el.id = `sl-${s.verdict}`;
    el.hidden = !shown.length && !!(q || type);
    folds.push(el);
  }
  $("#sl-shown").textContent = shownOf(shownTotal, a.rows.length, "components");
  if ((q || type) && !shownTotal) {
    body.append(
      filteredEmpty("No components match", `The search or type filter hides all ${a.rows.length} components.`, () => {
        ctl.reset();
        render();
      }),
    );
  }
  if (folds.filter((f) => !f.hidden).length >= 2) body.append(h("div", { class: "ub-folds-head", id: "sl-folds-head" }, foldAllButtons(body, "details.card[data-fold-key^='sl:']")));
  body.append(...folds);
  renderSelection();
  renderPlan();
}

function renderSelection(): void {
  if (!analysis) return;
  const n = analysis.rows.filter(removes).length;
  $("#sl-sel-count").textContent = `${n} to remove${overrides.size ? ` (${overrides.size} changed by hand)` : ""}`;
  $<HTMLButtonElement>("#sl-preview").disabled = n === 0;
}

// ---------- plan ----------

function updateConfirm(): void {
  const prodOk = !ctx.isProd(ctx.primary()) || $<HTMLInputElement>("#sl-prod-ack").checked;
  $<HTMLButtonElement>("#sl-confirm").disabled = applying || !(plan?.ops.length && backupDone && planConn && prodOk);
  $("#sl-backup").textContent = backupDone ? "1. Backup saved ✓" : "1. Download backup";
}

function renderPlan(): void {
  const wrap = $("#sl-plan");
  wrap.replaceChildren();
  $("#sl-fix-actions").hidden = !plan;
  $("#sl-prod-ack-wrap").hidden = !ctx.isProd(ctx.primary());
  if (plan && analysis) {
    if (ctx.isProd(ctx.primary())) wrap.append(h("div", { class: "danger-banner" }, `The primary connection (${ctx.primary()!.conn.name}) looks like Production. Slimming belongs in Dev.`));
    wrap.append(
      h("h3", {}, `${plan.ops.length} operation${plan.ops.length === 1 ? "" : "s"} on ${analysis.solution.uniqueName}: ${plan.removing.length} component${plan.removing.length === 1 ? "" : "s"} leave the solution${plan.shells ? `, ${plan.shells} table${plan.shells === 1 ? "" : "s"} converted` : ""}`),
      h("p", { class: "caption" }, "Membership only: nothing is deleted from the environment. The backup restores the membership from the Restore tab."),
      plan.ops.length ? h("ol", { class: "ops", id: "sl-ops" }, ...plan.ops.map((op) => h("li", { class: "op", "data-kind": op.kind }, h("span", { class: "mono" }, slimOpLabel(op)), h("span", { class: "caption" }, ` · ${op.reason}`)))) : emptyState("No operations", "The selection changes nothing."),
    );
  }
  updateConfirm();
}

function preview(): void {
  const p = ctx.primary();
  if (!p || !analysis) return;
  clearPlan();
  $<HTMLInputElement>("#sl-prod-ack").checked = false;
  $("#sl-results").replaceChildren();
  if (!ctx.sameUrl(p.conn.url, analysis.environment.url)) {
    void notify("Preview refused", `The analysis was run on ${analysis.environment.url}, the connection is now ${p.conn.url}. Analyze again.`, "error");
    renderPlan();
    return;
  }
  plan = planSlim(analysis, overrides);
  planConn = { id: p.conn.id, url: p.conn.url };
  renderPlan();
  $("#sl-plan").scrollIntoView({ block: "start" });
}

async function downloadBackup(): Promise<void> {
  if (!analysis || !plan) return;
  const ok = await saveText(backupFileName(analysis.solution.uniqueName), JSON.stringify(buildMembershipBackup(analysis.solution, analysis.environment, analysis.components, plan.ops.map(slimOpLabel)), null, 2));
  if (ok) {
    backupDone = true;
    await notify("Backup saved", "Keep it: the Restore tab reapplies it.", "success");
  }
  updateConfirm();
}

function resultsTable(results: SlimOpResult[]): HTMLElement {
  return h(
    "table",
    { id: "sl-results-table" },
    h("thead", {}, h("tr", {}, h("th", {}, "Operation"), h("th", {}, "Result"))),
    h("tbody", {}, ...results.map((r) => h("tr", {}, h("td", { class: "mono" }, slimOpLabel(r.op)), h("td", {}, r.ok ? badge("ok", "ok") : r.skipped ? badge(r.error ?? "skipped", "neutral") : badge(r.error ?? "failed", "bad"))))),
  );
}

async function confirm(): Promise<void> {
  const a = ctx.api();
  if (applying || !a || !analysis || !plan?.ops.length || !backupDone || !planConn) return;
  applying = true;
  updateConfirm();
  try {
    const sol = analysis.solution;
    const now = await ctx.currentPrimary();
    if (!now || now.conn.id !== planConn.id || !ctx.sameUrl(now.conn.url, planConn.url)) {
      const was = planConn.url;
      clearPlan();
      renderPlan();
      await notify("Refused", `The plan was made on ${was}, the connection is now ${now?.conn.url ?? "none"}. Nothing was written.`, "error");
      return;
    }
    const fresh = await fetchSolutionManaged(a, sol.id).catch(() => null);
    if (!fresh || fresh.isManaged) {
      await notify("Refused", `${sol.uniqueName} is managed (or could not be read). Nothing was written.`, "error");
      return;
    }
    const removes = plan.ops.filter((o) => o.kind === "remove").length;
    const go = await confirmWrite({
      title: "Slim solution",
      conn: now,
      scope: `${plural(plan.ops.length, "operation")} on solution ${fresh.uniqueName}: ${plural(plan.removing.length, "component")} leave the solution${plan.shells ? `, ${plural(plan.shells, "table")} converted to shells` : ""} (${removes} RemoveSolutionComponent, ${plan.ops.length - removes} AddSolutionComponent). Membership only: nothing is deleted from the environment.`,
      wayBack: "Way back: the backup you saved for this plan. The Restore tab re-adds what left and puts shell tables back to all assets; only in this environment.",
      okLabel: `Apply ${plan.ops.length}`,
      danger: ctx.isProd(now),
    });
    if (!go) return;
    const before = analysis.counts.remove + analysis.counts.shell;
    const results = await executeSlim(a, plan.ops, fresh.uniqueName, (i, n) => ctx.setStatus(i < n ? `Applying ${i + 1} / ${n}…` : null));
    ctx.setStatus(null);
    const failed = results.filter((r) => !r.ok && !r.skipped).length;
    await notify(failed ? "Some operations failed" : "Applied", failed ? `${failed} failed; the rest ran. Restore from the backup if needed.` : `${results.length} operations done. Analyzing again…`, failed ? "error" : "success");
    clearPlan();
    overrides.clear();
    renderPlan();
    const res = $("#sl-results");
    res.replaceChildren(h("h3", {}, "Results"), resultsTable(results));
    meta = new MetaCache();
    await run(sol.id);
    const after = analysis ? analysis.counts.remove + analysis.counts.shell : 0;
    res.append(h("div", { class: "summary", id: "sl-rerun" }, h("strong", {}, "Analyzed again:"), badge(`${before} → ${after} to remove`, after ? "warn" : "ok")));
  } finally {
    applying = false;
    updateConfirm();
  }
}

// ---------- wiring ----------

async function exportFile(name: string, content: string, mime: string): Promise<void> {
  if (await saveText(name, content, mime)) await notify("Exported", name, "success");
}

export function initSlim(c: SlimContext): void {
  ctx = c;
  persistControls("dependency-cleaner", ["sl-parents"]);
  ctl = persistControls("dependency-cleaner", ["sl-find", "sl-type"]);
  $("#sl-run").addEventListener("click", () => void run());
  $("#sl-cancel").addEventListener("click", () => {
    cancelFlag = true;
  });
  $("#sl-find").addEventListener("input", render);
  $("#sl-type").addEventListener("change", render);
  $("#sl-parents").addEventListener("change", () => {
    // the option changes the classification: the next Analyze applies it
    if (analysis) $("#sl-parents-note").hidden = false;
  });
  $("#sl-preview").addEventListener("click", preview);
  $("#sl-backup").addEventListener("click", () => void downloadBackup());
  $("#sl-prod-ack").addEventListener("change", updateConfirm);
  $("#sl-confirm").addEventListener("click", () => void confirm());
  $("#sl-export-md").addEventListener("click", () => {
    if (analysis) void exportFile(`slim.${safeFileName(analysis.solution.uniqueName)}.md`, slimMarkdown(analysis), "text/markdown");
  });
  $("#sl-export-csv").addEventListener("click", () => {
    if (analysis) void exportFile(`slim.${safeFileName(analysis.solution.uniqueName)}.csv`, slimCsv(analysis, csvCell), "text/csv");
  });
  render();
}

/** "Upgrade blockers" tab: docs/UPGRADE-BLOCKERS-PLAN.md. Dev = primary connection, target = secondary. */
import { $, badge, emptyState, foldAllButtons, foldCard, h, type Child } from "../../_shared/dom";
import { backupFileName, buildUpgradeBackup } from "./deps/backup";
import { Cancelled } from "./deps/diagnose";
import { csvCell, safeFileName } from "./deps/export";
import { fetchSolutionManaged, MetaCache, type DataverseLike } from "./deps/fetch";
import { typeName, type SolutionInfo } from "./deps/types";
import { analyzeUpgrade, locationLabel, planUpgradeFixes, upgradeMarkdown, type Blocker, type BlockerFix, type BlockerLocation, type UComponent, type UpgradeAnalysis, type UpgradePlan } from "./deps/upgrade";
import { executeOps, opLabel, type OpResult } from "./deps/write";
import { notify, saveText, type LiveConnection } from "./host";

export interface UpgradeContext {
  api: () => DataverseLike | undefined;
  primary: () => LiveConnection | undefined;
  secondary: () => LiveConnection | undefined;
  /** the host's current primary connection (not the cached one) */
  currentPrimary: () => Promise<LiveConnection | undefined>;
  devSolutions: () => SolutionInfo[];
  targetSolutions: () => SolutionInfo[] | null;
  isProd: (c: LiveConnection | undefined) => boolean;
  sameUrl: (a: string | null | undefined, b: string | null | undefined) => boolean;
  setStatus: (msg: string | null) => void;
}

let ctx: UpgradeContext;
let analysis: UpgradeAnalysis | null = null;
const selections = new Map<string, BlockerFix["kind"]>();
let plan: UpgradePlan | null = null;
let planConn: { id: string; url: string } | null = null;
let backupDone = false;
let running = false;
let applying = false;
let cancelFlag = false;
let gen = 0;
let devMeta = new MetaCache();
let targetMeta = new MetaCache();

const SYSTEM = new Set(["default", "active", "basic"]);
const cLabel = (c: UComponent): string => `${c.kind ?? typeName(c.type)} ${c.name}`;

function clearPlan(): void {
  plan = null;
  planConn = null;
  backupDone = false;
}

/** Connections changed: drop everything read from the previous pair and refill the solution picker. */
export function upgradeOnConnections(changed: boolean): void {
  if (changed) {
    gen++;
    analysis = null;
    selections.clear();
    clearPlan();
    devMeta = new MetaCache();
    targetMeta = new MetaCache();
    $("#ub-results").replaceChildren();
  }
  const sel = $<HTMLSelectElement>("#ub-solution");
  const prev = sel.value;
  const target = ctx.targetSolutions();
  const byName = new Map((target ?? []).map((s) => [s.uniqueName.toLowerCase(), s]));
  const pickable = ctx.devSolutions().filter((x) => !x.isManaged && !SYSTEM.has(x.uniqueName.toLowerCase()));
  sel.replaceChildren(
    ...(pickable.length
      ? pickable.map((x) => {
          const t = byName.get(x.uniqueName.toLowerCase());
          const where = !target ? "" : t ? ` · ${t.isManaged ? "managed" : "unmanaged"} ${t.version} in target` : " · not in target";
          return h("option", { value: x.id }, `${x.friendlyName} (${x.uniqueName}) ${x.version}${where}`);
        })
      : [h("option", { value: "" }, ctx.primary() ? "No unmanaged solutions" : "No connection")]),
  );
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  $<HTMLButtonElement>("#ub-run").disabled = !pickable.length || !ctx.secondary();
  render();
}

async function run(solutionId?: string): Promise<void> {
  const a = ctx.api();
  const p = ctx.primary();
  const s = ctx.secondary();
  const target = ctx.targetSolutions();
  const sol = ctx.devSolutions().find((x) => x.id === (solutionId ?? $<HTMLSelectElement>("#ub-solution").value));
  if (!a || !p || !s || !sol || running) return;
  if (!target) {
    await notify("Target not loaded", `Solutions of ${s.conn.name} could not be read.`, "error");
    return;
  }
  running = true;
  cancelFlag = false;
  const g = gen;
  $("#ub-cancel").hidden = false;
  $<HTMLButtonElement>("#ub-run").disabled = true;
  $("#ub-progress").hidden = false;
  const bar = $<HTMLProgressElement>("#ub-progress-bar");
  try {
    const r = await analyzeUpgrade({
      api: a,
      devMeta,
      targetMeta,
      solution: sol,
      targetSolutions: target,
      environment: { name: p.conn.name, url: p.conn.url },
      target: { name: s.conn.name, url: s.conn.url },
      scanRuntime: $<HTMLInputElement>("#ub-scan").checked,
      onProgress: (phase, done, total) => {
        bar.max = Math.max(total, 1);
        bar.value = done;
        $("#ub-progress-text").textContent = `${phase} ${done} / ${total}`;
      },
      cancelled: () => cancelFlag,
    });
    if (g !== gen) return; // connections changed while this ran
    analysis = r;
    for (const [k, fix] of [...selections]) if (!r.blockers.some((b) => b.key === k && b.fixes.some((f) => f.kind === fix))) selections.delete(k);
  } catch (e) {
    if (e instanceof Cancelled) await notify("Cancelled", "Analysis cancelled.", "info");
    else await notify("Analysis failed", (e as Error).message, "error");
  } finally {
    running = false;
    $("#ub-cancel").hidden = true;
    $<HTMLButtonElement>("#ub-run").disabled = false;
    $("#ub-progress").hidden = true;
  }
  render();
}

// ---------- render ----------

function blockerCard(b: Blocker): HTMLElement {
  const actionable = b.fixes.filter((f) => f.kind !== "report");
  let sel: HTMLSelectElement | null = null;
  if (actionable.length) {
    sel = h("select", { class: "fix", "aria-label": `Fix for ${b.dependent.name}` }) as HTMLSelectElement;
    sel.append(h("option", { value: "" }, "No action"), ...actionable.map((f) => h("option", { value: f.kind }, f.label)));
    sel.value = selections.get(b.key) ?? "";
    sel.addEventListener("change", () => {
      if (sel!.value) selections.set(b.key, sel!.value as BlockerFix["kind"]);
      else selections.delete(b.key);
      clearPlan();
      renderSelection();
      renderPlan();
    });
  }
  return h(
    "li",
    { class: "finding", "data-key": b.key, "data-location": b.location },
    h(
      "div",
      { class: "head" },
      badge(b.dependent.kind ?? typeName(b.dependent.type), "neutral"),
      h("span", { class: "name mono" }, b.dependent.name),
      h("span", { class: "caption" }, "references"),
      badge(b.required.kind ?? typeName(b.required.type), "neutral"),
      h("span", { class: "name mono" }, b.required.name),
      badge(b.owner === "Active" ? "unmanaged" : b.owner, b.location === "dev" ? "warn" : "bad"),
      sel,
    ),
    h("div", { class: "cause" }, b.note),
    h("div", { class: "caption" }, `Layers in target (top first): ${b.layers.join(" › ") || "none"}${b.layerSource === "membership" ? " · from solution membership, order unknown" : ""}`),
  );
}

function section(loc: BlockerLocation, list: Blocker[], a: UpgradeAnalysis): HTMLElement | null {
  if (!list.length) return null;
  const title = loc === "dev" ? `Fix in Dev (${a.solution.uniqueName})` : loc === "release" ? "Release first" : `Target unmanaged (${a.target.name})`;
  const body: Child[] = [];
  if (loc === "release") {
    const owners = [...new Set(list.map((b) => b.owner))];
    body.push(h("p", { class: "caption", id: "ub-order" }, `Release order: ${[...owners, a.solution.uniqueName].join(" → ")}. Each needs a new version without the reference, upgraded before ${a.solution.uniqueName}.`));
  }
  if (loc === "target") body.push(h("p", { class: "caption" }, "Not fixable from Dev: open the component in the target, See solution layers, and remove the unmanaged layer or edit it to drop the reference."));
  return h("div", { class: "ub-section", id: `ub-${loc}` }, h("h3", {}, `${title} · ${list.length}`), ...body, h("ul", { class: "findings" }, ...list.map(blockerCard)));
}

function list(items: Child[]): HTMLElement {
  return h("ul", { class: "plain" }, ...items.map((x) => h("li", {}, x)));
}

function render(): void {
  const sum = $("#ub-summary");
  const body = $("#ub-body");
  sum.replaceChildren();
  body.replaceChildren();
  $("#ub-actions").hidden = !analysis;
  for (const id of ["#ub-export-md", "#ub-export-csv"]) $(id).toggleAttribute("disabled", !analysis);
  if (!ctx.secondary()) {
    body.append(emptyState("No target connection", "Connect Dev as the primary connection and the environment you will upgrade (Test, Prod) as the secondary connection."));
    renderPlan();
    return;
  }
  if (!analysis) {
    body.append(emptyState("No analysis yet", "Pick the solution you are about to upgrade and run Analyze. Reads only; nothing is written until you confirm a fix."));
    renderPlan();
    return;
  }
  const a = analysis;
  const by = (l: BlockerLocation) => a.blockers.filter((b) => b.location === l);
  sum.append(
    h(
      "div",
      { class: "summary", id: "ub-counts" },
      h("strong", {}, `${a.solution.uniqueName} ${a.solution.version} → ${a.target.name} (${a.target.version})`),
      badge(`${a.removed} removed`, "neutral"),
      badge(`${a.deleted.length} deleted`, a.deleted.length ? "warn" : "ok"),
      badge(`${a.survivors.length} survive`, "neutral"),
      badge(`${a.blockers.length} blocker${a.blockers.length === 1 ? "" : "s"}`, a.blockers.length ? "bad" : "ok"),
      a.runtime.length ? badge(`${a.runtime.length} runtime break${a.runtime.length === 1 ? "" : "s"}`, "warn") : null,
      a.errors.length ? badge(`${a.errors.length} checks failed`, "warn") : null,
    ),
  );
  for (const w of a.warnings) sum.append(h("div", { class: "warnings" }, w));
  if (a.errors.length) sum.append(h("div", { class: "warnings" }, `RetrieveDependenciesForDelete failed for ${a.errors.length} component(s): ${a.errors.slice(0, 3).map((e) => `${e.component} (${e.error})`).join("; ")}`));
  if (!a.removed) body.append(emptyState("Nothing removed", `Dev's ${a.solution.uniqueName} contains everything the target's version does. The upgrade deletes nothing.`));
  else if (!a.blockers.length) body.append(emptyState("No blockers", a.deleted.length ? `${a.deleted.length} component(s) will be deleted and nothing references them.` : "Every removed component survives in another solution."));
  for (const loc of ["dev", "release", "target"] as BlockerLocation[]) {
    const s = section(loc, by(loc), a);
    if (s) body.append(s);
  }
  if (a.runtime.length)
    body.append(
      h(
        "div",
        { class: "ub-section", id: "ub-runtime" },
        h("h3", {}, `Runtime breaks · ${a.runtime.length}`),
        h("p", { class: "caption" }, "Not tracked as dependencies: the upgrade succeeds, then these fail when they run."),
        list(a.runtime.map((r) => `${r.whereType} ${r.where} → ${cLabel(r.component)}`)),
      ),
    );
  const folds = [
    a.resolved.length ? foldCard("Resolved by the new version", a.resolved.length, list(a.resolved.map((r) => `${cLabel(r.dependent)} → ${cLabel(r.required)}`)), false, { key: "ub:resolved" }) : null,
    a.survivors.length ? foldCard("Survives (held by another managed solution)", a.survivors.length, list(a.survivors.map((s) => `${cLabel(s.component)} · ${s.holders.join(", ")}`)), false, { key: "ub:survives" }) : null,
    a.deleted.length ? foldCard("Deleted by the upgrade", a.deleted.length, list(a.deleted.map(cLabel)), false, { key: "ub:deleted" }) : null,
  ].filter((x): x is HTMLElement => !!x);
  if (folds.length >= 2) body.append(h("div", { class: "ub-folds-head", id: "ub-folds-head" }, foldAllButtons(body, "details.card[data-fold-key^='ub:']")));
  body.append(...folds);
  renderSelection();
  renderPlan();
}

function renderSelection(): void {
  $("#ub-sel-count").textContent = `${selections.size} selected`;
  $<HTMLButtonElement>("#ub-preview").disabled = selections.size === 0;
}

// ---------- fix ----------

function updateConfirm(): void {
  const prodOk = !ctx.isProd(ctx.primary()) || $<HTMLInputElement>("#ub-prod-ack").checked;
  $<HTMLButtonElement>("#ub-confirm").disabled = applying || !(plan?.ops.length && backupDone && planConn && prodOk);
  $("#ub-backup").textContent = backupDone ? "1. Backup saved ✓" : "1. Download backup";
}

function renderPlan(): void {
  const wrap = $("#ub-plan");
  wrap.replaceChildren();
  $("#ub-fix-actions").hidden = !plan;
  $("#ub-prod-ack-wrap").hidden = !ctx.isProd(ctx.primary());
  if (plan) {
    if (ctx.isProd(ctx.primary())) wrap.append(h("div", { class: "danger-banner" }, `The primary connection (${ctx.primary()!.conn.name}) looks like Production. These fixes belong in Dev.`));
    if (plan.skipped.length) wrap.append(h("div", { class: "warnings" }, "Not changed: ", plan.skipped.map((x) => `${x.name} (${x.reason})`).join("; ")));
    wrap.append(
      h("h3", {}, `${plan.ops.length} operation${plan.ops.length === 1 ? "" : "s"} in Dev on ${analysis?.solution.uniqueName ?? ""}`),
      plan.ops.length ? h("ol", { class: "ops", id: "ub-ops" }, ...plan.ops.map((op) => h("li", { class: "op", "data-kind": op.kind }, h("span", { class: "mono" }, opLabel(op))))) : emptyState("No operations", "The selected fixes change nothing."),
    );
  }
  updateConfirm();
}

async function preview(): Promise<void> {
  const a = ctx.api();
  const p = ctx.primary();
  if (!a || !p || !analysis) return;
  clearPlan();
  $<HTMLInputElement>("#ub-prod-ack").checked = false;
  $("#ub-results").replaceChildren();
  ctx.setStatus("Preparing preview…");
  try {
    if (!ctx.sameUrl(p.conn.url, analysis.environment.url)) throw new Error(`The analysis was run on ${analysis.environment.url}, the connection is now ${p.conn.url}. Analyze again.`);
    const sel = [...selections].map(([k, fix]) => ({ blocker: analysis!.blockers.find((b) => b.key === k)!, fix })).filter((x) => x.blocker);
    plan = await planUpgradeFixes(a, analysis, sel);
    planConn = { id: p.conn.id, url: p.conn.url };
  } catch (e) {
    clearPlan();
    await notify("Preview failed", (e as Error).message, "error");
  } finally {
    ctx.setStatus(null);
  }
  renderPlan();
}

async function downloadBackup(): Promise<void> {
  if (!analysis || !plan) return;
  const ok = await saveText(backupFileName(analysis.solution.uniqueName), JSON.stringify(buildUpgradeBackup(analysis, plan), null, 2));
  if (ok) {
    backupDone = true;
    await notify("Backup saved", "Keep it: the Restore tab reapplies it.", "success");
  }
  updateConfirm();
}

function resultsTable(results: OpResult[]): HTMLElement {
  return h(
    "table",
    { id: "ub-results-table" },
    h("thead", {}, h("tr", {}, h("th", {}, "Operation"), h("th", {}, "Result"))),
    h("tbody", {}, ...results.map((r) => h("tr", {}, h("td", { class: "mono" }, opLabel(r.op)), h("td", {}, r.ok ? badge("ok", "ok") : r.skipped ? badge(r.error ?? "skipped", "neutral") : badge(r.error ?? "failed", "bad"))))),
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
      await notify("Refused", `${sol.uniqueName} is managed in Dev (or could not be read). Nothing was written.`, "error");
      return;
    }
    const before = analysis.blockers.length;
    const results = await executeOps(a, plan.ops, fresh.uniqueName, (i, n) => ctx.setStatus(i < n ? `Applying ${i + 1} / ${n}…` : null));
    ctx.setStatus(null);
    const failed = results.filter((r) => !r.ok && !r.skipped).length;
    await notify(failed ? "Some operations failed" : "Applied", failed ? "Restore from the backup if needed." : `${results.length} operations done. Analyzing again…`, failed ? "error" : "success");
    clearPlan();
    selections.clear();
    renderPlan();
    const res = $("#ub-results");
    res.replaceChildren(h("h3", {}, "Results"), resultsTable(results));
    devMeta = new MetaCache();
    await run(sol.id);
    const after = analysis?.blockers.length ?? 0;
    res.append(h("div", { class: "summary", id: "ub-rerun" }, h("strong", {}, "Analyzed again:"), badge(`${before} → ${after} blockers`, after ? "bad" : "ok")));
  } finally {
    applying = false;
    updateConfirm();
  }
}

// ---------- export ----------

export function upgradeCsv(a: UpgradeAnalysis): string {
  const rows = [["location", "owner", "dependent type", "dependent", "required type", "required", "layers", "note"]];
  for (const b of a.blockers) rows.push([locationLabel(b.location), b.owner, b.dependent.kind ?? typeName(b.dependent.type), b.dependent.name, b.required.kind ?? typeName(b.required.type), b.required.name, b.layers.join(" > "), b.note]);
  for (const r of a.runtime) rows.push(["Runtime break", "", r.whereType, r.where, r.component.kind ?? typeName(r.component.type), r.component.name, "", "not tracked as a dependency"]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
}

async function exportFile(name: string, content: string, mime: string): Promise<void> {
  if (await saveText(name, content, mime)) await notify("Exported", name, "success");
}

export function initUpgrade(c: UpgradeContext): void {
  ctx = c;
  $("#ub-run").addEventListener("click", () => void run());
  $("#ub-cancel").addEventListener("click", () => {
    cancelFlag = true;
  });
  $("#ub-preview").addEventListener("click", () => void preview());
  $("#ub-backup").addEventListener("click", () => void downloadBackup());
  $("#ub-prod-ack").addEventListener("change", updateConfirm);
  $("#ub-confirm").addEventListener("click", () => void confirm());
  $("#ub-export-md").addEventListener("click", () => {
    if (analysis) void exportFile(`upgrade-preflight.${safeFileName(analysis.solution.uniqueName)}.md`, upgradeMarkdown(analysis), "text/markdown");
  });
  $("#ub-export-csv").addEventListener("click", () => {
    if (analysis) void exportFile(`upgrade-preflight.${safeFileName(analysis.solution.uniqueName)}.csv`, upgradeCsv(analysis), "text/csv");
  });
  render();
}

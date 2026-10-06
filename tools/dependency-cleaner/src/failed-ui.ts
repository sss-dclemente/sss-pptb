/**
 * "Failed import" tab: an upgrade already failed with "component cannot be deleted because it is referenced by…".
 * Reads the error from solution history (or pasted text) in the environment the import failed in, finds what still
 * references each component, and fixes it there. Logic in deps/failed.ts.
 */
import { $, badge, emptyState, foldCard, h, keepFold, type Child } from "../../_shared/dom";
import { Cancelled } from "./deps/diagnose";
import { safeFileName } from "./deps/export";
import { MetaCache, onTarget, type DataverseLike } from "./deps/fetch";
import {
  buildFailedBackup,
  checkFailed,
  executeFailedOps,
  failedMarkdown,
  failOpLabel,
  fetchFailedRuns,
  parseBlocked,
  parseFailedBackup,
  parseSolutionName,
  planFailedFixes,
  undoFlows,
  type BlockedRef,
  type FailBlocker,
  type FailedCheck,
  type FailedRun,
  type FailLocation,
  type FailOpResult,
  type FailPlan,
} from "./deps/failed";
import { typeName, type SolutionInfo, type Target } from "./deps/types";
import type { UComponent } from "./deps/upgrade";
import { confirmWrite, plural } from "./confirm-write";
import { getConnections, notify, openText, saveText, type LiveConnection } from "./host";

export interface FailedContext {
  api: () => DataverseLike | undefined;
  connection: (t: Target) => LiveConnection | undefined;
  devSolutions: () => SolutionInfo[];
  isProd: (c: LiveConnection | undefined) => boolean;
  sameUrl: (a: string | null | undefined, b: string | null | undefined) => boolean;
  setStatus: (msg: string | null) => void;
  /** open Upgrade blockers on this Dev solution and analyze */
  runPreflight: (uniqueName: string) => void;
}

let ctx: FailedContext;
let runs: FailedRun[] | null = null;
let check: FailedCheck | null = null;
/** what the current check was run on, for the re-check after a fix */
let checked: { refs: BlockedRef[]; solution: string; target: Target } | null = null;
const selections = new Map<string, string>();
let plan: FailPlan | null = null;
let planConn: { target: Target; id: string; url: string } | null = null;
let backupDone = false;
let running = false;
let applying = false;
let cancelFlag = false;
let gen = 0;
let meta = new MetaCache();

const cLabel = (c: UComponent): string => `${c.kind ?? typeName(c.type)} ${c.name}`;
const envTarget = (): Target => ($<HTMLSelectElement>("#fi-env").value === "primary" ? "primary" : "secondary");
const envConn = (): LiveConnection | undefined => ctx.connection(envTarget());

function clearPlan(): void {
  plan = null;
  planConn = null;
  backupDone = false;
}

function reset(): void {
  gen++;
  runs = null;
  check = null;
  checked = null;
  selections.clear();
  clearPlan();
  meta = new MetaCache();
  $("#fi-results").replaceChildren();
}

/** Connections changed: the environment list is refilled; anything read from the previous pair is dropped. */
export function failedOnConnections(changed: boolean): void {
  if (changed) reset();
  const sel = $<HTMLSelectElement>("#fi-env");
  const prev = sel.value;
  const s = ctx.connection("secondary");
  const p = ctx.connection("primary");
  sel.replaceChildren(
    ...[s ? h("option", { value: "secondary" }, `${s.conn.name} (target)`) : null, p ? h("option", { value: "primary" }, `${p.conn.name} (primary)`) : null].filter((x): x is HTMLOptionElement => !!x),
  );
  if (!sel.options.length) sel.append(h("option", { value: "" }, "No connection"));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  $<HTMLButtonElement>("#fi-scan").disabled = !(p || s);
  $<HTMLButtonElement>("#fi-check-paste").disabled = !(p || s);
  render();
}

function progress(on: boolean): void {
  running = on;
  $("#fi-cancel").hidden = !on;
  $("#fi-progress").hidden = !on;
  for (const id of ["#fi-scan", "#fi-check-paste"]) $<HTMLButtonElement>(id).disabled = on || !envConn();
}

async function scan(): Promise<void> {
  const a = ctx.api();
  if (!a || !envConn() || running) return;
  const g = gen;
  progress(true);
  $("#fi-progress-text").textContent = "Reading solution history…";
  try {
    const r = await fetchFailedRuns(onTarget(a, envTarget()));
    if (g !== gen) return;
    runs = r;
  } catch (e) {
    await notify("Solution history unavailable", `${(e as Error).message}. Paste the error text instead.`, "error");
  } finally {
    progress(false);
  }
  render();
  if (runs?.length && g === gen) await runCheck(runs[0].refs, runs[0].solution);
}

async function checkPaste(): Promise<void> {
  const text = $<HTMLTextAreaElement>("#fi-paste").value;
  const refs = parseBlocked(text);
  if (!refs.length) {
    await notify("Nothing to check", "No “<table>(<id>) component cannot be deleted because it is referenced by …” in the pasted text.", "warning");
    return;
  }
  const sol = $<HTMLInputElement>("#fi-solution");
  if (!sol.value.trim()) sol.value = parseSolutionName(text);
  await runCheck(refs, sol.value.trim());
}

async function runCheck(refs: BlockedRef[], solution: string, target: Target = envTarget()): Promise<void> {
  const a = ctx.api();
  const c = ctx.connection(target);
  if (!a || !c || running) return;
  const g = gen;
  cancelFlag = false;
  progress(true);
  const bar = $<HTMLProgressElement>("#fi-progress-bar");
  try {
    const r = await checkFailed({
      api: onTarget(a, target),
      meta,
      refs,
      solution,
      environment: { name: c.conn.name, url: c.conn.url },
      onProgress: (phase, done, total) => {
        bar.max = Math.max(total, 1);
        bar.value = done;
        $("#fi-progress-text").textContent = `${phase} ${done} / ${total}`;
      },
      cancelled: () => cancelFlag,
    });
    if (g !== gen) return;
    check = r;
    checked = { refs, solution, target };
    for (const [k, fix] of [...selections]) if (!r.blockers.some((b) => b.key === k && b.fixes.some((f) => f.id === fix))) selections.delete(k);
  } catch (e) {
    if (e instanceof Cancelled) await notify("Cancelled", "Check cancelled.", "info");
    else await notify("Check failed", (e as Error).message, "error");
  } finally {
    progress(false);
  }
  clearPlan();
  render();
}

// ---------- render ----------

function runsList(): HTMLElement | null {
  if (!runs) return null;
  if (!runs.length) return emptyState("No failed import with a delete blocker", `The last solution operations in ${envConn()?.conn.name ?? "this environment"} name no component that “cannot be deleted”. Paste the error text if you have it.`);
  const items = runs.map((r) =>
    h(
      "li",
      { class: "fi-run", "data-run": r.id },
      h("strong", {}, `${r.solution} ${r.version}`),
      h("span", { class: "caption" }, r.startedOn.replace("T", " ").replace(/\.\d+Z?$/, "")),
      ...r.refs.map((x) => badge(`${x.entity} ${x.id.slice(0, 8)}…`, "neutral", x.id)),
      (() => {
        const b = h("button", { class: "btn btn-sm", type: "button" }, "Check");
        b.addEventListener("click", () => void runCheck(r.refs, r.solution));
        return b;
      })(),
    ),
  );
  return foldCard("Failed imports with delete blockers", runs.length, h("ul", { class: "plain fi-runs" }, ...items), !check, { key: "fi:runs" });
}

function blockerCard(b: FailBlocker): HTMLElement {
  const actionable = b.fixes.filter((f) => f.kind !== "report");
  let tail: HTMLElement;
  if (actionable.length) {
    const sel = h("select", { class: "fix", "aria-label": `Fix for ${b.dependent.name}` }) as HTMLSelectElement;
    sel.append(h("option", { value: "" }, "No action"), ...actionable.map((f) => h("option", { value: f.id }, f.label)));
    sel.value = selections.get(b.key) ?? "";
    sel.addEventListener("change", () => {
      if (sel.value) selections.set(b.key, sel.value);
      else selections.delete(b.key);
      clearPlan();
      renderSelection();
      renderPlan();
    });
    tail = sel;
  } else {
    tail = badge(b.fixes.find((f) => f.kind === "report")?.label ?? "Report only", b.location === "dev" ? "warn" : "neutral");
    tail.classList.add("report-only");
  }
  const layers = keepFold(
    h("details", { class: "layers-fold" }, h("summary", { class: "chev" }, "Layers"), h("div", { class: "caption" }, `Top first: ${b.layers.join(" › ") || "none"}${b.layerSource === "membership" ? " · from solution membership, order unknown" : ""}`)),
    `fi-layers:${b.key}`,
    b.layerSource === "membership",
  );
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
      tail,
    ),
    h("div", { class: "cause" }, b.note),
    layers,
  );
}

function section(loc: FailLocation, list: FailBlocker[], c: FailedCheck): HTMLElement | null {
  if (!list.length) return null;
  const title = loc === "target" ? `Fix in ${c.environment.name}` : loc === "dev" ? `Fix in Dev (${c.solution})` : "Release first";
  const body: Child[] = [];
  if (loc === "dev") {
    const dev = ctx.devSolutions().find((s) => !s.isManaged && s.uniqueName.toLowerCase() === c.solution.toLowerCase());
    if (dev && checked?.target === "secondary") {
      const b = h("button", { class: "btn btn-sm", type: "button", id: "fi-preflight" }, `Run Upgrade blockers for ${dev.uniqueName}`);
      b.addEventListener("click", () => ctx.runPreflight(dev.uniqueName));
      body.push(h("p", { class: "caption" }, "Dev is the primary connection: the pre-flight compares Dev's version with this environment and offers the Dev fixes. ", b));
    }
  }
  if (loc === "release") {
    const owners = [...new Set(list.map((b) => b.owner))];
    body.push(h("p", { class: "caption", id: "fi-order" }, `Release order: ${[...owners, c.solution || "this solution"].join(" → ")}.`));
  }
  const el = foldCard(title, list.length, h("div", { class: "ub-section" }, ...body, h("ul", { class: "findings" }, ...list.map(blockerCard))), true, { key: `fi:${loc}` });
  el.id = `fi-${loc}`;
  return el;
}

function render(): void {
  const sum = $("#fi-summary");
  const body = $("#fi-body");
  const runsEl = $("#fi-runs");
  sum.replaceChildren();
  body.replaceChildren();
  runsEl.replaceChildren();
  $<HTMLButtonElement>("#fi-export-md").disabled = !check;
  $("#fi-actions").hidden = !check;
  if (!envConn()) {
    body.append(emptyState("No connection", "Connect the environment the import failed in (as the secondary connection, with Dev as the primary, or as the primary connection alone)."));
    renderPlan();
    return;
  }
  const r = runsList();
  if (r) runsEl.append(r);
  if (!check) {
    if (!runs) body.append(emptyState("Nothing checked yet", "Scan solution history for failed imports, or paste the error text. Reads only; nothing is written until you confirm a fix."));
    renderPlan();
    return;
  }
  const c = check;
  sum.append(
    h(
      "div",
      { class: "summary", id: "fi-counts" },
      h("strong", {}, `${c.solution || "Pasted error"} · ${c.environment.name}`),
      badge(`${c.components.length} component${c.components.length === 1 ? "" : "s"}`, "neutral"),
      badge(`${c.blockers.length} reference${c.blockers.length === 1 ? "" : "s"}`, c.blockers.length ? "bad" : "ok"),
    ),
    h(
      "ul",
      { class: "plain", id: "fi-components" },
      ...c.components.map((x) =>
        h(
          "li",
          {},
          x.component ? `${cLabel(x.component)}: ` : `${x.ref.entity} ${x.ref.id}: `,
          x.error ? badge(`check failed: ${x.error}`, "warn") : !x.exists ? badge("no longer exists", "ok") : x.dependents ? badge(`${x.dependents} still reference${x.dependents === 1 ? "s" : ""} it`, "bad") : badge("nothing references it now", "ok"),
        ),
      ),
    ),
  );
  for (const w of c.warnings) sum.append(h("div", { class: "warnings" }, w));
  if (!c.blockers.length) body.append(emptyState("Nothing blocks the delete now", "Import the solution again. If it fails on another component, scan again: each failed import names the first blocker it meets."));
  body.append(...(["target", "dev", "release"] as FailLocation[]).map((l) => section(l, c.blockers.filter((b) => b.location === l), c)).filter((x): x is HTMLElement => !!x));
  renderSelection();
  renderPlan();
}

function renderSelection(): void {
  $("#fi-sel-count").textContent = `${selections.size} selected`;
  $<HTMLButtonElement>("#fi-preview").disabled = selections.size === 0;
}

// ---------- fix ----------

const hasIrreversible = (): boolean => !!plan?.ops.some((o) => o.kind === "remove-active");

function updateConfirm(): void {
  const prod = ctx.isProd(envConn());
  const prodOk = !prod || $<HTMLInputElement>("#fi-prod-ack").checked;
  const irrevOk = !hasIrreversible() || $<HTMLInputElement>("#fi-irrev").checked;
  $<HTMLButtonElement>("#fi-confirm").disabled = applying || !(plan?.ops.length && backupDone && planConn && prodOk && irrevOk);
  $("#fi-backup").textContent = backupDone ? "1. Backup saved ✓" : "1. Download backup";
}

function renderPlan(): void {
  const wrap = $("#fi-plan");
  wrap.replaceChildren();
  $("#fi-fix-actions").hidden = !plan;
  $("#fi-prod-ack-wrap").hidden = !ctx.isProd(envConn());
  $("#fi-irrev-wrap").hidden = !hasIrreversible();
  if (plan) {
    const c = envConn();
    if (ctx.isProd(c)) wrap.append(h("div", { class: "danger-banner" }, `${c!.conn.name} looks like Production. These changes are written there.`));
    if (hasIrreversible()) wrap.append(h("div", { class: "warnings" }, "Remove active customizations deletes the unmanaged layer: the backup keeps its JSON as a record, but it cannot be put back by this tool."));
    if (plan.skipped.length) wrap.append(h("div", { class: "warnings" }, "Not changed: ", plan.skipped.map((x) => `${x.name} (${x.reason})`).join("; ")));
    wrap.append(
      h("h3", {}, `${plan.ops.length} operation${plan.ops.length === 1 ? "" : "s"} in ${c?.conn.name ?? ""}`),
      plan.ops.length ? h("ol", { class: "ops", id: "fi-ops" }, ...plan.ops.map((op) => h("li", { class: "op", "data-kind": op.kind }, h("span", { class: "mono" }, failOpLabel(op))))) : emptyState("No operations", "The selected fixes change nothing."),
    );
  }
  updateConfirm();
}

async function preview(): Promise<void> {
  const a = ctx.api();
  const c = checked ? ctx.connection(checked.target) : undefined;
  if (!a || !c || !check || !checked) return;
  clearPlan();
  for (const id of ["#fi-prod-ack", "#fi-irrev"]) $<HTMLInputElement>(id).checked = false;
  $("#fi-results").replaceChildren();
  ctx.setStatus("Preparing preview…");
  try {
    if (!ctx.sameUrl(c.conn.url, check.environment.url)) throw new Error(`The check was run on ${check.environment.url}, the connection is now ${c.conn.url}. Check again.`);
    const sel = [...selections].map(([k, fixId]) => ({ blocker: check!.blockers.find((b) => b.key === k)!, fixId })).filter((x) => x.blocker);
    plan = await planFailedFixes(onTarget(a, checked.target), sel);
    planConn = { target: checked.target, id: c.conn.id, url: c.conn.url };
  } catch (e) {
    clearPlan();
    await notify("Preview failed", (e as Error).message, "error");
  } finally {
    ctx.setStatus(null);
  }
  renderPlan();
}

async function downloadBackup(): Promise<void> {
  if (!check || !plan) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ok = await saveText(`dependency-cleaner-failed-import-${safeFileName(check.solution || "pasted")}-${stamp}.json`, JSON.stringify(buildFailedBackup(check, plan), null, 2));
  if (ok) {
    backupDone = true;
    await notify("Backup saved", "Keep it: Undo flow changes reads it.", "success");
  }
  updateConfirm();
}

function resultsTable(results: FailOpResult[]): HTMLElement {
  return h(
    "table",
    { id: "fi-results-table" },
    h("thead", {}, h("tr", {}, h("th", {}, "Operation"), h("th", {}, "Result"))),
    h("tbody", {}, ...results.map((r) => h("tr", {}, h("td", { class: "mono" }, failOpLabel(r.op)), h("td", {}, r.ok ? badge("ok", "ok") : badge(r.error ?? "failed", "bad"))))),
  );
}

async function confirm(): Promise<void> {
  const a = ctx.api();
  if (applying || !a || !check || !checked || !plan?.ops.length || !backupDone || !planConn) return;
  applying = true;
  updateConfirm();
  try {
    const now = (await getConnections().catch(() => [] as LiveConnection[])).find((x) => x.target === planConn!.target);
    if (!now || now.conn.id !== planConn.id || !ctx.sameUrl(now.conn.url, planConn.url)) {
      const was = planConn.url;
      clearPlan();
      renderPlan();
      await notify("Refused", `The plan was made on ${was}, the connection is now ${now?.conn.url ?? "none"}. Nothing was written.`, "error");
      return;
    }
    const active = plan.ops.filter((o) => o.kind === "remove-active").length;
    const flows = plan.ops.length - active;
    const what = [
      active && `${plural(active, "active customization")} removed (RemoveActiveCustomizations)`,
      flows && `${plural(flows, "cloud flow")} re-pointed to another connection reference (turned off, clientdata updated, turned back on)`,
    ].filter(Boolean);
    const go = await confirmWrite({
      title: "Apply fixes",
      conn: now,
      scope: `${plural(plan.ops.length, "operation")} written to this environment: ${what.join(", ")}.`,
      warnings: active
        ? ["Removing an active customization cannot be undone, by this tool or by the platform: the unmanaged layer is deleted and the managed definition takes over. The backup keeps the layer's JSON as a record only; re-create the customization by hand if you need it back."]
        : [],
      wayBack: flows
        ? "Way back for flows: the backup you saved for this plan. Undo flow changes… writes each flow's previous clientdata back."
        : "The backup you saved for this plan is a record only: nothing in it can be put back.",
      okLabel: `Apply ${plan.ops.length}`,
      danger: true,
    });
    if (!go) return;
    const before = check.blockers.length;
    const results = await executeFailedOps(onTarget(a, planConn.target), plan.ops, (i, n) => ctx.setStatus(i < n ? `Applying ${i + 1} / ${n}…` : null));
    ctx.setStatus(null);
    const failed = results.filter((r) => !r.ok).length;
    await notify(failed ? "Some operations failed" : "Applied", failed ? "See the results. Flow changes can be undone from the backup." : `${results.length} operations done. Checking again…`, failed ? "error" : "success");
    clearPlan();
    selections.clear();
    renderPlan();
    const res = $("#fi-results");
    res.replaceChildren(h("h3", {}, "Results"), resultsTable(results));
    meta = new MetaCache();
    await runCheck(checked.refs, checked.solution, checked.target);
    const after = check?.blockers.length ?? 0;
    res.append(h("div", { class: "summary", id: "fi-rerun" }, h("strong", {}, "Checked again:"), badge(`${before} → ${after} references`, after ? "bad" : "ok"), after ? null : h("span", { class: "caption" }, "Import the solution again.")));
  } finally {
    applying = false;
    updateConfirm();
  }
}

async function undo(): Promise<void> {
  const a = ctx.api();
  if (!a) return;
  const file = await openText({ title: "Failed-import backup", extensions: ["json"] });
  if (!file) return;
  try {
    const b = parseFailedBackup(file.text);
    const conn = [ctx.connection("secondary"), ctx.connection("primary")].find((c) => c && ctx.sameUrl(c.conn.url, b.environment.url));
    if (!conn) throw new Error(`The backup was taken in ${b.environment.url}; no connection points there.`);
    if (!b.flows.length) throw new Error(`Nothing to undo: the backup has no flow changes${b.activeLayers.length ? " (removed active customizations cannot be put back)" : ""}.`);
    const ok = await confirmWrite({
      title: "Undo flow changes",
      conn,
      scope: `Write back the clientdata of ${plural(b.flows.length, "flow")} from the backup of ${b.takenAt} (each one turned off, updated and turned back on if it was on): ${b.flows.map((f) => f.name).join(", ")}.`,
      warnings: b.activeLayers.length ? [`${plural(b.activeLayers.length, "removed active customization")} in this backup cannot be put back.`] : [],
      wayBack: "No new backup is taken before an undo: the flows' current clientdata is overwritten. To go forward again, re-point the flows again from this tab.",
      okLabel: "Undo",
      danger: true,
    });
    if (!ok) return;
    const out = await undoFlows(onTarget(a, conn.target), b);
    const bad = out.filter((x) => !x.ok);
    await notify(bad.length ? "Undo incomplete" : "Undone", bad.length ? bad.map((x) => `${x.name}: ${x.error}`).join("; ") : `${out.length} flow(s) restored.`, bad.length ? "error" : "success");
  } catch (e) {
    await notify("Undo refused", (e as Error).message, "error");
  }
}

async function exportMd(): Promise<void> {
  if (!check) return;
  const name = `failed-import.${safeFileName(check.solution || "pasted")}.md`;
  if (await saveText(name, failedMarkdown(check), "text/markdown")) await notify("Exported", name, "success");
}

export function initFailed(c: FailedContext): void {
  ctx = c;
  $("#fi-env").addEventListener("change", () => {
    reset();
    render();
  });
  $("#fi-scan").addEventListener("click", () => void scan());
  $("#fi-check-paste").addEventListener("click", () => void checkPaste());
  $("#fi-cancel").addEventListener("click", () => {
    cancelFlag = true;
  });
  $("#fi-preview").addEventListener("click", () => void preview());
  $("#fi-backup").addEventListener("click", () => void downloadBackup());
  for (const id of ["#fi-prod-ack", "#fi-irrev"]) $(id).addEventListener("change", updateConfirm);
  $("#fi-confirm").addEventListener("click", () => void confirm());
  $("#fi-undo").addEventListener("click", () => void undo());
  $("#fi-export-md").addEventListener("click", () => void exportMd());
  render();
}

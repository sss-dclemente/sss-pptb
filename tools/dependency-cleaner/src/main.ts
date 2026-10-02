import { mountDebug } from "../../_shared/debug-ui";
import { $, append, badge, emptyState, filteredEmpty, foldAllButtons, h, keepFold, showDialog, shownOf, wireTabs, type Child } from "../../_shared/dom";
import { persistControls, type PersistedControls } from "../../_shared/view-state";
import { backupFileName, buildBackup, parseBackup, planRestore, type Backup, type RestorePlan } from "./deps/backup";
import { parseFilter } from "./deps/classify";
import { Cancelled, diagnose, reqKey } from "./deps/diagnose";
import { findingsCsv, findingsJson, safeFileName } from "./deps/export";
import { fetchEnvironmentId, fetchSolutionManaged, fetchSolutions, MetaCache, type DataverseLike, type DependencyRow } from "./deps/fetch";
import { readSolutionZip, refName, type OfflineGroup, type OfflineResult } from "./deps/offline";
import { CT, DEFAULT_FILTER, typeName, type Diagnosis, type Finding, type FixKind, type SolutionInfo } from "./deps/types";
import { buildOps, executeOps, opLabel, prepare, xmlDiff, type Op, type OpResult, type Prepared, type ShellPlan } from "./deps/write";
import { errorList } from "./error-list";
import { initUpgrade, upgradeOnConnections } from "./upgrade-ui";
import { dataverse, getConnections, initTheme, inToolbox, notify, onConnectionChange, openText, pickBinary, saveText, type LiveConnection } from "./host";

// ---------- state ----------
let conns: LiveConnection[] = [];
let solutions: SolutionInfo[] = [];
let targetSolutions: Set<string> | null = null;
let targetSolutionList: SolutionInfo[] | null = null;
let meta = new MetaCache();
/** RetrieveRequiredComponents cache per environment url for the session */
const reqCaches = new Map<string, Map<string, DependencyRow[]>>();
let envId: string | null | undefined;
let diagnosis: Diagnosis | null = null;
const selections = new Map<string, FixKind>();
let prepared: Prepared | null = null;
let ops: Op[] = [];
let backupDone = false;
/** why the last preview was refused (conflicting fixes, connection mismatch) */
let previewError: string | null = null;
/** the primary connection the preview was made on; Confirm refuses when the current one differs */
let planConn: { id: string; url: string } | null = null;
/** bumped when the connections change, so a diagnosis started before the change is dropped */
let connGen = 0;
let cancelFlag = false;
let running = false;
/** set synchronously when Confirm starts, so a second click cannot run the operations again */
let applying = false;
/** url: the primary connection the restore plan was compared against */
let restore: { backup: Backup; plan: RestorePlan | null; url: string | null } | null = null;
/** per shell root id: the leaving list's search, type filter and "Only leaving" toggle, kept across re-renders of one preview */
interface ShellView {
  q: string;
  type: string;
  only: boolean;
}
const shellViews = new Map<string, ShellView>();
/** the zip read on the Offline tab */
let offline: OfflineResult | null = null;
/** the diagnosis / zip the type selects were filled from */
let diagTypesOf: Diagnosis | null = null;
let offlineTypesOf: OfflineResult | null = null;
/** Diagnose / Offline find + type, saved per viewer; Clear resets these and not the "Show present in target" toggles */
let diagCtl: PersistedControls;
let offCtl: PersistedControls;
/** a leaving list longer than this opens on "Only leaving" */
const ONLY_LEAVING_OVER = 30;

const api = (): DataverseLike | undefined => dataverse() as unknown as DataverseLike | undefined;
const primary = (): LiveConnection | undefined => conns.find((c) => c.target === "primary");
const secondary = (): LiveConnection | undefined => conns.find((c) => c.target === "secondary");
const isProd = (c: LiveConnection | undefined): boolean => !!c && (c.conn.environment === "Production" || /\bprod/i.test(c.conn.name));
const reqCache = (): Map<string, DependencyRow[]> => {
  const url = primary()?.conn.url ?? "";
  let m = reqCaches.get(url);
  if (!m) reqCaches.set(url, (m = new Map()));
  return m;
};
const sameUrl = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();
const connKey = (list: LiveConnection[]): string => list.map((c) => `${c.target}:${c.conn.id}:${c.conn.url}`).join("|");
/** the primary connection as the host reports it now (not the cached one) */
const currentPrimary = async (): Promise<LiveConnection | undefined> => (await getConnections().catch(() => [] as LiveConnection[])).find((c) => c.target === "primary");
const clearPlan = (): void => {
  prepared = null;
  ops = [];
  backupDone = false;
  previewError = null;
  planConn = null;
  shellViews.clear();
};
const filter = (): string[] => {
  const f = parseFilter($<HTMLInputElement>("#filter").value);
  return f.length ? f : DEFAULT_FILTER;
};

function setStatus(msg: string | null): void {
  const el = $("#status");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

/**
 * A chip that reveals `detail` on a line of its own (`line`, placed by the caller) when clicked; `title` keeps the hover.
 * aria-expanded / aria-controls tell assistive tech what the click shows.
 */
let revealSeq = 0;
/** keys of the revealed lines, so a re-render (find, type filter, toggle) keeps them open */
const revealed = new Set<string>();
function revealChip(chip: HTMLButtonElement, line: HTMLElement, key?: string): HTMLButtonElement {
  line.id ||= `reveal-${++revealSeq}`;
  const sync = (open: boolean) => {
    line.hidden = !open;
    chip.setAttribute("aria-expanded", String(open));
  };
  sync(!!key && revealed.has(key));
  chip.setAttribute("aria-controls", line.id);
  chip.addEventListener("click", () => {
    const open = line.hidden;
    sync(open);
    if (!key) return;
    if (open) revealed.add(key);
    else revealed.delete(key);
  });
  return chip;
}

function connChip(c: LiveConnection, label: string): HTMLElement[] {
  const dot = h("span", { class: "dot" });
  if (c.conn.environmentColor) dot.style.background = c.conn.environmentColor;
  const line = h("span", { class: "conn-url mono" }, c.conn.url);
  const chip = h("button", { type: "button", class: "connchip", title: c.conn.url }, dot, h("span", { class: "env" }, c.conn.name), h("span", { class: "kind" }, `${label} · ${c.conn.environment}`));
  return [revealChip(chip, line), line];
}

function solutionLink(): string {
  const p = primary();
  const sol = diagnosis?.solution;
  if (!p || !sol) return "https://make.powerapps.com/";
  return envId ? `https://make.powerapps.com/environments/${envId}/solutions/${sol.id}` : `${p.conn.url.replace(/\/+$/, "")}/tools/solution/edit.aspx?id=${sol.id}`;
}

// ---------- connections ----------
async function loadConnections(): Promise<void> {
  const before = connKey(conns);
  conns = await getConnections();
  meta = new MetaCache();
  envId = undefined;
  const changed = connKey(conns) !== before;
  if (changed) {
    // everything read or planned belongs to the previous environment
    connGen++;
    diagnosis = null;
    selections.clear();
    clearPlan();
    restore = null;
    $("#fix-results").replaceChildren();
    $("#restore-results").replaceChildren();
    $("#restore-file").textContent = "";
    renderFix();
    renderRestore();
  }
  const wrap = $("#conn");
  wrap.replaceChildren();
  const p = primary();
  const s = secondary();
  if (p) wrap.append(...connChip(p, "dev"));
  if (s) wrap.append(...connChip(s, "target"));
  if (!p) wrap.append(h("span", { class: "caption" }, inToolbox() ? "No connection. Pick a primary (dev) connection in ToolBox." : "Standalone: Offline tab only."));
  const a = api();
  solutions = [];
  targetSolutions = null;
  targetSolutionList = null;
  if (a && p) {
    setStatus("Loading solutions…");
    try {
      solutions = await fetchSolutions(a, "primary");
    } catch (e) {
      await notify("Load failed", (e as Error).message, "error");
    }
    if (s) {
      try {
        targetSolutionList = await fetchSolutions(a, "secondary");
        targetSolutions = new Set(targetSolutionList.map((x) => x.uniqueName.toLowerCase()));
      } catch (e) {
        await notify("Target load failed", `${s.conn.name}: ${(e as Error).message}`, "warning");
      }
    }
    setStatus(null);
  }
  const sel = $<HTMLSelectElement>("#solution");
  const prev = sel.value;
  const pickable = solutions.filter((x) => !x.isManaged && !["default", "active", "basic"].includes(x.uniqueName.toLowerCase()));
  sel.replaceChildren(...(pickable.length ? pickable.map((x) => h("option", { value: x.id }, `${x.friendlyName} (${x.uniqueName}) ${x.version}`)) : [h("option", { value: "" }, p ? "No unmanaged solutions" : "No connection")]));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  $<HTMLButtonElement>("#btn-run").disabled = !pickable.length;
  upgradeOnConnections(changed);
}

// ---------- diagnose ----------
/** `solutionId`: the solution to diagnose; the dropdown's when omitted (re-diagnosis after a fix passes the diagnosed one). */
async function runDiagnosis(solutionId?: string): Promise<void> {
  const a = api();
  const p = primary();
  const sol = solutions.find((x) => x.id === (solutionId ?? $<HTMLSelectElement>("#solution").value));
  if (!a || !p || !sol || running) return;
  running = true;
  cancelFlag = false;
  const gen = connGen;
  $("#btn-cancel").hidden = false;
  $<HTMLButtonElement>("#btn-run").disabled = true;
  $("#progress").hidden = false;
  const bar = $<HTMLProgressElement>("#progress-bar");
  try {
    if (envId === undefined) envId = await fetchEnvironmentId(a);
    const s = secondary();
    const d = await diagnose({
      api: a,
      meta,
      reqCache: reqCache(),
      solution: sol,
      allSolutions: solutions,
      targetSolutions,
      filter: filter(),
      environment: { name: p.conn.name, url: p.conn.url, environment: p.conn.environment },
      target: s && targetSolutions ? { name: s.conn.name, url: s.conn.url } : null,
      link: () => solutionLink(),
      onProgress: (done, total) => {
        bar.max = Math.max(total, 1);
        bar.value = done;
        $("#progress-text").textContent = `RetrieveRequiredComponents ${done} / ${total}`;
      },
      cancelled: () => cancelFlag,
    });
    if (gen !== connGen) return; // the connection changed while this ran
    diagnosis = d;
    // links need the diagnosis solution; rebuild them now that it is set
    for (const f of diagnosis.findings) for (const x of f.fixes) if (x.kind === "report") x.link = solutionLink();
    // keep a selection only while its finding still offers that fix (the dropdown shows nothing else)
    for (const [k, fix] of [...selections]) if (!diagnosis.findings.some((f) => f.key === k && f.fixes.some((x) => x.kind === fix))) selections.delete(k);
  } catch (e) {
    if (e instanceof Cancelled) await notify("Cancelled", "Diagnosis cancelled. Finished calls stay cached.", "info");
    else await notify("Diagnosis failed", (e as Error).message, "error");
  } finally {
    running = false;
    $("#btn-cancel").hidden = true;
    $<HTMLButtonElement>("#btn-run").disabled = false;
    $("#progress").hidden = true;
  }
  renderDiagnosis();
}

/** The chip, and (when Dataverse named any) the line it reveals with every managed solution that contains the component. */
function requiredChip(f: Finding, r: Finding["required"][number]): { chip: HTMLElement; line: HTMLElement | null } {
  const safe = !!r.solution && !!targetSolutions?.has(r.solution.uniqueName.toLowerCase());
  const cls = `req${safe ? " is-safe" : ""}`;
  const content: Child[] = [h("span", { class: "sol" }, r.solution?.uniqueName ?? "unknown solution"), `${typeName(r.type)} ${r.name}`, safe ? " · in target" : ""];
  if (!r.solutions.length) return { chip: h("span", { class: cls }, ...content), line: null };
  const line = h("div", { class: "req-line caption" }, `${typeName(r.type)} ${r.name} is in ${r.solutions.length} managed solution${r.solutions.length === 1 ? "" : "s"}: `, h("span", { class: "mono" }, r.solutions.join(", ")));
  const chip = h("button", { type: "button", class: cls, title: r.solutions.join(", ") }, ...content);
  return { chip: revealChip(chip, line, `${f.key}>${r.type}:${r.id}`), line };
}

function findingCard(f: Finding): HTMLElement {
  const sel = h("select", { class: "fix", "aria-label": `Fix for ${f.dependent.name}` }) as HTMLSelectElement;
  sel.append(h("option", { value: "" }, "No action"), ...f.fixes.map((x) => h("option", { value: x.kind }, x.label)));
  sel.value = selections.get(f.key) ?? "";
  sel.addEventListener("change", () => {
    if (sel.value) selections.set(f.key, sel.value as FixKind);
    else selections.delete(f.key);
    renderSelCount();
  });
  const report = f.fixes.find((x) => x.kind === "report");
  const chips = f.required.map((r) => requiredChip(f, r));
  return h(
    "li",
    { class: `finding${f.status === "safe" ? " is-safe" : ""}`, "data-key": f.key },
    h(
      "div",
      { class: "head" },
      badge(typeName(f.dependent.type), "neutral"),
      h("span", { class: "name mono" }, f.dependent.name),
      f.dependent.table || f.dependent.rootTable ? h("span", { class: "caption" }, f.dependent.table ?? f.dependent.rootTable ?? "") : null,
      f.dependent.rootBehavior === 0 ? badge("table: all assets", "warn") : null,
      badge(f.status === "blocker" ? "blocker" : "present in target", f.status === "blocker" ? "bad" : "ok"),
      sel,
    ),
    h("div", { class: "cause" }, f.cause),
    h("div", { class: "chips" }, ...chips.map((c) => c.chip)),
    ...chips.map((c) => c.line),
    report?.link ? h("div", { class: "caption" }, report.note ?? "", " ", h("a", { href: report.link, target: "_blank", rel: "noopener" }, "Open solution in maker portal")) : null,
  );
}

function renderSelCount(): void {
  $("#sel-count").textContent = `${selections.size} selected`;
  $<HTMLButtonElement>("#btn-to-fix").disabled = selections.size === 0;
}

/** Type `<select>` options from the rows shown ("Form (3)"); re-applies the saved choice once it is offered. */
function fillTypes(sel: HTMLSelectElement, types: number[], ctl: PersistedControls): void {
  const counts = new Map<number, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  sel.replaceChildren(h("option", { value: "" }, "All types"), ...[...counts].sort((a, b) => a[0] - b[0]).map(([t, n]) => h("option", { value: String(t) }, `${typeName(t)} (${n})`)));
  ctl.restore();
}

/** Search text of a finding: dependent name and table, required components, their tables and owning solutions. */
const findText = (f: Finding): string =>
  [f.dependent.name, f.dependent.table, f.dependent.rootTable, ...f.required.flatMap((r) => [r.name, r.table, r.solution?.uniqueName, r.solution?.friendlyName])]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

function renderDiagnosis(): void {
  const list = $("#findings");
  const sum = $("#diag-summary");
  list.replaceChildren();
  sum.replaceChildren();
  $("#diag-actions").hidden = !diagnosis;
  $("#diag-tools").hidden = !diagnosis?.findings.length;
  for (const id of ["#btn-export-json", "#btn-export-csv"]) $(id).toggleAttribute("disabled", !diagnosis);
  if (!diagnosis) {
    list.append(emptyState("No diagnosis yet", primary() ? "Pick an unmanaged solution and run Diagnose." : "Connect a dev environment in ToolBox, or use the Offline tab."));
    return;
  }
  const d = diagnosis;
  if (diagTypesOf !== d) {
    fillTypes($<HTMLSelectElement>("#diag-type"), d.findings.map((f) => f.dependent.type), diagCtl);
    diagTypesOf = d;
  }
  const blockers = d.findings.filter((f) => f.status === "blocker");
  const safe = d.findings.length - blockers.length;
  const showSafe = $<HTMLInputElement>("#show-safe").checked;
  const q = $<HTMLInputElement>("#diag-find").value.trim().toLowerCase();
  const type = $<HTMLSelectElement>("#diag-type").value;
  const matching = d.findings.filter((f) => (!type || String(f.dependent.type) === type) && (!q || findText(f).includes(q)));
  const shown = matching.filter((f) => showSafe || f.status === "blocker");
  sum.append(
    h(
      "div",
      { class: "summary" },
      h("strong", {}, `${d.solution.friendlyName}`),
      `${d.components.length} components ·`,
      badge(`${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`, blockers.length ? "bad" : "ok"),
      d.target ? badge(`${safe} present in target`, "ok") : h("span", { class: "caption" }, "No target connection: every dependency matching the filter counts."),
      d.errors.length ? badge(`${d.errors.length} lookups failed`, "warn") : null,
      d.findings.length ? h("span", { class: "count-caption", id: "diag-shown", "aria-live": "polite" }, `${shownOf(shown.length, d.findings.length, "findings")} shown`) : null,
    ),
  );
  for (const w of d.warnings ?? []) sum.append(h("div", { class: "warnings" }, w));
  if (d.errors.length) sum.append(errorList(`RetrieveRequiredComponents failed for ${d.errors.length} component(s)`, d.errors, "diag:errors"));
  if (!shown.length) {
    list.append(
      !d.findings.length
        ? emptyState("No blocking dependencies", "Nothing in this solution depends on the filtered solutions.")
        : !matching.length
          ? filteredEmpty("No findings match", `The search or type filter hides all ${d.findings.length} findings. The diagnosis is kept: clearing shows them again.`, () => {
              diagCtl.reset();
              renderDiagnosis();
            })
          : filteredEmpty("No blocking dependencies", `Everything ${q || type ? "that matches " : ""}found is present in the target. Tick “Show present in target” to see it.`, () => {
              const safeBox = $<HTMLInputElement>("#show-safe");
              safeBox.checked = true;
              safeBox.dispatchEvent(new Event("change")); // saves the toggle and re-renders
            }, "Show present in target"),
    );
  } else list.append(h("ul", { class: "findings" }, ...shown.map(findingCard)));
  renderSelCount();
}

// ---------- fix ----------
/** A closed-by-default fold over one XML diff; `key` keeps it open across re-renders once the user opens it. */
function diffBlock(before: string, after: string, label: string, what: string, key: string): HTMLElement {
  const lines = xmlDiff(before, after);
  const pre = h("pre", { class: "diff", "aria-label": label });
  for (const l of lines) pre.append(h("span", { class: l.t === "-" ? "del" : l.t === "+" ? "add" : l.t === "…" ? "gap" : "ctx" }, l.t === "…" ? "…" : `${l.t} ${l.s}`));
  const del = lines.filter((l) => l.t === "-").length;
  const add = lines.filter((l) => l.t === "+").length;
  return keepFold(h("details", { class: "diff-fold" }, h("summary", { class: "chev" }, `Show ${what} diff (−${del} / +${add} lines)`), pre), key);
}

/** `scope` ("fix" / "restore") keeps the two tabs' diff folds apart when they show the same form or view. */
function opItem(op: Op, scope: string): HTMLElement {
  const li = h("li", { class: "op", "data-kind": op.kind }, h("span", { class: "mono" }, opLabel(op)));
  if (op.kind === "remove" || op.kind === "add") li.append(" ", h("span", { class: "why" }, op.reason));
  if (op.kind === "update-form") {
    const e = op.edit;
    append(
      li,
      e.removed.length ? h("div", { class: "caption" }, `Removes: ${e.removed.join(", ")}`) : null,
      e.kept.length ? h("div", { class: "caption" }, `Kept: ${e.kept.map((k) => `${k.name} (${k.reason})`).join(", ")}`) : null,
      e.warnings.length ? h("div", { class: "warnings" }, e.warnings.join(" ")) : null,
      diffBlock(e.form.formxml, e.after, `formxml diff ${e.form.name}`, "form XML", `${scope}:diff:form:${e.form.id}`),
    );
  }
  if (op.kind === "update-view") {
    const e = op.edit;
    append(
      li,
      e.removed.length ? h("div", { class: "caption" }, `Removes: ${e.removed.join(", ")}`) : null,
      e.warnings.length ? h("div", { class: "warnings" }, e.warnings.join(" ")) : null,
      diffBlock(e.view.fetchxml, e.after.fetchxml, `fetchxml diff ${e.view.name}`, "view FetchXML", `${scope}:diff:fetchxml:${e.view.id}`),
      diffBlock(e.view.layoutxml, e.after.layoutxml, `layoutxml diff ${e.view.name}`, "view LayoutXML", `${scope}:diff:layoutxml:${e.view.id}`),
    );
  }
  return li;
}

/** Ops list heading with Expand all / Collapse all for its diff folds when it has at least `minDiffs` of them. */
function opsHead(id: string, title: string, list: HTMLElement, minDiffs: number): HTMLElement {
  const n = list.querySelectorAll("details.diff-fold").length;
  return h("div", { class: "ops-head", id }, h("h3", {}, title), n >= minDiffs ? foldAllButtons(list, "details.diff-fold") : null);
}

function managedRefused(): boolean {
  return !!diagnosis?.solution.isManaged;
}

function updateConfirm(): void {
  const prodOk = !isProd(primary()) || $<HTMLInputElement>("#prod-ack").checked;
  $<HTMLButtonElement>("#btn-confirm").disabled = applying || !(backupDone && ops.length && planConn && prodOk && !managedRefused());
  $("#btn-backup").textContent = backupDone ? "1. Backup saved ✓" : "1. Download backup";
}

function renderFix(): void {
  const banners = $("#fix-banners");
  const body = $("#fix-body");
  banners.replaceChildren();
  body.replaceChildren();
  $("#fix-actions").hidden = !prepared;
  updateConfirm();
  if (previewError) {
    banners.append(h("div", { class: "danger-banner", id: "preview-error" }, previewError));
    body.append(emptyState("Preview refused", "Change the selected fixes in Diagnose, then Preview fixes again."));
    return;
  }
  if (!prepared || !diagnosis) {
    body.append(emptyState("Nothing selected", "Pick a fix on one or more findings in Diagnose, then Preview fixes."));
    return;
  }
  if (managedRefused()) banners.append(h("div", { class: "danger-banner" }, `${diagnosis.solution.uniqueName} is managed. Writes are refused: fix dependencies in the dev environment, in the unmanaged solution.`));
  if (isProd(primary())) banners.append(h("div", { class: "danger-banner" }, `This connection (${primary()!.conn.name}) looks like Production. Dependencies are fixed in dev.`));
  $("#prod-ack-wrap").hidden = !isProd(primary());

  for (const sh of prepared.shells) body.append(shellCard(sh));
  if (prepared.skipped.length)
    body.append(h("div", { class: "warnings" }, "Not changed: ", prepared.skipped.map((x) => `${x.name} (${x.reason})`).join("; ")));
  body.append(h("div", { id: "ops-wrap" }));
  renderOps();
}

/**
 * One shell conversion: its subcomponents, ticked = re-added (kept), unticked = leaves the solution.
 * Search, type and "Only leaving" decide which rows show; they never change a hidden row's tick.
 * Rows are re-filtered when a filter changes, not when a tick changes, so a row just ticked stays in view.
 */
function shellCard(sh: ShellPlan): HTMLElement {
  const total = sh.leaving.length;
  let v = shellViews.get(sh.root.id);
  if (!v) shellViews.set(sh.root.id, (v = { q: "", type: "", only: total > ONLY_LEAVING_OVER }));
  const view = v;
  const leaveBadge = badge("", "warn");
  const syncBadge = () => (leaveBadge.textContent = `${sh.leaving.filter((l) => !l.keep).length} leave`);
  syncBadge();
  const changed = () => {
    syncBadge();
    ops = buildOps(prepared!);
    renderOps();
  };
  const rows = sh.leaving.map((l) => {
    const cb = h("input", { type: "checkbox", "aria-label": `Keep ${l.component.name}` }) as HTMLInputElement;
    cb.checked = l.keep;
    cb.addEventListener("change", () => {
      l.keep = cb.checked;
      changed();
    });
    const name = l.component.name ?? l.component.objectId;
    const el = h("label", { title: l.why, "data-type": String(l.component.type) }, cb, badge(typeName(l.component.type), "neutral"), h("span", { class: "mono" }, name), h("span", { class: "caption" }, l.why));
    return { l, cb, el, name: `${name} ${l.component.objectId}`.toLowerCase() };
  });
  const head = h("div", { class: "card-head" }, h("h3", {}, `Shell conversion: ${sh.root.name}`), leaveBadge);
  const intro = h("p", { class: "caption" }, "The table is removed and added back without subcomponents. Every subcomponent below leaves the solution unless ticked to re-add. Other developers may rely on them.");
  if (!total) return h("div", { class: "card shell-card" }, head, h("div", { class: "card-body" }, intro, h("p", { class: "caption" }, "No subcomponent rows.")));

  const search = h("input", { type: "text", class: "shell-search", placeholder: "Search name", "aria-label": `Search subcomponents of ${sh.root.name}` }) as HTMLInputElement;
  search.value = view.q;
  const types = [...new Set(sh.leaving.map((l) => l.component.type))].sort((a, b) => a - b);
  const typeSel = h(
    "select",
    { class: "shell-type", "aria-label": `Subcomponent type of ${sh.root.name}` },
    h("option", { value: "" }, "All types"),
    ...types.map((t) => h("option", { value: String(t) }, `${typeName(t)} (${sh.leaving.filter((l) => l.component.type === t).length})`)),
  ) as HTMLSelectElement;
  typeSel.value = types.some((t) => String(t) === view.type) ? view.type : "";
  const only = h("input", { type: "checkbox", class: "shell-only" }) as HTMLInputElement;
  only.checked = view.only;
  const caption = h("span", { class: "count-caption shell-count", "aria-live": "polite" });
  const bulk = (label: string, keep: boolean, title: string) => {
    const b = h("button", { class: "btn btn-ghost btn-sm", type: "button", title }, label);
    b.addEventListener("click", () => {
      let n = 0;
      for (const r of rows)
        if (!r.el.hidden && r.l.keep !== keep) {
          r.l.keep = r.cb.checked = keep;
          n++;
        }
      if (n) changed();
    });
    return b;
  };
  const keepAll = bulk("Keep all shown", true, "Tick every subcomponent shown: each is added back to the solution");
  const dropAll = bulk("Drop all shown", false, "Untick every subcomponent shown: each leaves the solution");
  const grid = h("div", { class: "leaving" }, ...rows.map((r) => r.el));
  const empty = filteredEmpty("No subcomponents match", "The search, type or “Only leaving” hide every subcomponent of this table.", () => {
    view.q = search.value = "";
    view.type = typeSel.value = "";
    view.only = only.checked = false;
    apply();
  });
  const apply = () => {
    const q = view.q.trim().toLowerCase();
    let shown = 0;
    for (const r of rows) {
      const show = (!view.only || !r.l.keep) && (!view.type || String(r.l.component.type) === view.type) && (!q || r.name.includes(q));
      r.el.hidden = !show;
      if (show) shown++;
    }
    caption.textContent = `${shownOf(shown, total, "subcomponents")} shown`;
    grid.hidden = !shown;
    empty.hidden = !!shown;
    keepAll.disabled = dropAll.disabled = !shown;
  };
  search.addEventListener("input", () => {
    view.q = search.value;
    apply();
  });
  typeSel.addEventListener("change", () => {
    view.type = typeSel.value;
    apply();
  });
  only.addEventListener("change", () => {
    view.only = only.checked;
    apply();
  });
  apply();
  return h(
    "div",
    { class: "card shell-card", "data-root": sh.root.id },
    head,
    h(
      "div",
      { class: "card-body" },
      intro,
      h("div", { class: "leaving-tools" }, search, typeSel, h("label", { class: "check", title: "Show only the unticked subcomponents, the ones that leave the solution" }, only, " Only leaving"), caption, h("span", { class: "spacer" }), keepAll, dropAll),
      grid,
      empty,
    ),
  );
}

function renderOps(): void {
  const wrap = document.getElementById("ops-wrap");
  if (!wrap) return;
  const title = `${ops.length} operation${ops.length === 1 ? "" : "s"} on ${diagnosis?.solution.uniqueName ?? ""}`;
  const list = h("ol", { class: "ops", id: "ops" }, ...ops.map((op) => opItem(op, "fix")));
  wrap.replaceChildren(opsHead("ops-head", title, list, 1), ops.length ? list : emptyState("No operations", "The selected fixes change nothing."));
  updateConfirm();
}

async function toFix(): Promise<void> {
  const a = api();
  const p = primary();
  if (!a || !p || !diagnosis) return;
  // only fixes the finding still offers, i.e. what its dropdown shows
  const sel = [...selections]
    .map(([k, fix]) => ({ finding: diagnosis!.findings.find((f) => f.key === k)!, fix }))
    .filter((x) => x.finding && x.finding.fixes.some((f) => f.kind === x.fix));
  setStatus("Preparing preview…");
  clearPlan();
  $<HTMLInputElement>("#prod-ack").checked = false;
  $("#fix-results").replaceChildren();
  try {
    if (!sameUrl(p.conn.url, diagnosis.environment.url)) throw new Error(`The diagnosis was run on ${diagnosis.environment.url}, the connection is now ${p.conn.url}. Run Diagnose again.`);
    prepared = await prepare(a, meta, diagnosis, sel);
    ops = buildOps(prepared);
    planConn = { id: p.conn.id, url: p.conn.url };
  } catch (e) {
    clearPlan();
    previewError = (e as Error).message;
    await notify("Preview failed", previewError, "error");
  } finally {
    setStatus(null);
  }
  (document.querySelector('.tab[data-tab="fix"]') as HTMLButtonElement).click();
  renderFix();
}

async function downloadBackup(): Promise<void> {
  if (!diagnosis || !prepared) return;
  const b = buildBackup(diagnosis, prepared, ops);
  const ok = await saveText(backupFileName(diagnosis.solution.uniqueName), JSON.stringify(b, null, 2));
  if (ok) {
    backupDone = true;
    await notify("Backup saved", "Keep it: the Restore tab reapplies it.", "success");
  }
  updateConfirm();
}

function resultsTable(results: OpResult[]): HTMLElement {
  return h(
    "table",
    {},
    h("thead", {}, h("tr", {}, h("th", {}, "Operation"), h("th", {}, "Result"))),
    h("tbody", {}, ...results.map((r) => h("tr", {}, h("td", { class: "mono" }, opLabel(r.op)), h("td", {}, r.ok ? badge("ok", "ok") : r.skipped ? badge(r.error ?? "skipped", "neutral") : badge(r.error ?? "failed", "bad"))))),
  );
}

async function confirmFix(): Promise<void> {
  const a = api();
  if (applying || !a || !diagnosis || !prepared || !backupDone || !ops.length || !planConn) return;
  applying = true;
  $<HTMLButtonElement>("#btn-confirm").disabled = true;
  try {
    await applyFix(a);
  } finally {
    applying = false;
    updateConfirm();
  }
}

async function applyFix(a: DataverseLike): Promise<void> {
  if (!diagnosis || !planConn) return;
  const sol = diagnosis.solution;
  // the plan belongs to the connection it was previewed on: re-read the host's current one
  const now = await currentPrimary();
  if (!now || now.conn.id !== planConn.id || !sameUrl(now.conn.url, planConn.url)) {
    const was = planConn.url;
    clearPlan();
    renderFix();
    await notify("Refused", `The plan was made on ${was}, the connection is now ${now?.conn.url ?? "none"}. Nothing was written: run Diagnose and Preview again.`, "error");
    return;
  }
  // D7: re-read the managed flag right before writing
  const fresh = await fetchSolutionManaged(a, sol.id).catch(() => null);
  if (!fresh || fresh.isManaged || sol.isManaged) {
    diagnosis = { ...diagnosis, solution: { ...diagnosis.solution, isManaged: true } };
    renderFix();
    await notify("Refused", `${sol.uniqueName} is managed (or could not be read). Nothing was written.`, "error");
    return;
  }
  $<HTMLButtonElement>("#btn-confirm").disabled = true;
  const before = diagnosis.findings.filter((f) => f.status === "blocker").map((f) => f.key);
  const touched = new Set<string>();
  for (const op of ops) {
    if (op.kind === "update-form") touched.add(reqKey(CT.Form, op.edit.form.id));
    if (op.kind === "update-view") touched.add(reqKey(CT.View, op.edit.view.id));
    if (op.kind === "remove" || op.kind === "add") touched.add(reqKey(op.component.type, op.component.id));
  }
  const results = await executeOps(a, ops, fresh.uniqueName, (i, n) => setStatus(i < n ? `Applying ${i + 1} / ${n}…` : null));
  setStatus(null);
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  await notify(failed ? "Some operations failed" : "Applied", failed ? "Restore from the backup if needed." : `${results.length} operations done. Re-running diagnosis…`, failed ? "error" : "success");
  for (const k of touched) reqCache().delete(k);
  clearPlan();
  selections.clear();
  renderFix();
  const res = $("#fix-results");
  res.replaceChildren(h("h3", {}, "Results"), resultsTable(results));
  // re-diagnose (plan §3.4) the solution that was fixed, whatever the dropdown shows now
  await runDiagnosis(sol.id);
  const nowKeys = new Set((diagnosis?.findings ?? []).filter((f) => f.status === "blocker").map((f) => f.key));
  const fixed = before.filter((k) => !nowKeys.has(k)).length;
  res.append(
    h("div", { class: "summary", id: "rediag" }, h("strong", {}, "Re-diagnosis:"), badge(`${fixed} fixed`, "ok"), badge(`${before.length - fixed} still present`, before.length - fixed ? "bad" : "ok"), badge(`${nowKeys.size} blockers now`, nowKeys.size ? "bad" : "ok")),
  );
}

// ---------- restore ----------
async function loadBackup(): Promise<void> {
  const f = await openText({ title: "Open Dependency Cleaner backup", extensions: ["json"] });
  if (!f) return;
  $("#restore-results").replaceChildren();
  try {
    restore = { backup: parseBackup(f.text), plan: null, url: null };
    $("#restore-file").textContent = f.name;
  } catch (e) {
    restore = null;
    await notify("Backup rejected", `${f.name}: ${(e as Error).message}`, "error");
    renderRestore();
    return;
  }
  const a = api();
  const p = primary();
  if (a && p) {
    setStatus("Comparing backup to the environment…");
    restore.url = p.conn.url;
    try {
      restore.plan = await planRestore(a, restore.backup, solutions.length ? solutions : await fetchSolutions(a, "primary"), p.conn.url);
    } catch (e) {
      await notify("Restore refused", (e as Error).message, "error");
      renderRestore((e as Error).message);
      setStatus(null);
      return;
    }
    setStatus(null);
  }
  renderRestore();
}

function renderRestore(error?: string): void {
  const body = $("#restore-body");
  body.replaceChildren();
  $("#restore-actions").hidden = !restore?.plan;
  $<HTMLButtonElement>("#btn-restore-apply").disabled = !restore?.plan?.ops.length;
  if (!restore) {
    body.append(emptyState("No backup loaded", "Load a dependency-cleaner-backup-*.json file saved before a fix."));
    return;
  }
  const b = restore.backup;
  body.append(h("p", { class: "caption" }, `Backup of ${b.solution.uniqueName} from ${b.environment.name}, ${b.takenAt}. ${b.membership.length} members, ${b.forms.length} forms, ${b.views.length} views${b.apps?.length ? `, ${b.apps.length} app(s)` : ""}.`));
  if (error) body.append(h("div", { class: "danger-banner", id: "restore-error" }, error));
  if (!restore.plan) return;
  for (const n of restore.plan.notes) body.append(h("div", { class: "warnings" }, n));
  if (isProd(primary())) body.append(h("div", { class: "danger-banner" }, `This connection (${primary()!.conn.name}) looks like Production.`));
  if (!restore.plan.ops.length) {
    body.append(emptyState("Nothing to restore", "The environment already matches the backup."));
    return;
  }
  const list = h("ol", { class: "ops", id: "restore-ops" }, ...restore.plan.ops.map((op) => opItem(op, "restore")));
  body.append(opsHead("restore-ops-head", `${restore.plan.ops.length} operation${restore.plan.ops.length === 1 ? "" : "s"} to restore`, list, 2), list);
}

async function applyRestore(): Promise<void> {
  const a = api();
  if (!a || !restore?.plan) return;
  const plan = restore.plan;
  const now = await currentPrimary();
  if (!now || !sameUrl(now.conn.url, restore.url) || !sameUrl(now.conn.url, restore.backup.environment?.url)) {
    restore.plan = null;
    renderRestore();
    await notify("Refused", `The backup is from ${restore.backup.environment?.url ?? "an unknown environment"}, the connection is now ${now?.conn.url ?? "none"}. Nothing was written: load the backup again on the right connection.`, "error");
    return;
  }
  const fresh = await fetchSolutionManaged(a, plan.solution.id).catch(() => null);
  if (!fresh || fresh.isManaged) {
    await notify("Refused", `${plan.solution.uniqueName} is managed (or could not be read). Nothing was written.`, "error");
    return;
  }
  const ok = await showDialog({
    title: "Apply restore",
    body: h("p", {}, `${plan.ops.length} operations on ${plan.solution.uniqueName} in ${primary()?.conn.name ?? ""}.`),
    okLabel: `Apply ${plan.ops.length}`,
    danger: isProd(primary()),
  });
  if (!ok) return;
  const results = await executeOps(a, plan.ops, fresh.uniqueName, (i, n) => setStatus(i < n ? `Restoring ${i + 1} / ${n}…` : null));
  setStatus(null);
  for (const op of plan.ops) {
    if (op.kind === "update-form") reqCache().delete(reqKey(CT.Form, op.edit.form.id));
    if (op.kind === "update-view") reqCache().delete(reqKey(CT.View, op.edit.view.id));
  }
  const failed = results.filter((r) => !r.ok && !r.skipped).length;
  await notify(failed ? "Restore incomplete" : "Restored", `${results.length - failed} ok, ${failed} failed`, failed ? "error" : "success");
  restore.plan = null;
  renderRestore();
  $("#restore-results").replaceChildren(h("h3", {}, "Restore results"), resultsTable(results));
}

// ---------- offline ----------
async function openZip(name: string, data: Uint8Array): Promise<void> {
  try {
    offline = await readSolutionZip(name, data, filter(), targetSolutions);
    renderOffline();
  } catch (e) {
    offline = null;
    renderOffline((e as Error).message);
  }
}

const offlineText = (g: OfflineGroup): string =>
  [refName(g.dependent), g.dependent.parentSchemaName, ...g.required.flatMap((x) => [refName(x), x.parentSchemaName, x.solution])]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

function renderOffline(error?: string): void {
  const head = $("#offline-head");
  const out = $("#offline-list");
  head.replaceChildren();
  out.replaceChildren();
  $("#off-tools").hidden = !offline?.groups.length;
  if (error) head.append(h("div", { class: "danger-banner" }, error));
  if (!offline) return;
  const r = offline;
  if (offlineTypesOf !== r) {
    fillTypes($<HTMLSelectElement>("#off-type"), r.groups.map((g) => g.dependent.type), offCtl);
    offlineTypesOf = r;
  }
  const blockers = r.groups.filter((g) => g.status === "blocker").length;
  const q = $<HTMLInputElement>("#off-find").value.trim().toLowerCase();
  const type = $<HTMLSelectElement>("#off-type").value;
  const showSafe = $<HTMLInputElement>("#off-show-safe").checked;
  const matching = r.groups.filter((g) => (!type || String(g.dependent.type) === type) && (!q || offlineText(g).includes(q)));
  const shown = matching.filter((g) => showSafe || g.status === "blocker");
  const refLabel = (x: { typeName: string; schemaName: string | null; displayName: string | null; id: string | null; parentSchemaName: string | null }) =>
    `${x.typeName} ${refName(x as Parameters<typeof refName>[0])}${x.parentSchemaName ? ` (${x.parentSchemaName})` : ""}`;
  const cards: Child[] = shown.map((g) =>
    h(
      "li",
      { class: `finding${g.status === "safe" ? " is-safe" : ""}`, "data-key": g.key },
      h("div", { class: "head" }, badge(g.dependent.typeName, "neutral"), h("span", { class: "name mono" }, refName(g.dependent)), g.dependent.parentSchemaName ? h("span", { class: "caption" }, g.dependent.parentSchemaName) : null, badge(g.status === "blocker" ? "blocker" : "present in target", g.status === "blocker" ? "bad" : "ok")),
      h("div", { class: "chips" }, ...g.required.map((x) => h("span", { class: `req${x.safe ? " is-safe" : ""}` }, h("span", { class: "sol" }, x.solution ?? "unknown solution"), refLabel(x)))),
    ),
  );
  head.append(
    h(
      "div",
      { class: "summary", id: "offline-summary" },
      h("strong", {}, `${r.uniqueName} ${r.version}`),
      r.managed ? badge("managed", "neutral") : badge("unmanaged", "neutral"),
      `${r.total} missing dependencies in solution.xml ·`,
      badge(`${r.groups.length} dependents in scope`, "neutral"),
      badge(`${blockers} blocking`, blockers ? "bad" : "ok"),
      r.groups.length ? h("span", { class: "count-caption", id: "offline-shown", "aria-live": "polite" }, `${shownOf(shown.length, r.groups.length, "dependents")} shown`) : null,
    ),
  );
  out.append(
    shown.length
      ? h("ul", { class: "findings" }, ...cards)
      : !r.groups.length
        ? emptyState("No missing dependencies in scope", `Filter: ${filter().join(", ")}`)
        : !matching.length
          ? filteredEmpty("No dependents match", `The search or type filter hides all ${r.groups.length} dependents.`, () => {
              offCtl.reset();
              renderOffline();
            })
          : filteredEmpty("No blocking dependencies", `Every dependent ${q || type ? "that matches " : ""}is present in the target. Tick “Show present in target” to see it.`, () => {
              const safeBox = $<HTMLInputElement>("#off-show-safe");
              safeBox.checked = true;
              safeBox.dispatchEvent(new Event("change")); // saves the toggle and re-renders
            }, "Show present in target"),
  );
}

function wireDrop(): void {
  const dz = $("#drop");
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("is-over");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("is-over"));
  dz.addEventListener("drop", async (e) => {
    e.preventDefault();
    dz.classList.remove("is-over");
    const f = e.dataTransfer?.files?.[0];
    if (f) await openZip(f.name, new Uint8Array(await f.arrayBuffer()));
  });
  $("#btn-open-zip").addEventListener("click", async () => {
    const [f] = await pickBinary({ title: "Open solution zip", extensions: ["zip"] });
    if (f) await openZip(f.name, f.data);
  });
}

// ---------- wiring ----------
async function exportFile(name: string, content: string, mime: string): Promise<void> {
  if (await saveText(name, content, mime)) await notify("Exported", name, "success");
}

function wire(): void {
  persistControls("dependency-cleaner", ["show-safe", "ub-scan", "off-show-safe"]);
  diagCtl = persistControls("dependency-cleaner", ["diag-find", "diag-type"]);
  offCtl = persistControls("dependency-cleaner", ["off-find", "off-type"]);
  wireTabs(() => undefined);
  $("#btn-run").addEventListener("click", () => void runDiagnosis());
  $("#btn-cancel").addEventListener("click", () => {
    cancelFlag = true;
  });
  $("#show-safe").addEventListener("change", renderDiagnosis);
  $("#diag-find").addEventListener("input", renderDiagnosis);
  $("#diag-type").addEventListener("change", renderDiagnosis);
  $("#off-find").addEventListener("input", () => renderOffline());
  $("#off-type").addEventListener("change", () => renderOffline());
  $("#off-show-safe").addEventListener("change", () => renderOffline());
  $("#btn-to-fix").addEventListener("click", () => void toFix());
  $("#btn-backup").addEventListener("click", () => void downloadBackup());
  $("#prod-ack").addEventListener("change", updateConfirm);
  $("#btn-confirm").addEventListener("click", () => void confirmFix());
  $("#btn-load-backup").addEventListener("click", () => void loadBackup());
  $("#btn-restore-apply").addEventListener("click", () => void applyRestore());
  $("#btn-export-json").addEventListener("click", () => {
    if (diagnosis) void exportFile(`dependency-findings.${safeFileName(diagnosis.solution.uniqueName)}.json`, findingsJson(diagnosis), "application/json");
  });
  $("#btn-export-csv").addEventListener("click", () => {
    if (diagnosis) void exportFile(`dependency-findings.${safeFileName(diagnosis.solution.uniqueName)}.csv`, findingsCsv(diagnosis), "text/csv");
  });
  wireDrop();
  initUpgrade({
    api,
    primary,
    secondary,
    currentPrimary,
    devSolutions: () => solutions,
    targetSolutions: () => targetSolutionList,
    isProd,
    sameUrl,
    setStatus,
  });
  onConnectionChange(() => void loadConnections().then(renderDiagnosis));
  $("#host-mode").textContent = inToolbox() ? "Running inside Power Platform ToolBox" : "Standalone mode (Offline tab only)";
}

mountDebug(document.querySelector("footer"), "dependency-cleaner");
void initTheme((t) => document.documentElement.setAttribute("data-theme", t));
wire();
renderDiagnosis();
renderFix();
renderRestore();
void loadConnections();

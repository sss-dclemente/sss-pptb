import { mountDebug } from "../../_shared/debug-ui";
import { $, append, badge, emptyState, filteredEmpty, h, showDialog, shownOf, type Child } from "../../_shared/dom";
import { loadView, persistControls, saveView } from "../../_shared/view-state";
import { errText, isSetupError, listEnvironments, listPackages, type PpLike } from "./apps/api";
import { matrixCsv, pacScript, resultsCsv } from "./apps/export";
import { buildMatrix, cellKey, counts, emptyEnvIds, failedKeys, isProduction, planInstalls, updateKeys, visibleEnvs } from "./apps/matrix";
import { runInstalls, toRunItems } from "./apps/run";
import type { DvLike } from "./apps/unused";
import type { Cell, EnvPackages, Environment, Matrix, PlannedInstall, Row, RunItem } from "./apps/types";
import { initUnused, unusedAvailable } from "./unused-ui";
import { dataverse, getConnections, initTheme, inToolbox, notify, onConnectionChange, powerplatform, saveText, type LiveConnection } from "./host";

const STORE_KEY = "sss-d365-apps:envs";
const TOOL_ID = "d365-apps";
const ENV_CONCURRENCY = 4;
/** poll interval; ?pollMs= overrides it (tests) */
const POLL_MS = (() => {
  const v = Number(new URLSearchParams(location.search).get("pollMs"));
  return Number.isFinite(v) && v >= 10 ? v : 15_000;
})();

// ---------- state ----------
let conn: LiveConnection | undefined;
let envs: Environment[] = [];
let picked: string[] = [];
let results: EnvPackages[] = [];
let matrix: Matrix | null = null;
const selected = new Set<string>();
let run: RunItem[] = [];
let running = false;
let stopFlag = false;
let gen = 0;
/** Environment columns hidden with ✕ (local only, no reload); persisted per viewer. */
const hiddenEnvs = new Set<string>(
  (() => {
    const v = loadView<unknown>(TOOL_ID, "hiddenEnvs", []);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  })(),
);

const pp = (): PpLike | undefined => powerplatform() as unknown as PpLike | undefined;

function setStatus(msg: string | null): void {
  const el = $("#status");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}

function readStore(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writeStore(ids: string[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(ids));
  } catch {
    /* storage blocked */
  }
}

function setupBanner(kind: "nohost" | "noconn" | "api", detail?: string): void {
  const el = $("#setup");
  if (kind === "nohost") {
    el.replaceChildren(h("div", { class: "setup", id: "setup-banner" }, h("strong", {}, "Needs Power Platform ToolBox 1.2.6 or later. "), "This tool uses the Power Platform API (window.powerplatformAPI), which older hosts do not provide."));
    return;
  }
  if (kind === "noconn") {
    el.replaceChildren(h("div", { class: "setup", id: "setup-banner" }, h("strong", {}, "No connection. "), "Pick a connection in ToolBox that has the Power Platform API enabled."));
    return;
  }
  el.replaceChildren(
    h(
      "div",
      { class: "setup", id: "setup-banner" },
      h("strong", {}, "The Power Platform API refused the call. "),
      detail ? `${detail}. ` : "",
      "Enable the Power Platform API on this ToolBox connection (custom client id: your own Entra app registration) and grant it the delegated permissions ",
      h("code", {}, "EnvironmentManagement.Environments.Read"),
      ", ",
      h("code", {}, "AppManagement.ApplicationPackages.Read"),
      " and ",
      h("code", {}, "AppManagement.ApplicationPackages.Install"),
      ". You also need admin rights on each environment (Power Platform admin or System Administrator).",
    ),
  );
}

// ---------- load ----------
async function start(): Promise<void> {
  const g = ++gen;
  $("#setup").replaceChildren();
  unusedAvailable(false);
  results = [];
  matrix = null;
  selected.clear();
  const conns = await getConnections().catch(() => [] as LiveConnection[]);
  if (g !== gen) return;
  conn = conns.find((c) => c.target === "primary");
  renderConn();
  const p = pp();
  if (!p) {
    setupBanner("nohost");
    render();
    return;
  }
  if (!conn && inToolbox()) {
    setupBanner("noconn");
    render();
    return;
  }
  setStatus("Loading environments…");
  try {
    envs = (await listEnvironments(p)).filter((e) => e.hasDataverse);
  } catch (e) {
    if (g !== gen) return;
    setStatus(null);
    if (isSetupError(e)) setupBanner("api", errText(e));
    else await notify("Environments failed", errText(e), "error");
    render();
    return;
  }
  if (g !== gen) return;
  setStatus(null);
  $<HTMLButtonElement>("#btn-envs").disabled = false;
  unusedAvailable(!!dataverse() && envs.length > 0);
  const stored = readStore().filter((id) => envs.some((e) => e.id === id));
  picked = stored.length ? stored : await defaultPick();
  if (g !== gen) return;
  if (!picked.length) {
    render();
    await pickEnvironments();
    return;
  }
  await loadPackages();
}

/** The connection's environment id (RetrieveCurrentOrganization), null when unknown. */
async function connectionEnvId(): Promise<string | null> {
  try {
    const r = (await dataverse()?.execute({ operationName: "RetrieveCurrentOrganization", operationType: "function", parameters: { AccessType: "Microsoft.Dynamics.CRM.EndpointAccessType'Default'" } })) as { Detail?: { EnvironmentId?: string } } | undefined;
    return r?.Detail?.EnvironmentId ?? null;
  } catch {
    return null;
  }
}

/** The connection's own environment, else nothing. */
async function defaultPick(): Promise<string[]> {
  const id = await connectionEnvId();
  return id && envs.some((e) => e.id === id) ? [id] : [];
}

async function loadPackages(only?: string[]): Promise<void> {
  const p = pp();
  if (!p) return;
  const g = gen;
  const targets = envs.filter((e) => picked.includes(e.id) && (!only || only.includes(e.id)));
  const keep = only ? results.filter((r) => !only.includes(r.env.id) && picked.includes(r.env.id)) : [];
  const fresh: EnvPackages[] = [];
  let done = 0;
  setStatus(`Reading apps 0 / ${targets.length} environments…`);
  const queue = [...targets];
  await Promise.all(
    Array.from({ length: Math.min(ENV_CONCURRENCY, queue.length) }, async () => {
      for (let env = queue.shift(); env; env = queue.shift()) {
        try {
          const r = await listPackages(p, env.id);
          fresh.push({ env, ...r, error: null, setupError: false });
        } catch (e) {
          fresh.push({ env, installed: [], available: [], error: errText(e), setupError: isSetupError(e) });
        }
        setStatus(`Reading apps ${++done} / ${targets.length} environments…`);
      }
    }),
  );
  if (g !== gen) return;
  setStatus(null);
  const order = new Map(picked.map((id, i) => [id, i]));
  results = [...keep, ...fresh].sort((a, b) => (order.get(a.env.id) ?? 0) - (order.get(b.env.id) ?? 0));
  if (fresh.length && fresh.every((r) => r.setupError)) setupBanner("api", fresh[0].error ?? undefined);
  rebuild();
}

function rebuild(): void {
  matrix = buildMatrix(results, { showNotInstalled: $<HTMLInputElement>("#show-available").checked });
  // drop selections that no longer have an action
  for (const k of [...selected]) {
    const [envId, name] = k.split("|");
    const c = matrix.rows.find((r) => r.uniqueName.toLowerCase() === name)?.cells.get(envId);
    if (!c?.action) selected.delete(k);
  }
  render();
}

// ---------- environment picker ----------
async function pickEnvironments(): Promise<void> {
  const filter = h("input", { type: "search", placeholder: "Filter environments…", "aria-label": "Filter environments" }) as HTMLInputElement;
  const boxes = envs.map((e) => {
    const cb = h("input", { type: "checkbox", value: e.id, "data-env": e.id }) as HTMLInputElement;
    cb.checked = picked.includes(e.id);
    const label = h("label", { title: e.url ?? "" }, cb, h("span", {}, e.name), badge(e.type || "?", isProduction(e) ? "bad" : "neutral"));
    return { e, cb, label };
  });
  const list = h("div", { class: "list" }, ...boxes.map((b) => b.label));
  filter.addEventListener("input", () => {
    const q = filter.value.toLowerCase();
    for (const b of boxes) b.label.hidden = !!q && !`${b.e.name} ${b.e.type} ${b.e.url ?? ""}`.toLowerCase().includes(q);
  });
  const all = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Tick shown");
  all.addEventListener("click", () => boxes.filter((b) => !b.label.hidden).forEach((b) => (b.cb.checked = true)));
  const none = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, "Untick all");
  none.addEventListener("click", () => boxes.forEach((b) => (b.cb.checked = false)));
  const ok = await showDialog({
    title: "Environments",
    body: h("div", { class: "envpick" }, h("div", { class: "toolbar" }, filter, all, none), h("p", { class: "caption" }, `${envs.length} environments with a Dataverse database. Each ticked one is a column; reading it costs two calls.`), list),
    okLabel: "Load",
  });
  if (!ok) return;
  const added = boxes.filter((b) => b.cb.checked && !picked.includes(b.e.id)).map((b) => b.e.id);
  picked = boxes.filter((b) => b.cb.checked).map((b) => b.e.id);
  writeStore(picked);
  // an environment ticked again in the picker comes back as a column even if it was hidden with ✕
  if (added.some((id) => hiddenEnvs.delete(id))) saveHidden();
  await loadPackages();
}

// ---------- render ----------
function renderConn(): void {
  const wrap = $("#conn");
  wrap.replaceChildren();
  if (!conn) return;
  const dot = h("span", { class: "dot" });
  if (conn.conn.environmentColor) dot.style.background = conn.conn.environmentColor;
  wrap.append(h("span", { class: "connchip", title: conn.conn.url }, dot, h("span", { class: "env" }, conn.conn.name), h("span", { class: "kind" }, "Power Platform API")));
}

const ACTION_LABEL = { update: "Update", retry: "Retry", install: "Install" } as const;

function cellNode(envId: string, uniqueName: string, c: Cell): HTMLElement {
  const k = cellKey(envId, uniqueName);
  const live = run.find((i) => i.env.id === envId && i.uniqueName.toLowerCase() === uniqueName.toLowerCase() && (running || i.status !== "succeeded"));
  const td = h("td", { class: `cell k-${c.kind}${selected.has(k) ? " is-selected" : ""}`, "data-cell": k });
  const ver = (v: string | null | undefined) => h("span", { class: "ver" }, v ?? "?");
  let main: Child;
  switch (c.kind) {
    case "current":
      main = ver(c.installed?.version);
      break;
    case "update":
      main = h("span", {}, ver(c.installed?.version), " → ", ver(c.target?.version));
      break;
    case "failed":
      main = h("span", {}, badge("failed", "bad"), " ", c.installed?.version ? ver(c.installed.version) : "");
      break;
    case "busy":
      main = badge(c.note ?? "busy", "warn");
      break;
    case "available":
      main = h("span", {}, "available ", ver(c.target?.version));
      break;
    default:
      main = "—";
  }
  if (c.action && !running) {
    const cb = h("input", { type: "checkbox", "aria-label": `${ACTION_LABEL[c.action]} ${uniqueName} in ${envId}` }) as HTMLInputElement;
    cb.checked = selected.has(k);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(k);
      else selected.delete(k);
      td.classList.toggle("is-selected", cb.checked);
      renderSelection();
    });
    td.append(h("label", { title: ACTION_LABEL[c.action] }, cb, main));
  } else td.append(main as Node | string);
  if (c.note && c.kind !== "busy") td.append(h("span", { class: "note" }, c.note));
  if (live) td.append(h("span", { class: "note", "data-run": live.status }, `${live.status}${live.message ? `: ${live.message}` : ""}`));
  return td;
}

// ---------- environment columns: ✕ per column, "Hide empty environments" ----------
function saveHidden(): void {
  saveView(TOOL_ID, "hiddenEnvs", hiddenEnvs.size ? [...hiddenEnvs] : undefined);
}
const hideEmpty = (): boolean => $<HTMLInputElement>("#hide-empty").checked;
/** The environment columns shown, in column order. */
const shownEnvs = (m: Matrix): Environment[] => visibleEnvs(m, hiddenEnvs, hideEmpty());
const shownEnvIds = (m: Matrix): Set<string> => new Set(shownEnvs(m).map((e) => e.id));

function hideEnv(id: string): void {
  hiddenEnvs.add(id);
  saveHidden();
  render();
}

/** "Show all": un-hide the ✕ columns, and untick "Hide empty environments" when it hides any, so every column shows and the toolbar says why. */
function showAllEnvs(): void {
  hiddenEnvs.clear();
  saveHidden();
  const cb = $<HTMLInputElement>("#hide-empty");
  if (cb.checked && matrix && emptyEnvIds(matrix).size) {
    cb.checked = false;
    cb.dispatchEvent(new Event("change")); // saved by persistControls
  }
  render();
}

/** The rows the matrix shows (name filter, "Only updates / failed" in the shown columns). The select-all buttons and the hidden count use the same test. */
function shownFilter(m: Matrix): (r: Row) => boolean {
  const q = $<HTMLInputElement>("#filter-text").value.toLowerCase();
  const onlyUpd = $<HTMLInputElement>("#only-updates").checked;
  const cols = shownEnvIds(m);
  return (r) => (!q || `${r.name} ${r.uniqueName} ${r.publisher ?? ""}`.toLowerCase().includes(q)) && (!onlyUpd || [...r.cells].some(([id, c]) => cols.has(id) && (c.kind === "update" || c.kind === "failed")));
}
const shownNames = (m: Matrix): Set<string> => new Set(m.rows.filter(shownFilter(m)).map((r) => r.uniqueName));
/** Cell visibility for the select-all buttons and the hidden count: shown row and shown column. */
function shownCell(m: Matrix): (uniqueName: string, envId: string) => boolean {
  const rows = new Set([...shownNames(m)].map((u) => u.toLowerCase()));
  const cols = shownEnvIds(m);
  return (u, envId) => rows.has(u.toLowerCase()) && cols.has(envId);
}

function render(): void {
  const wrap = $("#matrix");
  const sum = $("#summary");
  sum.replaceChildren();
  $<HTMLButtonElement>("#btn-refresh").disabled = running || !picked.length;
  $<HTMLButtonElement>("#btn-envs").disabled = running || !envs.length;
  $<HTMLButtonElement>("#btn-export-csv").disabled = !matrix?.rows.length;
  $<HTMLButtonElement>("#btn-select-updates").disabled = running || !matrix;
  $<HTMLButtonElement>("#btn-select-failed").disabled = running || !matrix || counts(matrix).failed === 0;
  if (!matrix) {
    wrap.replaceChildren(emptyState(envs.length ? "No environments loaded" : "Nothing loaded yet", envs.length ? "Pick environments (Environments…)." : "Connect in ToolBox with the Power Platform API enabled."));
    renderSelection();
    return;
  }
  const m = matrix;
  const n = counts(m);
  const cols = shownEnvs(m);
  const rows = m.rows.filter(shownFilter(m));
  const hiddenCols = m.envs.filter((e) => !cols.includes(e));
  let showAll: HTMLElement | null = null;
  if (hiddenCols.length) {
    showAll = h("button", { class: "btn btn-ghost btn-sm", type: "button", id: "btn-show-envs" }, "Show all");
    showAll.addEventListener("click", showAllEnvs);
  }
  const empty = emptyEnvIds(m);
  append(
    sum,
    h("strong", { id: "counts" }, `${shownOf(rows.length, m.rows.length, "apps")} × ${shownOf(cols.length, m.envs.length, "environments")}`),
    hiddenCols.length
      ? h(
          "span",
          { class: "caption env-hidden", id: "env-hidden", title: `Hidden: ${hiddenCols.map((e) => `${e.name}${hiddenEnvs.has(e.id) ? "" : " (nothing installed)"}`).join(", ")}${hiddenCols.some((e) => !hiddenEnvs.has(e.id) && empty.has(e.id)) ? ". Untick Hide empty environments to show empty ones." : ""}` },
          `${hiddenCols.length} environment${hiddenCols.length === 1 ? "" : "s"} hidden · `,
          showAll,
        )
      : null,
    badge(`${n.updates} update${n.updates === 1 ? "" : "s"}`, n.updates ? "warn" : "ok"),
    n.failed ? badge(`${n.failed} failed`, "bad") : null,
    n.busy ? badge(`${n.busy} in progress`, "warn") : null,
    m.errors.size ? badge(`${m.errors.size} environment(s) unreadable`, "bad") : null,
  );
  const head = h(
    "tr",
    {},
    h("th", { class: "sticky-col" }, "App"),
    ...cols.map((e) =>
      h(
        "th",
        { class: "col", "data-env": e.id },
        h("span", { class: "col-head" }, h("span", { class: "env" }, e.name), hideButton(e)),
        badge(e.type || "?", isProduction(e) ? "bad" : "neutral"),
        m.errors.has(e.id) ? h("span", { class: "col-error" }, m.errors.get(e.id)!) : null,
      ),
    ),
  );
  const body = rows.map((r) =>
    h(
      "tr",
      { "data-app": r.uniqueName },
      h("td", { class: "name sticky-col" }, h("span", {}, r.name), r.customHandleUpgrade ? " " : null, r.customHandleUpgrade ? badge("custom upgrade", "warn") : null, h("span", { class: "uname" }, r.uniqueName)),
      ...cols.map((e) => cellNode(e.id, r.uniqueName, r.cells.get(e.id)!)),
    ),
  );
  wrap.replaceChildren(
    !m.rows.length
      ? emptyState("No apps", "No Dynamics 365 apps installed in the selected environments.")
      : !cols.length
        ? filteredEmpty("All environments hidden", "Every environment column is hidden (✕ or Hide empty environments).", showAllEnvs, "Show all")
        : rows.length
          ? h("table", { class: "matrix", id: "grid" }, h("thead", {}, head), h("tbody", {}, ...body))
          : filteredEmpty("No apps", "Nothing matches the filter.", () => {
              filters.reset();
              render();
            }),
  );
  renderSelection();
}

function hideButton(e: Environment): HTMLElement {
  const x = h("button", { class: "btn-icon col-hide", type: "button", title: "Hide this column (no reload; Show all brings it back)", "aria-label": `Hide ${e.name}` }, "✕");
  x.addEventListener("click", () => hideEnv(e.id));
  return x;
}

function renderSelection(): void {
  // a selection in a filtered-out row or a hidden column stays selected (and in the plan, flagged there) but is counted here
  const shown = matrix ? shownCell(matrix) : null;
  const hidden = shown ? [...selected].filter((k) => {
    const [envId, name] = k.split("|");
    return !shown(name, envId);
  }).length : 0;
  $("#sel-count").textContent = selected.size ? `${selected.size} selected${hidden ? ` (${hidden} hidden by filter)` : ""}` : "";
  for (const id of ["#btn-preview", "#btn-pac"]) $<HTMLButtonElement>(id).disabled = running || !selected.size;
  $<HTMLButtonElement>("#btn-clear-sel").disabled = running || !selected.size;
}

// ---------- run ----------
function planNode(plan: PlannedInstall[], shownCols: Set<string>): HTMLElement {
  const byEnv = new Map<string, PlannedInstall[]>();
  for (const p of plan) byEnv.set(p.env.id, [...(byEnv.get(p.env.id) ?? []), p]);
  const prod = plan.filter((p) => isProduction(p.env));
  const custom = plan.filter((p) => p.customHandleUpgrade);
  const offscreen = plan.filter((p) => !shownCols.has(p.env.id));
  return h(
    "div",
    { id: "plan" },
    prod.length ? h("div", { class: "danger-banner" }, `${new Set(prod.map((p) => p.env.id)).size} Production environment(s). Installs take the app's components through an upgrade; there is no undo.`) : null,
    offscreen.length
      ? h("div", { class: "warnings", id: "plan-hidden" }, `${offscreen.length} install${offscreen.length === 1 ? " is" : "s are"} in environment columns hidden from the matrix: ${[...new Set(offscreen.map((p) => p.env.name))].join(", ")}. They are part of this run; clear the selection or Show all to check them.`)
      : null,
    custom.length ? h("div", { class: "warnings" }, `Custom upgrade packages: ${[...new Set(custom.map((p) => p.name))].join(", ")}. The app handles its own upgrade; read its release notes first.`) : null,
    h("p", { class: "caption" }, `One install at a time per environment, up to ${Math.min(3, byEnv.size)} environments in parallel. Each install is followed until it finishes; that can take an hour.`),
    ...[...byEnv.values()].map((list) =>
      h(
        "div",
        { class: "plan-env" },
        h("h4", {}, list[0].env.name, badge(list[0].env.type || "?", isProduction(list[0].env) ? "bad" : "neutral"), shownCols.has(list[0].env.id) ? null : badge("hidden column", "warn")),
        h("ol", {}, ...list.map((p) => h("li", {}, `${ACTION_LABEL[p.action]} ${p.name} (${p.uniqueName})`, p.action === "update" ? ` ${p.from ?? "?"} → ${p.to ?? "?"}` : p.to ? ` ${p.to}` : ""))),
      ),
    ),
  );
}

async function preview(): Promise<void> {
  if (!matrix || running) return;
  const plan = planInstalls(matrix, selected);
  if (!plan.length) return;
  const prod = plan.some((p) => isProduction(p.env));
  const ok = await showDialog({ title: "Run installs", body: planNode(plan, shownEnvIds(matrix)), okLabel: `Run ${plan.length} install${plan.length === 1 ? "" : "s"}`, danger: prod });
  if (ok) await execute(plan);
}

function renderRun(): void {
  const sec = $("#run");
  sec.hidden = !run.length;
  if (!run.length) return;
  const done = run.filter((i) => !["queued", "starting", "running"].includes(i.status)).length;
  $("#run-title").textContent = running ? `Running: ${done} / ${run.length} done` : `Last run: ${run.filter((i) => i.status === "succeeded").length} succeeded, ${run.filter((i) => i.status === "failed").length} failed, ${run.filter((i) => i.status === "stopped" || i.status === "canceled").length} stopped`;
  $("#btn-stop").hidden = !running;
  const tone = (s: RunItem["status"]) => (s === "succeeded" ? "ok" : s === "failed" ? "bad" : s === "running" || s === "starting" ? "warn" : "neutral");
  $("#run-body").replaceChildren(
    h(
      "table",
      { id: "run-table" },
      h("thead", {}, h("tr", {}, h("th", {}, "Environment"), h("th", {}, "App"), h("th", {}, "Action"), h("th", {}, "Status"), h("th", {}, "Message"))),
      h(
        "tbody",
        {},
        ...run.map((i) =>
          h("tr", { "data-status": i.status }, h("td", {}, i.env.name), h("td", {}, i.name), h("td", {}, `${ACTION_LABEL[i.action]}${i.to ? ` ${i.to}` : ""}`), h("td", {}, badge(i.status, tone(i.status))), h("td", { class: "caption" }, i.message ?? "")),
        ),
      ),
    ),
  );
}

async function execute(plan: PlannedInstall[]): Promise<void> {
  const p = pp();
  if (!p || running) return;
  running = true;
  stopFlag = false;
  run = toRunItems(plan);
  selected.clear();
  render();
  renderRun();
  let pending = false;
  const refresh = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      renderRun();
      render();
    }, 100);
  };
  try {
    await runInstalls({ pp: p, items: run, pollMs: POLL_MS, onChange: refresh, stopped: () => stopFlag });
  } finally {
    running = false;
  }
  renderRun();
  const ok = run.filter((i) => i.status === "succeeded").length;
  const bad = run.filter((i) => i.status === "failed").length;
  await notify(bad ? "Installs finished with failures" : "Installs finished", `${ok} succeeded, ${bad} failed, ${run.length - ok - bad} stopped`, bad ? "error" : "success");
  await loadPackages([...new Set(run.map((i) => i.env.id))]);
}

// ---------- exports ----------
async function exportFile(name: string, content: string, mime: string): Promise<void> {
  if (await saveText(name, content, mime)) await notify("Exported", name, "success");
}
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

// ---------- wiring ----------
/** Toolbar filters, restored on open; "Clear filters" resets only these (not Show not installed / Hide empty environments / Unused Show all: view preferences). */
const filters = persistControls(TOOL_ID, ["filter-text", "only-updates"]);
persistControls(TOOL_ID, ["show-available", "hide-empty", "unused-all"]);

function wire(): void {
  $("#btn-envs").addEventListener("click", () => void pickEnvironments());
  $("#btn-refresh").addEventListener("click", () => void loadPackages());
  $("#filter-text").addEventListener("input", render);
  $("#only-updates").addEventListener("change", render);
  $("#show-available").addEventListener("change", () => matrix && rebuild());
  $("#hide-empty").addEventListener("change", render);
  $("#btn-select-failed").addEventListener("click", () => {
    if (!matrix) return;
    for (const k of failedKeys(matrix, shownCell(matrix))) selected.add(k);
    render();
  });
  $("#btn-select-updates").addEventListener("click", () => {
    if (!matrix) return;
    for (const k of updateKeys(matrix, shownCell(matrix))) selected.add(k);
    render();
  });
  $("#btn-clear-sel").addEventListener("click", () => {
    selected.clear();
    render();
  });
  $("#btn-preview").addEventListener("click", () => void preview());
  $("#btn-pac").addEventListener("click", () => {
    if (matrix) void exportFile(`d365-apps-install-${stamp()}.ps1`, pacScript(planInstalls(matrix, selected)), "text/plain");
  });
  $("#btn-export-csv").addEventListener("click", () => {
    if (matrix) void exportFile(`d365-apps-matrix-${stamp()}.csv`, matrixCsv(matrix), "text/csv");
  });
  $("#btn-results-csv").addEventListener("click", () => {
    if (run.length) void exportFile(`d365-apps-run-${stamp()}.csv`, resultsCsv(run), "text/csv");
  });
  $("#btn-stop").addEventListener("click", () => {
    stopFlag = true;
    $("#btn-stop").hidden = true;
  });
  onConnectionChange(() => {
    if (!running) void start();
  });
  $("#host-mode").textContent = inToolbox() ? "Running inside Power Platform ToolBox" : "Standalone mode";
}

initUnused({
  pp,
  dv: () => dataverse() as unknown as DvLike | undefined,
  envId: connectionEnvId,
  envs: () => envs,
  cached: (id) => results.find((r) => r.env.id === id && !r.error)?.installed ?? null,
  notify: async (t, b, k) => void (await notify(t, b, k)),
  save: exportFile,
});
mountDebug(document.querySelector("footer"), "d365-apps");
void initTheme((t) => document.documentElement.setAttribute("data-theme", t));
wire();
render();
void start();

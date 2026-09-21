import { $, badge, card, emptyState, h, showDialog, table, wireTabs } from "../../_shared/dom";
import { dataverse, getConnections, initTheme, inToolbox, notify, onConnectionChange, saveText } from "../../_shared/host";
import { applyPlan, DEFAULT_WRITE_CONCURRENCY } from "./offboard/apply";
import { inventoryCsv, inventoryJson, resultsCsv, resultsJson, safeFileName } from "./offboard/export";
import {
  fetchCategories,
  fetchLeaver,
  fetchOwnedRecordIds,
  fetchOwnedTables,
  fetchOrgAssignSettings,
  fetchPrincipalHeld,
  resolveRolesInBusinessUnit,
  scanOwnedRecords,
  searchTeams,
  searchUsers,
  type DataverseLike,
  type PoolControl,
} from "./offboard/fetch";
import { buildPlan, categoryLabel, DEFAULT_RECORD_CAP, estimateCounts, LARGE_PLAN_WARNING, type OwnerTarget } from "./offboard/plan";
import {
  ACCESS_MODE_LABEL,
  CALL_TEXT,
  type CategoryKey,
  type CategoryResult,
  type Inventory,
  type LeaverInfo,
  type OpResult,
  type Plan,
  type RoleRef,
  type TableInfo,
  type TeamRef,
  type UserInfo,
} from "./offboard/types";

// ---------- state ----------
let leaver: LeaverInfo | null = null;
let inventory: Inventory | null = null;
let tables: TableInfo[] = [];
let successor: UserInfo | null = null;
let recordTeam: TeamRef | null = null;
let useTeamTarget = false;
let lastPlan: Plan | null = null;
let lastResults: OpResult[] | null = null;
let envName: string | null = null;
let control: PoolControl | null = null;

const selectedCats = new Set<CategoryKey>();
const selectedTables = new Set<string>();
const opts = { roleCopy: true, roleRemove: false, profileCopy: true, profileRemove: false, teamRemove: true, teamAdd: false, recordCap: DEFAULT_RECORD_CAP };
const SCAN_CONCURRENCY = 6;
const PREVIEW_ROWS = 25;

const api = (): DataverseLike | null => (dataverse() as unknown as DataverseLike | undefined) ?? null;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

function setStatus(m: string | null): void {
  const el = $("#status");
  el.hidden = !m;
  el.textContent = m ?? "";
}

function setProgress(done: number, total: number, label: string, cancel: (() => void) | null): void {
  $("#progress").hidden = total <= 0;
  if (total <= 0) return;
  $("#progress-fill").style.width = `${Math.round((done / total) * 100)}%`;
  $("#progress-text").textContent = `${done} / ${total}${label ? ` · ${label}` : ""}`;
  const btn = $<HTMLButtonElement>("#btn-cancel");
  btn.hidden = !cancel;
  btn.onclick = cancel;
}

const clearProgress = (): void => {
  $("#progress").hidden = true;
  $("#progress-fill").style.width = "0%";
};

const check = (attrs: Record<string, string>, checked: boolean, disabled: boolean, onChange: (v: boolean) => void): HTMLInputElement => {
  const cb = h("input", { type: "checkbox", ...attrs });
  cb.checked = checked;
  cb.disabled = disabled;
  cb.addEventListener("click", (e) => e.stopPropagation()); // a checkbox inside <summary> must not toggle the fold
  cb.addEventListener("change", () => onChange(cb.checked));
  return cb;
};

// ---------- pickers ----------
/** Typeahead list shared by the leaver, successor and team pickers. */
function suggest(list: HTMLElement, items: { title: string; meta: string; onPick: () => void }[], empty: string): void {
  list.replaceChildren();
  if (!items.length) list.append(h("li", { class: "none" }, empty));
  for (const it of items) {
    const b = h("button", { type: "button" }, h("span", { class: "name" }, it.title), h("span", { class: "meta" }, it.meta));
    b.addEventListener("click", () => {
      list.hidden = true;
      it.onPick();
    });
    list.append(h("li", {}, b));
  }
  list.hidden = false;
}

function picker<T>(idBase: string, placeholder: string, search: (a: DataverseLike, q: string) => Promise<T[]>, row: (x: T) => { title: string; meta: string }, onPick: (x: T) => void): HTMLElement {
  const input = h("input", { type: "search", id: `${idBase}-q`, placeholder, "aria-label": placeholder });
  const list = h("ul", { class: "suggest", id: `${idBase}-results`, hidden: true });
  input.addEventListener(
    "input",
    debounce(async () => {
      const a = api();
      const q = input.value.trim();
      if (!a || q.length < 2) {
        list.hidden = true;
        return;
      }
      try {
        const found = await search(a, q);
        suggest(
          list,
          found.map((x) => ({
            ...row(x),
            onPick: () => {
              input.value = "";
              onPick(x);
            },
          })),
          "No match",
        );
      } catch (e) {
        await notify("Search failed", msg(e), "error");
      }
    }, 250),
  );
  input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 200));
  return h("div", { class: "suggest-wrap" }, input, list);
}

const userPicker = (idBase: string, onPick: (u: UserInfo) => void): HTMLElement =>
  picker<UserInfo>(idBase, "Name, domain or email…", searchUsers, (u) => ({
    title: u.fullName + (u.isDisabled ? " (disabled)" : ""),
    meta: [u.domainName ?? u.email, u.businessUnitId ? `BU ${u.businessUnitId.slice(0, 8)}` : null].filter(Boolean).join(" · "),
  }), onPick);

const teamPicker = (onPick: (t: TeamRef) => void): HTMLElement =>
  picker<TeamRef>("team", "Team name…", searchTeams, (t) => ({ title: t.name, meta: t.type === 0 ? "owner team" : t.type === 1 ? "access team" : "Entra group team" }), onPick);

// ---------- 1. leaver ----------
async function pickLeaver(u: UserInfo): Promise<void> {
  const a = api();
  if (!a) return;
  selectedCats.clear();
  selectedTables.clear();
  inventory = null;
  lastPlan = null;
  lastResults = null;
  setStatus("Reading the leaver's holdings…");
  try {
    leaver = await fetchLeaver(a, u);
    const [categories, orgAssign] = await Promise.all([fetchCategories(a, leaver.user.id), fetchOrgAssignSettings(a)]);
    inventory = { leaver, categories, scan: null, takenAt: new Date().toISOString(), orgAssign };
    for (const c of categories) if (c.items.length && c.writable) selectedCats.add(c.key);
  } catch (e) {
    await notify("Load failed", msg(e), "error");
  }
  setStatus(null);
  renderAll();
  $<HTMLButtonElement>("#btn-scan").disabled = !leaver;
}

function renderLeaver(): void {
  const panel = $("#leaver-detail");
  const chip = $("#leaver-chip");
  panel.replaceChildren();
  chip.replaceChildren();
  chip.hidden = !leaver;
  if (!leaver) return void panel.append(emptyState("No leaver selected", "Search for the user who is leaving. Nothing is read until you pick one."));
  const u = leaver.user;
  chip.append(h("span", { class: "env" }, u.fullName), u.isDisabled ? badge("disabled", "bad") : badge("enabled", "ok"));
  const reports = inventory?.categories.find((c) => c.key === "directreports")?.items.length ?? 0;
  const kv: [string, string, string?][] = [
    ["Name", u.fullName],
    ["Domain name", u.domainName ?? "—"],
    ["Email", u.email ?? "—"],
    ["Business unit", leaver.businessUnitName ?? u.businessUnitId ?? "—"],
    ["Manager", leaver.manager?.fullName ?? "—"],
    ["State", u.isDisabled ? "disabled" : "enabled"],
    ["Access mode", u.accessMode == null ? "—" : (ACCESS_MODE_LABEL[u.accessMode] ?? String(u.accessMode))],
    ["Direct reports", String(reports), "leaver-reports"],
  ];
  panel.append(
    h(
      "div",
      { class: "stack" },
      card("Leaver", h("dl", { class: "kv", id: "leaver-kv" }, ...kv.flatMap(([k, v, id]) => [h("dt", {}, k), h("dd", { id }, v)]))),
      h("p", { class: "caption" }, "This tool never disables the user and never touches licences: those stay a deliberate manual step, listed in the report."),
    ),
  );
}

// ---------- 2. inventory ----------
function scanTables(): TableInfo[] {
  const f = $<HTMLInputElement>("#scan-filter").value.trim().toLowerCase();
  return f ? tables.filter((t) => t.logicalName.includes(f) || t.displayName.toLowerCase().includes(f)) : tables;
}

async function runScan(): Promise<void> {
  const a = api();
  const inv = inventory;
  if (!a || !leaver || !inv) return;
  const leaverId = leaver.user.id;
  const list = scanTables();
  const ctrl: PoolControl = { cancelled: false };
  const cancel = (): void => {
    ctrl.cancelled = true;
  };
  const body = h(
    "div",
    {},
    h("p", {}, `Dataverse has no cross-table "what does this user own". The scan asks each owned table for a count: ${list.length} requests.`),
    h("p", { class: "caption" }, "Tables that reject the owner filter are listed as not scanned. You can cancel at any point; partial results are kept."),
  );
  if (!(await showDialog({ title: "Scan owned records", body, okLabel: `Scan ${list.length} tables` }))) return;
  control = ctrl;
  setProgress(0, list.length, "", cancel);
  const scan = await scanOwnedRecords(a, list, leaverId, { concurrency: SCAN_CONCURRENCY, cap: opts.recordCap, control: ctrl, onProgress: (d, t, name) => setProgress(d, t, name, cancel) });
  control = null;
  clearProgress();
  inventory = { ...inv, scan };
  if (scan.rows.length) selectedCats.add("records");
  for (const r of scan.rows) selectedTables.add(r.table.logicalName);
  renderAll();
  await notify("Scan finished", `${scan.rows.length} table(s) with records, ${scan.failed.length} not scanned`, scan.failed.length ? "warning" : "success");
}

const foldHead = (cb: HTMLElement, label: string, hint: string, count: Node): HTMLElement =>
  h("summary", {}, h("div", { class: "card-head" }, cb, h("span", { class: "label" }, label), h("span", { class: "caption" }, hint), h("span", { class: "count" }, count)));

function categoryCard(c: CategoryResult): HTMLElement {
  const cb = check({ "aria-label": `Include ${c.label}`, "data-cat": c.key }, selectedCats.has(c.key), !c.writable || !c.items.length || !!c.error, (v) => {
    if (v) selectedCats.add(c.key);
    else selectedCats.delete(c.key);
    updatePlanSummary();
  });
  const body = c.error
    ? h("div", { class: "danger-box" }, `Could not read this category: ${c.error}`)
    : c.items.length
      ? table(["Name", "Detail", "Note"], c.items.map((i) => [i.label, h("span", { class: "caption" }, i.meta), i.flag ? h("span", { class: "flag" }, i.flag) : ""]), undefined, `detail-table cat-${c.key}`)
      : h("p", { class: "caption" }, "Nothing held in this category.");
  return h("details", { class: "card", "data-cat": c.key }, foldHead(cb, c.label, c.hint, c.error ? badge("error", "bad") : badge(String(c.items.length), "neutral")), h("div", { class: "card-body" }, body));
}

function scanRow(r: NonNullable<Inventory["scan"]>["rows"][number]): (Node | string)[] {
  const cb = check({ "aria-label": `Include ${r.table.logicalName}`, "data-table": r.table.logicalName }, selectedTables.has(r.table.logicalName), r.error != null || !(r.count ?? 0), (v) => {
    if (v) selectedTables.add(r.table.logicalName);
    else selectedTables.delete(r.table.logicalName);
    updatePlanSummary();
  });
  return [
    cb,
    h("span", {}, r.table.displayName, " ", h("span", { class: "mono" }, r.table.logicalName)),
    r.error ? "—" : `${r.count}${r.approximate ? "+" : ""}`,
    r.error ? h("span", { class: "flag" }, `not scanned: ${r.error}`) : r.table.ownership === "team" ? h("span", { class: "caption" }, "team-owned table") : "",
  ];
}

function recordsCard(): HTMLElement {
  const scan = inventory?.scan ?? null;
  const cb = check({ "aria-label": "Include records", "data-cat": "records" }, selectedCats.has("records"), !scan || !scan.rows.length, (v) => {
    if (v) selectedCats.add("records");
    else selectedCats.delete("records");
    updatePlanSummary();
  });
  const total = scan?.rows.reduce((n, r) => n + (r.count ?? 0), 0) ?? 0;
  const rows = scan ? ($<HTMLInputElement>("#scan-hide-empty").checked ? scan.rows : [...scan.rows, ...scan.failed]) : [];
  const body = !scan
    ? h("p", { class: "caption" }, "Not scanned yet. Use “Scan owned records” above.")
    : h(
        "div",
        {},
        h("p", { class: "scan-note", id: "scan-note" }, `${scan.scanned} of ${scan.requested} tables scanned${scan.cancelled ? " (cancelled)" : ""} · ${scan.rows.length} with records · ${scan.failed.length} not scanned`),
        rows.length ? table(["", "Table", "#Records", "Note"], rows.map(scanRow), undefined, "scan") : emptyState("No records owned", "The leaver owns no records in the scanned tables."),
      );
  const count = badge(scan ? `${total} in ${scan.rows.length} tables` : "not scanned", scan?.rows.length ? "warn" : "neutral");
  return h("details", { class: "card", "data-cat": "records", open: !!scan?.rows.length }, foldHead(cb, "Records owned per table", "one count request per owned table", count), h("div", { class: "card-body" }, body));
}

function renderInventory(): void {
  const panel = $("#inventory-body");
  panel.replaceChildren();
  if (!inventory) return void panel.append(emptyState("No leaver selected", "Pick the leaver on the first tab."));
  panel.append(h("div", { class: "stack", id: "inventory-cards" }, recordsCard(), ...inventory.categories.map(categoryCard)));
}

// ---------- 3. plan & apply ----------
function optionsCard(): HTMLElement {
  const box = (labelText: string, key: keyof typeof opts): HTMLElement =>
    h("label", {}, check({ "data-opt": key }, opts[key] === true, false, (v) => {
      (opts as Record<string, unknown>)[key] = v;
      updatePlanSummary();
    }), labelText);
  const cap = h("input", { type: "number", min: "1", max: "5000", id: "record-cap", style: "width:90px" });
  cap.value = String(opts.recordCap);
  cap.addEventListener("change", () => {
    opts.recordCap = Math.max(1, Math.min(5000, Number(cap.value) || DEFAULT_RECORD_CAP));
    cap.value = String(opts.recordCap);
    updatePlanSummary();
  });
  return card(
    "What to do per category",
    h(
      "div",
      { class: "opts" },
      box("copy security roles to the successor", "roleCopy"),
      box("remove security roles from the leaver", "roleRemove"),
      box("copy field security profiles", "profileCopy"),
      box("remove field security profiles", "profileRemove"),
      box("remove the leaver from their teams", "teamRemove"),
      box("add the successor to those teams", "teamAdd"),
      h("label", {}, "max records per table", cap),
    ),
  );
}

function targetCards(): HTMLElement[] {
  const chip = successor
    ? h("span", { class: "connchip", id: "successor-chip" }, h("span", { class: "env" }, successor.fullName), h("span", { class: "caption" }, successor.domainName ?? successor.id))
    : h("span", { class: "caption" }, "no successor picked");
  const radio = (id: string, labelText: string, on: boolean, pick: () => void): HTMLElement => {
    const r = h("input", { type: "radio", name: "rt", id });
    r.checked = on;
    r.addEventListener("change", () => {
      pick();
      renderPlan();
    });
    return h("label", {}, r, labelText);
  };
  const successorCard = card(
    "Successor",
    h(
      "div",
      { class: "stack" },
      userPicker("successor", (u) => {
        successor = u;
        renderPlan();
      }),
      h("div", { class: "row" }, chip, successor?.isDisabled ? badge("successor is disabled", "bad") : h("span", {})),
    ),
  );
  const teamSide = useTeamTarget
    ? h(
        "div",
        { class: "stack" },
        teamPicker((t) => {
          recordTeam = t;
          renderPlan();
        }),
        recordTeam ? h("span", { class: "connchip", id: "team-chip" }, h("span", { class: "env" }, recordTeam.name)) : h("span", { class: "caption" }, "no team picked"),
      )
    : h("p", { class: "caption" }, "Flows, personal views, charts, queues and connection references always move to the successor user: they cannot be team-owned.");
  const targetCard = card(
    "Where reassigned records go",
    h("div", { class: "stack" }, h("div", { class: "opts" }, radio("rt-user", "the successor user", !useTeamTarget, () => (useTeamTarget = false)), radio("rt-team", "a team", useTeamTarget, () => (useTeamTarget = true))), teamSide),
  );
  return [successorCard, targetCard];
}

const recordTarget = (): OwnerTarget | null =>
  useTeamTarget ? (recordTeam ? { kind: "team", id: recordTeam.id, name: recordTeam.name } : null) : successor ? { kind: "user", id: successor.id, name: successor.fullName } : null;

function updatePlanSummary(): void {
  const el = document.querySelector("#plan-summary");
  if (!el || !inventory) return;
  const rows = estimateCounts(inventory, { categories: selectedCats, tables: selectedTables, ...opts });
  const total = rows.reduce((n, r) => n + r.count, 0);
  el.replaceChildren(
    rows.length ? table(["Category", "#Operations"], rows.map((r) => [r.label, String(r.count)])) : h("p", { class: "caption" }, "Nothing selected on the Inventory tab."),
    // An estimate, not the plan: what the successor already holds and which roles have an equivalent
    // in their business unit are only read when the preview is built, and both can only remove rows.
    h(
      "p",
      { class: "caption" },
      `${total} operation${total === 1 ? "" : "s"} at most · applied ${DEFAULT_WRITE_CONCURRENCY} at a time. The preview is the real count: anything the successor already holds is dropped there.`,
    ),
  );
  const btn = document.querySelector<HTMLButtonElement>("#btn-preview");
  if (btn) btn.disabled = !total || !successor || (useTeamTarget && !recordTeam);
}

function renderPlan(): void {
  const panel = $("#tab-plan");
  panel.replaceChildren();
  if (!inventory) return void panel.append(emptyState("No leaver selected", "Pick the leaver, then choose what to move."));
  const preview = h("button", { class: "btn btn-primary", type: "button", id: "btn-preview" }, "Preview plan");
  preview.addEventListener("click", () => void previewAndApply());
  panel.append(
    h(
      "div",
      { class: "stack" },
      ...targetCards(),
      optionsCard(),
      card("Plan", h("div", { id: "plan-summary" }), preview),
      h("p", { class: "caption" }, "Nothing is written until you confirm the preview. The leaver is never disabled and licences are never touched."),
    ),
  );
  updatePlanSummary();
}

/** Fetch the ids of every ticked table, tolerating a table that refuses to list. */
async function collectRecordIds(a: DataverseLike, inv: Inventory): Promise<Map<string, { id: string; name: string }[]>> {
  const out = new Map<string, { id: string; name: string }[]>();
  if (!selectedCats.has("records")) return out;
  for (const r of inv.scan?.rows ?? []) {
    if (!selectedTables.has(r.table.logicalName)) continue;
    try {
      out.set(r.table.logicalName, await fetchOwnedRecordIds(a, r.table, inv.leaver.user.id, opts.recordCap));
    } catch (e) {
      await notify("Records not listed", `${r.table.displayName}: ${msg(e)}`, "warning");
    }
  }
  return out;
}

function previewBody(plan: Plan): Node {
  const big = plan.ops.length > LARGE_PLAN_WARNING;
  return h(
    "div",
    {},
    h("p", {}, `${plan.ops.length} operation${plan.ops.length === 1 ? "" : "s"} against ${envName ?? "this environment"}.`),
    big ? h("div", { class: "danger-box" }, `This is a large batch (over ${LARGE_PLAN_WARNING} writes). Narrow the table selection, or use the ToolBox "Ownership Mover" for bulk ownership changes.`) : h("span", {}),
    table(["Category", "#Operations"], plan.counts.map((c) => [c.label, String(c.count)])),
    plan.warnings.length ? h("div", { class: "warnings" }, h("ul", { class: "notes" }, ...plan.warnings.map((w) => h("li", {}, w)))) : h("span", {}),
    plan.skipped.length ? h("ul", { class: "notes" }, ...plan.skipped.map((sk) => h("li", { class: "caption" }, sk))) : h("span", {}),
    h("h3", { style: "margin-top:12px" }, `First ${Math.min(PREVIEW_ROWS, plan.ops.length)} operations`),
    table(["Target", "Change", "Call"], plan.ops.slice(0, PREVIEW_ROWS).map((op) => [op.label, op.detail, h("span", { class: "mono" }, CALL_TEXT(op.call))]), undefined, "preview"),
  );
}


/**
 * Roles are business-unit scoped, so a role held by the leaver cannot be granted to a successor in
 * another business unit: the equivalent role there is the one sharing `parentrootroleid`. Same BU
 * (or an unknown one) needs no remapping, and returning undefined leaves the plan's ids untouched.
 */
async function resolveRoleRemap(a: DataverseLike, inv: Inventory, successorUser: UserInfo): Promise<Map<string, RoleRef | null> | undefined> {
  const bu = successorUser.businessUnitId;
  if (!bu || bu === inv.leaver.user.businessUnitId) return undefined;
  const roles = inv.categories.find((c) => c.key === "roles")?.items ?? [];
  if (!roles.length) return undefined;
  const roots = roles.map((it) => String(it.data?.rootRoleId ?? it.id));
  const byRoot = await resolveRolesInBusinessUnit(a, roots, bu);
  return new Map(roles.map((it) => [it.id, byRoot.get(String(it.data?.rootRoleId ?? it.id)) ?? null]));
}
async function previewAndApply(): Promise<void> {
  const a = api();
  const inv = inventory;
  const target = recordTarget();
  if (!a || !inv || !successor || !target) return;
  const successorUser = successor;
  setStatus("Building the plan…");
  const [recordIds, successorHeld, roleRemap] = await Promise.all([
    collectRecordIds(a, inv),
    fetchPrincipalHeld(a, successorUser.id),
    resolveRoleRemap(a, inv, successorUser),
  ]);
  const plan = buildPlan(inv, recordIds, {
    successor: successorUser,
    recordTarget: target,
    categories: selectedCats,
    tables: selectedTables,
    ...opts,
    successorHeld,
    roleRemap,
  });
  lastPlan = plan;
  setStatus(null);
  if (!plan.ops.length) {
    await showDialog({ title: "Nothing to do", body: h("div", {}, h("p", {}, "The current selection produces no operations."), ...plan.skipped.map((sk) => h("p", { class: "caption" }, sk))) });
    return;
  }
  const confirmed = await showDialog({
    title: "Preview — nothing has been written yet",
    target: h("span", {}, "Successor:", badge(successorUser.fullName, "neutral")),
    body: previewBody(plan),
    okLabel: `Apply ${plan.ops.length}`,
    danger: true,
  });
  if (!confirmed) return;
  const ctrl: PoolControl = { cancelled: false };
  const cancel = (): void => {
    ctrl.cancelled = true;
  };
  control = ctrl;
  setProgress(0, plan.ops.length, "writing", cancel);
  const results = await applyPlan(a, plan.ops, { concurrency: DEFAULT_WRITE_CONCURRENCY, control: ctrl, onProgress: (d, t) => setProgress(d, t, "writing", cancel) });
  control = null;
  clearProgress();
  lastResults = results;
  const failed = results.filter((r) => !r.ok).length;
  await notify(failed ? "Applied with failures" : "Applied", `${results.length - failed} ok, ${failed} failed`, failed ? "warning" : "success");
  renderReport();
  document.querySelector<HTMLButtonElement>(".tab[data-tab='report']")?.click();
}

// ---------- 4. report ----------
function exportButton(id: string, label: string, name: () => string, content: () => string, mime: string): HTMLElement {
  const b = h("button", { class: "btn btn-ghost btn-sm", type: "button", id }, label);
  b.addEventListener("click", async () => {
    if (await saveText(name(), content(), mime)) await notify("Exported", name(), "success");
  });
  return b;
}

function renderReport(): void {
  const panel = $("#tab-report");
  panel.replaceChildren();
  if (!inventory) return void panel.append(emptyState("Nothing to report", "Pick a leaver first."));
  const inv = inventory;
  const base = safeFileName(inv.leaver.user.domainName ?? inv.leaver.user.fullName);
  const results = lastResults;
  const plan = lastPlan;
  const succ = successor;
  const failed = results?.filter((r) => !r.ok) ?? [];
  const items = inv.categories.reduce((n, c) => n + c.items.length, 0);
  const invCard = card(
    "Inventory",
    h("p", { class: "caption" }, `Taken ${new Date(inv.takenAt).toLocaleString()} · ${items} items across ${inv.categories.length} categories${inv.scan ? ` · ${inv.scan.rows.length} tables with records` : " · records not scanned"}.`),
    h(
      "span",
      { class: "row" },
      exportButton("btn-export-inv-json", "Export JSON", () => `${base}.offboarding-inventory.json`, () => inventoryJson(inv, envName), "application/json"),
      exportButton("btn-export-inv-csv", "Export CSV", () => `${base}.offboarding-inventory.csv`, () => inventoryCsv(inv), "text/csv"),
    ),
  );
  const resultsCard =
    results && plan && succ
      ? card(
          "Apply results",
          h(
            "div",
            {},
            h("p", { class: "caption", id: "result-summary" }, `${results.length - failed.length} ok · ${failed.length} failed`),
            table(
              ["Category", "Target", "Change", "Result"],
              results.map((r) => [categoryLabel(r.op.category), r.op.label, r.op.detail, r.ok ? badge("ok", "ok") : badge(r.error ?? "failed", "bad")]),
              undefined,
              "results",
            ),
          ),
          h(
            "span",
            { class: "row" },
            exportButton("btn-export-res-json", "Export JSON", () => `${base}.offboarding-results.json`, () => resultsJson(inv, plan, results, succ, envName), "application/json"),
            exportButton("btn-export-res-csv", "Export CSV", () => `${base}.offboarding-results.csv`, () => resultsCsv(results), "text/csv"),
          ),
        )
      : card("Apply results", h("p", { class: "caption" }, "No plan has been applied yet."));
  const manual = [
    "Disable the leaver's Dataverse user — this tool never does it.",
    "Release or reassign their Power Platform / Microsoft 365 licence.",
    "Re-authenticate the connections behind any reassigned connection reference.",
    "Remove the leaver from the queues they were a member of.",
  ];
  panel.append(h("div", { class: "stack" }, invCard, resultsCard, card("Remaining manual steps", h("ul", { class: "notes", id: "manual-steps" }, ...manual.map((m) => h("li", {}, m))))));
}

function renderAll(): void {
  renderLeaver();
  renderInventory();
  renderPlan();
  renderReport();
}

// ---------- host ----------
async function renderConnection(): Promise<void> {
  const chip = $("#conn");
  chip.replaceChildren();
  const [c] = await getConnections();
  envName = c ? `${c.conn.name} (${c.conn.environment})` : null;
  if (!c) return;
  const dot = h("span", { class: "dot" });
  if (c.conn.environmentColor) dot.style.background = c.conn.environmentColor;
  chip.append(dot, h("span", { class: "env" }, c.conn.name), h("span", { class: "caption" }, c.conn.environment));
}

async function loadTables(): Promise<void> {
  const a = api();
  if (!a) return;
  try {
    tables = await fetchOwnedTables(a);
  } catch (e) {
    await notify("Tables", msg(e), "error");
  }
}

function wire(): void {
  wireTabs(() => undefined);
  $("#leaver-form .field").replaceChildren(h("label", { for: "leaver-q" }, "Leaver"), userPicker("leaver", (u) => void pickLeaver(u)));
  $("#leaver-form").addEventListener("submit", (e) => e.preventDefault());
  $("#btn-scan").addEventListener("click", () => void runScan());
  $("#scan-filter").addEventListener("input", debounce(() => renderInventory(), 250));
  $("#scan-hide-empty").addEventListener("change", () => renderInventory());
  $("#btn-cancel").addEventListener("click", () => {
    if (control) control.cancelled = true;
  });
  onConnectionChange(() => {
    leaver = null;
    inventory = null;
    lastPlan = null;
    lastResults = null;
    void renderConnection();
    void loadTables();
    renderAll();
  });
}

async function main(): Promise<void> {
  await initTheme((t) => document.documentElement.setAttribute("data-theme", t));
  $("#host-mode").textContent = inToolbox() ? "Running inside Power Platform ToolBox" : "Not running inside ToolBox: open this tool in Power Platform ToolBox with a connection to use it";
  wire();
  renderAll();
  await renderConnection();
  await loadTables();
}

void main();

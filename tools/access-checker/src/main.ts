import { mountDebug } from "../../_shared/debug-ui";
import { $, append, badge, card, emptyState, filteredEmpty, foldAllButtons, foldCard, h, keepFold, shownOf, table, wireTabs, type BadgeKind, type Child } from "../../_shared/dom";
import { loadView, saveView } from "../../_shared/view-state";
import { dataverse, getConnections, initTheme, inToolbox, notify, onConnectionChange, saveText } from "../../_shared/host";
import { columnAccess } from "./access/columns";
import { explain } from "./access/explain";
import { checkJson, columnsCsv, safeFileName, sharesCsv } from "./access/export";
import {
  Cache,
  fetchBusinessUnits,
  fetchDirectRoles,
  fetchFieldPermissions,
  fetchFieldProfiles,
  fetchHierarchySettings,
  fetchManagerChain,
  fetchPrincipalAccess,
  fetchRecord,
  fetchRolePrivileges,
  fetchSecuredColumns,
  fetchShares,
  fetchTablePrivileges,
  fetchTables,
  fetchTeams,
  fetchUser,
  fetchUserPrivileges,
  fetchUsersById,
  heldRoles,
  searchRecords,
  searchUsers,
  type DataverseLike,
} from "./access/fetch";
import { depthHint, depthInfo, depthLabel, isSystemAdminRole, tablePrivilegeName } from "./access/privileges";
import { RIGHTS, TEAM_TYPE_LABEL, type CheckData, type Right, type Depth, type ColumnAccess, type Explanation, type PrivilegePath, type RecordInfo, type RightVerdict, type ShareEntry, type TableInfo, type TeamInfo, type UserInfo } from "./access/types";

// ---------- state ----------
const cache = new Cache();
let tables: TableInfo[] = [];
let user: UserInfo | null = null;
let tbl: TableInfo | null = null;
let record: RecordInfo | null = null;
let recordId: string | null = null; // GUID pasted without a fetched record yet
let data: CheckData | null = null;
let expl: Explanation | null = null;
let colRows: ColumnAccess[] | null = null;
/** Column security for the current check: "idle" before any check, then loading → ready | failed. */
let colState: "idle" | "loading" | "ready" | "failed" = "idle";
let colError: string | null = null;
/** Bumped by every check / search; a result whose token is no longer current is dropped. */
let checkSeq = 0;
let userSeq = 0;
let recSeq = 0;
let envName: string | null = null;
/** Roles table: hide roles with no depth for any right on the checked table (per-viewer, persisted). */
const VIEW = "access-checker";
let hideIrrelevantRoles = loadView<boolean>(VIEW, "hideIrrelevantRoles", true) !== false;
/** Shares tab: principal search (kept for the session) and "Only shares affecting <user>" (persisted, default off). */
let sharesQ = "";
let sharesOnlyAffecting = loadView<boolean>(VIEW, "sharesOnlyAffecting", false) === true;
/** Column security tab: column search (kept for the session) and "Only columns with a denied right" (persisted, default off). */
let columnsQ = "";
let columnsOnlyDenied = loadView<boolean>(VIEW, "columnsOnlyDenied", false) === true;
/** Right picked from a verdict chip: its column is highlighted in the Roles table. Kept while the same check is re-rendered. */
let focusRight: Right | null = null;
let focusScope = "";

const api = (): DataverseLike | null => (dataverse() as unknown as DataverseLike | undefined) ?? null;
const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;
const debounce = <A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

function setStatus(msg: string | null): void {
  const el = $("#status");
  el.hidden = !msg;
  el.textContent = msg ?? "";
}
const kindOf = (v: "yes" | "no" | "n/a"): BadgeKind => (v === "yes" ? "ok" : v === "no" ? "bad" : "neutral");

// ---------- inputs ----------
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

function renderUserSel(): void {
  const el = $("#user-sel");
  el.hidden = !user;
  el.replaceChildren();
  if (!user) return;
  const clear = h("button", { class: "btn-icon", type: "button", title: "Clear user", "aria-label": "Clear user" }, "×");
  clear.addEventListener("click", () => {
    user = null;
    renderUserSel();
    updateCheckButton();
  });
  append(el, h("span", { class: "name" }, user.fullName), h("span", { class: "caption" }, user.domainName ?? user.email ?? user.id), user.isDisabled ? badge("disabled", "bad") : null, clear);
}

function renderRecordSel(): void {
  const el = $("#record-sel");
  const has = !!(record || recordId);
  el.hidden = !has;
  el.replaceChildren();
  if (!has) return;
  const clear = h("button", { class: "btn-icon", type: "button", title: "Clear record", "aria-label": "Clear record" }, "×");
  clear.addEventListener("click", () => {
    record = null;
    recordId = null;
    $<HTMLInputElement>("#record-q").value = "";
    renderRecordSel();
  });
  el.append(h("span", { class: "name" }, record ? record.name : "Record by id"), h("span", { class: "mono" }, record?.id ?? recordId ?? ""), clear);
}

function updateCheckButton(): void {
  $<HTMLButtonElement>("#btn-check").disabled = !(user && tbl && api());
}

async function loadTables(): Promise<void> {
  const a = api();
  const sel = $<HTMLSelectElement>("#table");
  if (!a) {
    sel.replaceChildren(h("option", { value: "" }, "No connection"));
    return;
  }
  try {
    tables = await fetchTables(a, cache);
    sel.replaceChildren(h("option", { value: "" }, "Select a table…"), ...tables.map((t) => h("option", { value: t.logicalName }, `${t.displayName} (${t.logicalName})`)));
  } catch (e) {
    sel.replaceChildren(h("option", { value: "" }, "Failed to load tables"));
    await notify("Tables", (e as Error).message, "error");
  }
}

// ---------- check ----------
async function runCheck(): Promise<void> {
  const a = api();
  if (!a || !user || !tbl) return;
  // Everything the check depends on is captured now: the inputs may change while it is in flight.
  const seq = ++checkSeq;
  const stale = (): boolean => seq !== checkSeq;
  const t = tbl;
  const picked = user;
  const pickedRecord = record;
  const pickedRecordId = recordId;
  // Role and user privileges change without a connection change (a role assigned or edited between two
  // checks): re-read them for every check. Metadata caches (tables, privileges, BUs) are kept.
  cache.userPrivileges = {};
  cache.rolePrivileges = {};
  colRows = null;
  colState = "loading";
  colError = null;
  renderColumns();
  setStatus("Checking…");
  $<HTMLButtonElement>("#btn-check").disabled = true;
  try {
    const fresh = (await fetchUser(a, picked.id)) ?? picked;
    if (stale()) return;
    // Refresh the selection only if it is still the user this check started for.
    if (user && user.id === picked.id) {
      user = fresh;
      renderUserSel();
    }
    const [direct, teams, bus, tablePrivileges] = await Promise.all([fetchDirectRoles(a, fresh.id), fetchTeams(a, fresh.id), fetchBusinessUnits(a, cache), fetchTablePrivileges(a, cache, t.logicalName)]);
    if (stale()) return;
    const held = heldRoles(direct, teams);
    const rolePrivileges = await fetchRolePrivileges(a, cache, held.map((x) => x.role));
    if (stale()) return;
    let rec: RecordInfo | null = null;
    if (pickedRecordId && (!pickedRecord || pickedRecord.id !== pickedRecordId)) rec = await fetchRecord(a, t, pickedRecordId);
    else rec = pickedRecord;
    if (stale()) return;
    if (pickedRecordId && !rec) throw new Error(`Record ${pickedRecordId} not found in ${t.logicalName}`);
    if (tbl === t && recordId === pickedRecordId && pickedRecordId) {
      record = rec;
      renderRecordSel();
    }

    let shares: ShareEntry[] | null = null;
    let platformRights: ReturnType<typeof explain>["verdicts"][number]["right"][] | null = null;
    let platformDepths: CheckData["platformDepths"] = null;
    let hierarchyEnabled: boolean | null = null;
    let hierarchyMaxDepth = 3;
    let ownerManagers: UserInfo[] = [];
    if (rec) {
      const [sh, pa, hier] = await Promise.all([
        fetchShares(a, t, rec.id).catch((e: Error) => {
          if (!stale()) void notify("Shares", e.message, "warning");
          return null;
        }),
        fetchPrincipalAccess(a, fresh.id, t, rec.id),
        fetchHierarchySettings(a, cache),
      ]);
      shares = sh;
      platformRights = pa;
      hierarchyEnabled = hier.enabled;
      hierarchyMaxDepth = hier.maxDepth;
      if (hier.enabled && rec.ownerType === "systemuser" && rec.ownerId && rec.ownerId !== fresh.id) {
        const owner = (await fetchUsersById(a, [rec.ownerId])).get(rec.ownerId);
        if (owner) ownerManagers = await fetchManagerChain(a, owner, hier.maxDepth);
      }
    } else platformDepths = await fetchUserPrivileges(a, cache, fresh.id, t.logicalName, tablePrivileges);
    if (stale()) return;

    data = {
      user: fresh,
      userBu: bus.find((b) => b.id === fresh.businessUnitId) ?? null,
      businessUnits: bus,
      heldRoles: held,
      teams,
      rolePrivileges,
      table: t,
      tablePrivileges,
      record: rec,
      shares,
      platformRights,
      platformDepths,
      hierarchyEnabled,
      hierarchyMaxDepth,
      ownerManagers,
    };
    expl = explain(data);
    renderCheck();
    renderShares();
    renderColumns();
    $<HTMLButtonElement>("#btn-export-json").disabled = false;

    setStatus("Loading column security…");
    const isAdmin = held.some((x) => isSystemAdminRole(x.role));
    try {
      const [cols, profiles] = await Promise.all([fetchSecuredColumns(a, t), fetchFieldProfiles(a, fresh.id, teams)]);
      const perms = await fetchFieldPermissions(a, t, [...new Set(profiles.map((p) => p.id))]);
      if (stale()) return;
      colRows = columnAccess(cols, profiles, perms, isAdmin);
      colState = "ready";
    } catch (e) {
      if (stale()) return;
      colState = "failed";
      colError = (e as Error).message;
      void notify("Column security", colError, "warning");
    }
    renderColumns();
    setStatus(null);
  } catch (e) {
    if (stale()) return;
    colState = "failed";
    colError = `Check failed: ${(e as Error).message}`;
    renderColumns();
    setStatus(null);
    await notify("Check failed", (e as Error).message, "error");
  } finally {
    if (!stale()) updateCheckButton();
  }
}

// ---------- render: check ----------
function renderCheck(): void {
  const panel = $("#tab-check");
  panel.replaceChildren();
  if (!data || !expl) {
    panel.append(emptyState("No check yet", "Pick a user and a table (optionally a record), then Check."));
    return;
  }
  const d = data;
  const x = expl;
  const title = x.mode === "record" ? `${d.user.fullName} on ${d.record!.name} (${d.table.displayName})` : `${d.user.fullName} on table ${d.table.displayName}`;

  // Fold memory is keyed per check (user + table + record) and right: re-rendering the same check keeps what the
  // user opened; checking another user/table/record starts from the defaults (denied or disagreeing rights open).
  const foldScope = `why:${d.user.id}:${d.table.logicalName}:${d.record?.id ?? "table"}`;
  if (focusScope !== foldScope) {
    focusScope = foldScope;
    focusRight = null;
  }

  // A chip with a Why row is a button: it opens that row, scrolls to it and highlights the right's column in the
  // Roles table; clicking it again clears the highlight. Rights that do not apply (n/a) have no row and stay plain.
  const verdicts = h(
    "div",
    { class: "verdicts", id: "verdicts" },
    ...x.verdicts.map((v) => {
      const platform = v.platform;
      const cls = `verdict is-${platform === "yes" ? "yes" : platform === "no" ? "no" : "na"}`;
      const main = verdictBadge(v, x.mode);
      const depth =
        x.mode === "table"
          ? depthEl(v.platformDepth ?? v.bestDepth, "depth")
          : v.agrees === false
            ? h("span", { class: "depth", title: "The tool's explanation differs from the platform verdict: trust the platform" }, "tool disagrees")
            : null;
      if (!v.applicable) return h("div", { class: cls, "data-right": v.right }, h("span", { class: "right" }, v.right), main, depth);
      const b = h(
        "button",
        { class: cls, type: "button", "data-right": v.right, "aria-controls": whyId(v.right), "aria-pressed": String(focusRight === v.right), title: `Why ${v.right}: open its explanation and highlight its column in Roles` },
        h("span", { class: "right" }, v.right),
        main,
        depth,
      );
      b.addEventListener("click", () => {
        focusRight = focusRight === v.right ? null : v.right;
        const row = document.getElementById(whyId(v.right));
        if (focusRight && row instanceof HTMLDetailsElement) {
          row.open = true;
          row.scrollIntoView({ block: "nearest" });
        }
        syncFocus();
      });
      return b;
    }),
  );
  const why = h(
    "ul",
    { class: "why", id: "why" },
    ...x.verdicts
      .filter((v) => v.applicable)
      .map((v) => {
        const denied = (v.platform === "n/a" ? v.computed : v.platform) === "no";
        const row = h(
          "details",
          { id: whyId(v.right) },
          h("summary", { class: "chev" }, h("span", { class: "right" }, v.right), h("span", { class: "summary" }, v.summary), v.agrees === false ? badge("platform says otherwise", "warn") : v.agrees === true ? badge("agrees", "ok") : null),
          h(
            "div",
            { class: "detail" },
            whyPaths(v, x.mode, `No role grants ${d.tablePrivileges[v.right] ?? tablePrivilegeName(d.tablePrivileges, v.right, d.table.logicalName) ?? v.right}.`),
            v.sharePaths.length ? h("ul", {}, ...v.sharePaths.map((s) => h("li", { class: `path ${v.sharesEffective ? "is-ok" : "is-miss"}` }, `Share: ${s}${v.sharesEffective ? "" : " (no effect: the user holds no role with this privilege)"}`))) : null,
            v.hierarchyHint ? h("p", { class: "caption" }, v.hierarchyHint) : null,
            x.mode === "table" && v.platformDepth != null ? h("p", { class: "caption" }, "Platform effective depth: ", depthEl(v.platformDepth)) : null,
          ),
        );
        return h("li", { "data-right": v.right }, keepFold(row, `${foldScope}:${v.right}`, denied || v.agrees === false));
      }),
  );

  const roles = d.heldRoles.length ? rolesView(d) : null;
  const own = x.ownership;
  const ownership = own
    ? h(
        "dl",
        { class: "kv" },
        h("dt", {}, "Owner"), h("dd", {}, own.ownerLabel),
        h("dt", {}, "Owning BU"), h("dd", {}, own.owningBu?.name ?? "—"),
        h("dt", {}, "User BU"), h("dd", {}, own.userBu?.name ?? "—"),
        h("dt", {}, "Relation"), h("dd", { id: "relation" }, own.relation),
      )
    : h("dl", { class: "kv" }, h("dt", {}, "User BU"), h("dd", {}, d.userBu?.name ?? "—"), h("dt", {}, "Teams"), h("dd", {}, teamNames(d.teams)));

  const sharesForUser = x.sharesForUser.length
    ? table(["Via", "Rights"], x.sharesForUser.map((s) => [s.via, h("span", { class: "chips" }, ...s.entry.rights.map((r) => badge(r, "ok")))]))
    : h("p", { class: "caption" }, x.mode === "record" ? "No share on this record applies to the user." : "Table-level check: shares apply to records only.");

  append(
    panel,
    h("h2", {}, title),
    verdicts,
    notesBanner(x.notes),
    card("Why", why, foldAllButtons(why, "details")),
    roles ? fold("Roles", null, roles.body, true, "roles", roles.extra) : fold("Roles", 0, emptyState("No roles", "This user holds no security roles."), true, "roles"),
    fold("Ownership & business unit", null, ownership, true, "ownership"),
    fold("Shares affecting this user", x.mode === "record" ? x.sharesForUser.length : null, sharesForUser, true, "shares"),
    x.hierarchy ? fold("Hierarchy", null, h("p", { class: "caption", id: "hierarchy" }, x.hierarchy), false, "hierarchy") : null,
  );
}

const whyId = (r: Right): string => `why-${r}`;

/** Depth name with its meaning as a tooltip ("—" reads "None: …"). */
const depthEl = (d: Depth | null, cls?: string): HTMLElement => h("span", { class: cls, title: depthHint(d) }, depthLabel(d));

/** Verdict chip badge. A starred verdict is the tool's own result, shown when the platform's is unavailable. */
function verdictBadge(v: RightVerdict, mode: Explanation["mode"]): HTMLElement {
  if (!v.applicable) return withTitle(badge("n/a", "neutral"), "Not applicable: organization-owned tables have no Assign or Share");
  if (v.platform === "n/a") {
    const word = v.computed === "yes" ? "granted" : "denied";
    return withTitle(badge(`${word}*`, kindOf(v.computed)), `${word}*: platform verdict unavailable; this is the tool's computed result`);
  }
  const src = mode === "record" ? "RetrievePrincipalAccess" : "RetrieveUserPrivilegeByPrivilegeName";
  return withTitle(badge(v.platform === "yes" ? "granted" : "denied", kindOf(v.platform)), `Platform verdict (${src})`);
}
const withTitle = <T extends HTMLElement>(el: T, title: string): T => {
  el.title = title;
  return el;
};

/**
 * Why-row privilege paths. With one path and no share, the row's summary already is that path's sentence: only
 * what it leaves out (the depth, and whether the role is held directly or through a team) is shown again.
 */
function whyPaths(v: RightVerdict, mode: Explanation["mode"], none: string): HTMLElement {
  const held = (p: PrivilegePath): string => (p.viaTeam ? `held via team ${p.viaTeam.name} (${TEAM_TYPE_LABEL[p.viaTeam.type] ?? "team"})` : "held directly");
  const [only] = v.paths;
  if (v.paths.length === 1 && !v.sharePaths.length && v.summary.includes(only.role.name))
    return h("p", { class: "caption path-meta" }, depthEl(only.depth), " depth · ", held(only));
  if (!v.paths.length) return h("p", { class: "caption" }, none);
  return h(
    "ul",
    {},
    ...v.paths.map((p) =>
      h("li", { class: `path ${p.reaches === false ? "is-miss" : "is-ok"}` }, `${p.role.name}${p.viaTeam ? ` via team ${p.viaTeam.name}` : " (direct)"} · `, depthEl(p.depth), mode === "record" ? ` · ${p.reason}` : ""),
    ),
  );
}

/** Teams in the user details: the first few, then a "+N more" button that reveals the rest in place. */
const TEAMS_SHOWN = 5;
function teamNames(teams: TeamInfo[]): HTMLElement {
  const names = teams.map((t) => t.name);
  const el = h("span", { id: "teams" }, names.length ? names.slice(0, TEAMS_SHOWN).join(", ") : "none");
  const rest = names.slice(TEAMS_SHOWN);
  if (rest.length) {
    const more = h("button", { class: "btn btn-ghost btn-sm more-inline", type: "button", id: "btn-more-teams", title: rest.join(", ") }, `+${rest.length} more`);
    const wrap = h("span", {}, " ", more);
    more.addEventListener("click", () => {
      const tail = h("span", { tabindex: "-1" }, `, ${rest.join(", ")}`);
      wrap.replaceWith(tail);
      tail.focus(); // keep keyboard focus where the button was
    });
    el.append(wrap);
  }
  return el;
}

/** Notes banner: the first note always shows, any others fold behind "N more notes" (remembered for the page). */
function notesBanner(notes: string[]): HTMLElement | null {
  if (!notes.length) return null;
  const [first, ...rest] = notes;
  const more: Child = rest.length
    ? keepFold(
        h("details", { class: "more-notes" }, h("summary", { class: "chev" }, `${rest.length} more ${rest.length === 1 ? "note" : "notes"}`), h("ul", { class: "notes" }, ...rest.map((n) => h("li", {}, n)))),
        "ac:more-notes",
      )
    : null;
  return h("div", { class: "warnings", id: "notes" }, h("ul", { class: "notes" }, h("li", {}, first)), more);
}

/** Highlight the focused right's column in the Roles table (under `root`) and mark which verdict chip is pressed. */
function markFocusColumn(root: ParentNode): void {
  const col = focusRight ? 2 + RIGHTS.indexOf(focusRight) : -1; // Role, Held, then one column per right
  root.querySelectorAll<HTMLTableRowElement>("table.roles tr").forEach((tr) => [...tr.children].forEach((c, j) => c.classList.toggle("is-focus", j === col)));
}
function syncFocus(): void {
  document.querySelectorAll<HTMLElement>("#verdicts button.verdict").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.right === focusRight)));
  markFocusColumn($("#tab-check"));
}

/**
 * Check-tab fold card, open/closed remembered for the page under `ac:<key>` (across checks); `count` null shows no
 * count badge. Controls in `extra` sit inside <summary>: a click or Space on a
 * checkbox, its label or a button there is handled by that control and does not toggle the fold (e2e covers it).
 */
function fold(title: string, count: number | null, body: Node, open: boolean, key: string, extra?: HTMLElement): HTMLElement {
  const el = foldCard(title, count, body, open, { key: `ac:${key}`, extra });
  el.id = `card-${key}`;
  return el;
}

/**
 * Roles card body + header controls. The "hide roles with no privilege" toggle re-renders only this body, so the
 * rest of the check (Why folds, scroll position) is left alone. A role held through a team counts like a direct one.
 */
function rolesView(d: CheckData): { body: HTMLElement; extra: HTMLElement } {
  const prvs = RIGHTS.map((r) => tablePrivilegeName(d.tablePrivileges, r, d.table.logicalName));
  const depthOf = (roleId: string, i: number): Depth | null => {
    const prv = prvs[i];
    return prv ? (d.rolePrivileges[roleId]?.[prv] ?? null) : null;
  };
  // System Administrator always counts: the verdict treats it as full access whatever its stored privileges say
  const relevant = (hr: CheckData["heldRoles"][number]): boolean => isSystemAdminRole(hr.role) || RIGHTS.some((_, i) => depthOf(hr.role.id, i) != null);
  const body = h("div", { id: "roles-body" });
  const caption = h("span", { class: "count-caption", id: "roles-count" });
  const box = h("input", { type: "checkbox", id: "hide-irrelevant-roles" });
  box.checked = hideIrrelevantRoles;
  const render = (): void => {
    const all = d.heldRoles;
    const shown = hideIrrelevantRoles ? all.filter(relevant) : all;
    caption.textContent = shownOf(shown.length, all.length, all.length === 1 ? "role" : "roles");
    if (!shown.length) {
      const show = h("button", { class: "btn btn-ghost btn-sm", type: "button", id: "btn-show-all-roles" }, "Show all roles");
      show.addEventListener("click", () => {
        box.checked = false;
        box.dispatchEvent(new Event("change")); // saves the toggle and re-renders
      });
      body.replaceChildren(
        h("p", { class: "caption roles-none" }, `None of the user's ${all.length} ${all.length === 1 ? "role" : "roles"} grants a privilege on ${d.table.displayName}.`, show),
      );
      return;
    }
    body.replaceChildren(
      table(
        ["Role", "Held", ...RIGHTS],
        shown.map((hr) => [
          hr.role.name,
          hr.viaTeam ? `via team ${hr.viaTeam.name} (${TEAM_TYPE_LABEL[hr.viaTeam.type] ?? "team"})${hr.role.isInherited ? "" : " · team privileges only"}` : "direct",
          ...RIGHTS.map((_, i) => depthEl(depthOf(hr.role.id, i))),
        ]),
        undefined,
        "roles",
      ),
    );
    markFocusColumn(body);
  };
  box.addEventListener("change", () => {
    hideIrrelevantRoles = box.checked;
    saveView(VIEW, "hideIrrelevantRoles", hideIrrelevantRoles ? undefined : false);
    render();
  });
  render();
  const extra = h("span", { class: "roles-filter" }, h("label", { class: "check" }, box, "Hide roles with no privilege on this table"), caption);
  return { body: h("div", {}, body, depthLegend()), extra };
}

/** Collapsed legend under the Roles table: what each depth name covers (also on each cell's tooltip). */
function depthLegend(): HTMLElement {
  const depths: (Depth | null)[] = [0, 1, 2, 3, null];
  const row = (d: Depth | null): Node[] => {
    const i = depthInfo(d);
    return [h("dt", {}, d == null ? "— (None)" : i.name), h("dd", {}, i.meaning)];
  };
  return keepFold(
    h(
      "details",
      { class: "depth-legend", id: "depth-legend" },
      h("summary", { class: "chev caption" }, "Depth legend"),
      h("dl", { class: "kv" }, ...depths.flatMap(row)),
      h("p", { class: "caption" }, "Local and Deep count from the business unit of the role (or team) that grants the privilege: the user's own unless a note above says otherwise."),
    ),
    "ac:depth-legend",
  );
}

// ---------- render: shares ----------
/** Search box + toggle row above a filtered table; `onChange` re-renders only the results, so focus stays in the box. */
function filterBar(o: { id: string; q: string; placeholder: string; label: string; toggleLabel: string; on: boolean; onChange: (q: string, on: boolean) => void }): { bar: HTMLElement; caption: HTMLElement; set: (q: string, on: boolean) => void } {
  const search = h("input", { type: "search", id: `${o.id}-q`, placeholder: o.placeholder, "aria-label": o.label });
  search.value = o.q;
  const box = h("input", { type: "checkbox", id: `${o.id}-only` });
  box.checked = o.on;
  const caption = h("span", { class: "count-caption", id: `${o.id}-count`, "aria-live": "polite" });
  const fire = (): void => o.onChange(search.value, box.checked);
  search.addEventListener("input", fire);
  box.addEventListener("change", fire);
  const set = (q: string, on: boolean): void => {
    search.value = q;
    box.checked = on;
    fire();
  };
  return { bar: h("div", { class: "filters" }, search, h("label", { class: "check" }, box, o.toggleLabel), caption), caption, set };
}

function renderShares(): void {
  const panel = $("#tab-shares");
  panel.replaceChildren();
  if (!data) {
    panel.append(emptyState("No check yet", "Run a check with a record to list its shares."));
    return;
  }
  if (!data.record) {
    panel.append(emptyState("Table-level check", "Shares exist on records. Pick a record and Check again."));
    return;
  }
  const d = data;
  const rec = data.record;
  const shares = d.shares ?? [];
  const affects = (e: ShareEntry): string | null => (e.principalType === "systemuser" && e.principalId === d.user.id ? "direct" : e.principalType === "team" && d.teams.some((t) => t.id === e.principalId) ? "via team" : null);
  const btn = h("button", { class: "btn btn-ghost btn-sm", type: "button", id: "btn-export-shares" }, "Export CSV");
  btn.addEventListener("click", async () => {
    if (await saveText(safeFileName(`${d.table.logicalName}_${rec.id}_shares`) + ".csv", sharesCsv(shares, affects), "text/csv")) await notify("Exported", "Shares CSV", "success");
  });
  // Shares that reach the checked user (directly or through one of their teams) come first; order is otherwise kept.
  const rows = shares.map((e) => ({ e, via: affects(e), name: e.principalName ?? e.principalId })).sort((a, b) => (a.via ? 0 : 1) - (b.via ? 0 : 1));
  const nAffect = rows.filter((r) => r.via).length;
  const noun = shares.length === 1 ? "principal" : "principals";
  const title = `${shares.length} ${noun} · ${nAffect} ${nAffect === 1 ? "affects" : "affect"} ${d.user.fullName}`;
  if (!shares.length) {
    panel.append(h("h2", {}, `Shares on ${rec.name}`), card(title, emptyState("No shares", "Nobody has been granted access to this record explicitly."), btn));
    return;
  }
  const results = h("div", { id: "shares-body" });
  const f = filterBar({
    id: "shares",
    q: sharesQ,
    placeholder: "Search principal…",
    label: "Search share principals",
    toggleLabel: `Only shares affecting ${d.user.fullName}`,
    on: sharesOnlyAffecting,
    onChange: (q, on) => {
      sharesQ = q;
      if (on !== sharesOnlyAffecting) saveView(VIEW, "sharesOnlyAffecting", on || undefined);
      sharesOnlyAffecting = on;
      apply();
    },
  });
  const apply = (): void => {
    const q = sharesQ.trim().toLowerCase();
    const shown = rows.filter((r) => (!sharesOnlyAffecting || r.via) && (!q || r.name.toLowerCase().includes(q)));
    f.caption.textContent = shown.length === rows.length ? "" : shownOf(shown.length, rows.length, noun);
    results.replaceChildren(
      shown.length
        ? table(
            ["Principal", "Type", "Rights", "Affects checked user"],
            shown.map((r) => [r.name, r.e.principalType === "team" ? "team" : "user", h("span", { class: "chips" }, ...r.e.rights.map((x) => badge(x, "neutral"))), r.via ? badge(r.via, "ok") : ""]),
            (i) => (shown[i].via ? "is-affecting" : undefined),
            "shares",
          )
        : filteredEmpty(
            "No shares match",
            sharesOnlyAffecting && !nAffect ? `No share on this record affects ${d.user.fullName}.` : `The search or “Only shares affecting ${d.user.fullName}” hide every principal.`,
            () => f.set("", false),
          ),
    );
  };
  apply();
  panel.append(h("h2", {}, `Shares on ${rec.name}`), card(title, h("div", {}, f.bar, results), btn));
}

// ---------- render: columns ----------
function renderColumns(): void {
  const panel = $("#tab-columns");
  panel.replaceChildren();
  if (colState === "loading") {
    panel.append(emptyState("Loading column security…", "Column security for this check is still loading."));
    return;
  }
  if (colState === "failed") {
    panel.append(emptyState("Column security failed to load", colError ?? "Run the check again."));
    return;
  }
  if (!data || !colRows) {
    panel.append(emptyState("No check yet", "Run a check to see column security for the table."));
    return;
  }
  const d = data;
  const rows = colRows;
  const via = (p: ColumnAccess["read"]): Node => (p.length ? h("span", {}, badge("yes", "ok"), " ", h("span", { class: "caption" }, p.map((x) => (x.viaTeam ? `${x.name} (team ${x.viaTeam.name})` : x.name)).join(", "))) : badge("no", "bad"));
  const btn = h("button", { class: "btn btn-ghost btn-sm", type: "button", id: "btn-export-columns" }, "Export CSV");
  btn.addEventListener("click", async () => {
    if (await saveText(safeFileName(`${d.table.logicalName}_${d.user.fullName}_columns`) + ".csv", columnsCsv(rows), "text/csv")) await notify("Exported", "Column security CSV", "success");
  });
  const noun = rows.length === 1 ? "secured column" : "secured columns";
  const heading = h("h2", {}, `Column security on ${d.table.displayName} for ${d.user.fullName}`);
  if (!rows.length) {
    panel.append(heading, card(`0 ${noun}`, emptyState("No secured columns", "This table has no column with column security enabled."), btn));
    return;
  }
  const denied = (r: ColumnAccess): boolean => !r.read.length || !r.update.length || !r.create.length;
  const results = h("div", { id: "columns-body" });
  const f = filterBar({
    id: "columns",
    q: columnsQ,
    placeholder: "Search column…",
    label: "Search secured columns",
    toggleLabel: "Only columns with a denied right",
    on: columnsOnlyDenied,
    onChange: (q, on) => {
      columnsQ = q;
      if (on !== columnsOnlyDenied) saveView(VIEW, "columnsOnlyDenied", on || undefined);
      columnsOnlyDenied = on;
      apply();
    },
  });
  const apply = (): void => {
    const q = columnsQ.trim().toLowerCase();
    const shown = rows.filter((r) => (!columnsOnlyDenied || denied(r)) && (!q || r.column.displayName.toLowerCase().includes(q) || r.column.logicalName.toLowerCase().includes(q)));
    f.caption.textContent = shown.length === rows.length ? "" : shownOf(shown.length, rows.length, noun);
    results.replaceChildren(
      shown.length
        ? table(["Column", "Logical name", "Read", "Update", "Create"], shown.map((r) => [r.column.displayName, h("span", { class: "mono" }, r.column.logicalName), via(r.read), via(r.update), via(r.create)]), undefined, "columns")
        : filteredEmpty(
            "No columns match",
            columnsOnlyDenied && !rows.some(denied) ? `${d.user.fullName} has every right on every secured column.` : "The search or “Only columns with a denied right” hide every secured column.",
            () => f.set("", false),
          ),
    );
  };
  apply();
  panel.append(heading, card(`${rows.length} ${noun}`, h("div", {}, f.bar, results), btn));
}

// ---------- connection ----------
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

// ---------- wiring ----------
function wire(): void {
  wireTabs(() => undefined);
  const userQ = $<HTMLInputElement>("#user-q");
  const userList = $("#user-results");
  userQ.addEventListener(
    "input",
    debounce(async () => {
      const a = api();
      const q = userQ.value.trim();
      const seq = ++userSeq;
      if (!a || q.length < 2) {
        userList.hidden = true;
        return;
      }
      try {
        const found = await searchUsers(a, q);
        if (seq !== userSeq) return;
        suggest(
          userList,
          found.map((u) => ({
            title: u.fullName + (u.isDisabled ? " (disabled)" : ""),
            meta: [u.domainName ?? u.email, u.businessUnitId ? `BU ${cache.businessUnits?.find((b) => b.id === u.businessUnitId)?.name ?? u.businessUnitId}` : null].filter(Boolean).join(" · "),
            onPick: () => {
              user = u;
              userQ.value = "";
              renderUserSel();
              updateCheckButton();
            },
          })),
          "No users match",
        );
      } catch (e) {
        await notify("User search failed", (e as Error).message, "error");
      }
    }, 250),
  );
  userQ.addEventListener("blur", () => setTimeout(() => (userList.hidden = true), 200));

  const recQ = $<HTMLInputElement>("#record-q");
  const recList = $("#record-results");
  $<HTMLSelectElement>("#table").addEventListener("change", (ev) => {
    const ln = (ev.target as HTMLSelectElement).value;
    tbl = tables.find((t) => t.logicalName === ln) ?? null;
    // Drop any record search in flight for the previous table and its suggestions.
    recSeq++;
    recList.hidden = true;
    recList.replaceChildren();
    record = null;
    recordId = null;
    $<HTMLInputElement>("#record-q").value = "";
    renderRecordSel();
    updateCheckButton();
  });

  recQ.addEventListener(
    "input",
    debounce(async () => {
      const a = api();
      const q = recQ.value.trim();
      const seq = ++recSeq;
      const t = tbl;
      recList.hidden = true;
      if (GUID.test(q)) {
        recordId = q.replace(/[{}]/g, "").toLowerCase();
        record = null;
        renderRecordSel();
        return;
      }
      if (!a || !t || q.length < 2) return;
      try {
        const found = await searchRecords(a, t, q);
        // Results belong to the table and text they were searched for.
        if (seq !== recSeq || tbl !== t) return;
        suggest(
          recList,
          found.map((r) => ({
            title: r.name,
            meta: `${r.id}${r.ownerName ? ` · owner ${r.ownerName}` : ""}`,
            onPick: () => {
              if (tbl !== t) return;
              record = r;
              recordId = r.id;
              recQ.value = "";
              renderRecordSel();
            },
          })),
          t.primaryName ? "No records match" : "This table has no primary name column: paste a GUID",
        );
      } catch (e) {
        if (seq !== recSeq) return;
        await notify("Record search failed", (e as Error).message, "error");
      }
    }, 250),
  );
  recQ.addEventListener("blur", () => setTimeout(() => (recList.hidden = true), 200));

  $("#inputs").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void runCheck();
  });
  $("#btn-export-json").addEventListener("click", async () => {
    if (!data || !expl) return;
    const name = safeFileName(`${data.user.fullName}_${data.table.logicalName}${data.record ? "_" + data.record.id : ""}`) + ".access.json";
    if (await saveText(name, checkJson(data, expl, envName))) await notify("Exported", name, "success");
  });
  onConnectionChange(() => {
    cache.tables = null;
    cache.businessUnits = null;
    cache.privileges = null;
    cache.rolePrivileges = {};
    cache.userPrivileges = {};
    cache.hierarchy = undefined;
    cache.hierarchyMaxDepth = undefined;
    cache.tablePrivileges = {};
    void renderConnection();
    void loadTables().then(updateCheckButton);
  });
}

async function main(): Promise<void> {
  await initTheme((t) => document.documentElement.setAttribute("data-theme", t));
  $("#host-mode").textContent = inToolbox() ? "Running inside Power Platform ToolBox" : "No ToolBox host: connect inside ToolBox to run checks";
  wire();
  renderCheck();
  renderShares();
  renderColumns();
  await renderConnection();
  const a = api();
  if (a) await fetchBusinessUnits(a, cache).catch(() => []);
  await loadTables();
  updateCheckButton();
}

mountDebug(document.querySelector("footer"), "access-checker");
void main();

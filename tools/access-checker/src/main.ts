import { $, append, badge, card, emptyState, h, table, wireTabs, type BadgeKind } from "../../_shared/dom";
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
import { depthLabel, isSystemAdminRole, tablePrivilegeName } from "./access/privileges";
import { RIGHTS, TEAM_TYPE_LABEL, type CheckData, type ColumnAccess, type Explanation, type RecordInfo, type ShareEntry, type TableInfo, type UserInfo } from "./access/types";

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
let envName: string | null = null;

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
  const t = tbl;
  setStatus("Checking…");
  $<HTMLButtonElement>("#btn-check").disabled = true;
  try {
    const fresh = (await fetchUser(a, user.id)) ?? user;
    user = fresh;
    renderUserSel();
    const [direct, teams, bus, tablePrivileges] = await Promise.all([fetchDirectRoles(a, fresh.id), fetchTeams(a, fresh.id), fetchBusinessUnits(a, cache), fetchTablePrivileges(a, cache, t.logicalName)]);
    const held = heldRoles(direct, teams);
    const rolePrivileges = await fetchRolePrivileges(a, cache, held.map((x) => x.role));
    let rec: RecordInfo | null = null;
    if (recordId && (!record || record.id !== recordId)) rec = await fetchRecord(a, t, recordId);
    else rec = record;
    if (recordId && !rec) throw new Error(`Record ${recordId} not found in ${t.logicalName}`);
    record = rec;
    renderRecordSel();

    let shares: ShareEntry[] | null = null;
    let platformRights: ReturnType<typeof explain>["verdicts"][number]["right"][] | null = null;
    let platformDepths: CheckData["platformDepths"] = null;
    let hierarchyEnabled: boolean | null = null;
    let hierarchyMaxDepth = 3;
    let ownerManagers: UserInfo[] = [];
    if (rec) {
      const [sh, pa, hier] = await Promise.all([
        fetchShares(a, t, rec.id).catch((e: Error) => {
          void notify("Shares", e.message, "warning");
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
    $<HTMLButtonElement>("#btn-export-json").disabled = false;

    setStatus("Loading column security…");
    const isAdmin = held.some((x) => isSystemAdminRole(x.role));
    const [cols, profiles] = await Promise.all([fetchSecuredColumns(a, t), fetchFieldProfiles(a, fresh.id, teams)]);
    const perms = await fetchFieldPermissions(a, t, [...new Set(profiles.map((p) => p.id))]);
    colRows = columnAccess(cols, profiles, perms, isAdmin);
    renderColumns();
    setStatus(null);
  } catch (e) {
    setStatus(null);
    await notify("Check failed", (e as Error).message, "error");
  } finally {
    updateCheckButton();
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

  const verdicts = h(
    "div",
    { class: "verdicts", id: "verdicts" },
    ...x.verdicts.map((v) => {
      const platform = v.platform;
      const cls = `verdict is-${platform === "yes" ? "yes" : platform === "no" ? "no" : "na"}`;
      const main = platform === "n/a" && v.applicable ? badge(v.computed === "yes" ? "granted*" : "denied*", kindOf(v.computed)) : badge(platform === "yes" ? "granted" : platform === "no" ? "denied" : "n/a", kindOf(platform));
      const depth = x.mode === "table" ? h("span", { class: "depth" }, depthLabel(v.platformDepth ?? v.bestDepth)) : v.agrees === false ? h("span", { class: "depth" }, "tool disagrees") : null;
      return h("div", { class: cls, "data-right": v.right }, h("span", { class: "right" }, v.right), main, depth);
    }),
  );

  const why = h(
    "ul",
    { class: "why", id: "why" },
    ...x.verdicts
      .filter((v) => v.applicable)
      .map((v) =>
        h(
          "li",
          {},
          h(
            "details",
            {},
            h("summary", {}, h("span", { class: "right" }, v.right), h("span", { class: "summary" }, v.summary), v.agrees === false ? badge("platform says otherwise", "warn") : v.agrees === true ? badge("agrees", "ok") : null),
            h(
              "div",
              { class: "detail" },
              v.paths.length
                ? h("ul", {}, ...v.paths.map((p) => h("li", { class: `path ${p.reaches === false ? "is-miss" : "is-ok"}` }, `${p.role.name}${p.viaTeam ? ` via team ${p.viaTeam.name}` : " (direct)"} · ${depthLabel(p.depth)}${x.mode === "record" ? ` · ${p.reason}` : ""}`)))
                : h("p", { class: "caption" }, `No role grants ${d.tablePrivileges[v.right] ?? tablePrivilegeName(d.tablePrivileges, v.right, d.table.logicalName) ?? v.right}.`),
              v.sharePaths.length ? h("ul", {}, ...v.sharePaths.map((s) => h("li", { class: `path ${v.sharesEffective ? "is-ok" : "is-miss"}` }, `Share: ${s}${v.sharesEffective ? "" : " (no effect: the user holds no role with this privilege)"}`))) : null,
              v.hierarchyHint ? h("p", { class: "caption" }, v.hierarchyHint) : null,
              x.mode === "table" && v.platformDepth != null ? h("p", { class: "caption" }, `Platform effective depth: ${depthLabel(v.platformDepth)}`) : null,
            ),
          ),
        ),
      ),
  );

  const roles = d.heldRoles.length
    ? table(
        ["Role", "Held", ...RIGHTS],
        d.heldRoles.map((hr) => [
          hr.role.name,
          hr.viaTeam ? `via team ${hr.viaTeam.name} (${TEAM_TYPE_LABEL[hr.viaTeam.type] ?? "team"})${hr.role.isInherited ? "" : " · team privileges only"}` : "direct",
          ...RIGHTS.map((r) => {
            const prv = tablePrivilegeName(d.tablePrivileges, r, d.table.logicalName);
            return depthLabel(prv ? (d.rolePrivileges[hr.role.id]?.[prv] ?? null) : null);
          }),
        ]),
        undefined,
        "roles",
      )
    : emptyState("No roles", "This user holds no security roles.");

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
    : h("dl", { class: "kv" }, h("dt", {}, "User BU"), h("dd", {}, d.userBu?.name ?? "—"), h("dt", {}, "Teams"), h("dd", {}, d.teams.length ? d.teams.map((t) => t.name).join(", ") : "none"));

  const sharesForUser = x.sharesForUser.length
    ? table(["Via", "Rights"], x.sharesForUser.map((s) => [s.via, h("span", { class: "chips" }, ...s.entry.rights.map((r) => badge(r, "ok")))]))
    : h("p", { class: "caption" }, x.mode === "record" ? "No share on this record applies to the user." : "Table-level check: shares apply to records only.");

  append(
    panel,
    h("h2", {}, title),
    verdicts,
    x.notes.length ? h("div", { class: "warnings" }, h("ul", { class: "notes" }, ...x.notes.map((n) => h("li", {}, n)))) : null,
    card("Why", why),
    card("Roles", roles),
    card("Ownership & business unit", ownership),
    card("Shares affecting this user", sharesForUser),
    x.hierarchy ? card("Hierarchy", h("p", { class: "caption", id: "hierarchy" }, x.hierarchy)) : null,
  );
}

// ---------- render: shares ----------
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
  const shares = data.shares ?? [];
  const affects = (e: ShareEntry): string | null => (e.principalType === "systemuser" && e.principalId === data!.user.id ? "direct" : e.principalType === "team" && data!.teams.some((t) => t.id === e.principalId) ? "via team" : null);
  const btn = h("button", { class: "btn btn-ghost btn-sm", type: "button", id: "btn-export-shares" }, "Export CSV");
  btn.addEventListener("click", async () => {
    if (await saveText(safeFileName(`${data!.table.logicalName}_${data!.record!.id}_shares`) + ".csv", sharesCsv(shares, affects), "text/csv")) await notify("Exported", "Shares CSV", "success");
  });
  panel.append(
    h("h2", {}, `Shares on ${data.record.name}`),
    card(
      `${shares.length} principal${shares.length === 1 ? "" : "s"}`,
      shares.length
        ? table(
            ["Principal", "Type", "Rights", "Affects checked user"],
            shares.map((e) => {
              const via = affects(e);
              return [e.principalName ?? e.principalId, e.principalType === "team" ? "team" : "user", h("span", { class: "chips" }, ...e.rights.map((r) => badge(r, "neutral"))), via ? badge(via, "ok") : ""];
            }),
            undefined,
            "shares",
          )
        : emptyState("No shares", "Nobody has been granted access to this record explicitly."),
      btn,
    ),
  );
}

// ---------- render: columns ----------
function renderColumns(): void {
  const panel = $("#tab-columns");
  panel.replaceChildren();
  if (!data || !colRows) {
    panel.append(emptyState("No check yet", "Run a check to see column security for the table."));
    return;
  }
  const rows = colRows;
  const via = (p: ColumnAccess["read"]): Node => (p.length ? h("span", {}, badge("yes", "ok"), " ", h("span", { class: "caption" }, p.map((x) => (x.viaTeam ? `${x.name} (team ${x.viaTeam.name})` : x.name)).join(", "))) : badge("no", "bad"));
  const btn = h("button", { class: "btn btn-ghost btn-sm", type: "button", id: "btn-export-columns" }, "Export CSV");
  btn.addEventListener("click", async () => {
    if (await saveText(safeFileName(`${data!.table.logicalName}_${data!.user.fullName}_columns`) + ".csv", columnsCsv(rows), "text/csv")) await notify("Exported", "Column security CSV", "success");
  });
  panel.append(
    h("h2", {}, `Column security on ${data.table.displayName} for ${data.user.fullName}`),
    card(
      `${rows.length} secured column${rows.length === 1 ? "" : "s"}`,
      rows.length
        ? table(["Column", "Logical name", "Read", "Update", "Create"], rows.map((r) => [r.column.displayName, h("span", { class: "mono" }, r.column.logicalName), via(r.read), via(r.update), via(r.create)]), undefined, "columns")
        : emptyState("No secured columns", "This table has no column with column security enabled."),
      btn,
    ),
  );
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
      if (!a || q.length < 2) {
        userList.hidden = true;
        return;
      }
      try {
        const found = await searchUsers(a, q);
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

  $<HTMLSelectElement>("#table").addEventListener("change", (ev) => {
    const ln = (ev.target as HTMLSelectElement).value;
    tbl = tables.find((t) => t.logicalName === ln) ?? null;
    record = null;
    recordId = null;
    $<HTMLInputElement>("#record-q").value = "";
    renderRecordSel();
    updateCheckButton();
  });

  const recQ = $<HTMLInputElement>("#record-q");
  const recList = $("#record-results");
  recQ.addEventListener(
    "input",
    debounce(async () => {
      const a = api();
      const q = recQ.value.trim();
      recList.hidden = true;
      if (GUID.test(q)) {
        recordId = q.replace(/[{}]/g, "").toLowerCase();
        record = null;
        renderRecordSel();
        return;
      }
      if (!a || !tbl || q.length < 2) return;
      try {
        const found = await searchRecords(a, tbl, q);
        suggest(
          recList,
          found.map((r) => ({
            title: r.name,
            meta: `${r.id}${r.ownerName ? ` · owner ${r.ownerName}` : ""}`,
            onPick: () => {
              record = r;
              recordId = r.id;
              recQ.value = "";
              renderRecordSel();
            },
          })),
          tbl.primaryName ? "No records match" : "This table has no primary name column: paste a GUID",
        );
      } catch (e) {
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

void main();

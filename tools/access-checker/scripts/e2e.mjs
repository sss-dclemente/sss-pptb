// E2E smoke test for the dist build with a mocked PPTB host (window.toolboxAPI / window.dataverseAPI).
// Fixture: BUs Root > Sales. Ana (Sales, reports to Carla) holds "Sales Person" directly (Read Deep,
// Write/Create Basic, Append/AppendTo Local on account, Read Global on task = prvReadActivity) and
// "Root Appender" directly from BU Root (AppendTo Local: record ownership across BUs), plus via owner
// team "Sales EU" "Sharer" (Share Local) and "Team Assigner" (Assign Basic, isinherited = 0 "Team
// privileges only"). Accounts owned by Ana (shared Read with 60 users), Bruno (Sales, reports to Ana)
// and Carla (Root); Carla's account shared Write + Delete with team Sales EU (Ana holds no Delete
// privilege, so the Delete share has no effect). Organization hierarchy depth 1.
// Diego (Root) holds a System Administrator copy under a localized name: detected by roletemplateid.
// One secured column (sss_margin) readable through profile "Margin Readers" held by the team.
// privileges and systemusers are paged (@odata.nextLink); `or` filters over 50 ids are rejected.
// Run: npm run build && node scripts/e2e.mjs   (needs playwright + chromium available)
import { launchPage } from "../../_shared/e2e-loader.mjs";
import { checkDebugLog } from "../../_shared/e2e-debug.mjs";
import { mockHost } from "./mock-host.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const MOCK = mockHost();

const { page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto("file://" + TOOL + "/dist/index.html");

const text = (sel) => page.textContent(sel);
const chip = async (right) => (await page.textContent(`#verdicts .verdict[data-right="${right}"]`)).replace(/\s+/g, " ").trim();

assert((await text("#host-mode")).includes("inside Power Platform ToolBox"), "toolbox host detected");
assert((await text("#conn")).includes("Contoso Dev"), "connection chip");
await page.waitForFunction(() => document.querySelectorAll("#table option").length > 1);
const opts = await page.$$eval("#table option", (o) => o.map((x) => x.value));
assert(opts.includes("account") && opts.includes("sss_setting") && !opts.includes("accountleads"), "tables loaded, intersect filtered");
assert((await text("#tab-check")).includes("No check yet"), "empty state");

// user typeahead
await page.fill("#user-q", "ana");
await page.waitForSelector("#user-results li button");
assert((await text("#user-results")).includes("Ana Silva") && (await text("#user-results")).includes("BU Sales"), "user suggestions with BU");
await page.click("#user-results li button");
assert((await text("#user-sel")).includes("Ana Silva"), "user selected");
assert(await page.$eval("#btn-check", (b) => b.disabled), "check disabled until table");
await page.selectOption("#table", "account");
assert(!(await page.$eval("#btn-check", (b) => b.disabled)), "check enabled");

// table-level check
await page.click("#btn-check");
await page.waitForSelector("#verdicts");
await page.waitForFunction(() => document.querySelector("#tab-columns table.columns"));
assert((await chip("Read")).includes("granted") && (await chip("Read")).includes("Deep"), "table-level Read Deep");
assert((await chip("Share")).includes("granted") && (await chip("Share")).includes("Local"), "table-level Share Local via team");
assert((await chip("Delete")).includes("denied"), "table-level Delete denied");
assert((await chip("Assign")).includes("granted") && (await chip("Assign")).includes("Basic"), "table-level Assign Basic from the team-only role");
const why1 = await text("#why");
assert(why1.includes("Deep via Sales Person") && why1.includes("Local via Sharer (team Sales EU)"), "why summaries name roles and team");
assert(why1.includes("agrees") && !why1.includes("platform says otherwise"), "tool agrees with RetrieveUserPrivilegeByPrivilegeName");
// Why rows: chevron cue, denied rights open by default, granted closed, expand/collapse all.
{
  const whyOpen = (right) => page.$eval(`#why li[data-right="${right}"] details`, (d) => d.open);
  assert(await page.$$eval("#why summary", (s) => s.length > 0 && s.every((x) => x.classList.contains("chev"))), "why: summaries carry the chev class");
  assert(await page.$eval("#why summary", (s) => getComputedStyle(s, "::before").content !== "none" && getComputedStyle(s).display === "flex"), "why: chevron rendered, summary still flex");
  assert((await whyOpen("Delete")) === true && (await whyOpen("Read")) === false, "why: denied Delete open by default, granted Read closed");
  const card = page.locator(".card", { has: page.locator("#why") });
  await card.locator(".fold-all button", { hasText: "Expand all" }).click();
  assert(await page.$$eval("#why details", (d) => d.every((x) => x.open)), "why: Expand all opens every row");
  await card.locator(".fold-all button", { hasText: "Collapse all" }).click();
  assert(await page.$$eval("#why details", (d) => d.every((x) => !x.open)), "why: Collapse all closes every row");
}
// A8: depth names and verdicts explain themselves; depth legend under Roles; one-path Why rows don't repeat the summary.
{
  const title = (sel) => page.getAttribute(sel, "title");
  assert((await title('#verdicts .verdict[data-right="Read"] .depth')).startsWith("Deep (Parent: Child Business Units): records in the user's business unit and its child"), "legend: chip depth carries a tooltip");
  assert((await title('#verdicts .verdict[data-right="Read"] .badge')).startsWith("Platform verdict"), "legend: platform verdict badge carries a tooltip");
  const cellTitles = await page.$$eval("#tab-check table.roles td span[title]", (s) => Object.fromEntries(s.map((x) => [x.textContent, x.title])));
  assert(cellTitles.Global === undefined && cellTitles.Deep.includes("child business units") && cellTitles.Basic.startsWith("Basic (User): records the user") && cellTitles.Local.startsWith("Local (Business Unit): records in the user's business unit") && cellTitles["—"].startsWith("None"), "legend: Roles depth cells carry tooltips: " + JSON.stringify(cellTitles));
  const legend = "#card-roles #depth-legend";
  assert(await page.$eval(legend, (d) => d.tagName === "DETAILS" && !d.open && d.querySelector(":scope > summary").classList.contains("chev") && d.querySelector(":scope > summary").textContent === "Depth legend"), "legend: Roles card has a collapsed 'Depth legend' fold with a chevron");
  const legendText = await text(legend);
  assert(["Basic (User)", "Local (Business Unit)", "Deep (Parent: Child Business Units)", "Global (Organization)", "— (None)", "every record in the organisation"].every((t) => legendText.includes(t)), "legend: lists every depth name with its meaning");
  await page.click(`${legend} > summary`);
  assert(await page.$eval(legend, (d) => d.open), "legend: opens on click");
  await page.uncheck("#hide-irrelevant-roles");
  assert(await page.$eval(legend, (d) => d.open), "legend: stays open when the roles toggle re-renders the table");
  await page.check("#hide-irrelevant-roles");
  await page.click(`${legend} > summary`);
  // One path, no share: the row's summary is that path's sentence; the detail adds only depth and how it is held.
  const detail = (r) => page.$eval(`#why-${r} .detail`, (d) => d.textContent.replace(/\s+/g, " ").trim());
  const meta = (r) => page.$eval(`#why-${r} .detail > :first-child`, (d) => d.textContent);
  assert((await detail("Read")) === "Deep depth · held directlyPlatform effective depth: Deep" && (await meta("Read")) === "Deep depth · held directly", "why: one-path Read detail shows only depth and how it is held (+ platform depth)");
  assert((await meta("Share")) === "Local depth · held via team Sales EU (owner team)", "why: one-path Share detail names the team");
  assert(!(await detail("Read")).includes("Sales Person") && (await text("#why-Read summary")).includes("Deep via Sales Person"), "why: role named once, in the summary");
  assert((await page.$$("#why-AppendTo .detail li")).length === 2 && (await detail("AppendTo")).includes("Root Appender (direct)") && (await detail("AppendTo")).includes("Sales Person (direct)"), "why: several paths still list each one");
  assert((await detail("Delete")).includes("No role grants prvDeleteAccount."), "why: no path keeps its 'no role grants' line");
  assert((await title("#why-Read .detail span[title]")).startsWith("Deep"), "why: depth in the detail carries a tooltip");
  // Teams in the user details: one team, no "+N more".
  assert((await text("#teams")) === "Sales EU" && !(await page.$("#btn-more-teams")), "teams: short list shown whole");
  // Notes banner: first note shown, the other folded behind "1 more note".
  assert((await page.$$("#notes > ul.notes > li")).length === 1, "notes: one note shown up front");
  assert(await page.$eval("#notes details.more-notes", (d) => !d.open && d.querySelector(":scope > summary.chev").textContent === "1 more note"), "notes: the rest behind a closed '1 more note' chevron fold");
  await page.click("#notes details.more-notes > summary");
  assert(await page.$eval("#notes details.more-notes", (d) => d.open && d.textContent.includes("Team privileges only")) && (await text("#notes > ul.notes")).includes("Direct role Root Appender"), "notes: opening the fold shows the other note");
}
// The point of moving off RetrieveUserPrivileges: prvShareAccount comes from a role held
// through a team, and its real depth is Local. The old message reports team-inherited
// privileges as Basic, which would have shown "Basic" here and flagged a disagreement.
assert((await chip("Share")).includes("Local") && !(await chip("Share")).includes("Basic"), "team-inherited depth is the real depth, not Basic");
assert((await text("#tab-check table.roles")).includes("via team Sales EU (owner team)"), "roles table shows team role");
assert((await text("#tab-check table.roles")).includes("Team Assigner") && (await text("#tab-check table.roles")).includes("team privileges only"), "roles table flags the isinherited = 0 team role");
// Roles with no privilege on the table are hidden by default (team-held roles that grant one stay).
{
  const roleNames = () => page.$$eval("#tab-check table.roles tbody tr td:first-child", (t) => t.map((x) => x.textContent));
  assert(await page.$eval("#hide-irrelevant-roles", (b) => b.checked), "roles: 'Hide roles with no privilege' on by default");
  const shown = await roleNames();
  assert(shown.length === 4 && !shown.includes("Report Viewer") && shown.includes("Sharer") && shown.includes("Team Assigner"), "roles: no-privilege role hidden, team-held roles kept: " + shown.join(","));
  assert((await text("#roles-count")) === "4 of 5 roles", "roles: count caption '4 of 5 roles'");
  await page.click('#why li[data-right="Write"] summary');
  await page.evaluate(() => (document.querySelector("#why").__marker = 1));
  await page.uncheck("#hide-irrelevant-roles");
  assert((await roleNames()).includes("Report Viewer") && (await roleNames()).length === 5, "roles: unticking shows the no-privilege role");
  assert((await text("#roles-count")) === "5 roles", "roles: count caption '5 roles' when nothing is hidden");
  assert(await page.evaluate(() => document.querySelector("#why").__marker === 1 && document.querySelector('#why li[data-right="Write"] details').open), "roles: toggling re-renders only the Roles table (Why kept)");
  await page.check("#hide-irrelevant-roles");
  assert((await roleNames()).length === 4, "roles: ticking hides it again");
  await page.click('#why li[data-right="Write"] summary');
}
// A4: verdict chips are buttons that open their Why row, scroll to it and highlight the right's column in Roles.
{
  const focusCols = () => page.$$eval("#tab-check table.roles tr", (trs) => [...new Set(trs.flatMap((tr) => [...tr.children].map((c, j) => (c.classList.contains("is-focus") ? j : -1)).filter((j) => j >= 0)))]);
  const focusCount = () => page.$$eval("#tab-check table.roles .is-focus", (c) => c.length);
  const rows = await page.$$eval("#tab-check table.roles tr", (r) => r.length);
  assert(await page.$$eval("#verdicts .verdict", (v) => v.every((x) => x.tagName === "BUTTON" && x.type === "button" && document.getElementById(x.getAttribute("aria-controls"))?.tagName === "DETAILS")), "chips: every applicable verdict is a button whose aria-controls is its Why <details>");
  assert(!(await page.$eval("#why-Read", (d) => d.open)), "chips: Read Why row closed before the click");
  await page.evaluate(() => (document.querySelector(".main").scrollTop = document.querySelector(".main").scrollHeight));
  await page.click('#verdicts .verdict[data-right="Read"]');
  assert(await page.$eval("#why-Read", (d) => d.open), "chips: clicking Read opens its Why row");
  assert(await page.$eval("#why-Read", (d) => { const r = d.getBoundingClientRect(), m = document.querySelector(".main").getBoundingClientRect(); return r.top >= m.top - 1 && r.top < m.bottom; }), "chips: the Read Why row is scrolled into view");
  assert((await page.getAttribute('#verdicts .verdict[data-right="Read"]', "aria-pressed")) === "true", "chips: Read chip pressed");
  assert(JSON.stringify(await focusCols()) === "[3]" && (await focusCount()) === rows && (await page.textContent("#tab-check table.roles th.is-focus")) === "Read", "chips: Read column (th + every td) highlighted in Roles");
  await page.click('#verdicts .verdict[data-right="Write"]');
  assert(JSON.stringify(await focusCols()) === "[4]" && (await page.textContent("#tab-check table.roles th.is-focus")) === "Write" && (await page.getAttribute('#verdicts .verdict[data-right="Read"]', "aria-pressed")) === "false", "chips: another chip moves the highlight to its column");
  await page.uncheck("#hide-irrelevant-roles");
  assert(JSON.stringify(await focusCols()) === "[4]", "chips: highlight survives the roles toggle re-render");
  await page.check("#hide-irrelevant-roles");
  await page.click('#verdicts .verdict[data-right="Write"]');
  assert((await focusCount()) === 0 && (await page.$$eval("#verdicts button.verdict", (b) => b.every((x) => x.getAttribute("aria-pressed") === "false"))), "chips: clicking the pressed chip again clears the highlight");
  assert(await page.$eval("#why-Write", (d) => d.open), "chips: clearing the highlight leaves the Why row open");
  await page.evaluate(() => document.querySelectorAll("#why details").forEach((d) => (d.open = false)));
  await page.click('#why li[data-right="Delete"] summary');
}
// A7: Roles / Ownership / Shares cards fold (open by default); controls in the Roles fold header do not toggle it.
{
  const isOpen = (id) => page.$eval(id, (d) => d.tagName === "DETAILS" && d.open);
  assert((await isOpen("#card-roles")) && (await isOpen("#card-ownership")) && (await isOpen("#card-shares")), "folds: Roles, Ownership, Shares are fold cards open by default");
  assert(await page.$eval("#card-roles summary", (s) => s.contains(document.querySelector("#hide-irrelevant-roles")) && s.contains(document.querySelector("#roles-count"))), "folds: roles toggle + count sit in the Roles fold header");
  await page.click("#hide-irrelevant-roles");
  assert((await isOpen("#card-roles")) && !(await page.$eval("#hide-irrelevant-roles", (b) => b.checked)) && (await text("#roles-count")) === "5 roles", "folds: clicking the roles checkbox in the header toggles it, not the fold");
  await page.click("#card-roles summary label.check", { position: { x: 40, y: 5 } });
  assert((await isOpen("#card-roles")) && (await page.$eval("#hide-irrelevant-roles", (b) => b.checked)) && (await text("#roles-count")) === "4 of 5 roles", "folds: clicking the roles label text in the header toggles it, not the fold");
  await page.focus("#hide-irrelevant-roles");
  await page.keyboard.press("Space");
  assert((await isOpen("#card-roles")) && !(await page.$eval("#hide-irrelevant-roles", (b) => b.checked)), "folds: Space on the header checkbox toggles it, not the fold");
  await page.keyboard.press("Space");
  assert(await page.$eval("#hide-irrelevant-roles", (b) => b.checked), "folds: Space again re-ticks it");
  await page.click("#card-ownership summary h3");
  assert(!(await isOpen("#card-ownership")), "folds: clicking the Ownership title collapses it");
  await page.click("#card-roles summary h3");
  assert(!(await isOpen("#card-roles")), "folds: clicking the Roles title collapses it");
}
// Privilege names now come from EntityDefinitions(...)/Privileges; privileges list is paged (10 per page).
assert((await page.evaluate(() => window.__calls)).includes("EntityDefinitions(LogicalName='account')?$select=Privileges"), "privilege names read from entity metadata");
assert((await page.evaluate(() => window.__calls)).some((c) => c.startsWith("privileges?") && c.includes("$skiptoken=")), "privilege list follows @odata.nextLink");
assert((await text("#tab-shares")).includes("Table-level check"), "shares tab explains table-level");
const cols = await text("#tab-columns table.columns");
assert(cols.includes("sss_margin") && cols.includes("Margin Readers (team Sales EU)"), "column security via team profile");
const colCells = await page.$$eval("#tab-columns table.columns tbody td .badge", (b) => b.map((x) => x.textContent));
assert(colCells.join(",") === "yes,no,no", "column read yes / update no / create no");
// A6: column search, "Only columns with a denied right", n of N, filtered empty with Clear.
{
  const colRowsN = () => page.$$eval("#tab-columns table.columns tbody tr", (r) => r.length);
  await page.click(".tab[data-tab='columns']");
  assert(!(await page.$eval("#columns-only", (b) => b.checked)) && (await text("#columns-count")) === "", "columns: toggle off by default, no n-of-N caption unfiltered");
  await page.fill("#columns-q", "sss_");
  assert((await colRowsN()) === 1, "columns: search matches the logical name");
  await page.fill("#columns-q", "zzz");
  assert(!(await page.$("#tab-columns table.columns")) && (await text("#tab-columns .empty-state")).includes("No columns match") && (await text("#columns-count")) === "0 of 1 secured column", "columns: no match shows a filtered empty state and '0 of 1 secured column'");
  assert((await page.$eval("#columns-q", (e) => document.activeElement === e)), "columns: focus stays in the search box while filtering");
  await page.click("#tab-columns .empty-actions button");
  assert((await colRowsN()) === 1 && (await page.inputValue("#columns-q")) === "", "columns: Clear empties the search and restores the rows");
  await page.check("#columns-only");
  assert((await colRowsN()) === 1, "columns: 'Only denied' keeps a column with a denied right (update/create no)");
  await page.uncheck("#columns-only");
  await page.fill("#columns-q", "margin");
  await page.click(".tab[data-tab='check']");
}

// record check: Bruno's account (same BU, Ana is Bruno's manager)
await page.fill("#record-q", "bruno");
await page.waitForSelector("#record-results li button");
assert((await text("#record-results")).includes("Bruno Corp") && (await text("#record-results")).includes("owner Bruno Costa"), "record suggestions");
await page.click("#record-results li button");
assert((await text("#record-sel")).includes("Bruno Corp"), "record selected");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Bruno Corp"));
assert((await chip("Read")).includes("granted") && (await chip("Write")).includes("denied") && (await chip("Share")).includes("granted") && (await chip("Append")).includes("granted"), "record verdicts from platform");
assert(await page.$eval('#why li[data-right="Write"] details', (d) => d.open) && !(await page.$eval('#why li[data-right="Read"] details', (d) => d.open)), "why: a new record check starts from defaults (denied Write open, granted Read closed)");
const why2 = await text("#why");
assert(why2.includes("Deep depth: record BU Sales is under Sales"), "Read reach explained");
assert(why2.includes("Basic depth covers only records the user"), "Write miss explained");
assert(why2.includes("Sharer via team Sales EU: Local depth: record is in the same BU"), "Share via team explained");
{
  const detail = (r) => page.$eval(`#why-${r} .detail`, (d) => d.textContent.replace(/\s+/g, " ").trim());
  assert((await detail("Read")) === "Deep depth · held directly" && (await text("#why-Read summary")).includes("Sales Person: Deep depth: record BU Sales is under Sales"), "why (record): one-path Read keeps the reason in the summary only");
  const appendTo = await detail("AppendTo");
  assert((await page.$$("#why-AppendTo .detail li")).length === 2 && appendTo.includes("Root Appender (direct) · Local · Local depth covers only Root; record is in Sales"), "why (record): several paths keep each reason, misses included: " + appendTo);
  assert(await page.$eval("#notes details.more-notes", (d) => d.open), "notes: 'more notes' fold opened on one check stays open on the next");
}
assert(!why2.includes("platform says otherwise"), "tool agrees with RetrievePrincipalAccess");
assert((await text("#relation")).includes("record in the user's BU"), "BU relation");
assert((await text("#hierarchy")).includes("direct manager"), "hierarchy hint for manager");
assert(await page.$eval("#card-hierarchy", (d) => d.tagName === "DETAILS" && !d.open), "folds: Hierarchy is a fold card, closed by default");
{
  const isOpen = (id) => page.$eval(id, (d) => d.open);
  assert(!(await isOpen("#card-ownership")) && !(await isOpen("#card-roles")) && (await isOpen("#card-shares")), "folds: cards collapsed on the previous check stay collapsed on the next");
  await page.click("#card-ownership summary h3");
  await page.click("#card-roles summary h3");
  assert((await isOpen("#card-ownership")) && (await isOpen("#card-roles")), "folds: reopened");
  await page.click(".tab[data-tab='columns']");
  assert((await page.inputValue("#columns-q")) === "margin" && (await page.$$("#tab-columns table.columns tbody tr")).length === 1, "columns: search kept for the next check");
  await page.fill("#columns-q", "");
  await page.click(".tab[data-tab='check']");
}
assert(await page.$eval("#card-shares", (d) => d.open && d.querySelector(".card-head .count .badge")?.textContent === "0"), "folds: Shares affecting this user shows its count");
assert(!why2.includes("platform says otherwise") && !(await text("#tab-check")).includes("Platform verdict differs"), "no disagreement on a clean case");
assert((await text("#tab-check .warnings")).includes("Team privileges only") && (await text("#tab-check .warnings")).includes("Direct role Root Appender belongs to BU Root"), "notes explain team-only role and cross-BU direct role");
// organization.maxdepthforhierarchicalsecuritymodel = 1: the chain above Bruno stops at Ana, Carla (Ana's manager) is never fetched.
{
  const c = await page.evaluate(() => window.__calls);
  const carla = await page.evaluate(() => window.__ids.CARLA);
  const from = c.lastIndexOf("RetrieveSharedPrincipalsAndAccess:" + (await page.evaluate(() => window.__ids.ACC_B)));
  assert(c.some((q) => q.includes("maxdepthforhierarchicalsecuritymodel")), "hierarchy depth read from organization");
  assert(from >= 0 && !c.slice(from).some((q) => q.includes("systemuserid eq " + carla)), "manager chain stops at the organization hierarchy depth");
}

// record check by GUID: Carla's account (Root BU, shared Write with team)
await page.fill("#record-q", "{" + (await page.evaluate(() => window.__ids.ACC_C)).toUpperCase() + "}");
await page.waitForFunction(() => !document.querySelector("#record-sel").hidden && document.querySelector("#record-sel").textContent.includes("Record by id"));
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Carla Holdings"));
assert((await chip("Read")).includes("denied") && (await chip("Write")).includes("granted"), "Carla: Read denied, Write granted");
const why3 = await text("#why");
assert(why3.includes("Deep depth stops at Sales and its children; record is in Root"), "Deep miss explained");
assert(why3.includes("shared with team Sales EU (user holds prvWriteAccount at Basic"), "Write via share explained, privilege held");
assert((await chip("Delete")).includes("denied") && why3.includes("but no role grants prvDeleteAccount"), "Delete share without the privilege has no effect");
assert((await chip("AppendTo")).includes("granted") && why3.includes("Root Appender: Local depth: record is in the same BU (Root)"), "direct role from BU Root: Local evaluated against the role's BU");
assert((await text("#relation")).includes("outside the user's BU subtree"), "BU relation outside");
assert((await text("#tab-check")).includes("Shares affecting this user") && (await text("#tab-check")).includes("team Sales EU"), "share affecting user listed");
await page.click(".tab[data-tab='shares']");
assert(await page.$$eval(".tab", (t) => t.every((x) => x.getAttribute("role") === "tab" && x.getAttribute("aria-selected") === String(x.dataset.tab === "shares"))), "tabs: aria-selected follows the active tab");
const sharesRows = await page.$$eval("#tab-shares table.shares tbody tr", (r) => r.map((x) => x.textContent));
assert(sharesRows.length === 2 && sharesRows[0].includes("Sales EU") && sharesRows[0].includes("via team") && sharesRows[1].includes("Bruno Costa") && !sharesRows[1].includes("via"), "shares table with affects badge");
// A5: affecting shares first and counted, principal search, "Only shares affecting <user>", filtered empty with Clear.
{
  const shareNames = () => page.$$eval("#tab-shares table.shares tbody tr td:first-child", (t) => t.map((x) => x.textContent));
  assert((await text("#tab-shares .card-head h3")) === "2 principals · 1 affects Ana Silva", "shares: title counts principals and those affecting the user");
  assert(!(await page.$eval("#shares-only", (b) => b.checked)) && (await text("label:has(#shares-only)")).includes("Only shares affecting Ana Silva"), "shares: toggle off by default, names the user");
  await page.check("#shares-only");
  assert(JSON.stringify(await shareNames()) === '["Sales EU"]' && (await text("#shares-count")) === "1 of 2 principals", "shares: toggle keeps only the affecting share, '1 of 2 principals'");
  await page.uncheck("#shares-only");
  await page.fill("#shares-q", "BRUNO");
  assert(JSON.stringify(await shareNames()) === '["Bruno Costa"]' && (await text("#shares-count")) === "1 of 2 principals", "shares: search by principal name (case-insensitive)");
  await page.check("#shares-only");
  assert(!(await page.$("#tab-shares table.shares")) && (await text("#tab-shares .empty-state")).includes("No shares match"), "shares: search + toggle hiding everything shows a filtered empty state");
  await page.click("#tab-shares .empty-actions button");
  assert((await shareNames()).length === 2 && (await page.inputValue("#shares-q")) === "" && !(await page.$eval("#shares-only", (b) => b.checked)), "shares: Clear resets search and toggle");
}

// exports
await page.click("#btn-export-shares");
await page.click("#btn-export-json");
await page.waitForFunction(() => window.__saved.length === 2);
const saved = await page.evaluate(() => window.__saved);
assert(saved[0].name.endsWith("_shares.csv") && saved[0].content.includes("team,Sales EU") && saved[0].content.includes("via team"), "shares CSV");
const json = JSON.parse(saved[1].content);
assert(saved[1].name.endsWith(".access.json") && json.verdicts.length === 8 && json.verdicts.find((v) => v.right === "Write").shares.length === 1 && json.environment.includes("Contoso Dev"), "JSON export");
await page.click(".tab[data-tab='columns']");
await page.click("#btn-export-columns");
await page.waitForFunction(() => window.__saved.length === 3);
assert((await page.evaluate(() => window.__saved[2].content)).includes("sss_margin,Margin,true,false,false"), "columns CSV");

// record check: Ana's own account. "Team privileges only" Assign Basic must not reach it; 60 shares resolve in chunks.
await page.click(".tab[data-tab='check']");
await page.fill("#record-q", "ventures");
await page.waitForSelector("#record-results li button");
await page.click("#record-results li button");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Ana Ventures"));
const why4 = await text("#why");
assert((await chip("Write")).includes("granted") && why4.includes("Basic depth: user owns the record"), "own record: Write Basic reaches");
assert((await chip("Assign")).includes("denied") && why4.includes('Basic depth from a "Team privileges only" role covers only records owned by team Sales EU, not the user\'s own records'), "team-only Basic does not reach the user's own record");
assert(!why4.includes("platform says otherwise"), "tool agrees with RetrievePrincipalAccess on own record");
await page.click(".tab[data-tab='shares']");
const dummyRows = await page.$$eval("#tab-shares table.shares tbody tr", (r) => r.map((x) => x.textContent));
assert(dummyRows.length === 60 && dummyRows.every((r) => r.includes("Dummy ")) && dummyRows.some((r) => r.includes("Dummy 60")), "60 share principals resolved by name");
{
  assert((await text("#tab-shares .card-head h3")) === "60 principals · 0 affect Ana Silva", "shares: '60 principals · 0 affect Ana Silva'");
  await page.fill("#shares-q", "dummy 0");
  assert((await page.$$("#tab-shares table.shares tbody tr")).length === 9 && (await text("#shares-count")) === "9 of 60 principals", "shares: search 'dummy 0' → Dummy 01..09, '9 of 60 principals'");
  await page.fill("#shares-q", "");
  await page.check("#shares-only");
  assert((await text("#tab-shares .empty-state")).includes("No share on this record affects Ana Silva.") && (await text("#shares-count")) === "0 of 60 principals", "shares: toggle on with nothing affecting explains why it is empty");
  assert((await page.evaluate(() => JSON.parse(localStorage.getItem("sss-view:access-checker") ?? "{}").sharesOnlyAffecting)) === true, "shares: toggle saved in view state");
}
{
  const c = await page.evaluate(() => window.__calls);
  const byId = c.filter((q) => q.startsWith("systemusers?") && (q.match(/systemuserid eq /g) ?? []).length > 1);
  assert(byId.length >= 2 && byId.every((q) => (q.match(/systemuserid eq /g) ?? []).length <= 40), "long or-filter chunked (<= 40 ids per request)");
  assert(c.some((q) => q.startsWith("systemusers?") && q.includes("$skiptoken=")), "chunk query follows @odata.nextLink");
}
await page.click(".tab[data-tab='check']");

// org-owned table: Assign/Share n/a
await page.click(".tab[data-tab='check']");
await page.selectOption("#table", "sss_setting");
assert(await page.$eval("#record-sel", (e) => e.hidden), "record cleared on table change");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("table Setting"));
assert((await chip("Assign")).includes("n/a") && (await chip("Share")).includes("n/a") && (await chip("Read")).includes("denied"), "org-owned: Assign/Share n/a");

// activity table: privileges are prv*Activity, not prv*Task
await page.selectOption("#table", "task");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("table Task"));
assert((await chip("Read")).includes("granted") && (await chip("Read")).includes("Global") && (await text("#why")).includes("Global via Sales Person"), "task Read Global via prvReadActivity");
assert((await chip("Write")).includes("denied") && (await text("#why")).includes("agrees") && !(await text("#why")).includes("platform says otherwise"), "task: tool agrees with platform");

// theme + cache reuse
await page.evaluate(() => window.__emit({ event: "settings:updated", data: { theme: "dark" } }));
assert((await page.getAttribute("html", "data-theme")) === "dark", "dark theme applied from settings:updated");
const calls = await page.evaluate(() => window.__calls);
// Role privileges are re-read on every check (a role edited between checks must not show a stale
// depth), but only once per role within a check.
{
  const salesReads = calls.filter((c) => c === "RetrieveRolePrivilegesRole(RoleId=" + "c0000000-0000-0000-0000-000000000001" + ")").length;
  const checks = calls.filter((c) => c.startsWith("systemusers?$select=systemuserid,fullname") && c.endsWith("eq a0000000-0000-0000-0000-000000000001")).length;
  assert(salesReads > 1 && salesReads <= checks, "role privileges re-read per check, once per role");
}
assert(calls.filter((c) => c === "RetrieveUserPrivilegeByPrivilegeName:prvShareAccount").length === 1, "user privileges cached per privilege");
assert(!calls.some((c) => c.startsWith("RetrieveUserPrivileges:")), "RetrieveUserPrivileges is never called");
assert(calls.filter((c) => c.startsWith("RetrieveUserPrivilegeByPrivilegeName:")).every((c) => /:prv\w+(Account|Activity|sss_Setting)$/.test(c)), "only the checked tables' privileges are fetched");
assert(calls.includes("RetrieveUserPrivilegeByPrivilegeName:prvReadActivity") && !calls.some((c) => /prv\w+Task$/.test(c)), "activity privilege names from metadata, not the convention");
assert(calls.filter((c) => c.startsWith("privileges?") && !c.includes("$skiptoken")).length === 1, "privilege list fetched once");
assert(calls.filter((c) => c === "EntityDefinitions(LogicalName='account')?$select=Privileges").length === 1, "table privileges cached per table");

// System Administrator detected by roletemplateid under a localized role name
await page.fill("#user-q", "diego");
await page.waitForSelector("#user-results li button");
await page.click("#user-results li button");
await page.waitForFunction(() => document.querySelector("#user-sel")?.textContent.includes("Diego Admin"));
await page.selectOption("#table", "account");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Diego Admin"));
assert((await text("#tab-check .warnings")).includes("User holds System Administrator"), "sysadmin by role template, not name");
await page.waitForFunction(() => document.querySelector("#tab-columns table.columns"));
assert((await text("#tab-columns table.columns")).includes("System Administrator (bypasses column security)"), "column security bypass for template-detected sysadmin");
await page.click(".tab[data-tab='columns']");
await page.check("#columns-only");
assert((await text("#tab-columns .empty-state")).includes("Diego Admin has every right on every secured column.") && (await text("#columns-count")) === "0 of 1 secured column", "columns: 'Only denied' for a sysadmin explains nothing is denied");
await page.uncheck("#columns-only");
await page.click(".tab[data-tab='check']");

// ---------- regression cases ----------
const until = (fn, arg, timeout = 4000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);
const settle = () => page.waitForFunction(() => document.querySelector("#status").hidden);
const pickUser = async (q, name) => {
  await page.fill("#user-q", q);
  await page.waitForFunction((n) => { const l = document.querySelector("#user-results"); return !l.hidden && l.textContent.includes(n); }, name);
  await page.click(`#user-results li button:has-text("${name}")`);
  await page.waitForFunction((n) => document.querySelector("#user-sel")?.textContent.includes(n), name);
};
const pickRecord = async (q, name) => {
  await page.fill("#record-q", q);
  await page.waitForFunction((n) => { const l = document.querySelector("#record-results"); return !l.hidden && l.textContent.includes(n); }, name);
  await page.click(`#record-results li button:has-text("${name}")`);
  await page.waitForFunction((n) => document.querySelector("#record-sel")?.textContent.includes(n), name);
};
const h2 = () => page.textContent("#tab-check h2");
await page.click(".tab[data-tab='check']");

// Search text with & + reaches Dataverse intact (queryData appends the query verbatim).
await page.fill("#user-q", "a+b@x.com");
assert(await until(() => { const l = document.querySelector("#user-results"); return !l.hidden && l.textContent.includes("Plus User"); }), "user search: 'a+b@x.com' finds Plus User");
assert((await page.evaluate(() => window.__filters)).some((f) => f.includes("contains(internalemailaddress,'a+b@x.com')")), "user search: '+' reaches the filter as '+', not a space");
await page.fill("#record-q", "AT&T");
await until(() => { const l = document.querySelector("#record-results"); return !l.hidden && l.querySelector("li"); });
{
  const r = await text("#record-results");
  assert(r.includes("AT&T Wireless") && !r.includes("Bruno Corp"), "record search: '&' does not split the query string");
  assert((await page.evaluate(() => window.__filters)).includes("contains(name,'AT&T')"), "record search: filter decoded as contains(name,'AT&T')");
}
await page.fill("#record-q", "");

// Record search results belong to the table they were searched in.
await page.evaluate(() => (window.__delays = { "accounts?$select=accountid,name,_ownerid_value,_owningbusinessunit_value&$filter=contains": 600 }));
await page.fill("#record-q", "carla");
await page.waitForTimeout(400);
await page.selectOption("#table", "contact");
await page.waitForTimeout(700);
assert(await page.$eval("#record-results", (e) => e.hidden || !e.textContent.includes("Carla Holdings")), "account search results dropped after switching to contact");
await page.evaluate(() => (window.__delays = {}));

// A check uses the inputs it started with; a user picked mid-check is kept.
await pickUser("ana silva", "Ana Silva");
await page.selectOption("#table", "account");
await pickRecord("bruno", "Bruno Corp");
await page.evaluate(() => (window.__delays = { "$filter=systemuserid eq a0000000-0000-0000-0000-000000000001": 1500 }));
await page.click("#btn-check");
await page.click("#record-sel button");
await pickUser("diego", "Diego Admin");
await page.evaluate(() => (window.__delays = {}));
await page.waitForTimeout(1600);
await settle();
assert((await h2()).includes("Ana Silva on Bruno Corp"), "check result is for the record it started with, not the one cleared mid-check");
assert((await text("#user-sel")).includes("Diego Admin"), "user picked mid-check is not overwritten");
assert(await page.$eval("#record-sel", (e) => e.hidden), "record cleared mid-check stays cleared");

// Column security: previous check's columns are not shown while loading or after a failure.
assert(!!(await page.$("#tab-columns table.columns")), "columns present from the previous check");
await page.evaluate(() => { window.__delays = { "attrs:account": 800 }; window.__failAttrs = true; });
await page.click("#btn-check");
await until(() => document.querySelector("#tab-check h2")?.textContent.includes("Diego Admin"));
assert(!(await page.$("#tab-columns table.columns")) && (await text("#tab-columns")).includes("Loading"), "columns tab shows loading, not the previous check");
await settle();
assert(!(await page.$("#tab-columns table.columns")) && (await text("#tab-columns")).toLowerCase().includes("failed"), "columns tab shows the failure, not the previous check");
assert(await page.$eval("#btn-export-columns", (b) => b.disabled).catch(() => true), "columns CSV export unavailable when column security failed");
await page.evaluate(() => { window.__delays = {}; window.__failAttrs = false; });

// Privileges changed between two checks: platform and role depths are re-read.
await pickUser("ana silva", "Ana Silva");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Ana Silva on table Account"));
await settle();
assert((await chip("Delete")).includes("denied"), "before role change: Delete denied");
await page.click('#why li[data-right="Read"] summary');
await page.evaluate(() => window.__mock.rolePrivs[window.__mock.R_SALES].push(["prvDeleteAccount", "Local"]));
await page.click("#btn-check");
await page.waitForTimeout(100);
await settle();
assert(await page.$eval('#why li[data-right="Read"] details', (d) => d.open), "why: a row the user opened stays open when the same check re-runs");
assert((await chip("Delete")).includes("granted") && (await chip("Delete")).includes("Local"), "after role change: platform Delete Local (not cached)");
assert(!(await text("#why")).includes("platform says otherwise"), "after role change: role depth re-read, tool agrees");
await page.evaluate(() => window.__mock.rolePrivs[window.__mock.R_SALES].pop());

// A8: platform verdict unavailable → starred tool verdicts, each explained by a tooltip.
await pickRecord("bruno", "Bruno Corp");
await page.evaluate(() => (window.__failPrincipalAccess = true));
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Bruno Corp"));
await settle();
{
  const badgeOf = (r) => page.$eval(`#verdicts .verdict[data-right="${r}"] .badge`, (b) => ({ t: b.textContent, title: b.title }));
  const read = await badgeOf("Read");
  const write = await badgeOf("Write");
  assert(read.t === "granted*" && read.title === "granted*: platform verdict unavailable; this is the tool's computed result", "starred: granted* explained, got " + JSON.stringify(read));
  assert(write.t === "denied*" && write.title.startsWith("denied*: platform verdict unavailable"), "starred: denied* explained");
  assert((await text("#notes")).includes("RetrievePrincipalAccess failed"), "starred: notes say why the platform verdict is missing");
}
await page.evaluate(() => (window.__failPrincipalAccess = false));

// Local/Deep include Basic: the user's own record in another BU than the role's base BU.
await pickUser("eva", "Eva Nunes");
await page.selectOption("#table", "contact");
await pickRecord("eva", "Eva Contact");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Eva Contact"));
await settle();
{
  const why = await text("#why");
  assert(!why.includes("platform says otherwise"), "own record: Local (team, other BU) / Deep / direct Local from other BU agree with platform");
  assert(why.includes("Contact Reader via team Sales Readers: Local depth includes Basic: user owns the record"), "own record reached by Local depth via team in another BU");
  assert(why.includes("Deep depth includes Basic: user owns the record") && why.includes("Contact Appender: Local depth includes Basic"), "own record reached by Deep and by a direct role from another BU");
}

// Roles: a user whose roles all miss the table gets a one-line caption, not an empty table; the toggle survives a reload.
await pickUser("eva", "Eva Nunes");
await page.selectOption("#table", "account");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Eva Nunes on table Account"));
await settle();
assert(!(await page.$("#tab-check table.roles")) && (await text("#roles-body")).includes("None of the user's 2 roles grants a privilege on Account."), "roles: all-hidden caption instead of an empty table");
assert((await text("#roles-count")) === "0 of 2 roles", "roles: count caption '0 of 2 roles'");
await page.click("#btn-show-all-roles");
assert(!(await page.$eval("#hide-irrelevant-roles", (b) => b.checked)) && (await page.$$("#tab-check table.roles tbody tr")).length === 2, "roles: 'Show all roles' unticks the toggle and lists both roles");
await page.waitForFunction(() => document.querySelector("#columns-only"));
await page.click(".tab[data-tab='columns']");
await page.check("#columns-only");
await page.click(".tab[data-tab='check']");
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#table option").length > 1);
await pickUser("eva", "Eva Nunes");
await page.selectOption("#table", "account");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Eva Nunes on table Account"));
await settle();
assert(!(await page.$eval("#hide-irrelevant-roles", (b) => b.checked)) && (await page.$$("#tab-check table.roles tbody tr")).length === 2, "roles: unticked toggle survives a reload");
await page.waitForFunction(() => document.querySelector("#columns-only"));
assert(await page.$eval("#columns-only", (b) => b.checked), "columns: 'Only columns with a denied right' survives a reload");
await page.click(".tab[data-tab='columns']");
await page.uncheck("#columns-only");
await page.click(".tab[data-tab='check']");
await page.check("#hide-irrelevant-roles");
assert((await text("#roles-body")).includes("None of the user's 2 roles"), "roles: re-ticking hides them again");

// A8: a long team list shows 5 names and a "+2 more" button that reveals the rest in place.
await pickUser("plus user", "Plus User");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Plus User on table Account"));
await settle();
{
  assert((await text("#teams")) === "Team 1, Team 2, Team 3, Team 4, Team 5 +2 more" && (await page.getAttribute("#btn-more-teams", "title")) === "Team 6, Team 7", "teams: first 5 then '+2 more' (rest in its tooltip)");
  await page.click("#btn-more-teams");
  assert((await text("#teams")) === "Team 1, Team 2, Team 3, Team 4, Team 5, Team 6, Team 7" && !(await page.$("#btn-more-teams")), "teams: '+2 more' reveals the rest inline");
  assert(await page.evaluate(() => document.querySelector("#teams").contains(document.activeElement)), "teams: focus stays in the list after revealing");
  assert((await page.$$("#notes > ul.notes > li")).length === 1 && !(await page.$("#notes details")), "notes: a single note has no 'more notes' fold");
}

// ---- debug mode: the switch survives a reload, so start-up calls are in the log ----
// Shares toggle saved on Ana Ventures (left ticked) survived the reload above.
await pickUser("ana silva", "Ana Silva");
await pickRecord("ventures", "Ana Ventures");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Ana Ventures"));
await settle();
await page.click(".tab[data-tab='shares']");
assert(await page.$eval("#shares-only", (b) => b.checked), "shares: 'Only shares affecting' survives a reload");
await page.uncheck("#shares-only");
assert((await page.$$("#tab-shares table.shares tbody tr")).length === 60 && (await page.evaluate(() => JSON.parse(localStorage.getItem("sss-view:access-checker") ?? "{}").sharesOnlyAffecting)) === undefined, "shares: unticking shows all 60 and drops the saved value");
await page.click(".tab[data-tab='check']");

await checkDebugLog(page, assert, {
  tool: "access-checker",
  act: async () => {
    await page.reload();
    await page.waitForSelector("#debug-toggle");
    assert(await page.$eval("#debug-toggle", (e) => e.checked), "access-checker: debug mode remembered across a reload");
    await page.waitForTimeout(500);
  },
  readSaved: async (click) => {
    await click();
    await page.waitForFunction(() => window.__saved.length > 0);
    const f = await page.evaluate(() => window.__saved.at(-1));
    assert(/^access-checker-debug-.*\.txt$/.test(f.name), "access-checker: debug log file name " + f.name);
    return f.content;
  },
  expect: [[/\[call\] #\d+ toolboxAPI\.connections\.getActiveConnection/, "records start-up host calls"]],
});

await finish();

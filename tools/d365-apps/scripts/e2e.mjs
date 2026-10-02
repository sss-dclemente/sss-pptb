// E2E for SSS D365 Apps Matrix on the dist build with a mocked host (toolboxAPI, dataverseAPI, powerplatformAPI).
// Environments: Dev (Sandbox, the connection's), Prod (Production), Teams (no Dataverse: hidden).
// Dev: sales 1.0 (catalog 1.2: update, Installed list paged), fs InstallFailed, custom 1.0 → 1.5 (customHandleUpgrade).
// Prod: sales 1.2 (current), portal Installing, extra available only (install returns no operation id → state fallback).
// Empty (nothing installed, extra available: still "empty"), Broken (Installed list fails: error column, never auto-hidden).
// Run: npm run build && node scripts/e2e.mjs
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";
import { checkDebugLog } from "../../_shared/e2e-debug.mjs";
import { MOCK } from "./mock-host.mjs";

const TOOL = resolve(new URL("..", import.meta.url).pathname);

const { page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto("file://" + TOOL + "/dist/index.html?pollMs=30");
const M = (fn, a) => page.evaluate(fn, a);
const cell = (env, app) => `td[data-cell="${env}|${app}"]`;

// ---- default column: the connection's environment ----
await page.waitForSelector("#grid");
let cols = await page.$$eval("#grid th.col", (els) => els.map((e) => e.dataset.env));
assert(cols.length === 1 && cols[0] === "env-dev", "default column: the connection's environment (RetrieveCurrentOrganization): " + cols.join(","));
const gets0 = await M(() => window.__mock.gets);
assert(gets0.some((g) => g.includes("$skiptoken=2")), "Installed list followed @odata.nextLink (absolute → relative to the category)");
assert((await page.$$eval("#grid tbody tr", (els) => els.length)) === 4, "paged Dev list: 4 installed apps shown");

// ---- environment picker: Teams (no Dataverse) is not offered; pick Dev + Prod ----
const txt = async (sel) => (await page.textContent(sel)) ?? "";
await page.click("#btn-envs");
await page.waitForSelector(".envpick input[data-env]");
const offered = await page.$$eval(".envpick input[data-env]", (els) => els.map((e) => e.dataset.env));
assert(offered.length === 4 && !offered.includes("env-teams"), "picker hides environments without Dataverse: " + offered.join(","));
// ticked count (live), type filter (present types only) combined with the text filter; Tick shown = visible only
const pickShown = () => page.$$eval(".envpick label:not([hidden]) input[data-env]", (els) => els.map((e) => e.dataset.env).join(","));
assert((await txt("#envpick-count")) === "1 of 4 ticked", "picker: ticked count: " + (await txt("#envpick-count")));
assert((await page.$$eval("#envpick-type option", (els) => els.map((o) => o.value).join(","))) === ",Production,Sandbox,Developer", "type filter offers the present types only, usual order");
await page.selectOption("#envpick-type", "Sandbox");
assert((await pickShown()) === "env-broken,env-dev" && (await txt("#envpick-count")) === "1 of 4 ticked · 2 of 4 shown", "type filter: Sandbox only: " + (await pickShown()) + " / " + (await txt("#envpick-count")));
await page.fill(".envpick input[type=search]", "broken");
assert((await pickShown()) === "env-broken", "type and text filters combine");
await page.fill(".envpick input[type=search]", "");
await page.click(".envpick button:has-text('Tick shown')");
assert((await txt("#envpick-count")).startsWith("2 of 4 ticked") && !(await page.isChecked('.envpick input[data-env="env-prod"]')) && !(await page.isChecked('.envpick input[data-env="env-empty"]')), "Tick shown ticks the shown (Sandbox) environments only: " + (await txt("#envpick-count")));
await page.click(".envpick button:has-text('Untick all')");
assert((await txt("#envpick-count")).startsWith("0 of 4 ticked"), "Untick all: count follows");
await page.selectOption("#envpick-type", "");
assert((await pickShown()).split(",").length === 4 && (await txt("#envpick-count")) === "0 of 4 ticked", "All types: every environment shown again");
await page.check('.envpick input[data-env="env-dev"]');
await page.check('.envpick input[data-env="env-prod"]');
assert((await txt("#envpick-count")) === "2 of 4 ticked", "ticking a box updates the count live");
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelectorAll("#grid th.col").length === 2);
assert(await M(() => JSON.parse(localStorage.getItem("sss-d365-apps:envs")).join(",") === "env-dev,env-prod"), "selection remembered");

// ---- cells ----
assert(/1\.0\.0\.0\s*→\s*1\.2\.0\.0/.test(await txt(cell("env-dev", "msdyn_sales"))), "Dev sales: update derived from the NotInstalled catalog (1.0 → 1.2)");
assert((await page.$eval(cell("env-prod", "msdyn_sales"), (e) => e.className)).includes("k-current"), "Prod sales 1.2: current, no action");
assert((await txt(cell("env-dev", "msdyn_fs"))).includes("Dependency msdyn_anchor missing"), "Dev fs: failed with the last error");
assert((await txt(cell("env-prod", "msdyn_portal"))).includes("Installing"), "Prod portal: in progress, no checkbox");
assert(!(await page.$(`${cell("env-prod", "msdyn_portal")} input`)), "busy cell is not selectable");
assert((await txt('tr[data-app="msdyn_custom"]')).includes("custom upgrade"), "custom upgrade package flagged");
assert((await page.getAttribute(`${cell("env-dev", "msdyn_sales")} input`, "aria-label")) === "Update SALES in SSS Dev" && (await page.getAttribute(`${cell("env-dev", "msdyn_fs")} input`, "aria-label")) === "Retry FS in SSS Dev", "cell checkbox label: action, app name and environment name (not the GUID)");
assert((await txt("#counts")).includes("5 apps × 2 environments") && (await txt("#summary")).includes("2 updates") && (await txt("#summary")).includes("1 failed"), "summary counts: " + (await txt("#summary")));

// ---- filter: shown rows, count caption, select-all respects it, hidden count, persisted, sticky App column ----
await page.fill("#filter-text", "fs");
assert((await page.$$eval("#grid tbody tr", (els) => els.map((e) => e.dataset.app))).join(",") === "msdyn_fs", "name filter shows only FS");
assert((await txt("#counts")).includes("1 of 5 apps × 2 environments"), "count caption while filtered: " + (await txt("#counts")));
await page.click("#btn-select-updates");
assert((await page.$$eval("td.cell.is-selected", (els) => els.length)) === 0 && (await txt("#sel-count")) === "", "Select all updates leaves out rows the name filter hides (regression: ticked hidden SALES)");
await page.fill("#filter-text", "");
await page.click("#btn-select-updates");
await page.fill("#filter-text", "fs");
assert((await txt("#sel-count")) === "1 selected (1 hidden by filter)", "selection hidden by the filter is counted: " + (await txt("#sel-count")));
const bU = await page.$eval("#btn-select-updates", (b) => b.getBoundingClientRect().right);
const bF = await page.$eval("#btn-select-failed", (b) => b.getBoundingClientRect().left);
assert(bF - bU < 20, "toolbar: Select all updates / failed sit together: gap " + (bF - bU));
await M(() => {
  const u = document.querySelector("#unused-all");
  u.checked = true;
  u.dispatchEvent(new Event("change"));
});
await page.reload();
await page.waitForSelector("#grid");
assert((await page.inputValue("#filter-text")) === "fs" && (await txt("#counts")).includes("1 of 5 apps"), "name filter persisted across reload");
assert(await page.$eval("#unused-all", (e) => e.checked), "Unused Show all persisted across reload");
await M(() => {
  const u = document.querySelector("#unused-all");
  u.checked = false;
  u.dispatchEvent(new Event("change"));
});
const sticky = await page.$$eval(["#grid thead th:first-child", "#grid td.name"].join(","), (els) => els.map((e) => getComputedStyle(e).position + ":" + getComputedStyle(e).left));
assert(sticky.length === 2 && sticky.every((s) => s === "sticky:0px"), "App column sticky on the left: " + sticky.join(","));
await page.fill("#filter-text", "nothing-like-this");
await page.waitForSelector("#matrix .empty-state");
assert((await txt("#matrix .empty-state")).includes("Nothing matches the filter."), "filtered empty state");
await page.click("#matrix .empty-state button");
await page.waitForSelector("#grid");
assert((await page.inputValue("#filter-text")) === "" && (await page.$$eval("#grid tbody tr", (els) => els.length)) === 5 && (await txt("#counts")).includes("5 apps × 2"), "Clear filters resets the filter and shows every app");
assert(await M(() => !JSON.parse(localStorage.getItem("sss-view:d365-apps") || "{}")["ctl:filter-text"]), "cleared filter saved as default");

// ---- state badges filter rows (any pressed one), persisted, Clear filters, old checkbox migrated ----
const appsShown = () => page.$$eval("#grid tbody tr", (els) => els.map((e) => e.dataset.app).join(","));
const pressed = (sel) => page.$eval(sel, (b) => b.getAttribute("aria-pressed"));
assert(!(await page.$("#only-updates")), "the Only updates / failed checkbox is replaced by the badges");
assert((await txt("#f-update")) === "2 updates" && (await txt("#f-busy")) === "1 in progress" && (await pressed("#f-update")) === "false" && (await pressed("#f-failed")) === "false", "update / failed / in progress badges are toggles, not pressed");
assert(!(await page.$("#btn-clear-filters")), "no Clear filters while nothing filters");
await page.click("#f-busy");
assert((await appsShown()) === "msdyn_portal" && (await pressed("#f-busy")) === "true" && (await txt("#counts")).includes("1 of 5 apps"), "in progress badge: only the app being installed: " + (await appsShown()));
await page.click("#f-failed");
assert((await appsShown()) === "msdyn_fs,msdyn_portal" && (await txt("#counts")).includes("2 of 5 apps"), "pressed badges combine (any of them): " + (await appsShown()));
await page.click("#btn-select-updates");
assert((await txt("#sel-count")) === "", "Select all updates follows the badge filter (SALES row hidden): " + (await txt("#sel-count")));
await page.click("#btn-select-failed");
await page.click("#f-failed");
assert((await appsShown()) === "msdyn_portal" && (await txt("#sel-count")) === "1 selected (1 hidden by filter)", "the hidden count follows the badge filter: " + (await txt("#sel-count")));
await page.click("#btn-clear-sel");
await page.click("#f-failed");
await page.reload();
await page.waitForSelector("#grid");
assert((await appsShown()) === "msdyn_fs,msdyn_portal" && (await pressed("#f-failed")) === "true" && (await pressed("#f-busy")) === "true", "pressed badges persisted across reload");
await page.click("#btn-clear-filters");
assert((await appsShown()).split(",").length === 5 && (await pressed("#f-failed")) === "false" && (await pressed("#f-busy")) === "false" && !(await page.$("#btn-clear-filters")), "Clear filters releases the badges");
await M(() => {
  const v = JSON.parse(localStorage.getItem("sss-view:d365-apps") || "{}");
  delete v.states;
  v["ctl:only-updates"] = true;
  localStorage.setItem("sss-view:d365-apps", JSON.stringify(v));
});
await page.reload();
await page.waitForSelector("#grid");
assert((await appsShown()) === "msdyn_custom,msdyn_fs,msdyn_sales" && (await pressed("#f-update")) === "true" && (await pressed("#f-failed")) === "true" && (await pressed("#f-busy")) === "false", "a saved Only updates / failed tick becomes the update + failed badges: " + (await appsShown()));
assert(await M(() => {
  const v = JSON.parse(localStorage.getItem("sss-view:d365-apps"));
  return !("ctl:only-updates" in v) && v.states.join(",") === "update,failed";
}), "migrated once: the old key is gone");
await page.click("#btn-clear-filters");

// ---- selection ----
await page.click("#btn-select-updates");
let sel = await page.$$eval("td.cell.is-selected", (els) => els.map((e) => e.dataset.cell));
assert(sel.length === 1 && sel[0] === "env-dev|msdyn_sales", "Select all updates skips the custom-upgrade package: " + sel.join(","));
assert(!(await page.$eval("#btn-select-failed", (b) => b.disabled)), "Select all failed enabled: there is a failed install");
await page.click("#btn-select-failed");
assert(await page.$eval(`${cell("env-dev", "msdyn_fs")} input`, (e) => e.checked), "Select all failed ticks the failed install for a retry");
await page.check("#show-available");
await page.waitForSelector(cell("env-prod", "msdyn_extra"));
await page.check(`${cell("env-prod", "msdyn_extra")} input`);
assert((await txt("#sel-count")) === "3 selected", "3 selected after ticking retry + install");

// ---- pac script ----
await page.click("#btn-pac");
await page.waitForFunction(() => window.__mock.saved.length > 0);
const ps = await M(() => window.__mock.saved.at(-1));
assert(/^d365-apps-install-.*\.ps1$/.test(ps.name) && ps.content.includes("pac application install --environment 'env-dev' --application-name 'msdyn_fs'") && ps.content.includes("# SSS Prod (Production)"), "pac script: one line per install, grouped per environment");

// ---- preview + run ----
await page.click("#btn-preview");
await page.waitForSelector("#plan");
const plan = await txt("#plan");
assert(plan.includes("1 Production environment") && plan.includes("Retry FS") && plan.includes("Install EXTRA"), "preview: Production warning and per-environment list");
const planFolds = () => page.$$eval("#plan details.plan-env", (els) => els.map((d) => `${d.querySelector("summary").textContent}:${d.open}`).join("|"));
assert((await planFolds()) === "SSS Dev · 2 installsSandbox:true|SSS Prod · 1 installProduction:true" && !(await page.$("#plan .fold-all")), "preview: one open fold per environment (≤ 5), summary 'name · N installs': " + (await planFolds()));
assert((await page.$eval("#dlg-ok", (b) => b.className)).includes("btn-danger") && (await txt("#dlg-ok")) === "Run 3 installs", "confirm is the danger button when Production is in the plan");
await page.click("#dlg-ok");
await page.waitForSelector("#run-table");
await page.waitForFunction(() => /Last run/.test(document.querySelector("#run-title")?.textContent ?? ""), null, { timeout: 20000 });
const rows = await page.$$eval("#run-table tbody tr", (els) => els.map((e) => [e.children[1].textContent, e.dataset.status, e.children[4].textContent]));
const st = Object.fromEntries(rows.map(([n, s, m]) => [n, { s, m }]));
assert(st.SALES?.s === "succeeded" && st.EXTRA?.s === "succeeded" && st.FS?.s === "failed" && st.FS.m.includes("missing dependency"), "run: update + install succeeded, retry failed with the operation error: " + JSON.stringify(rows));
const posts = await M(() => window.__mock.posts.map((p) => p.path));
assert(posts.length === 3 && posts.every((p) => p.endsWith("/install?api-version=2024-10-01")), "3 install POSTs");
const devOrder = posts.filter((p) => p.includes("env-dev")).map((p) => p.split("/")[3]);
assert(devOrder.join(",") === "msdyn_fs,msdyn_sales", "Dev installs in matrix row order: " + devOrder.join(","));
const conc = await M(() => ({ maxActive: window.__mock.maxActive, maxEnvs: window.__mock.maxEnvs }));
assert(conc.maxActive === 1 && conc.maxEnvs === 2, "one install at a time per environment, both environments in parallel: " + JSON.stringify(conc));
const g = await M(() => window.__mock.gets);
assert(g.some((x) => x.includes("/operations/op-env-dev-msdyn_sales")), "progress polled by operation id");
assert(g.filter((x) => x.startsWith("environments/env-prod/applicationPackages?appInstallState=Installed")).length >= 3, "install without an operation id: polled through the package state");
await page.waitForFunction(() => /1\.2\.0\.0/.test(document.querySelector('td[data-cell="env-dev|msdyn_sales"]')?.textContent ?? "") && !/→/.test(document.querySelector('td[data-cell="env-dev|msdyn_sales"]')?.textContent ?? ""));
assert(true, "environments read again after the run: Dev sales now 1.2 current");
assert(await M(() => window.__mock.notes.some((n) => n.title === "Installs finished with failures")), "notification summarises the run");

// ---- run section: stays open with a failure, Only problems; cell notes one line, run note dropped after the reload ----
assert(await page.$eval("#run-fold", (d) => d.open), "a run with a failure stays open");
const fsNote = await page.$eval(`${cell("env-dev", "msdyn_fs")} .note`, (e) => ({ ws: getComputedStyle(e).whiteSpace, to: getComputedStyle(e).textOverflow, title: e.title, h: e.getBoundingClientRect().height }));
assert(fsNote.ws === "nowrap" && fsNote.to === "ellipsis" && fsNote.title === "Dependency msdyn_anchor missing" && fsNote.h < 20, "cell error: one line with ellipsis, the full text in its title: " + JSON.stringify(fsNote));
assert((await page.$$eval(`${cell("env-dev", "msdyn_fs")} .note`, (els) => els.length)) === 1 && !(await page.$("#grid [data-run]")), "the run's note is dropped once the environments were read again");
await page.check("#run-problems");
assert((await page.$$eval("#run-table tbody tr", (els) => els.map((e) => e.children[1].textContent).join(","))) === "FS" && (await txt("#run-count")).startsWith("1 of 3 installs"), "Only problems hides the succeeded installs");
await page.uncheck("#run-problems");
assert((await page.$$eval("#run-table tbody tr", (els) => els.length)) === 3, "Only problems off: every install listed");

// ---- results CSV ----
await page.click("#btn-results-csv");
const res = await M(() => window.__mock.saved.at(-1));
assert(res.name.endsWith(".csv") && res.content.split("\n")[0].startsWith("environment,type,app") && res.content.includes("failed"), "results CSV");

// ---- a clean run folds away; Dismiss (not while running) clears it ----
await page.check(`${cell("env-dev", "msdyn_custom")} input`);
await page.click("#btn-preview");
await page.waitForSelector("#plan");
await page.click("#dlg-ok");
const during = await page.waitForFunction(() => {
  const t = document.querySelector("#run-title")?.textContent ?? "";
  if (/^Running/.test(t)) return document.querySelector("#btn-run-dismiss").disabled && document.querySelector("#run-fold").open ? "ok" : "bad";
  return /^Last run: 1 succeeded/.test(t) ? "missed" : false;
});
assert((await during.jsonValue()) !== "bad", "while running: the run section is open and Dismiss disabled (" + (await during.jsonValue()) + ")");
await page.waitForFunction(() => /^Last run: 1 succeeded, 0 failed/.test(document.querySelector("#run-title")?.textContent ?? ""), null, { timeout: 20000 });
await page.waitForFunction(() => /1\.5\.0\.0/.test(document.querySelector('td[data-cell="env-dev|msdyn_custom"]')?.textContent ?? "") && !/→/.test(document.querySelector('td[data-cell="env-dev|msdyn_custom"]')?.textContent ?? ""));
assert(!(await page.$eval("#run-fold", (d) => d.open)), "a clean run folds the run section");
assert(!(await page.$eval("#btn-run-dismiss", (b) => b.disabled)) && (await page.$eval("#btn-results-csv", (b) => b.getBoundingClientRect().height)) > 0, "folded: Results CSV and Dismiss stay reachable");
await page.click("#run-fold > summary");
assert(await page.$eval("#run-fold", (d) => d.open), "the run title unfolds it");
await page.click("#btn-run-dismiss");
assert(await page.$eval("#run", (e) => e.hidden), "Dismiss clears the run list");

// ---- unused apps report (connection's environment: Dev) ----
assert(!(await page.$eval("#btn-unused", (b) => b.disabled)), "Unused apps enabled with a Dataverse connection");
const postsBefore = await M(() => window.__mock.posts.length);
await page.click("#btn-unused");
await page.waitForSelector("#unused-table");
assert((await txt("#unused-env")) === "SSS Dev", "report runs on the connection's environment");
let uv = await page.$$eval("#unused-table tbody tr", (els) => els.map((e) => e.dataset.app + ":" + e.dataset.verdict));
assert(uv[0] === "msdyn_teamsapp:unused", "anchor app with only empty own tables: probably unused, listed first: " + uv.join(","));
assert(!uv.some((x) => x.startsWith("msdyn_sales:")), "apps in use are hidden by default: " + uv.join(","));
const tRow = await txt('#unused-table tr[data-app="msdyn_teamsapp"]');
assert(tRow.includes("0 of 1 with rows") && tRow.includes("Teams Hub (1 role)"), "row shows own tables and model-driven app roles: " + tRow);
await page.check("#unused-all");
uv = await page.$$eval("#unused-table tbody tr", (els) => els.map((e) => e.dataset.app + ":" + e.dataset.verdict));
assert(uv.includes("msdyn_sales:in-use"), "Show all lists in-use apps: " + uv.join(","));
assert((await txt('#unused-table tr[data-app="msdyn_sales"]')).includes("msdyn_quote: 1,234"), "in-use row names the table with rows");
const dvq = await M(() => window.__mock.dvq);
assert(!dvq.some((q) => q.includes("msdyn_shared")), "shared table (msdyn_common) not counted");
assert(dvq.includes("msdyn_tiles?$select=msdyn_tileid&$top=1") && !dvq.some((q) => q.startsWith("msdyn_quotes?")), "only snapshot zeros re-checked live");
assert((await M(() => window.__mock.posts.length)) === postsBefore && dvq.every((q) => !/^(Uninstall|Delete)/i.test(q)), "read-only: no Power Platform posts, no write calls");
await page.click("#btn-unused-csv");
const ucsv = await M(() => window.__mock.saved.at(-1));
assert(ucsv.name.startsWith("d365-apps-unused-SSS_Dev-") && ucsv.content.includes("SSS Dev,TEAMSAPP,msdyn_teamsapp,3.1.0.0,Probably unused"), "report CSV: " + ucsv.content.split("\r\n")[1]);

// ---- unused: notes folded, verdict badges filter, name filter, expand / collapse all, Hide keeps the report, Re-run ----
assert(!(await page.$eval("#unused-how", (d) => d.open)) && (await txt("#unused-how")).includes("RetrieveTotalRecordCount"), "How verdicts work: folded by default");
const uApps = () => page.$$eval("#unused-table tbody tr", (els) => els.map((e) => e.dataset.app).join(","));
const uAll = await uApps();
await page.click('#unused-counts button[data-verdict="unused"]');
assert((await uApps()) === "msdyn_teamsapp" && (await pressed('#unused-counts button[data-verdict="unused"]')) === "true" && (await txt("#unused-shown")).startsWith("1 of "), "probably unused badge filters the report: " + (await uApps()));
await page.click('#unused-counts button[data-verdict="in-use"]');
assert((await uApps()) === "msdyn_teamsapp,msdyn_sales", "verdict badges combine (any of them): " + (await uApps()));
assert(await M(() => JSON.parse(localStorage.getItem("sss-view:d365-apps")).unusedVerdicts.join(",") === "unused,in-use"), "pressed verdicts saved in the view state");
await page.fill("#unused-filter", "sales");
assert((await uApps()) === "msdyn_sales", "name filter on top of the verdicts");
await page.fill("#unused-filter", "nothing-like-this");
await page.waitForSelector("#unused-body .empty-state");
await page.click("#unused-body .empty-state button");
assert((await uApps()) === uAll && (await page.inputValue("#unused-filter")) === "" && (await pressed('#unused-counts button[data-verdict="unused"]')) === "false", "Clear filters: name and verdicts reset, every app back");
const folds = () => page.$$eval("#unused-table details.sol-fold", (els) => els.map((d) => d.open));
assert((await folds()).length >= 2 && (await folds()).every((o) => !o), "per-app solution folds start closed");
await page.click("#unused-counts .fold-all button:first-child");
assert((await folds()).every((o) => o), "Expand all opens every app's solutions");
await M(() => new Promise((r) => setTimeout(r, 50))); // the toggle events (recorded by keepFold) are queued tasks
await page.fill("#unused-filter", "teams");
assert((await folds()).length === 1 && (await folds())[0], "an unfolded app stays open while filtering: " + JSON.stringify(await folds()) + (await uApps()));
await page.fill("#unused-filter", "");
await page.click("#unused-counts .fold-all button:last-child");
assert((await folds()).every((o) => !o), "Collapse all closes them");
const q0 = await M(() => window.__mock.dvq.length);
await page.click("#btn-unused-hide");
assert(await page.$eval("#unused", (e) => e.hidden), "Hide hides the report");
await page.click("#btn-unused");
assert(!(await page.$eval("#unused", (e) => e.hidden)) && !!(await page.$("#unused-table")) && (await M(() => window.__mock.dvq.length)) === q0, "Unused apps… shows the kept report again without reading");
await page.click("#btn-unused-rerun");
await page.waitForFunction((q) => window.__mock.dvq.length > q && !!document.querySelector("#unused-table") && !document.querySelector("#btn-unused-rerun").disabled, q0);
assert((await uApps()) === uAll, "Re-run reads the report again");
await page.click("#btn-unused-hide");

// ---- environment columns: Hide empty environments (default on), ✕ per column, Show all ----
const colIds = () => page.$$eval("#grid th.col", (els) => els.map((e) => e.dataset.env).join(","));
const calls = () => M(() => window.__mock.gets.length + window.__mock.posts.length);
assert(await page.$eval("#hide-empty", (e) => e.checked), "Hide empty environments on by default");
await page.click("#btn-envs");
await page.waitForSelector(".envpick input[data-env]");
await page.check('.envpick input[data-env="env-empty"]');
await page.check('.envpick input[data-env="env-broken"]');
await page.click("#dlg-ok");
await page.waitForSelector('#grid th.col[data-env="env-broken"]');
assert(await page.$eval("#show-available", (e) => e.checked), "(Show not installed is on: Empty has an available-only cell)");
assert((await colIds()) === "env-broken,env-dev,env-prod", "empty environment hidden, unreadable one kept: " + (await colIds()));
assert((await txt('#grid th.col[data-env="env-broken"]')).includes("500"), "unreadable environment shows its error header");
assert((await txt("#counts")).includes("× 3 of 4 environments") && (await txt("#env-hidden")).startsWith("1 environment hidden"), "counts reflect shown columns: " + (await txt("#summary")));
// a selection in a column that gets hidden: kept, counted as hidden, flagged in the plan
await page.check(`${cell("env-dev", "msdyn_fs")} input`);
let before = await calls();
await page.click('#grid th.col[data-env="env-dev"] button[aria-label="Hide SSS Dev"]');
assert((await colIds()) === "env-broken,env-prod" && (await calls()) === before, "✕ hides the column locally, no API call");
assert((await txt("#counts")).includes("× 2 of 4 environments") && (await txt("#env-hidden")).startsWith("2 environments hidden"), "2 hidden: " + (await txt("#summary")));
assert(!(await page.$("#f-failed")), "badge counts cover the shown columns only (the failed install is in hidden Dev)");
assert((await txt("#sel-count")) === "1 selected (1 hidden by filter)", "selection in a hidden column counted as hidden: " + (await txt("#sel-count")));
await page.click("#btn-select-failed");
assert((await txt("#sel-count")) === "1 selected (1 hidden by filter)", "Select all failed leaves out hidden columns");
await page.click("#btn-preview");
await page.waitForSelector("#plan");
assert((await txt("#plan-hidden")).includes("1 install is in environment columns hidden from the matrix: SSS Dev") && (await txt("#plan")).includes("hidden column"), "plan flags installs in hidden columns: " + (await txt("#plan")));
await page.click("#dlg-cancel");
await page.waitForFunction(() => !document.querySelector("#dlg").open);
// persisted across reload
await page.reload();
await page.waitForSelector('#grid th.col[data-env="env-broken"]');
assert((await colIds()) === "env-broken,env-prod" && (await page.$eval("#hide-empty", (e) => e.checked)), "hidden columns and Hide empty persisted across reload: " + (await colIds()));
assert(await M(() => JSON.parse(localStorage.getItem("sss-view:d365-apps")).hiddenEnvs.join(",") === "env-dev"), "hiddenEnvs saved in the view state");
// every column hidden → empty state with Show all
await page.click('button[aria-label="Hide SSS Prod"]');
await page.click('button[aria-label="Hide SSS Broken"]');
await page.waitForSelector("#matrix .empty-state");
assert((await txt("#matrix .empty-state")).includes("All environments hidden"), "all columns hidden: empty state");
before = await calls();
await page.click("#matrix .empty-state button");
await page.waitForSelector('#grid th.col[data-env="env-empty"]');
assert((await colIds()) === "env-broken,env-dev,env-empty,env-prod" && (await calls()) === before, "Show all brings every column back without an API call");
assert(!(await page.$eval("#hide-empty", (e) => e.checked)) && !(await page.$("#env-hidden")) && (await txt("#counts")).includes("× 4 environments"), "Show all unticks Hide empty environments; no hidden caption");
await page.reload();
await page.waitForSelector('#grid th.col[data-env="env-empty"]');
assert((await colIds()) === "env-broken,env-dev,env-empty,env-prod", "Show all persisted across reload");
await page.check("#hide-empty");
await page.click('button[aria-label="Hide SSS Prod"]');
await page.click("#btn-show-envs");
assert((await colIds()) === "env-broken,env-dev,env-empty,env-prod", "summary Show all un-hides ✕ and empty columns");
await page.check("#hide-empty");
assert((await colIds()) === "env-broken,env-dev,env-prod", "Hide empty environments ticked again hides Empty only");
// Clear filters leaves Hide empty environments alone (view preference, not a filter)
await page.fill("#filter-text", "nothing-like-this");
await page.click("#matrix .empty-state button");
assert(await page.$eval("#hide-empty", (e) => e.checked), "Clear filters keeps Hide empty environments");

// ---- many environments: preview folds (closed past 5, Production and hidden columns open); long app names ----
await page.uncheck("#hide-empty");
await M(() => {
  const m = window.__mock;
  const add = (id, displayName, type) => {
    m.envs.push({ id, displayName, type, state: 'Ready', dataverseId: 'org-' + id, url: 'https://' + id + '.crm4.dynamics.com', geo: 'europe' });
    m.available[id] = [{ uniqueName: 'msdyn_extra', localizedName: 'EXTRA', version: '7.0.0.0', state: 'None', publisherName: 'Microsoft' }];
  };
  add('env-t1', 'SSS Trial', 'Trial');
  add('env-s2', 'SSS Sandbox 2', 'Sandbox');
  add('env-d1', 'SSS Default', 'Default');
  add('env-p2', 'SSS Prod 2', 'Production');
  m.installed['env-dev'].push({ uniqueName: 'msdyn_long', localizedName: 'A very long Dynamics 365 application name that keeps going well past any sensible column width', version: '1.0.0.0', state: 'Installed', publisherName: 'Microsoft' });
  m.emit("connection:updated");
});
await page.waitForSelector('#grid tr[data-app="msdyn_long"]');
const long = await page.$eval('#grid tr[data-app="msdyn_long"] td.name', (td) => {
  const n = td.querySelector(".app-name");
  const next = td.nextElementSibling.getBoundingClientRect();
  return { title: n.title, cut: n.scrollWidth > n.clientWidth, w: n.getBoundingClientRect().width, h: n.getBoundingClientRect().height, to: getComputedStyle(n).textOverflow, td: td.getBoundingClientRect().right, next: next.left, pos: getComputedStyle(td).position };
});
assert(long.title.startsWith("A very long Dynamics 365") && long.cut && long.to === "ellipsis" && long.w <= 281 && long.h < 24, "long app name: one line cut with an ellipsis, full name in title: " + JSON.stringify(long));
assert(long.pos === "sticky" && long.td <= long.next + 1, "long name: App column stays sticky and does not run into the first environment column: " + JSON.stringify(long));
await page.click("#btn-envs");
await page.waitForSelector(".envpick input[data-env]");
assert((await page.$$eval("#envpick-type option", (els) => els.map((o) => o.textContent).join(","))) === "All types,Production,Sandbox,Developer,Trial,Default", "type filter: Production / Sandbox / Developer / Trial / Default");
await page.selectOption("#envpick-type", "Production");
await page.click(".envpick button:has-text('Tick shown')");
await page.selectOption("#envpick-type", "Trial");
await page.click(".envpick button:has-text('Tick shown')");
await page.selectOption("#envpick-type", "");
for (const id of ["env-s2", "env-d1", "env-empty"]) await page.check(`.envpick input[data-env="${id}"]`);
assert((await txt("#envpick-count")).startsWith("8 of 8 ticked"), "every environment ticked: " + (await txt("#envpick-count")));
await page.click("#dlg-ok");
await page.waitForSelector('#grid th.col[data-env="env-p2"]');
for (const id of ["env-empty", "env-t1", "env-s2", "env-d1", "env-p2"]) await page.check(`${cell(id, "msdyn_extra")} input`);
await page.check(`${cell("env-dev", "msdyn_fs")} input`);
await page.click('button[aria-label="Hide SSS Sandbox 2"]');
await page.click("#btn-preview");
await page.waitForSelector("#plan");
const openFolds = () => page.$$eval("#plan details.plan-env", (els) => els.filter((d) => d.open).map((d) => d.dataset.env).sort().join(","));
assert((await page.$$eval("#plan details.plan-env", (els) => els.length)) === 6 && (await openFolds()) === "env-p2,env-s2", "6 environments: folds closed except Production and the hidden column: " + (await openFolds()));
assert((await txt('#plan details[data-env="env-p2"] > summary')).startsWith("SSS Prod 2 · 1 install") && (await txt("#plan-hidden")).includes("SSS Sandbox 2"), "summary and the hidden-column warning kept");
await page.click('#plan details[data-env="env-t1"] > summary');
assert((await openFolds()).includes("env-t1"), "a closed environment unfolds from its summary");
await page.click("#plan .fold-all button:first-child");
assert((await openFolds()).split(",").length === 6, "Expand all opens every environment");
await page.click("#dlg-cancel");
await page.waitForFunction(() => !document.querySelector("#dlg").open);
await page.click("#btn-clear-sel");

// ---- debug log (shared check) ----
await checkDebugLog(page, assert, {
  tool: "d365-apps",
  act: async () => {
    await page.click("#btn-refresh");
    await page.waitForTimeout(400);
  },
  readSaved: async (click) => {
    const n = await M(() => window.__mock.saved.length);
    await click();
    await page.waitForFunction((k) => window.__mock.saved.length > k, n);
    return (await M(() => window.__mock.saved.at(-1))).content;
  },
  expect: [[/powerplatformAPI\.AppManagement\.Get \["environments\/env-dev\/applicationPackages\?appInstallState=Installed/, "records the Power Platform API paths"]],
});

// ---- setup banner on 403 ----
await M(() => {
  window.__mock.fail403 = true;
  window.__mock.emit("connection:updated");
});
await page.waitForSelector("#setup-banner");
const banner = await txt("#setup-banner");
assert(banner.includes("AppManagement.ApplicationPackages.Install") && banner.includes("EnvironmentManagement.Environments.Read") && banner.includes("403"), "403 → setup banner with the permissions to grant");

await finish();

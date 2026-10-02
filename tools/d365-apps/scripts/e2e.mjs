// E2E for SSS D365 Apps Matrix on the dist build with a mocked host (toolboxAPI, dataverseAPI, powerplatformAPI).
// Environments: Dev (Sandbox, the connection's), Prod (Production), Teams (no Dataverse: hidden).
// Dev: sales 1.0 (catalog 1.2: update, Installed list paged), fs InstallFailed, custom 1.0 → 1.5 (customHandleUpgrade).
// Prod: sales 1.2 (current), portal Installing, extra available only (install returns no operation id → state fallback).
// Empty (nothing installed, extra available: still "empty"), Broken (Installed list fails: error column, never auto-hidden).
// Run: npm run build && node scripts/e2e.mjs
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";
import { checkDebugLog } from "../../_shared/e2e-debug.mjs";

const TOOL = resolve(new URL("..", import.meta.url).pathname);

const MOCK = `
(() => {
  const M = window.__mock = { gets: [], posts: [], saved: [], notes: [], listeners: [], fail403: false, active: {}, maxActive: 0, maxEnvs: 0 };
  const envs = [
    { id: 'env-dev', displayName: 'SSS Dev', type: 'Sandbox', state: 'Ready', dataverseId: 'org-dev', url: 'https://sss-dev.crm4.dynamics.com', geo: 'europe' },
    { id: 'env-prod', displayName: 'SSS Prod', type: 'Production', state: 'Ready', dataverseId: 'org-prod', url: 'https://sss.crm4.dynamics.com', geo: 'europe' },
    { id: 'env-teams', displayName: 'Teams Room', type: 'Teams', state: 'Ready', geo: 'europe' },
    { id: 'env-empty', displayName: 'SSS Empty', type: 'Developer', state: 'Ready', dataverseId: 'org-empty', url: 'https://sss-empty.crm4.dynamics.com', geo: 'europe' },
    { id: 'env-broken', displayName: 'SSS Broken', type: 'Sandbox', state: 'Ready', dataverseId: 'org-broken', url: 'https://sss-broken.crm4.dynamics.com', geo: 'europe' },
  ];
  const P = (uniqueName, version, state, extra = {}) => ({ uniqueName, localizedName: uniqueName.replace(/^msdyn_/, '').toUpperCase(), version, state, publisherName: 'Microsoft', ...extra });
  M.installed = {
    'env-dev': [P('msdyn_sales', '1.0.0.0', 'Installed'), P('msdyn_fs', '2.0.0.0', 'InstallFailed', { lastError: { message: 'Dependency msdyn_anchor missing' } }), P('msdyn_custom', '1.0.0.0', 'Installed', { customHandleUpgrade: true }), P('msdyn_teamsapp', '3.1.0.0', 'Installed')],
    'env-prod': [P('msdyn_sales', '1.2.0.0', 'Installed'), P('msdyn_portal', '5.0.0.0', 'Installing')],
  };
  M.available = {
    'env-dev': [P('msdyn_sales', '1.2.0.0', 'None'), P('msdyn_custom', '1.5.0.0', 'None', { customHandleUpgrade: true }), P('msdyn_fs', '2.0.0.0', 'None')],
    'env-prod': [P('msdyn_sales', '1.2.0.0', 'None'), P('msdyn_extra', '7.0.0.0', 'None')],
    'env-empty': [P('msdyn_extra', '7.0.0.0', 'None')],
  };
  const ops = {};
  const err = (msg) => { throw new Error('Power Platform request failed: ' + msg); };
  const pageOf = (list, path) => {
    // page the Installed list of Dev in two to exercise @odata.nextLink
    const m = path.match(/[$]skiptoken=(\\d+)/);
    const start = m ? Number(m[1]) : 0;
    const size = path.includes('env-dev') && path.includes('appInstallState=Installed') ? 2 : 100;
    const out = { value: list.slice(start, start + size) };
    if (start + size < list.length) out['@odata.nextLink'] = 'https://api.powerplatform.com/appmanagement/' + path.replace(/&[$]skiptoken=\\d+/, '') + '&$skiptoken=' + (start + size);
    return out;
  };
  const track = (envId, d) => {
    M.active[envId] = (M.active[envId] || 0) + d;
    M.maxActive = Math.max(M.maxActive, ...Object.values(M.active));
    M.maxEnvs = Math.max(M.maxEnvs, Object.values(M.active).filter((n) => n > 0).length);
  };
  const finish = (envId, name, ok) => {
    track(envId, -1);
    if (!ok) return;
    const target = (M.available[envId] || []).filter((p) => p.uniqueName === name).sort((a, b) => b.version.localeCompare(a.version))[0];
    const list = M.installed[envId] = M.installed[envId] || [];
    const cur = list.find((p) => p.uniqueName === name);
    if (cur) Object.assign(cur, { version: target ? target.version : cur.version, state: 'Installed', lastError: undefined });
    else list.push(P(name, target ? target.version : '1.0.0.0', 'Installed'));
  };
  window.powerplatformAPI = {
    EnvironmentManagement: {
      Get: async (path) => {
        M.gets.push('env:' + path);
        if (M.fail403) err('HTTP 403: Forbidden');
        if (!/^environments[?]api-version=2024-10-01$/.test(path)) err('mock: bad environments path ' + path);
        return { value: envs };
      },
    },
    AppManagement: {
      Get: async (path) => {
        M.gets.push(path);
        await new Promise((r) => setTimeout(r, 5));
        let m;
        if ((m = path.match(/^environments[/]([^/]+)[/]applicationPackages[?]appInstallState=(Installed|NotInstalled)&api-version=2024-10-01/))) {
          const envId = decodeURIComponent(m[1]);
          if (envId === 'env-teams') err('mock: teams env has no Dataverse');
          if (envId === 'env-broken') err('HTTP 500: Internal Server Error');
          const list = m[2] === 'Installed' ? (M.installed[envId] || []) : (M.available[envId] || []);
          if (M.pending && M.pending[envId] && m[2] === 'Installed') {
            const p = M.pending[envId];
            if (++p.polls >= 2) { delete M.pending[envId]; finish(envId, p.name, true); }
            else return { value: [...list.filter((x) => x.uniqueName !== p.name), P(p.name, '7.0.0.0', 'Installing')] };
          }
          return pageOf(list.map((x) => ({ ...x })), path);
        }
        if ((m = path.match(/^environments[/]([^/]+)[/]operations[/]([^?]+)[?]api-version=2024-10-01$/))) {
          const o = ops[decodeURIComponent(m[2])];
          if (!o) err('HTTP 404: no operation');
          o.polls++;
          if (o.polls < 2) return { status: 'Running', operationId: o.id };
          if (!o.done) { o.done = true; finish(o.envId, o.name, !o.fail); }
          return o.fail ? { status: 'Failed', error: { message: 'Solution msdyn_fs failed to import: missing dependency' }, operationId: o.id } : { status: 'Succeeded', operationId: o.id };
        }
        err('mock: unexpected GET ' + path);
      },
      Post: async (path, body) => {
        M.posts.push({ path, body });
        const m = path.match(/^environments[/]([^/]+)[/]applicationPackages[/]([^/]+)[/]install[?]api-version=2024-10-01$/);
        if (!m) err('mock: unexpected POST ' + path);
        const envId = decodeURIComponent(m[1]);
        const name = decodeURIComponent(m[2]);
        track(envId, 1);
        if (name === 'msdyn_extra') { M.pending = { ...(M.pending || {}), [envId]: { name, polls: 0 } }; return {}; }
        const id = 'op-' + envId + '-' + name;
        ops[id] = { id, envId, name, polls: 0, fail: name === 'msdyn_fs' };
        return { id: 'instance-' + name, packageUniqueName: name, lastOperation: { operationId: id, state: 'InstallRequested' } };
      },
    },
  };
  window.dataverseAPI = {
    execute: async (req) => {
      if (req.operationName === 'RetrieveCurrentOrganization') return { Detail: { EnvironmentId: 'env-dev' } };
      throw new Error('mock: unexpected execute ' + req.operationName);
    },
    // Unused apps (Dev): msdyn_sales owns msdyn_quote (rows); msdyn_teamsapp (anchor) owns msdyn_tile (empty); msdyn_common shared
    queryData: async (q) => {
      M.dvq = M.dvq || [];
      M.dvq.push(q);
      const G = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
      const page = (value) => ({ value });
      if (q.startsWith('solutions?')) return page([
        { solutionid: G(1), uniquename: 'msdyn_SalesCore', friendlyname: 'Sales core', version: '1.2' },
        { solutionid: G(2), uniquename: 'msdyn_teamsapp', friendlyname: 'Teams app', version: '3.1' },
        { solutionid: G(3), uniquename: 'msdyn_common', friendlyname: 'Common', version: '1.0' },
      ]);
      if (q.startsWith('msdyn_solutionhistories?')) return page([
        { msdyn_name: 'msdyn_SalesCore', msdyn_packagename: 'msdyn_sales', msdyn_operation: 0, msdyn_result: true },
        { msdyn_name: 'msdyn_common', msdyn_packagename: 'msdyn_sales', msdyn_operation: 0, msdyn_result: true },
        { msdyn_name: 'msdyn_common', msdyn_packagename: 'msdyn_teamsapp', msdyn_operation: 0, msdyn_result: true },
      ]);
      if (q.startsWith('solutioncomponents?')) return page([
        { objectid: G(11), componenttype: 1, _solutionid_value: G(1) },
        { objectid: G(12), componenttype: 1, _solutionid_value: G(2) },
        { objectid: G(13), componenttype: 1, _solutionid_value: G(3) },
        { objectid: G(21), componenttype: 80, _solutionid_value: G(2) },
      ].filter((c) => q.includes(c._solutionid_value)));
      if (q.startsWith('EntityDefinitions?')) return page([
        { MetadataId: G(11), LogicalName: 'msdyn_quote', EntitySetName: 'msdyn_quotes', PrimaryIdAttribute: 'msdyn_quoteid', IsCustomEntity: true, IsIntersect: false, TableType: 'Standard' },
        { MetadataId: G(12), LogicalName: 'msdyn_tile', EntitySetName: 'msdyn_tiles', PrimaryIdAttribute: 'msdyn_tileid', IsCustomEntity: true, IsIntersect: false, TableType: 'Standard' },
        { MetadataId: G(13), LogicalName: 'msdyn_shared', EntitySetName: 'msdyn_shareds', PrimaryIdAttribute: 'msdyn_sharedid', IsCustomEntity: true, IsIntersect: false, TableType: 'Standard' },
      ]);
      if (q.startsWith('RetrieveTotalRecordCount(EntityNames=@p1)?@p1=')) {
        const names = JSON.parse(decodeURIComponent(q.split('@p1=')[1]));
        const n = { msdyn_quote: 1234, msdyn_tile: 0 };
        const keys = names.filter((k) => k in n);
        return { EntityRecordCountCollection: { Count: keys.length, IsReadOnly: false, Keys: keys, Values: keys.map((k) => n[k]) } };
      }
      if (q === 'msdyn_tiles?$select=msdyn_tileid&$top=1') return page([]);
      if (q.startsWith('appmodules?')) return page([{ appmoduleid: G(21), name: 'Teams Hub', uniquename: 'msdyn_teamshub', appmoduleroles_association: [{ roleid: G(31) }] }]);
      throw new Error('mock: unexpected queryData ' + q);
    },
  };
  window.toolboxAPI = {
    connections: { getActiveConnection: async () => ({ id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' }), getSecondaryConnection: async () => null },
    utils: { getCurrentTheme: async () => 'light', showNotification: async (o) => { M.notes.push(o); } },
    events: { on(cb) { M.listeners.push(cb); } },
    fileSystem: { saveFile: async (name, content) => { M.saved.push({ name, content }); return '/tmp/' + name; }, selectPath: async () => null, readText: async () => '', readBinary: async () => null },
  };
  M.emit = (event) => M.listeners.forEach((cb) => cb({}, { event }));
})();
`;

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
await page.click("#btn-envs");
await page.waitForSelector(".envpick input[data-env]");
const offered = await page.$$eval(".envpick input[data-env]", (els) => els.map((e) => e.dataset.env));
assert(offered.length === 4 && !offered.includes("env-teams"), "picker hides environments without Dataverse: " + offered.join(","));
await page.check('.envpick input[data-env="env-prod"]');
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelectorAll("#grid th.col").length === 2);
assert(await M(() => JSON.parse(localStorage.getItem("sss-d365-apps:envs")).join(",") === "env-dev,env-prod"), "selection remembered");

// ---- cells ----
const txt = async (sel) => (await page.textContent(sel)) ?? "";
assert(/1\.0\.0\.0\s*→\s*1\.2\.0\.0/.test(await txt(cell("env-dev", "msdyn_sales"))), "Dev sales: update derived from the NotInstalled catalog (1.0 → 1.2)");
assert((await page.$eval(cell("env-prod", "msdyn_sales"), (e) => e.className)).includes("k-current"), "Prod sales 1.2: current, no action");
assert((await txt(cell("env-dev", "msdyn_fs"))).includes("Dependency msdyn_anchor missing"), "Dev fs: failed with the last error");
assert((await txt(cell("env-prod", "msdyn_portal"))).includes("Installing"), "Prod portal: in progress, no checkbox");
assert(!(await page.$(`${cell("env-prod", "msdyn_portal")} input`)), "busy cell is not selectable");
assert((await txt('tr[data-app="msdyn_custom"]')).includes("custom upgrade"), "custom upgrade package flagged");
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

// ---- results CSV ----
await page.click("#btn-results-csv");
const res = await M(() => window.__mock.saved.at(-1));
assert(res.name.endsWith(".csv") && res.content.split("\n")[0].startsWith("environment,type,app") && res.content.includes("failed"), "results CSV");

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
await page.click("#btn-unused-close");
assert(await page.$eval("#unused", (e) => e.hidden), "Close hides the report");

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

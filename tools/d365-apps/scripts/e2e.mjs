// E2E for SSS D365 Apps Matrix on the dist build with a mocked host (toolboxAPI, dataverseAPI, powerplatformAPI).
// Environments: Dev (Sandbox, the connection's), Prod (Production), Teams (no Dataverse: hidden).
// Dev: sales 1.0 (catalog 1.2: update, Installed list paged), fs InstallFailed, custom 1.0 → 1.5 (customHandleUpgrade).
// Prod: sales 1.2 (current), portal Installing, extra available only (install returns no operation id → state fallback).
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
  ];
  const P = (uniqueName, version, state, extra = {}) => ({ uniqueName, localizedName: uniqueName.replace(/^msdyn_/, '').toUpperCase(), version, state, publisherName: 'Microsoft', ...extra });
  M.installed = {
    'env-dev': [P('msdyn_sales', '1.0.0.0', 'Installed'), P('msdyn_fs', '2.0.0.0', 'InstallFailed', { lastError: { message: 'Dependency msdyn_anchor missing' } }), P('msdyn_custom', '1.0.0.0', 'Installed', { customHandleUpgrade: true }), P('msdyn_teamsapp', '3.1.0.0', 'Installed')],
    'env-prod': [P('msdyn_sales', '1.2.0.0', 'Installed'), P('msdyn_portal', '5.0.0.0', 'Installing')],
  };
  M.available = {
    'env-dev': [P('msdyn_sales', '1.2.0.0', 'None'), P('msdyn_custom', '1.5.0.0', 'None', { customHandleUpgrade: true }), P('msdyn_fs', '2.0.0.0', 'None')],
    'env-prod': [P('msdyn_sales', '1.2.0.0', 'None'), P('msdyn_extra', '7.0.0.0', 'None')],
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
assert(offered.length === 2 && !offered.includes("env-teams"), "picker hides environments without Dataverse: " + offered.join(","));
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

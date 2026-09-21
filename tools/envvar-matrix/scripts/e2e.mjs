// E2E smoke test for the dist build with a mocked PPTB host (window.toolboxAPI / window.dataverseAPI).
// Two fake environments (Dev = primary, Test = secondary). Covers matrix merge, filters, solution scope,
// copy with preview/confirm, single-cell set, exports, snapshot round-trip, connection references.
// Run: npm run build && node scripts/e2e.mjs   (needs playwright + chromium available)
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = resolve(TOOL, "scripts/.e2e-out");
mkdirSync(OUT, { recursive: true });


// ---- mock host, serialized into the page before load ----
const MOCK = `
(() => {
  const S = 100000000, SECRET = 100000005, BOOL = 100000002;
  const def = (id, schemaname, type, defaultvalue, ismanaged = false) => ({ environmentvariabledefinitionid: id, schemaname, displayname: schemaname.replace('sss_', '').toUpperCase(), type, defaultvalue, ismanaged });
  const val = (id, defId, value) => ({ environmentvariablevalueid: id, value, _environmentvariabledefinitionid_value: defId });
  const cr = (id, name, connector, connectionid, ismanaged = true) => ({ connectionreferenceid: id, connectionreferencelogicalname: name, connectionreferencedisplayname: name, connectorid: '/providers/Microsoft.PowerApps/apis/' + connector, connectionid, ismanaged });
  const envs = {
    primary: {
      conn: { id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' },
      defs: [def('d1', 'sss_apiurl', S, 'https://dev.api'), def('d2', 'sss_apikey', SECRET, null), def('d3', 'sss_flag', BOOL, 'yes'), def('d4', 'sss_onlydev', S, null)],
      vals: [val('v1', 'd1', 'https://dev.api/v2'), val('v2', 'd2', 'kv-ref'), val('v4', 'd4', 'd')],
      crs: [cr('r1', 'sss_office365', 'shared_office365', 'conn-dev-1'), cr('r2', 'sss_sql', 'shared_sql', null)],
    },
    secondary: {
      conn: { id: 'c2', name: 'SSS Test', url: 'https://sss-test.crm4.dynamics.com', environment: 'Test', environmentColor: '#92400e' },
      defs: [def('t1', 'sss_apiurl', S, 'https://dev.api', true), def('t2', 'sss_apikey', SECRET, null, true), def('t3', 'sss_flag', BOOL, null, true), def('t5', 'sss_onlytest', S, null)],
      vals: [val('w1', 't1', 'https://test.api'), val('w2', 't2', 'kv-ref'), val('w5', 't5', 't')],
      crs: [cr('s1', 'sss_office365', 'shared_office365', null), cr('s2', 'sss_sql', 'shared_sql', 'conn-test-9')],
    },
  };
  window.__mock = { envs, writes: [], saved: [], notes: [], nextOpen: null };
  let seq = 100;
  window.toolboxAPI = {
    connections: {
      getActiveConnection: async () => envs.primary.conn,
      getSecondaryConnection: async () => envs.secondary.conn,
    },
    utils: { getCurrentTheme: async () => 'light', showNotification: async (o) => { window.__mock.notes.push(o); } },
    events: { on() {} },
    fileSystem: {
      saveFile: async (name, content) => { window.__mock.saved.push({ name, content }); return '/tmp/' + name; },
      selectPath: async () => (window.__mock.nextOpen ? '/tmp/snapshot.json' : null),
      readText: async () => window.__mock.nextOpen,
    },
  };
  window.dataverseAPI = {
    queryData: async (q, target = 'primary') => {
      const e = envs[target];
      if (q.startsWith('environmentvariabledefinitions')) return { value: e.defs };
      if (q.startsWith('environmentvariablevalues')) return { value: e.vals };
      if (q.startsWith('connectionreferences')) return { value: e.crs };
      if (q.startsWith('solutioncomponents')) return { value: [{ objectid: 'd1', componenttype: 380 }, { objectid: 'r1', componenttype: 371 }] };
      throw new Error('unexpected query ' + q);
    },
    getSolutions: async () => ({ value: [{ solutionid: 'sol1', uniquename: 'SolA', friendlyname: 'Sol A', version: '1.0.0.0', ismanaged: false, isvisible: true }] }),
    create: async (entity, rec, target = 'primary') => {
      window.__mock.writes.push({ op: 'create', entity, rec, target });
      const defId = String(rec['EnvironmentVariableDefinitionId@odata.bind']).match(/\\(([^)]+)\\)/)[1];
      const id = 'n' + (seq++);
      envs[target].vals.push({ environmentvariablevalueid: id, value: rec.value, _environmentvariabledefinitionid_value: defId });
      return { id };
    },
    update: async (entity, id, rec, target = 'primary') => {
      window.__mock.writes.push({ op: 'update', entity, id, rec, target });
      const v = envs[target].vals.find((x) => x.environmentvariablevalueid === id);
      if (!v) throw new Error('no such value ' + id);
      v.value = rec.value;
    },
  };
})();
`;

const { page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto("file://" + TOOL + "/dist/index.html");

const rowNames = () => page.$$eval("table.matrix tbody td.name .mono", (els) => els.map((e) => e.textContent));

await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 2);
assert(true, "two live columns");
assert((await page.textContent("#host-mode")).includes("inside"), "host mode detected");

// env vars union
let names = await rowNames();
assert(JSON.stringify(names) === JSON.stringify(["sss_apikey", "sss_apiurl", "sss_flag", "sss_onlydev", "sss_onlytest"]), "env var rows = union " + names.join(","));
const flagRow = await page.$eval("table.matrix tbody tr:nth-child(3)", (tr) => tr.textContent);
assert(flagRow.includes("yes") && flagRow.includes("default") && flagRow.includes("missing"), "flag: default in Dev, missing in Test");
assert(await page.$eval("table.matrix tbody tr:nth-child(1)", (tr) => tr.textContent.includes("••••")), "secret masked");
await page.screenshot({ path: resolve(OUT, "01-envvars.png") });

// filters
await page.check("#filter-diff");
names = await rowNames();
assert(names.length === 4 && !names.includes("sss_apikey"), "only differences → 4 rows");
await page.uncheck("#filter-diff");
await page.check("#filter-missing");
names = await rowNames();
assert(JSON.stringify(names) === JSON.stringify(["sss_flag", "sss_onlydev", "sss_onlytest"]), "only missing → flag, onlydev, onlytest");
await page.uncheck("#filter-missing");
await page.fill("#filter-text", "api");
names = await rowNames();
assert(names.length === 2, "text filter");
await page.fill("#filter-text", "");

// solution scope
await page.selectOption("#filter-solution", "sol1");
await page.waitForFunction(() => document.querySelectorAll("table.matrix tbody tr").length === 1);
names = await rowNames();
assert(names[0] === "sss_apiurl", "solution scope env vars");
await page.click('.tab[data-tab="connrefs"]');
names = await rowNames();
assert(names[0] === "sss_office365" && names.length === 1, "solution scope conn refs");
await page.selectOption("#filter-solution", "");
await page.waitForFunction(() => document.querySelectorAll("table.matrix tbody tr").length === 2);
const crText = await page.textContent("#matrix-body");
assert(crText.includes("conn-dev-1") && crText.includes("conn-test-9") && crText.includes("unbound"), "conn refs bound/unbound");
await page.screenshot({ path: resolve(OUT, "02-connrefs.png") });

// copy primary -> secondary
await page.click('.tab[data-tab="envvars"]');
await page.check('input[aria-label="Select sss_apiurl"]');
await page.check('input[aria-label="Select sss_flag"]');
await page.check('input[aria-label="Select sss_onlydev"]');
assert(!(await page.isHidden("#bulkbar")), "bulk bar visible");
await page.selectOption("#copy-from", "primary");
await page.selectOption("#copy-to", "secondary");
await page.click("#btn-copy");
await page.waitForSelector("dialog[open]");
const preview = await page.textContent("#dlg-body");
assert(preview.includes("update") && preview.includes("create") && preview.includes("skip") && preview.includes("does not exist"), "preview: update + create + skip");
await page.screenshot({ path: resolve(OUT, "03-preview.png") });
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results");
await page.click("#dlg-cancel");
const writes = await page.evaluate(() => window.__mock.writes);
assert(writes.length === 2 && writes[0].op === "update" && writes[0].id === "w1" && writes[0].rec.value === "https://dev.api/v2" && writes[0].target === "secondary", "update written to secondary");
assert(writes[1].op === "create" && writes[1].rec["EnvironmentVariableDefinitionId@odata.bind"] === "/environmentvariabledefinitions(t3)" && writes[1].rec.value === "yes", "create written for flag");
await page.waitForFunction(() => !document.querySelector("table.matrix tbody tr:nth-child(3)")?.textContent.includes("missing"), null, { timeout: 10000 }).catch(() => {});
const after = await page.$eval("table.matrix tbody tr:nth-child(3)", (tr) => tr.textContent);
assert(!after.includes("missing") && after.includes("sss_flag"), "flag no longer missing after refresh");

// single cell set
await page.hover("table.matrix tbody tr:nth-child(2)");
await page.click('button[aria-label="Set sss_apiurl in SSS Test"]');
await page.waitForSelector("dialog[open]");
await page.fill("dialog textarea", "https://test.api/v3");
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Preview changes");
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results");
await page.click("#dlg-cancel");
const writes2 = await page.evaluate(() => window.__mock.writes);
assert(writes2.length === 3 && writes2[2].rec.value === "https://test.api/v3", "single-cell set written");

// exports
await page.selectOption("#export-col", "secondary");
await page.click("#btn-export-settings");
await page.click("#btn-export-snap");
await page.click("#btn-export-csv");
const saved = await page.evaluate(() => window.__mock.saved);
assert(saved.length === 3, "three exports saved");
const ds = JSON.parse(saved[0].content);
assert(saved[0].name.startsWith("deploymentSettings.") && ds.EnvironmentVariables.some((e) => e.SchemaName === "sss_apiurl" && e.Value === "https://test.api/v3") && ds.ConnectionReferences.some((c) => c.LogicalName === "sss_sql" && c.ConnectionId === "conn-test-9"), "deploymentSettings shape");
const snap = JSON.parse(saved[1].content);
assert(snap.kind === "sss-envvar-matrix-snapshot" && snap.environmentVariables.find((e) => e.schemaName === "sss_apikey").value === "<secret>", "snapshot masks secrets");
assert(saved[2].content.split("\n")[0].startsWith("kind,name,display name"), "csv header");

// snapshot round-trip → third column
await page.evaluate((c) => { window.__mock.nextOpen = c; }, saved[1].content);
await page.click("#btn-load-snap");
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 3);
assert(true, "snapshot loaded as third column");
assert((await page.$$eval("table.matrix thead th.col", (els) => els.length)) === 3, "three matrix columns");
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.screenshot({ path: resolve(OUT, "04-snapshot-dark.png") });
await page.click('#columns .colchip button[aria-label^="Remove"]');
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 2);
assert(true, "snapshot removed");

await finish();

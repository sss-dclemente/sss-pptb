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
  const val = (id, defId, value, ismanaged = false) => ({ environmentvariablevalueid: id, value, ismanaged, _environmentvariabledefinitionid_value: defId });
  const cr = (id, name, connector, connectionid, ismanaged = true) => ({ connectionreferenceid: id, connectionreferencelogicalname: name, connectionreferencedisplayname: name, connectorid: '/providers/Microsoft.PowerApps/apis/' + connector, connectionid, ismanaged });
  const envs = {
    primary: {
      conn: { id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' },
      defs: [def('d1', 'sss_apiurl', S, 'https://dev.api'), def('d2', 'sss_apikey', SECRET, null), def('d3', 'sss_flag', BOOL, 'yes'), def('d4', 'sss_onlydev', S, null)],
      vals: [val('v1', 'd1', 'https://dev.api/v2'), val('v2', 'd2', 'kv-ref'), val('v4', 'd4', 'd')],
      crs: [cr('r1', 'sss_office365', 'shared_office365', 'conn-dev-1'), cr('r2', 'sss_sql', 'shared_sql', null)],
      // connectionreference ObjectTypeCode is org-specific (custom-table range); 371 is the Connector component type.
      crType: 10097,
      sols: [{ solutionid: 'sol1', uniquename: 'SolA', friendlyname: 'Sol A', version: '1.0.0.0', ismanaged: false, isvisible: true }],
      comps: [{ solutionid: 'sol1', objectid: 'd1', componenttype: 380 }, { solutionid: 'sol1', objectid: 'r1', componenttype: 10097 }, { solutionid: 'sol1', objectid: 'shared_sql', componenttype: 371 }],
    },
    secondary: {
      conn: { id: 'c2', name: 'SSS Test', url: 'https://sss-test.crm4.dynamics.com', environment: 'Test', environmentColor: '#92400e' },
      defs: [def('t1', 'sss_apiurl', S, 'https://dev.api', true), def('t2', 'sss_apikey', SECRET, null, true), def('t3', 'sss_flag', BOOL, null, true), def('t5', 'sss_onlytest', S, null)],
      vals: [val('w1', 't1', 'https://test.api', true), val('w2', 't2', 'kv-ref'), val('w5', 't5', 't'), val('w6', 't5', 't-dup')],
      crs: [cr('s1', 'sss_office365', 'shared_office365', null), cr('s2', 'sss_sql', 'shared_sql', 'conn-test-9')],
      crType: 10112,
      sols: [],
      comps: [],
    },
    // third environment the primary connection can be switched to (connection change scenarios)
    prod: {
      conn: { id: 'c3', name: 'SSS Prod', url: 'https://sss-prod.crm4.dynamics.com', environment: 'Prod', environmentColor: '#b91c1c' },
      defs: [def('p1', 'sss_apiurl', S, 'https://dev.api'), def('p2', 'sss_flag', BOOL, 'no')],
      vals: [val('pv1', 'p1', 'https://prod.api')],
      crs: [cr('q1', 'sss_office365', 'shared_office365', 'conn-prod-1'), cr('q2', 'sss_sql', 'shared_sql', 'conn-prod-2')],
      crType: 10123,
      sols: [{ solutionid: 'sol2', uniquename: 'SolB', friendlyname: 'Sol B', version: '2.0.0.0', ismanaged: true, isvisible: true }],
      comps: [{ solutionid: 'sol2', objectid: 'p1', componenttype: 380 }, { solutionid: 'sol2', objectid: 'q1', componenttype: 10123 }],
    },
  };
  envs.dev = envs.primary;
  const listeners = [];
  window.__mock = { envs, writes: [], saved: [], notes: [], nextOpen: null, queries: [], fail: null, failEntityDefs: false };
  window.__mock.emit = (event) => listeners.forEach((cb) => cb({}, { event }));
  window.__mock.usePrimary = (name) => { envs.primary = envs[name]; };
  // Server-side paging: 3 rows per page, absolute @odata.nextLink like Dataverse returns.
  const page = (q, target, rows) => {
    const m = q.match(/&\\$skiptoken=(\\d+)/);
    const start = m ? Number(m[1]) : 0;
    const out = { value: rows.slice(start, start + 3) };
    if (start + 3 < rows.length) out['@odata.nextLink'] = envs[target].conn.url + '/api/data/v9.2/' + q.replace(/&\\$skiptoken=\\d+/, '') + '&$skiptoken=' + (start + 3);
    return out;
  };
  let seq = 100;
  window.toolboxAPI = {
    connections: {
      getActiveConnection: async () => envs.primary.conn,
      getSecondaryConnection: async () => envs.secondary.conn,
    },
    utils: { getCurrentTheme: async () => 'light', showNotification: async (o) => { window.__mock.notes.push(o); } },
    events: { on(cb) { listeners.push(cb); } },
    fileSystem: {
      saveFile: async (name, content) => { window.__mock.saved.push({ name, content }); return '/tmp/' + name; },
      selectPath: async () => (window.__mock.nextOpen ? '/tmp/snapshot.json' : null),
      readText: async () => window.__mock.nextOpen,
    },
  };
  window.dataverseAPI = {
    queryData: async (q, target = 'primary') => {
      const e = envs[target];
      window.__mock.queries.push({ q, target });
      await new Promise((r) => setTimeout(r, 15));
      if (window.__mock.fail === target) throw new Error('503 from ' + target);
      if (q.startsWith('environmentvariabledefinitions')) return page(q, target, e.defs);
      if (q.startsWith('environmentvariablevalues')) return page(q, target, e.vals);
      if (q.startsWith('connectionreferences')) return page(q, target, e.crs);
      if (q.startsWith("EntityDefinitions(LogicalName='connectionreference')")) {
        if (window.__mock.failEntityDefs) throw new Error('403 metadata');
        return { ObjectTypeCode: e.crType };
      }
      if (q.startsWith('solutioncomponents')) {
        // honour the filter: solution id, componenttype list, objectid list
        const sol = (q.match(/_solutionid_value eq ([^ &)]+)/) || [])[1];
        const types = [...q.matchAll(/componenttype eq (\\d+)/g)].map((m) => Number(m[1]));
        const oids = [...q.matchAll(/objectid eq ([^ &)]+)/g)].map((m) => m[1]);
        return { value: e.comps.filter((c) => c.solutionid === sol && (!types.length || types.includes(c.componenttype)) && (!oids.length || oids.includes(c.objectid))) };
      }
      throw new Error('unexpected query ' + q);
    },
    getSolutions: async (cols, target = 'primary') => ({ value: envs[target].sols }),
    create: async (entity, rec, target = 'primary') => {
      window.__mock.writes.push({ op: 'create', entity, rec, target, env: envs[target].conn.name });
      const defId = String(rec['EnvironmentVariableDefinitionId@odata.bind']).match(/\\(([^)]+)\\)/)[1];
      const id = 'n' + (seq++);
      envs[target].vals.push({ environmentvariablevalueid: id, value: rec.value, _environmentvariabledefinitionid_value: defId });
      return { id };
    },
    update: async (entity, id, rec, target = 'primary') => {
      window.__mock.writes.push({ op: 'update', entity, id, rec, target, env: envs[target].conn.name });
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
const q0 = await page.evaluate(() => window.__mock.queries);
assert(q0.some((x) => x.q.startsWith("environmentvariabledefinitions") && x.q.includes("$skiptoken=3")) && !q0.some((x) => x.q.startsWith("http")), "paging: nextLink followed as relative query");
assert(q0.some((x) => x.q.startsWith("environmentvariablevalues") && x.q.includes("ismanaged")), "value rows select ismanaged");
assert(names.includes("sss_onlydev"), "paging: definition on page 2 loaded");
assert(await page.$eval("table.matrix tbody tr:nth-child(5)", (tr) => tr.textContent.includes("2 value rows")), "duplicate value rows flagged on cell");
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
await page.check('input[aria-label="Select sss_apikey"]');
assert(!(await page.isHidden("#bulkbar")), "bulk bar visible");
await page.selectOption("#copy-from", "primary");
await page.selectOption("#copy-to", "secondary");
await page.click("#btn-copy");
await page.waitForSelector("dialog[open]");
const preview = await page.textContent("#dlg-body");
assert(preview.includes("update") && preview.includes("create") && preview.includes("skip") && preview.includes("does not exist"), "preview: update + create + skip");
assert(preview.includes("from source default"), "preview labels copy of a source default");
assert(preview.includes("value row is managed") && preview.includes("caution"), "preview warns on managed value row update");
assert(preview.includes("secret variables are read-only") && !preview.includes("kv-ref"), "preview skips secrets and never shows their value");
const dlgBox = await page.locator("dialog[open]").boundingBox();
assert(dlgBox && Math.abs(dlgBox.x + dlgBox.width / 2 - 700) < 20, "dialog centred horizontally");
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

// same copy again: everything already equal → nothing to apply, no pointless rows
await page.click("#btn-copy");
await page.waitForSelector("dialog[open]");
const preview2 = await page.textContent("#dlg-body");
assert(preview2.includes("0 writes") && (await page.isHidden("#dlg-ok")), "repeat copy: 0 writes, no apply button");
await page.click("#dlg-cancel");
assert((await page.evaluate(() => window.__mock.writes.length)) === 2, "repeat copy wrote nothing");
await page.click("#btn-clear-sel");

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

// type validation + empty input + default-equal set
async function previewSet(label, value) {
  await page.hover("table.matrix tbody tr:nth-child(3)");
  await page.click(`button[aria-label="${label}"]`);
  await page.waitForSelector("dialog[open]");
  if (value != null) await page.fill("dialog textarea", value);
  await page.click("#dlg-ok");
  await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Preview changes");
  const text = await page.textContent("#dlg-body");
  const okHidden = await page.isHidden("#dlg-ok");
  await page.click("#dlg-cancel");
  return { text, okHidden };
}
let pv = await previewSet("Set sss_flag in SSS Test", "maybe");
assert(pv.text.includes("invalid") && pv.text.includes('Boolean must be "yes" or "no"') && pv.okHidden, "invalid Boolean blocked in preview");
pv = await previewSet("Set sss_flag in SSS Test", "   ");
assert(pv.text.includes("empty input") && pv.okHidden, "empty input skipped, not written as empty string");
pv = await previewSet("Set sss_flag in SSS Dev", null);
assert(pv.text.includes("equals target default") && pv.okHidden, "setting the default value again creates no value row");
assert((await page.evaluate(() => window.__mock.writes.length)) === 3, "no writes from blocked previews");

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
assert(ds.EnvironmentVariables.find((e) => e.SchemaName === "sss_apikey").Value === "", "deploymentSettings: secret exported with empty Value");

// deploymentSettings respects solution scope; default-only vars get empty Value
await page.selectOption("#export-col", "primary");
await page.selectOption("#filter-solution", "sol1");
await page.waitForFunction(() => document.querySelectorAll("table.matrix tbody tr").length === 1);
await page.click("#btn-export-settings");
await page.selectOption("#filter-solution", "");
await page.waitForFunction(() => document.querySelectorAll("table.matrix tbody tr").length === 5);
await page.click("#btn-export-settings");
const saved2 = await page.evaluate(() => window.__mock.saved);
const dsScoped = JSON.parse(saved2[3].content);
assert(JSON.stringify(dsScoped.EnvironmentVariables.map((e) => e.SchemaName)) === '["sss_apiurl"]' && JSON.stringify(dsScoped.ConnectionReferences.map((c) => c.LogicalName)) === '["sss_office365"]', "deploymentSettings scoped to selected solution");
const dsAll = JSON.parse(saved2[4].content);
assert(dsAll.EnvironmentVariables.length === 4 && dsAll.EnvironmentVariables.find((e) => e.SchemaName === "sss_flag").Value === "", "deploymentSettings: default-only var → empty Value");

// snapshot round-trip → third column
await page.evaluate((c) => { window.__mock.nextOpen = c; }, saved[1].content);
await page.click("#btn-load-snap");
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 3);
assert(true, "snapshot loaded as third column");
assert((await page.$$eval("table.matrix thead th.col", (els) => els.length)) === 3, "three matrix columns");
await page.selectOption("#export-col", "snap:1");
await page.click("#btn-export-settings");
const dsSnap = JSON.parse((await page.evaluate(() => window.__mock.saved)).at(-1).content);
assert(dsSnap.EnvironmentVariables.find((e) => e.SchemaName === "sss_apikey").Value === "" && !JSON.stringify(dsSnap).includes("<secret>"), "deploymentSettings from snapshot: never the <secret> placeholder");
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.screenshot({ path: resolve(OUT, "04-snapshot-dark.png") });
await page.click('#columns .colchip button[aria-label^="Remove"]');
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 2);
assert(true, "snapshot removed");

// deploymentSettings.json loaded as a column; copy from it goes through the normal preview
await page.evaluate(() => {
  window.__mock.nextOpen = JSON.stringify({ EnvironmentVariables: [{ SchemaName: "sss_flag", Value: "no" }, { SchemaName: "sss_apiurl", Value: "" }], ConnectionReferences: [{ LogicalName: "sss_sql", ConnectionId: "conn-file-1", ConnectorId: "/providers/Microsoft.PowerApps/apis/shared_sql" }] });
});
await page.click("#btn-load-snap");
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 3);
assert((await page.textContent("#columns")).includes("settings") && (await page.$$eval("table.matrix thead th.col", (els) => els.at(-1).textContent)).startsWith("settings"), "settings file loaded as a column labelled settings");
{
  const flagRow = await page.$eval('tr:has(input[aria-label="Select sss_flag"])', (tr) => tr.textContent);
  assert(flagRow.includes("no") && flagRow.includes("value"), "settings value shown in its column");
  const apiRow = await page.$eval('tr:has(input[aria-label="Select sss_apiurl"])', (tr) => tr.lastElementChild.textContent);
  assert(apiRow.includes("missing"), "empty Value in settings = not set");
}
if (!(await page.isHidden("#bulkbar"))) await page.click("#btn-clear-sel");
await page.check('input[aria-label="Select sss_flag"]');
await page.check('input[aria-label="Select sss_apiurl"]');
await page.selectOption("#copy-from", "settings:1");
await page.selectOption("#copy-to", "primary");
await page.click("#btn-copy");
await page.waitForSelector("dialog[open]");
{
  const pv = await page.textContent("#dlg-body");
  assert(pv.includes("create") && pv.includes("only default set") && pv.includes("source has no value"), "copy from settings: flag planned, empty value skipped");
}
await page.click("#dlg-cancel");
await page.click("#btn-clear-sel");
await page.click('.tab[data-tab="connrefs"]');
assert((await page.textContent("#matrix-body")).includes("conn-file-1"), "settings connection ids shown on connection references tab");
await page.click('.tab[data-tab="envvars"]');
await page.click('#columns .colchip button[aria-label^="Remove"]');
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 2);
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

// CSV: formula injection neutralised, \r quoted
await page.evaluate(() => { window.__mock.envs.secondary.vals.find((v) => v.environmentvariablevalueid === "w6").value = "=1+1\rx"; });
await page.click("#btn-refresh");
await page.waitForFunction(() => document.querySelector("#matrix-body").textContent.includes("=1+1"));
await page.click("#btn-export-csv");
const csv = (await page.evaluate(() => window.__mock.saved)).at(-1).content;
assert(csv.includes('"\'=1+1\rx"') && !/,=1\+1/.test(csv), "csv: formula cell prefixed with ' and \\r quoted");

// connection references: different connector id counts as a difference
await page.evaluate(() => {
  const e = window.__mock.envs;
  e.primary.crs[1].connectionid = "conn-dev-2";
  e.secondary.crs[0].connectionid = "conn-test-1";
  e.secondary.crs[1].connectorid = "/providers/Microsoft.PowerApps/apis/shared_sqlx";
});
await page.click("#btn-refresh");
await page.click('.tab[data-tab="connrefs"]');
await page.waitForFunction(() => document.querySelector("#matrix-body").textContent.includes("shared_sqlx"));
await page.check("#filter-diff");
names = await rowNames();
assert(JSON.stringify(names) === '["sss_sql"]', "conn ref differs on connector id (both bound)");
await page.uncheck("#filter-diff");
await page.click('.tab[data-tab="envvars"]');

// overlapping refreshes coalesce: one in flight + one queued rerun
await page.evaluate(() => { window.__mock.queries = []; });
await page.evaluate(() => { for (let i = 0; i < 4; i++) document.querySelector("#btn-refresh").click(); });
await page.waitForTimeout(800);
const defLoads = await page.evaluate(() => window.__mock.queries.filter((x) => x.target === "primary" && x.q.startsWith("environmentvariabledefinitions") && !x.q.includes("skiptoken")).length);
assert(defLoads === 2, "4 overlapping refreshes → 2 loads (got " + defLoads + ")");

// one failing connection does not blank the other column
await page.evaluate(() => { window.__mock.fail = "secondary"; });
await page.click("#btn-refresh");
await page.waitForFunction(() => document.querySelector("#columns").textContent.includes("load failed"));
const failText = await page.textContent("#matrix-body");
assert(failText.includes("https://dev.api/v2") && failText.includes("503 from secondary"), "primary data kept, error shown on failed column");
assert((await page.$$eval("table.matrix td.cell.error", (els) => els.length)) === 4, "failed column cells marked error (4 primary rows)");
assert(JSON.stringify(await page.$$eval("#copy-to option", (els) => els.map((e) => e.value))) === '["primary"]', "failed column is not a copy target");
assert((await page.evaluate(() => window.__mock.notes)).some((n) => /Load failed/.test(n.title) && /503/.test(n.body)), "load failure notified");
await page.evaluate(() => { window.__mock.fail = null; });
await page.click("#btn-refresh");
await page.waitForFunction(() => !document.querySelector("#columns").textContent.includes("load failed"));
assert(true, "column recovers after refresh");

// ---- bug 2: connection references scoped by the org-specific connectionreference ObjectTypeCode, not 371 (Connector) ----
{
  await page.evaluate(() => { window.__mock.queries = []; });
  await page.selectOption("#filter-solution", "sol1");
  await page.waitForFunction(() => document.querySelectorAll("table.matrix tbody tr").length === 1);
  const qs = await page.evaluate(() => window.__mock.queries.map((x) => x.q));
  const sc = qs.filter((q) => q.startsWith("solutioncomponents"));
  assert(sc.length > 0 && sc.every((q) => !q.includes("componenttype eq 371")) && sc.some((q) => q.includes("componenttype eq 10097")), "bug2: solutioncomponents filtered by resolved connectionreference ObjectTypeCode (10097), never 371");
  assert(dsScoped.ConnectionReferences.length === 1, "bug2: scoped deploymentSettings includes the solution's connection reference");
  await page.selectOption("#filter-solution", "");
  await page.waitForFunction(() => document.querySelectorAll("table.matrix tbody tr").length === 5);
}

// ---- bug 1: connection change while a solution is selected ----
const waitPrimary = (name) => page.waitForFunction((n) => document.querySelector("#columns").textContent.includes(n), name);
await page.selectOption("#filter-solution", "sol1");
await page.waitForFunction(() => document.querySelectorAll("table.matrix tbody tr").length === 1);
await page.evaluate(() => { window.__mock.usePrimary("prod"); window.__mock.emit("connection:updated"); });
await waitPrimary("SSS Prod");
await page.waitForTimeout(200);
assert((await page.$eval("#filter-solution", (s) => s.value)) === "", "bug1: solution dropdown reset to all after connection change");
names = await rowNames();
assert(names.length === 4, "bug1: grid not empty after connection change (got " + names.length + " rows)");
await page.selectOption("#export-col", "primary");
await page.click("#btn-export-settings");
{
  const ds1 = JSON.parse((await page.evaluate(() => window.__mock.saved)).at(-1).content);
  assert(ds1.EnvironmentVariables.length === 2 && ds1.ConnectionReferences.length === 2, "bug1: deploymentSettings not empty after connection change");
}

// ---- bug 2 fallback: ObjectTypeCode lookup fails → solutioncomponents matched by connection reference ids ----
await page.evaluate(() => { window.__mock.failEntityDefs = true; window.__mock.queries = []; });
await page.selectOption("#filter-solution", "sol2");
await page.waitForFunction(() => document.querySelectorAll("table.matrix tbody tr").length === 1);
assert(JSON.stringify(await rowNames()) === '["sss_apiurl"]', "bug2 fallback: env vars scoped");
await page.click("#btn-export-settings");
{
  const ds2 = JSON.parse((await page.evaluate(() => window.__mock.saved)).at(-1).content);
  const fq = await page.evaluate(() => window.__mock.queries.map((x) => x.q).filter((q) => q.startsWith("solutioncomponents")));
  assert(JSON.stringify(ds2.ConnectionReferences.map((c) => c.LogicalName)) === '["sss_office365"]' && fq.some((q) => q.includes("objectid eq q1")), "bug2 fallback: scoped connection references via objectid filter");
}
await page.click('.tab[data-tab="connrefs"]');
assert(JSON.stringify(await rowNames()) === '["sss_office365"]', "bug2 fallback: conn ref grid scoped");
await page.click('.tab[data-tab="envvars"]');
await page.selectOption("#filter-solution", "");
await page.evaluate(() => { window.__mock.failEntityDefs = false; });

// ---- bug 3: preview is bound to the connection it was built for ----
await page.evaluate(() => { window.__mock.usePrimary("dev"); window.__mock.emit("connection:updated"); });
await waitPrimary("SSS Dev");
await page.waitForFunction(() => document.querySelectorAll("table.matrix tbody tr").length === 5);
async function openDevPreview(value) {
  await page.hover("table.matrix tbody tr:nth-child(2)");
  await page.click('button[aria-label="Set sss_apiurl in SSS Dev"]');
  await page.waitForSelector("dialog[open]");
  await page.fill("dialog textarea", value);
  await page.click("#dlg-ok");
  await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Preview changes" && document.querySelector("dialog").open);
}
// (a) connection change event closes the open preview
let wBefore = await page.evaluate(() => window.__mock.writes.length);
await openDevPreview("https://dev.api/v8");
await page.evaluate(() => { window.__mock.usePrimary("prod"); window.__mock.emit("connection:updated"); });
await waitPrimary("SSS Prod");
await page.waitForTimeout(200);
const stillOpen = await page.$eval("dialog", (d) => d.open);
if (stillOpen && !(await page.isHidden("#dlg-ok"))) {
  await page.click("#dlg-ok");
  await page.waitForTimeout(500);
}
if (await page.$eval("dialog", (d) => d.open)) await page.click("#dlg-cancel");
assert(!stillOpen, "bug3: open preview closed on connection change");
assert((await page.evaluate(() => window.__mock.writes.length)) === wBefore, "bug3: nothing written to the new connection from a stale preview");
// (b) host switched without (or before) the event: Apply re-checks the connection and refuses
await page.evaluate(() => { window.__mock.usePrimary("dev"); window.__mock.emit("connection:updated"); });
await waitPrimary("SSS Dev");
await page.waitForFunction(() => document.querySelectorAll("table.matrix tbody tr").length === 5);
wBefore = await page.evaluate(() => window.__mock.writes.length);
await openDevPreview("https://dev.api/v7");
await page.evaluate(() => { window.__mock.notes = []; window.__mock.usePrimary("prod"); });
await page.click("#dlg-ok");
await page.waitForTimeout(500);
if (await page.$eval("dialog", (d) => d.open)) await page.click("#dlg-cancel");
{
  const w = await page.evaluate(() => window.__mock.writes);
  assert(w.length === wBefore, "bug3: Apply refused when the target connection changed after preview (writes: " + w.slice(wBefore).map((x) => x.env).join(",") + ")");
  assert((await page.evaluate(() => window.__mock.notes)).some((n) => /connection changed/i.test(n.title + " " + n.body)), "bug3: clear 'connection changed' error shown");
}
await page.evaluate(() => { window.__mock.usePrimary("dev"); window.__mock.emit("connection:updated"); });
await waitPrimary("SSS Dev");

await finish();

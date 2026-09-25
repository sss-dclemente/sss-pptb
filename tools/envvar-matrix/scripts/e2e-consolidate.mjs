// E2E for connection reference consolidation with a mocked PPTB host (one Dev environment).
// Covers: usage per reference from flow clientdata, groups per connector, suggested keep target, merge preview,
// mandatory backup, off → clientdata → on, safe delete (usage re-check + dependencies), managed refs kept, restore.
// Run: npm run build && node scripts/e2e-consolidate.mjs   (needs playwright + chromium available)
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const MOCK = `
(() => {
  const cr = (id, name, connector, connectionid, ismanaged = false) => ({ connectionreferenceid: id, connectionreferencelogicalname: name, connectionreferencedisplayname: name.toUpperCase(), connectorid: '/providers/Microsoft.PowerApps/apis/' + connector, connectionid, ismanaged });
  const cd = (refs) => JSON.stringify({ properties: { connectionReferences: Object.fromEntries(refs.map(([k, n, api]) => [k, { runtimeSource: 'embedded', connection: { connectionReferenceLogicalName: n }, api: { name: api } }])), definition: { actions: {} } }, schemaVersion: '1.0.0.0' });
  const wf = (id, name, statecode, refs, ismanaged = false, definition) => {
    const o = JSON.parse(cd(refs));
    if (definition) o.properties.definition = definition;
    return { workflowid: id, name, statecode, statuscode: statecode === 1 ? 2 : 1, ismanaged, clientdata: JSON.stringify(o) };
  };
  const act = (key) => ({ type: 'OpenApiConnection', inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_office365', connectionName: key, operationId: 'SendEmailV2' } } });
  const f3def = { actions: { Send_1: act('shared_office365'), Send_2: act('shared_office365_1'), Compose: { type: 'Compose', inputs: "@parameters('$connections')['shared_office365_1']['connectionId']" }, Compose2: { type: 'Compose', inputs: "@{body('x')['$connections']['shared_office365_1']}" } } };
  const f7def = { actions: { Send_1: act('shared_office365'), Send_2: act('shared_office365_1'), Weird: { type: 'Compose', inputs: { key: 'shared_office365_1' } } } };
  const env = {
    conn: { id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' },
    crs: [
      cr('r1', 'sss_o365_a', 'shared_office365', 'conn-1'),
      cr('r2', 'sss_o365_b', 'shared_office365', 'conn-1'),
      cr('r3', 'sss_o365_c', 'shared_office365', null),
      cr('r4', 'sss_o365_m', 'shared_office365', 'conn-2', true),
      cr('r5', 'sss_sql', 'shared_sql', 'conn-9'),
      cr('r6', 'sss_dv_1', 'shared_commondataserviceforapps', 'conn-5'),
      cr('r7', 'sss_dv_2', 'shared_commondataserviceforapps', 'conn-5'),
      cr('r8', 'sss_unused', 'shared_teams', null),
      cr('r9', 'sss_canvas', 'shared_sharepointonline', 'conn-7'),
    ],
    flows: [
      wf('f1', 'Flow One', 1, [['shared_office365', 'sss_o365_a', 'shared_office365'], ['shared_sql', 'sss_sql', 'shared_sql']]),
      wf('f2', 'Flow Two', 1, [['shared_office365', 'sss_o365_b', 'shared_office365']]),
      wf('f3', 'Flow Three', 0, [['shared_office365', 'sss_o365_a', 'shared_office365'], ['shared_office365_1', 'sss_o365_c', 'shared_office365']], false, f3def),
      wf('f7', 'Flow Odd Key', 0, [['shared_office365', 'sss_o365_a', 'shared_office365'], ['shared_office365_1', 'sss_o365_b', 'shared_office365']], false, f7def),
      wf('f4', 'Flow Managed', 1, [['shared_office365', 'sss_o365_m', 'shared_office365']], true),
      wf('f5', 'Flow DV', 1, [['shared_commondataserviceforapps', 'sss_dv_2', 'shared_commondataserviceforapps']]),
      wf('f8', 'Flow Ghost', 0, [['shared_teams', 'sss_ghost', 'shared_teams']]),
      { workflowid: 'f6', name: 'Flow Broken', statecode: 0, statuscode: 1, ismanaged: false, clientdata: '{not json' },
    ],
    deps: { r7: 1, r9: 2 },
    sols: [{ solutionid: 'sol1', uniquename: 'SolA', friendlyname: 'Sol A', version: '1.0.0.0', ismanaged: false, isvisible: true }],
    comps: [{ solutionid: 'sol1', objectid: 'f1', componenttype: 29 }, { solutionid: 'sol1', objectid: 'f2', componenttype: 29 }, { solutionid: 'sol1', objectid: 'f8', componenttype: 29 }, { solutionid: 'sol1', objectid: 'r1', componenttype: 10097 }],
  };
  window.__mock = { env, writes: [], saved: [], notes: [], nextOpen: null, failActivate: null };
  const flow = (id) => env.flows.find((f) => f.workflowid === id);
  window.toolboxAPI = {
    connections: { getActiveConnection: async () => env.conn, getSecondaryConnection: async () => null },
    utils: { getCurrentTheme: async () => 'light', showNotification: async (o) => { window.__mock.notes.push(o); } },
    events: { on() {} },
    fileSystem: {
      saveFile: async (name, content) => { window.__mock.saved.push({ name, content }); return '/tmp/' + name; },
      selectPath: async () => (window.__mock.nextOpen ? '/tmp/backup.json' : null),
      readText: async () => window.__mock.nextOpen,
    },
  };
  const ppc = (name, connector, displayName, status, account) => ({ name, id: connector ? '/providers/Microsoft.PowerApps/apis/' + connector + '/connections/' + name : undefined, type: 'Microsoft.PowerApps/apis/connections', properties: { displayName, accountName: account, statuses: status ? [{ status }] : undefined } });
  window.__mock.pp = {
    fail: null,
    gets: [],
    pages: [
      [ppc('conn-o-1', 'shared_office365', 'Office A', 'Connected', 'a@contoso.com'), ppc('conn-o-2', 'shared_office365', 'Office B', 'Error', 'b@contoso.com')],
      [ppc('conn-sql-1', 'shared_sql', 'SQL prod', 'Connected'), ppc('weird', null, 'No connector')],
    ],
  };
  window.powerplatformAPI = {
    Connectivity: {
      Get: async (path, target = 'primary') => {
        const m = window.__mock.pp;
        m.gets.push({ path, target });
        if (m.fail) throw new Error('Power Platform request failed: ' + m.fail);
        const page = /skiptoken=1/.test(path) ? 1 : 0;
        const out = { value: m.pages[page] };
        if (page === 0) out.nextLink = 'https://api.powerplatform.com/connectivity/environments/env-guid-1/connections?api-version=2024-10-01&skiptoken=1';
        return out;
      },
    },
  };
  window.dataverseAPI = {
    queryData: async (q) => {
      await new Promise((r) => setTimeout(r, 10));
      if (q.startsWith('environmentvariable')) return { value: [] };
      if (q.startsWith('connectionreferences')) return { value: env.crs.map((x) => ({ ...x })) };
      if (q.startsWith('workflows')) {
        if (!/category eq 5 and type eq 1/.test(q)) throw new Error('flow filter missing');
        return { value: env.flows.map((x) => ({ ...x })) };
      }
      if (q.startsWith("EntityDefinitions(LogicalName='connectionreference')")) return { ObjectTypeCode: 10097 };
      if (q.startsWith('solutioncomponents')) {
        const sol = (q.match(/_solutionid_value eq ([^ &)]+)/) || [])[1];
        const types = [...q.matchAll(/componenttype eq (\\d+)/g)].map((m) => Number(m[1]));
        return { value: env.comps.filter((c) => c.solutionid === sol && (!types.length || types.includes(c.componenttype))) };
      }
      if (q.startsWith('RetrieveDependenciesForDelete')) {
        const id = q.match(/ObjectId=([^,]+)/)[1];
        return { EntityCollection: { Entities: Array.from({ length: env.deps[id] || 0 }, () => ({})) } };
      }
      throw new Error('unexpected query ' + q);
    },
    getSolutions: async () => ({ value: env.sols }),
    execute: async (req) => {
      window.__mock.writes.push({ op: 'execute', req });
      if (req.operationName === 'RetrieveCurrentOrganization') return { Detail: { EnvironmentId: 'env-guid-1' } };
      if (req.operationName !== 'AddSolutionComponent') throw new Error('unexpected execute ' + req.operationName);
      const sol = env.sols.find((x) => x.uniquename === req.parameters.SolutionUniqueName);
      env.comps.push({ solutionid: sol.solutionid, objectid: req.parameters.ComponentId, componenttype: req.parameters.ComponentType });
      return {};
    },
    create: async (entity, rec) => {
      window.__mock.writes.push({ op: 'create', entity, rec });
      const id = 'new-' + rec.connectionreferencelogicalname;
      env.crs.push({ connectionreferenceid: id, ...rec });
      return { id };
    },
    update: async (entity, id, rec) => {
      window.__mock.writes.push({ op: 'update', entity, id, rec });
      if (entity === 'connectionreference') {
        const c = env.crs.find((x) => x.connectionreferenceid === id);
        if (!c) throw new Error('no such reference ' + id);
        Object.assign(c, rec);
        return;
      }
      if (entity !== 'workflow') throw new Error('unexpected update ' + entity);
      const f = flow(id);
      if (rec.statecode === 1 && window.__mock.failActivate === id) throw new Error('connection not bound');
      Object.assign(f, rec);
    },
    delete: async (entity, id) => {
      window.__mock.writes.push({ op: 'delete', entity, id });
      env.crs = env.crs.filter((x) => x.connectionreferenceid !== id);
    },
  };
})();
`;

const { page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto("file://" + TOOL + "/dist/index.html");
await page.waitForFunction(() => document.querySelector("#columns").textContent.includes("SSS Dev"));

await page.click('.tab[data-tab="connrefs"]');
assert(await page.isVisible("#btn-consolidate"), "Consolidate button on connection references tab");
await page.click("#btn-consolidate");
await page.waitForSelector(".cons-groups");
const text = await page.textContent("#matrix-body");
assert(text.includes("8 cloud flows scanned"), "flows scanned");
assert(text.includes("1 flow with unreadable clientdata"), "broken clientdata counted");
const cards = await page.$$eval(".cons-groups .card", (els) => els.map((e) => e.querySelector("h3").textContent).filter((t) => !/^(Unused|Solution|Flows that are off)/.test(t)));
assert(cards.length === 2 && cards.some((c) => c.startsWith("shared_office365 · 4")) && cards.some((c) => c.startsWith("shared_commondataserviceforapps · 2")), "groups per connector, sql singleton excluded: " + cards.join(" | "));
{
  const unusedCard = await page.textContent('.cons-groups .card:has(h3:text-matches("^Unused"))');
  assert(unusedCard.includes("Unused connection references · 3") && unusedCard.includes("sss_unused") && unusedCard.includes("sss_canvas") && unusedCard.includes("sss_dv_1"), "unused references listed: " + unusedCard.slice(0, 80));
}

// solution fit: Sol A holds f1, f2, f8 and only reference r1 (sss_o365_a)
await page.selectOption("#filter-solution", "sol1");
await page.waitForSelector("#btn-fit-add", { timeout: 10000 });
{
  const fit = await page.textContent(".cons-groups .card:first-child");
  assert(fit.includes("Solution check · Sol A") && fit.includes("sss_sql") && fit.includes("sss_o365_b") && !fit.includes("sss_o365_c"), "fit: references used by the solution's flows but not in it");
  assert(fit.includes("sss_ghost") && fit.includes("does not exist"), "fit: flow naming a missing reference flagged");
  assert((await page.textContent("#btn-fit-add")).includes("Add 2"), "fit: add only existing references");
}
await page.click("#btn-fit-add");
await page.waitForSelector("dialog[open]");
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results" && document.querySelector("dialog").open, null, { timeout: 10000 });
{
  const ex = (await page.evaluate(() => window.__mock.writes)).filter((w) => w.op === "execute");
  assert(ex.length === 2 && ex.every((w) => w.req.parameters.SolutionUniqueName === "SolA" && w.req.parameters.ComponentType === 10097 && w.req.parameters.AddRequiredComponents === false) && ex.map((w) => w.req.parameters.ComponentId).sort().join() === "r2,r5", "AddSolutionComponent for r2 + r5 with the org's connectionreference type");
}
await page.click("#dlg-cancel");
await page.waitForFunction(() => (document.querySelector(".cons-groups .card:first-child")?.textContent || "").includes("sss_ghost") && !document.querySelector("#btn-fit-add"), null, { timeout: 10000 });
assert(true, "fit: after add only the missing reference remains");
await page.selectOption("#filter-solution", "");
await page.waitForFunction(() => document.querySelectorAll(".cons-groups .card").length >= 3);
await page.evaluate(() => { window.__mock.writes = []; });

const o365 = page.locator(".cons-groups .card", { hasText: "shared_office365 ·" });
const keep = await o365.locator("tr.keep td.name .mono").textContent();
assert(keep === "sss_o365_a", "suggested target: bound + most used (" + keep + ")");

// select b + c + managed m into a
await o365.getByRole("button", { name: "Merge all into kept" }).click();
assert((await page.textContent("#merge-count")).includes("3 references → 1 target"), "merge bar count");
await page.screenshot({ path: resolve(TOOL, "scripts/.e2e-out/09-consolidate-groups.png") });
await page.click("#btn-merge-preview");
await page.waitForSelector("dialog[open]");
const pv = await page.textContent("#dlg-body");
assert(pv.includes("4 flows to update"), "preview: 4 flows to update (f1 already uses the kept reference)");
assert(pv.includes("key shared_office365_1 → shared_office365 (3 uses)"), "duplicate key collapse shown with use count");
assert(pv.includes("duplicate key kept: shared_office365_1: used in a form"), "collapse refused when an unrecognised use of the key remains");
assert(pv.includes("shared_office365_1: sss_o365_c → sss_o365_a"), "per-key rewrite shown");
assert(pv.includes("managed flow"), "managed flow caution");
assert(pv.includes("managed: remove it"), "managed reference kept, not deleted");
await page.screenshot({ path: resolve(TOOL, "scripts/.e2e-out/09-consolidate-preview.png") });
assert(!pv.includes("Flow Broken"), "broken flow not using selection is not listed");
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results" && document.querySelector("dialog").open, null, { timeout: 10000 });
const saved = await page.evaluate(() => window.__mock.saved);
assert(saved.length === 1 && saved[0].name.startsWith("connref-merge-backup-SSS_Dev"), "backup saved before apply");
const backup = JSON.parse(saved[0].content);
assert(backup.flows.map((f) => f.id).sort().join() === "f2,f3,f4,f7" && backup.flows.every((f) => f.clientdata.includes("sss_o365")), "backup holds original clientdata of every touched flow");
const writes = await page.evaluate(() => window.__mock.writes);
const f2 = writes.filter((w) => w.id === "f2").map((w) => Object.keys(w.rec).join(",") + (w.rec.statecode != null ? "=" + w.rec.statecode : ""));
assert(f2.join(" ") === "statecode,statuscode=0 clientdata statecode,statuscode=1", "active flow: off → clientdata → on (" + f2.join(" ") + ")");
const f3 = writes.filter((w) => w.id === "f3");
assert(f3.length === 1 && f3[0].rec.clientdata, "flow that is off: clientdata only");
const env = await page.evaluate(() => window.__mock.env);
const refsOf = (id) => Object.values(JSON.parse(env.flows.find((f) => f.workflowid === id).clientdata).properties.connectionReferences).map((v) => v.connection.connectionReferenceLogicalName);
assert(refsOf("f2").join() === "sss_o365_a" && refsOf("f3").join() === "sss_o365_a" && refsOf("f4").join() === "sss_o365_a", "flows now point to the kept reference");
{
  const d3 = JSON.stringify(JSON.parse(env.flows.find((f) => f.workflowid === "f3").clientdata).properties.definition);
  assert(!d3.includes("shared_office365_1") && d3.includes("['$connections']['shared_office365']") && d3.includes("parameters('$connections')['shared_office365']"), "f3: duplicate key collapsed, definition repointed");
  assert(refsOf("f7").join() === "sss_o365_a,sss_o365_a", "f7: unrecognised key use -> both keys kept, still rewritten");
}
assert(refsOf("f1").includes("sss_sql"), "other connector untouched");
const dels = writes.filter((w) => w.op === "delete").map((w) => w.id).sort();
assert(dels.join() === "r2,r3", "unmanaged sources deleted, managed kept (" + dels.join() + ")");
await page.click("#dlg-cancel");
await page.waitForFunction(() => document.querySelectorAll(".cons-groups .card").length === 4, null, { timeout: 10000 });
assert((await page.$eval(".cons-groups", (e) => e.textContent)).includes("sss_o365_m"), "managed ref still listed after merge");

// dependency blocks delete; activation failure reported as left off
await page.evaluate(() => { window.__mock.failActivate = 'f5'; window.__mock.writes = []; });
const dv = page.locator(".cons-groups .card", { hasText: "shared_commondataserviceforapps" });
const dvKeep = await dv.locator("tr.keep td.name .mono").textContent();
assert(dvKeep === "sss_dv_2", "dv: used reference suggested");
await dv.getByRole("button", { name: "Merge all into kept" }).click();
// flip: keep dv_1 instead, merge dv_2 (the one with a dependency) into it
await dv.getByLabel("Keep sss_dv_1").check();
await dv.getByLabel("Merge sss_dv_2").check();
await page.click("#btn-merge-preview");
await page.waitForSelector("dialog[open]");
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results" && document.querySelector("dialog").open, null, { timeout: 10000 });
const res = await page.textContent("#dlg-body");
assert(res.includes("left off") && res.includes("turning it back on failed"), "activation failure: reported, flow left off");
{
  const w = await page.evaluate(() => window.__mock.writes);
  assert(!w.some((x) => x.op === "delete"), "no delete when reference still has a dependent component");
  assert(/depends? on it/.test(res), "dependency reason shown");
}
await page.click("#dlg-cancel");

// restore from backup: recreates deleted refs, puts clientdata back
await page.evaluate((b) => { window.__mock.nextOpen = b; window.__mock.writes = []; window.__mock.failActivate = null; }, saved[0].content);
await page.getByRole("button", { name: "Restore from backup…" }).click();
await page.waitForSelector("dialog[open]");
const rp = await page.textContent("#dlg-body");
assert(rp.includes("Recreated first: sss_o365_b, sss_o365_c"), "restore recreates deleted references");
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results" && document.querySelector("dialog").open, null, { timeout: 10000 });
{
  const e2 = await page.evaluate(() => window.__mock.env);
  const r = (id) => Object.values(JSON.parse(e2.flows.find((f) => f.workflowid === id).clientdata).properties.connectionReferences).map((v) => v.connection.connectionReferenceLogicalName);
  assert(r("f2").join() === "sss_o365_b" && r("f3").join() === "sss_o365_a,sss_o365_c" && r("f7").join() === "sss_o365_a,sss_o365_b", "restore puts original references back (collapsed keys too)");
  assert(e2.crs.some((c) => c.connectionreferencelogicalname === "sss_o365_c"), "deleted reference recreated");
}
await page.click("#dlg-cancel");
await page.screenshot({ path: resolve(TOOL, "scripts/.e2e-out/10-consolidate.png") });

// unused cleanup: dv_2 (dependent), sss_unused, sss_canvas (dependent) are unused now
await page.waitForFunction(() => [...document.querySelectorAll(".cons-groups .card")].some((c) => c.querySelector("h3")?.textContent.startsWith("Unused") && c.textContent.includes("sss_unused")), null, { timeout: 10000 });
await page.evaluate(() => { window.__mock.writes = []; window.__mock.saved = []; });
await page.getByRole("button", { name: "Select all unmanaged" }).click();
await page.click("#btn-cleanup-preview");
await page.waitForSelector("dialog[open]");
{
  const pv = await page.textContent("#dlg-body");
  assert(pv.includes("sss_canvas") && pv.includes("2 other components depend on it"), "cleanup preview: dependents found before apply");
  assert(await page.textContent("#dlg-title") === "Preview delete", "cleanup dialog title");
}
await page.screenshot({ path: resolve(TOOL, "scripts/.e2e-out/11-cleanup-preview.png") });
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results" && document.querySelector("dialog").open, null, { timeout: 10000 });
{
  const w = await page.evaluate(() => window.__mock.writes);
  const saved2 = await page.evaluate(() => window.__mock.saved);
  assert(w.filter((x) => x.op === "delete").map((x) => x.id).join() === "r8", "cleanup deletes only the reference without dependents");
  assert(saved2.length === 1 && JSON.parse(saved2[0].content).connectionReferences.some((c) => c.logicalName === "sss_unused"), "cleanup backup holds the deleted reference");
}
await page.click("#dlg-cancel");

// ---- bind connection ids from a deploymentSettings.json ----
await page.click("#btn-consolidate"); // back to matrix
await page.waitForSelector("table.matrix");
await page.evaluate(() => {
  const f3 = window.__mock.env.flows.find((f) => f.workflowid === "f3");
  f3.statecode = 1; f3.statuscode = 2;
  window.__mock.writes = [];
  window.__mock.nextOpen = JSON.stringify({
    EnvironmentVariables: [],
    ConnectionReferences: [
      { LogicalName: "sss_o365_c", ConnectionId: "conn-new", ConnectorId: "/providers/Microsoft.PowerApps/apis/shared_office365" },
      { LogicalName: "sss_o365_a", ConnectionId: "conn-1", ConnectorId: "/providers/Microsoft.PowerApps/apis/shared_office365" },
      { LogicalName: "sss_sql", ConnectionId: "conn-x", ConnectorId: "/providers/Microsoft.PowerApps/apis/shared_teams" },
      { LogicalName: "sss_dv_2", ConnectionId: "", ConnectorId: "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps" },
    ],
  });
});
await page.click("#btn-load-snap");
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 2);
for (const n of ["sss_o365_c", "sss_o365_a", "sss_sql", "sss_dv_2"]) await page.check(`input[aria-label="Select ${n}"]`);
assert(!(await page.isHidden("#bulkbar")) && (await page.textContent("#btn-copy")) === "Preview bind…" && (await page.isVisible("#bind-restart")), "bind bar on connection references tab");
await page.selectOption("#copy-from", "settings:1");
await page.selectOption("#copy-to", "primary");
await page.click("#btn-copy");
await page.waitForSelector("dialog[open]");
{
  const pv = await page.textContent("#dlg-body");
  assert(pv.includes("1 binding from"), "bind preview: 1 binding");
  assert(pv.includes("binding an unbound reference") && pv.includes("conn-new"), "bind preview: unbound reference gets the file's id");
  assert(pv.includes("already bound to this connection"), "bind preview: same id skipped");
  assert(pv.includes("connector differs"), "bind preview: connector mismatch invalid");
  assert(pv.includes("source has no connection id"), "bind preview: empty id skipped");
  assert(pv.includes("Settings file"), "bind preview: settings-file note");
}
await page.screenshot({ path: resolve(TOOL, "scripts/.e2e-out/12-bind-preview.png") });
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results" && document.querySelector("dialog").open, null, { timeout: 10000 });
{
  const w = await page.evaluate(() => window.__mock.writes);
  const cr = w.filter((x) => x.entity === "connectionreference");
  assert(cr.length === 1 && cr[0].id === "new-sss_o365_c" && cr[0].rec.connectionid === "conn-new", "bind: connectionid written");
  const f3 = w.filter((x) => x.id === "f3").map((x) => x.rec.statecode);
  assert(f3.join() === "0,1", "bind: flow that is on and uses the rebound reference restarted (" + f3.join() + ")");
  assert(!w.some((x) => x.entity === "workflow" && x.id !== "f3"), "bind: no other flow touched");
}
await page.click("#dlg-cancel");
await page.click('#columns .colchip button[aria-label^="Remove"]');

// snapshot of another org: connection ids refused
await page.evaluate(() => {
  window.__mock.writes = [];
  window.__mock.nextOpen = JSON.stringify({ kind: "sss-envvar-matrix-snapshot", version: 1, environment: { name: "Other", url: "https://other.crm4.dynamics.com", environment: "Test" }, environmentVariables: [], connectionReferences: [{ logicalName: "sss_o365_c", connectorId: "/providers/Microsoft.PowerApps/apis/shared_office365", connectionId: "conn-other" }] });
});
await page.click("#btn-load-snap");
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 2);
if (await page.isHidden("#bulkbar")) await page.check('input[aria-label="Select sss_o365_c"]');
await page.selectOption("#copy-from", "snap:1");
await page.click("#btn-copy");
await page.waitForSelector("dialog[open]");
{
  const pv = await page.textContent("#dlg-body");
  assert(pv.includes("connection ids belong to one environment") && (await page.isHidden("#dlg-ok")), "bind from another org's snapshot refused");
}
await page.click("#dlg-cancel");
assert((await page.evaluate(() => window.__mock.writes.length)) === 0, "nothing written from another org");

// ---- pick connections through the Power Platform API ----
await page.click('#columns .colchip button[aria-label^="Remove"]');
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 1);
await page.evaluate(() => { window.__mock.writes = []; });
if (!(await page.isHidden("#bulkbar"))) await page.click("#btn-clear-sel");
await page.check('input[aria-label="Select sss_o365_c"]');
await page.check('input[aria-label="Select sss_sql"]');
assert(await page.isVisible("#btn-pick"), "Pick connections button on connection references tab");
await page.selectOption("#copy-to", "primary");
await page.click("#btn-pick");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Pick connections" && document.querySelector("dialog").open, null, { timeout: 10000 });
{
  const gets = await page.evaluate(() => window.__mock.pp.gets.map((g) => g.path));
  assert(gets[0] === "environments/env-guid-1/connections?api-version=2024-10-01" && gets[1].includes("skiptoken=1"), "connections listed with env id from RetrieveCurrentOrganization, next link followed: " + gets.join(" | "));
  const body = await page.textContent("#dlg-body");
  assert(body.includes("4 connections") && body.includes("1 connection has no readable connector"), "picker: count and unknown-connector note");
  const o365 = await page.$$eval('select[aria-label="Connection for sss_o365_c"] option', (os) => os.map((o) => o.value));
  const sql = await page.$$eval('select[aria-label="Connection for sss_sql"] option', (os) => os.map((o) => o.value));
  assert(o365.join() === ",conn-o-1,conn-o-2" && sql.join() === ",conn-sql-1", "picker: only same-connector connections offered");
  const cur = await page.$eval('select[aria-label="Connection for sss_sql"]', (s) => [...s.options].map((o) => o.textContent).join("|"));
  assert(cur.includes("SQL prod") && cur.includes("Connected"), "picker: label with display name and status");
}
await page.selectOption('select[aria-label="Connection for sss_o365_c"]', "conn-o-2");
await page.selectOption('select[aria-label="Connection for sss_sql"]', "conn-sql-1");
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Preview bind" && document.querySelector("dialog").open, null, { timeout: 10000 });
{
  const pv = await page.textContent("#dlg-body");
  assert(pv.includes("2 bindings from Picked connections") && pv.includes("picked from the Power Platform API"), "picker → bind preview");
  assert(pv.includes("reports an error status"), "picker: error-status connection cautioned");
}
await page.screenshot({ path: resolve(TOOL, "scripts/.e2e-out/13-picker-preview.png") });
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results" && document.querySelector("dialog").open, null, { timeout: 10000 });
{
  const cr = (await page.evaluate(() => window.__mock.writes)).filter((x) => x.entity === "connectionreference").map((x) => x.id + "=" + x.rec.connectionid).sort();
  assert(cr.join() === "new-sss_o365_c=conn-o-2,r5=conn-sql-1", "picker: picked connection ids written (" + cr.join() + ")");
}
await page.click("#dlg-cancel");

// API refuses: readable reason + fallback hint, nothing written
await page.evaluate(() => { window.__mock.pp.fail = "HTTP 403: Forbidden"; window.__mock.writes = []; });
await page.waitForFunction(() => !document.querySelector("#bulkbar").hidden, null, { timeout: 10000 }).catch(() => {});
if (await page.isHidden("#bulkbar")) await page.check('input[aria-label="Select sss_o365_c"]');
await page.click("#btn-pick");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Connections unavailable" && document.querySelector("dialog").open, null, { timeout: 10000 });
{
  const b = await page.textContent("#dlg-body");
  assert(b.includes("403") && b.includes("Connectivity.Connections.Read") && b.includes("deploymentSettings.json"), "picker 403: reason, permission and fallback shown");
}
await page.click("#dlg-cancel");

// older ToolBox without the API
await page.evaluate(() => { delete window.powerplatformAPI; });
await page.click("#btn-pick");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Connections unavailable" && document.querySelector("dialog").open, null, { timeout: 10000 });
assert((await page.textContent("#dlg-body")).includes("does not expose the Power Platform API"), "picker: missing API explained");
await page.click("#dlg-cancel");
assert((await page.evaluate(() => window.__mock.writes.filter((w) => w.op !== "execute").length)) === 0, "picker failures write nothing");

// ---- turn on flows that are off ----
await page.evaluate(() => { window.__mock.writes = []; window.__mock.failActivate = "f7"; });
await page.click("#btn-consolidate");
await page.waitForFunction(() => [...document.querySelectorAll(".cons-groups .card h3")].some((h) => h.textContent.startsWith("Flows that are off")), null, { timeout: 10000 });
{
  const card = page.locator(".cons-groups .card", { hasText: "Flows that are off" });
  const t = await card.textContent();
  assert(t.includes("Flows that are off · 4"), "off flows listed: " + t.slice(0, 40));
  assert(/Flow DV.*ready/.test(t) && /Flow Odd Key.*ready/.test(t), "flows with every reference bound are ready");
  assert(/Flow Ghost.*blocked.*missing reference.*sss_ghost/.test(t), "flow naming a missing reference is blocked");
  assert(/Flow Broken.*blocked.*clientdata does not parse/.test(t), "flow with unreadable clientdata is blocked");
  assert(await card.getByLabel("Turn on Flow Ghost").isDisabled(), "blocked flow cannot be selected");
  await card.getByRole("button", { name: "Select all ready" }).click();
}
await page.click("#btn-turnon-preview");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Turn on flows" && document.querySelector("dialog").open, null, { timeout: 10000 });
{
  const b = await page.textContent("#dlg-body");
  assert(b.includes("2 flows to turn on") && b.includes("start running on their triggers"), "turn-on preview warns about triggers");
}
await page.screenshot({ path: resolve(TOOL, "scripts/.e2e-out/14-turn-on.png") });
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results" && document.querySelector("dialog").open, null, { timeout: 10000 });
{
  const w = (await page.evaluate(() => window.__mock.writes)).filter((x) => x.entity === "workflow");
  assert(w.map((x) => x.id + ":" + x.rec.statecode).sort().join() === "f5:1,f7:1", "turn on: statecode 1 written for the ready flows only (" + w.map((x) => x.id).join() + ")");
  const r = await page.textContent("#dlg-body");
  assert(r.includes("Flow Odd Key") && r.includes("connection not bound"), "turn-on failure reported per flow");
}
await page.click("#dlg-cancel");
await page.waitForFunction(() => (document.querySelector(".cons-groups")?.textContent || "").includes("Flows that are off · 3"), null, { timeout: 10000 });
assert(true, "turned-on flow leaves the off list; the failed one stays");

// ---- bind backups, restore bindings, run log ----
{
  const backups = (await page.evaluate(() => window.__mock.saved)).filter((f) => f.name.startsWith("connref-bind-backup-"));
  assert(backups.length === 2, "every bind saved a backup first (" + backups.length + ")");
  const first = JSON.parse(backups[0].content);
  const second = JSON.parse(backups[1].content);
  assert(first.bindings.length === 1 && first.bindings[0].logicalName === "sss_o365_c" && first.bindings[0].connectionId === null, "settings bind backup: sss_o365_c was unbound");
  assert(second.bindings.map((b) => b.logicalName + "=" + b.connectionId).sort().join() === "sss_o365_c=conn-new,sss_sql=conn-9", "picker bind backup: previous bindings");

  // restore the picker bind
  await page.evaluate((b) => { window.__mock.writes = []; window.__mock.nextOpen = b; }, backups[1].content);
  await page.getByRole("button", { name: "Restore from backup…" }).click();
  await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Restore bindings" && document.querySelector("dialog").open, null, { timeout: 10000 });
  assert((await page.textContent("#dlg-body")).includes("2 bindings to put back"), "bind backup detected, restore previewed");
  await page.click("#dlg-ok");
  await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results" && document.querySelector("dialog").open, null, { timeout: 10000 });
  let cr = (await page.evaluate(() => window.__mock.writes)).filter((x) => x.entity === "connectionreference").map((x) => x.id + "=" + x.rec.connectionid).sort();
  assert(cr.join() === "new-sss_o365_c=conn-new,r5=conn-9", "previous connection ids written back (" + cr.join() + ")");
  await page.click("#dlg-cancel");

  // restore the first bind: back to unbound
  await page.waitForFunction(() => !document.querySelector("#status") || document.querySelector("#status").hidden);
  await page.evaluate((b) => { window.__mock.writes = []; window.__mock.nextOpen = b; }, backups[0].content);
  await page.getByRole("button", { name: "Restore from backup…" }).click();
  await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Restore bindings" && document.querySelector("dialog").open, null, { timeout: 10000 });
  assert((await page.textContent("#dlg-body")).includes("restore: unbind"), "restore to unbound previewed");
  await page.click("#dlg-ok");
  await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results" && document.querySelector("dialog").open, null, { timeout: 10000 });
  cr = (await page.evaluate(() => window.__mock.writes)).filter((x) => x.entity === "connectionreference");
  assert(cr.length === 1 && cr[0].id === "new-sss_o365_c" && cr[0].rec.connectionid === null, "unbound restored as connectionid null");
  await page.click("#dlg-cancel");
}

// a bind whose backup save is cancelled writes nothing
await page.click("#btn-consolidate");
await page.waitForSelector("table.matrix");
await page.evaluate(() => {
  window.__mock.writes = [];
  window.toolboxAPI.fileSystem.saveFile = async (name, content) => (name.startsWith("connref-bind-backup-") ? null : (window.__mock.saved.push({ name, content }), "/tmp/" + name));
  window.__mock.nextOpen = JSON.stringify({ EnvironmentVariables: [], ConnectionReferences: [{ LogicalName: "sss_o365_c", ConnectionId: "conn-z", ConnectorId: "/providers/Microsoft.PowerApps/apis/shared_office365" }] });
});
await page.click("#btn-load-snap");
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 2);
if (!(await page.isHidden("#bulkbar"))) await page.click("#btn-clear-sel");
await page.check('input[aria-label="Select sss_o365_c"]');
await page.selectOption("#copy-from", await page.$eval("#copy-from", (s) => [...s.options].find((o) => o.value.startsWith("settings:")).value));
await page.click("#btn-copy");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Preview bind" && document.querySelector("dialog").open, null, { timeout: 10000 });
assert((await page.textContent("#dlg-body")).includes("saved to a backup file first"), "bind preview mentions the backup");
await page.click("#dlg-ok");
await page.waitForTimeout(400);
assert((await page.evaluate(() => window.__mock.writes.filter((w) => w.entity === "connectionreference").length)) === 0, "backup not saved → nothing bound");
assert((await page.evaluate(() => window.__mock.notes.some((n) => /Backup not saved/.test(n.title)))), "backup-not-saved notice");
if (await page.$eval("dialog", (d) => d.open)) await page.click("#dlg-cancel");

// run log
{
  const label = await page.textContent("#btn-runlog");
  const n = Number((label.match(/\((\d+)\)/) || [])[1]);
  assert(n >= 10, "run log counts writes: " + label);
  await page.click("#btn-runlog");
  await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Run log" && document.querySelector("dialog").open, null, { timeout: 10000 });
  const body = await page.textContent("#dlg-body");
  for (const a of ["bind", "restart flow", "merge: update flow", "cleanup: delete reference", "add to solution", "turn on flow", "restore binding", "restore: flow clientdata"])
    assert(body.includes(a), "run log has '" + a + "'");
  assert(/failed/.test(body), "failed writes are logged too");
  await page.screenshot({ path: resolve(TOOL, "scripts/.e2e-out/15-runlog.png") });
  await page.evaluate(() => { window.toolboxAPI.fileSystem.saveFile = async (name, content) => { window.__mock.saved.push({ name, content }); return "/tmp/" + name; }; });
  await page.getByRole("button", { name: "Export CSV" }).click();
  await page.getByRole("button", { name: "Export JSON" }).click();
  await page.waitForTimeout(300);
  const saved = await page.evaluate(() => window.__mock.saved);
  const csv = saved.find((f) => /envvar-matrix-runlog-.*\.csv$/.test(f.name));
  const json = saved.find((f) => /envvar-matrix-runlog-.*\.json$/.test(f.name));
  assert(csv && csv.content.startsWith("at,action,environment,url,item,detail,result,error") && csv.content.split("\n").length - 2 === n, "run log CSV export");
  assert(json && JSON.parse(json.content).entries.length === n, "run log JSON export");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("sss-envvar-matrix-runlog") || "[]").length);
  assert(stored === n, "run log mirrored to localStorage (" + stored + ")");
  await page.click("#dlg-cancel");
}

await finish();

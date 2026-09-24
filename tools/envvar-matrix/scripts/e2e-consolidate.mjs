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
const cards = await page.$$eval(".cons-groups .card", (els) => els.map((e) => e.querySelector("h3").textContent).filter((t) => !/^(Unused|Solution)/.test(t)));
assert(cards.length === 2 && cards.some((c) => c.startsWith("shared_office365 · 4")) && cards.some((c) => c.startsWith("shared_commondataserviceforapps · 2")), "groups per connector, sql singleton excluded: " + cards.join(" | "));
{
  const unusedCard = await page.textContent(".cons-groups .card:last-child");
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
await page.waitForFunction(() => document.querySelectorAll(".cons-groups .card").length === 3, null, { timeout: 10000 });
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
await page.waitForFunction(() => (document.querySelector(".cons-groups .card:last-child")?.textContent || "").includes("sss_unused"), null, { timeout: 10000 });
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

await finish();

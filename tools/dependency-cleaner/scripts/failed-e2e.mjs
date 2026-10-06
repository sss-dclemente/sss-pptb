// E2E for the Failed import tab on the dist build with a mocked PPTB host.
// Test (secondary): SssCore 1.1 failed to upgrade with "The connectionreference(<CR1>) component cannot be deleted
// because it is referenced by … other components". Four components reference the connection reference sss_SharePointOld:
// - Notify (cloud flow, unmanaged only, on) → re-point to sss_SharePointNew (same connector);
// - Sync (cloud flow, Active layer over SssCore) → Remove active customizations;
// - Archive (cloud flow, SssCore layer on top) → fix in Dev, with a button to Upgrade blockers (Dev has SssCore);
// - Orders (canvas app in managed SssApps) → release SssApps first.
// Run: npm run build && node scripts/failed-e2e.mjs
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = resolve(new URL("..", import.meta.url).pathname);

const MOCK = `
(() => {
  const g = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
  const CR1 = '3a70b68f-cbb4-41dd-9d32-111f430fee50';
  const ID = { CR1, CR2: g(2), CR3: g(3), FL1: g(11), FL2: g(12), FL3: g(13), CA: g(21), devCore: g(31), tCore: g(41), tApps: g(42), pub: g(51), H1: g(61), H2: g(62) };
  const CRT = 10050;
  const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
  const cd = (name) => JSON.stringify({ properties: { connectionReferences: { shared_sharepointonline: { api: { name: 'shared_sharepointonline' }, connection: { connectionReferenceLogicalName: name }, runtimeSource: 'embedded' } }, definition: { actions: {} } }, schemaVersion: '1.0.0.0' });
  const MSG = (id) => 'ImportAsHolding failed with exception :The connectionreference(' + id + ') component cannot be deleted because it is referenced by 4 other components. For a list of referenced components, use the RetrieveDependenciesForDeleteRequest.';
  const M = window.__mock = { ID, queries: [], executes: [], updates: [], saved: [], notes: [], nextText: null, listeners: [], historyNoFilter: false };
  const T = M.T = {
    connrefs: {
      [CR1]: { connectionreferenceid: CR1, connectionreferencelogicalname: 'sss_SharePointOld', connectionreferencedisplayname: 'SharePoint Old', connectorid: SP },
      [ID.CR2]: { connectionreferenceid: ID.CR2, connectionreferencelogicalname: 'sss_SharePointNew', connectionreferencedisplayname: 'SharePoint New', connectorid: SP },
      [ID.CR3]: { connectionreferenceid: ID.CR3, connectionreferencelogicalname: 'sss_Outlook', connectionreferencedisplayname: 'Outlook', connectorid: '/providers/Microsoft.PowerApps/apis/shared_office365' },
    },
    flows: {
      [ID.FL1]: { workflowid: ID.FL1, name: 'Notify', category: 5, statecode: 1, clientdata: cd('sss_SharePointOld') },
      [ID.FL2]: { workflowid: ID.FL2, name: 'Sync', category: 5, statecode: 0, clientdata: cd('sss_SharePointOld') },
      [ID.FL3]: { workflowid: ID.FL3, name: 'Archive', category: 5, statecode: 1, clientdata: cd('sss_SharePointOld') },
    },
    layers: { [ID.FL1]: [['Active', 1]], [ID.FL2]: [['Active', 2], ['SssCore', 1]], [ID.FL3]: [['SssCore', 1]], [ID.CA]: [['SssApps', 1]] },
  };
  const usesOld = (id) => T.flows[id].clientdata.includes('sss_SharePointOld') && (id !== ID.FL2 || T.layers[ID.FL2][0][0] === 'Active');
  const dependents = () => [
    ...[ID.FL1, ID.FL2, ID.FL3].filter(usesOld).map((id) => ({ dependentcomponentobjectid: id, dependentcomponenttype: 29 })),
    { dependentcomponentobjectid: ID.CA, dependentcomponenttype: 300 },
  ];
  const history = [
    { msdyn_solutionhistoryid: ID.H1, msdyn_name: 'SssCore', msdyn_solutionversion: '1.1.0.0', msdyn_starttime: '2026-10-06T08:34:00Z', msdyn_result: false, msdyn_operation: 0, msdyn_exceptionmessage: MSG(CR1) },
    { msdyn_solutionhistoryid: ID.H2, msdyn_name: 'SssApps', msdyn_solutionversion: '2.0.0.0', msdyn_starttime: '2026-10-05T10:00:00Z', msdyn_result: true, msdyn_operation: 0, msdyn_exceptionmessage: '' },
  ];
  const envs = {
    primary: {
      conn: { id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' },
      solutions: [{ solutionid: ID.devCore, uniquename: 'SssCore', friendlyname: 'SSS Core', version: '1.1.0.0', ismanaged: false, _publisherid_value: ID.pub }],
    },
    secondary: {
      conn: { id: 'c2', name: 'SSS Prod', url: 'https://sss-prod.crm4.dynamics.com', environment: 'Production', environmentColor: '#b91c1c' },
      solutions: [
        { solutionid: ID.tCore, uniquename: 'SssCore', friendlyname: 'SSS Core', version: '1.0.0.0', ismanaged: true, _publisherid_value: ID.pub },
        { solutionid: ID.tApps, uniquename: 'SssApps', friendlyname: 'SSS Apps', version: '2.0.0.0', ismanaged: true, _publisherid_value: ID.pub },
      ],
    },
  };
  const idsIn = (q, field) => [...q.matchAll(new RegExp(field + ' eq ([0-9a-f-]{36})', 'g'))].map((m) => m[1]);
  const sel = (q) => (q.match(/[$]select=([^&]+)/)?.[1] ?? '').split(',');
  const project = (o, q) => Object.fromEntries(sel(q).filter((k) => k in o).map((k) => [k, o[k]]));

  function answer(q, target) {
    let m;
    if (target === 'primary') return { value: [] };
    if (q.startsWith('msdyn_solutionhistories?')) {
      if (M.historyNoFilter && q.includes('$filter')) throw new Error('mock: virtual table refuses $filter');
      const rows = q.includes('msdyn_result eq false') ? history.filter((r) => !r.msdyn_result) : history;
      return { value: rows.map((r) => project(r, q)) };
    }
    if (q.startsWith('solutioncomponentdefinitions?')) return { value: [{ solutioncomponenttype: CRT, name: 'connectionreference', primaryentityname: 'connectionreference' }] };
    if ((m = q.match(/^RetrieveDependenciesForDelete[(]ObjectId=([^,]+),ComponentType=(\\d+)[)]$/))) {
      if (m[1] !== CR1 || Number(m[2]) !== CRT) throw new Error('mock: unexpected RetrieveDependenciesForDelete ' + q);
      return { EntityCollection: dependents() };
    }
    if ((m = q.match(/^RemoveActiveCustomizations[(]SolutionComponentName='([A-Za-z]+)',ComponentId=([0-9a-f-]{36})[)]$/))) {
      if (m[1] !== 'Workflow' || m[2] !== ID.FL2) throw new Error('mock: bad RemoveActiveCustomizations ' + q);
      T.layers[ID.FL2] = [['SssCore', 1]];
      T.flows[ID.FL2].clientdata = cd('sss_SharePointNew'); // the managed definition takes over
      return {};
    }
    if (q.startsWith('msdyn_componentlayers?')) {
      const id = q.match(/msdyn_componentid eq '([0-9a-f-]{36})'/)?.[1];
      const name = q.match(/msdyn_solutioncomponentname eq '([A-Za-z]+)'/)?.[1];
      if (!id || !name) throw new Error('mock: bad layer filter ' + q);
      if (name !== (id === ID.CA ? 'CanvasApp' : 'Workflow')) return { value: [] };
      return { value: (T.layers[id] ?? []).map(([s, o]) => ({ msdyn_solutionname: s, msdyn_order: o, msdyn_componentjson: s === 'Active' ? '{"Attributes":[{"Key":"clientdata","Value":"active"}]}' : '{}' })) };
    }
    if (q.startsWith('connectionreferences?')) {
      const by = q.match(/connectorid eq '([^']+)'/)?.[1];
      const rows = by ? Object.values(T.connrefs).filter((c) => c.connectorid === by) : idsIn(q, 'connectionreferenceid').map((id) => T.connrefs[id]).filter(Boolean);
      return { value: rows.map((r) => project(r, q)) };
    }
    if (q.startsWith('workflows?')) return { value: idsIn(q, 'workflowid').map((id) => T.flows[id]).filter(Boolean).map((r) => project(r, q)) };
    if (q.startsWith('canvasapps?')) return { value: idsIn(q, 'canvasappid').filter((id) => id === ID.CA).map(() => project({ canvasappid: ID.CA, name: 'sss_orders_a1b2c', displayname: 'Orders', canvasapptype: 0 }, q)) };
    if (q.startsWith('solutioncomponents?') && q.includes('objectid eq')) {
      const out = [];
      for (const id of idsIn(q, 'objectid')) if (id === CR1) out.push({ objectid: id, componenttype: CRT, _solutionid_value: ID.tCore });
      return { value: out };
    }
    if (q.startsWith('solutions?')) return { value: idsIn(q, 'solutionid').map((id) => envs.secondary.solutions.find((s) => s.solutionid === id)).filter(Boolean) };
    throw new Error('mock: unexpected query (' + target + ') ' + q);
  }

  window.toolboxAPI = {
    connections: { getActiveConnection: async () => envs.primary.conn, getSecondaryConnection: async () => envs.secondary.conn },
    utils: { getCurrentTheme: async () => 'light', showNotification: async (o) => { M.notes.push(o); } },
    events: { on(cb) { M.listeners.push(cb); } },
    fileSystem: {
      saveFile: async (name, content) => { M.saved.push({ name, content }); return '/tmp/' + name; },
      selectPath: async () => (M.nextText != null ? '/tmp/backup.json' : null),
      readText: async () => { const t = M.nextText; M.nextText = null; return t; },
      readBinary: async () => null,
    },
  };
  window.dataverseAPI = {
    getSolutions: async (cols, target = 'primary') => ({ value: envs[target].solutions.map((s) => ({ ...s })) }),
    getAllEntitiesMetadata: async (props, target = 'primary') => ({ value: target === 'secondary' ? [{ LogicalName: 'connectionreference', MetadataId: g(99), EntitySetName: 'connectionreferences', PrimaryIdAttribute: 'connectionreferenceid', PrimaryNameAttribute: 'connectionreferencedisplayname', IsCustomEntity: false }] : [] }),
    getEntityRelatedMetadata: async () => ({ value: [] }),
    queryData: async (q, target = 'primary') => {
      M.queries.push({ q, target });
      await new Promise((r) => setTimeout(r, 3));
      return answer(q, target);
    },
    execute: async (req, target = 'primary') => {
      M.executes.push({ ...JSON.parse(JSON.stringify(req)), target });
      if (req.operationName === 'RetrieveCurrentOrganization') return { Detail: { EnvironmentId: 'env' } };
      throw new Error('mock: unexpected execute ' + req.operationName);
    },
    update: async (entity, id, rec, target = 'primary') => {
      M.updates.push({ entity, id, rec: { ...rec }, target });
      if (target !== 'secondary' || entity !== 'workflow' || !T.flows[id]) throw new Error('mock: unexpected update ' + entity + ' ' + id + ' on ' + target);
      Object.assign(T.flows[id], rec);
    },
  };
})();
`;

const { page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto("file://" + TOOL + "/dist/index.html");
const M = (fn, arg) => page.evaluate(fn, arg);
// the last confirmation before a write names the environment, the scope and the way back
const okWrite = async (env, url, scope, wayBack = /backup/i) => {
  await page.waitForSelector("#dlg[open] #dlg-write");
  const t = await page.textContent("#dlg-write");
  assert(t.includes(env) && t.includes(url) && t.includes(scope) && wayBack.test(t), "write confirmation names environment, scope and way back: " + t);
  await page.click("#dlg-ok");
};
const ID = await M(() => window.__mock.ID);

await page.click('.tab[data-tab="failed"]');
await page.waitForFunction(() => !document.querySelector("#fi-scan").disabled);
const envOpts = await page.$$eval("#fi-env option", (els) => els.map((e) => `${e.value}:${e.textContent}`));
assert(envOpts[0] === "secondary:SSS Prod (target)" && envOpts[1] === "primary:SSS Dev (primary)", "environment picker: target first, then primary: " + envOpts.join(" | "));

// ---- scan → newest failed run is checked ----
await page.click("#fi-scan");
await page.waitForSelector("#fi-counts", { timeout: 15000 });
const runs = await page.$$eval(".fi-run", (els) => els.map((e) => e.textContent));
assert(runs.length === 1 && runs[0].includes("SssCore 1.1.0.0") && runs[0].includes("connectionreference 3a70b68f"), "solution history: one failed run with a delete blocker (the successful one is left out): " + runs.join(" | "));
const counts = await page.textContent("#fi-counts");
assert(counts.includes("SssCore · SSS Prod") && counts.includes("1 component") && counts.includes("4 references"), "counts: 1 component, 4 references: " + counts);
const comps = await page.textContent("#fi-components");
assert(comps.includes("Connection reference SharePoint Old") && comps.includes("4 still reference it"), "the connection reference is named by its display name (per-org type via solutioncomponentdefinitions): " + comps);
let q = await M(() => window.__mock.queries);
assert(q.some((x) => x.target === "secondary" && x.q === `RetrieveDependenciesForDelete(ObjectId=${ID.CR1},ComponentType=10050)`), "RetrieveDependenciesForDelete on the target with the per-org connection reference type, unquoted guid");

const tgt = await page.textContent("#fi-target");
assert(tgt.includes("Notify") && tgt.includes("Sync") && tgt.includes("Unmanaged customization in SSS Prod on top of SssCore") && tgt.includes("Unmanaged process in SSS Prod"), "target section: Notify (unmanaged only) and Sync (Active over SssCore): " + tgt.slice(0, 300));
const optsOf = (name) => page.$$eval(`#fi-target .finding`, (els, n) => { const e = els.find((x) => x.querySelector(".head").textContent.includes(n)); return e ? [...e.querySelectorAll("select option")].map((o) => o.value) : null; }, name);
const notifyOpts = await optsOf("Notify");
const syncOpts = await optsOf("Sync");
assert(JSON.stringify(notifyOpts) === `["","repoint:${ID.CR2}"]`, "Notify: re-point to the other SharePoint connection reference only (not Outlook), no remove-active: " + JSON.stringify(notifyOpts));
assert(JSON.stringify(syncOpts) === `["","remove-active","repoint:${ID.CR2}"]`, "Sync: remove active customizations or re-point: " + JSON.stringify(syncOpts));
const dev = await page.textContent("#fi-dev");
assert(dev.includes("Archive") && dev.includes("SssCore's own process still references SharePoint Old") && (await page.isVisible("#fi-preflight")), "dev section: Archive (SssCore layer) with Run Upgrade blockers: " + dev.slice(0, 200));
const rel = await page.textContent("#fi-release");
assert(rel.includes("Orders") && rel.includes("SssApps references it") && (await page.textContent("#fi-order")).includes("SssApps → SssCore"), "release section: canvas app Orders in SssApps, release order SssApps → SssCore");

// ---- fix: re-point Notify, remove the Active layer of Sync ----
const keyOf = (name) => page.$$eval("#fi-target .finding", (els, n) => els.find((x) => x.querySelector(".head").textContent.includes(n)).dataset.key, name);
await page.selectOption(`#fi-target .finding[data-key="${await keyOf("Notify")}"] select`, `repoint:${ID.CR2}`);
await page.selectOption(`#fi-target .finding[data-key="${await keyOf("Sync")}"] select`, "remove-active");
await page.click("#fi-preview");
await page.waitForSelector("#fi-ops li");
const ops = await page.$$eval("#fi-ops li", (els) => els.map((e) => e.textContent));
assert(ops.length === 2 && ops[0].startsWith("Update flow Notify: sss_SharePointOld → sss_SharePointNew (off, update, on)") && ops[1].startsWith("RemoveActiveCustomizations Workflow Sync"), "preview: flow update, then remove active customizations: " + ops.join(" | "));
assert((await page.textContent("#fi-plan")).includes("looks like Production"), "Production banner for the target");
assert(await page.isVisible("#fi-irrev-wrap") && (await page.isVisible("#fi-prod-ack-wrap")), "irreversible and Production acknowledgements shown");
await page.click("#fi-backup");
await page.waitForFunction(() => document.querySelector("#fi-backup").textContent.includes("✓"));
assert(await page.$eval("#fi-confirm", (b) => b.disabled), "Confirm still disabled until both acknowledgements are ticked");
await page.check("#fi-irrev");
assert(await page.$eval("#fi-confirm", (b) => b.disabled), "…and the Production one");
await page.check("#fi-prod-ack");
assert(!(await page.$eval("#fi-confirm", (b) => b.disabled)), "Confirm enabled: backup + both acknowledgements");
let saved = await M(() => window.__mock.saved);
const backup = saved.at(-1);
const bk = JSON.parse(backup.content);
assert(bk.kind === "sss-dependency-cleaner-failed-import-backup" && bk.flows.length === 1 && bk.flows[0].id === ID.FL1 && bk.flows[0].clientdata.includes("sss_SharePointOld") && bk.activeLayers[0].id === ID.FL2 && bk.activeLayers[0].json.includes("clientdata"), "backup: Notify's clientdata before, Sync's Active layer JSON");

await page.click("#fi-confirm");
await okWrite("SSS Prod", "https://sss-prod.crm4.dynamics.com", "2 operations written to this environment: 1 active customization removed (RemoveActiveCustomizations), 1 cloud flow re-pointed", /cannot be undone, by this tool or by the platform[\s\S]*Undo flow changes/);
await page.waitForSelector("#fi-rerun", { timeout: 15000 });
const upd = await M(() => window.__mock.updates);
const fl1 = upd.filter((u) => u.id === ID.FL1);
assert(fl1.length === 3 && fl1[0].rec.statecode === 0 && fl1[1].rec.clientdata.includes("sss_SharePointNew") && !fl1[1].rec.clientdata.includes("sss_SharePointOld") && fl1[2].rec.statecode === 1 && fl1.every((u) => u.target === "secondary"), "Notify: off → clientdata re-pointed → on, on the target");
q = await M(() => window.__mock.queries);
assert(q.some((x) => x.target === "secondary" && x.q === `RemoveActiveCustomizations(SolutionComponentName='Workflow',ComponentId=${ID.FL2})`), "RemoveActiveCustomizations via queryData on the target, unquoted guid");
assert((await page.textContent("#fi-rerun")).includes("4 → 2 references"), "checked again: 4 → 2 references: " + (await page.textContent("#fi-rerun")));
assert(!(await page.$("#fi-target")), "target section gone after the fixes");

// ---- undo the flow re-point from the backup ----
await M((t) => { window.__mock.nextText = t; }, backup.content);
await page.click("#fi-undo");
await okWrite("SSS Prod", "https://sss-prod.crm4.dynamics.com", "Write back the clientdata of 1 flow from the backup", /cannot be put back[\s\S]*No new backup/);
await page.waitForFunction(() => window.__mock.notes.some((n) => n.title === "Undone"));
assert(await M(() => window.__mock.T.flows[window.__mock.ID.FL1].clientdata.includes("sss_SharePointOld")), "undo wrote Notify's clientdata back");

// ---- paste the raw error (fault XML repeats the message) ----
await page.click("#fi-paste-wrap > summary");
const raw = `Failure details
ImportAsHolding failed with exception :The connectionreference(${ID.CR1}) component cannot be deleted because it is referenced by 1 other components. For a list of referenced components, use the RetrieveDependenciesForDeleteRequest.
Detail: <Message>ImportAsHolding failed with exception :The connectionreference(${ID.CR1}) component cannot be deleted because it is referenced by 1 other components.</Message> <Message>The connectionreference(${ID.CR1}) component cannot be deleted because it is referenced by 1 other components.</Message>`;
await page.fill("#fi-paste", raw);
await page.fill("#fi-solution", "SssCore");
await page.evaluate(() => document.querySelector("#fi-counts")?.remove());
await page.click("#fi-check-paste");
await page.waitForSelector("#fi-counts", { timeout: 15000 });
assert((await page.$$eval("#fi-components li", (els) => els.length)) === 1, "pasted error: the repeated message is one component");
assert(!!(await page.$("#fi-target")) && (await page.textContent("#fi-target")).includes("Notify"), "pasted error: Notify references it again after the undo");

// ---- history fallback: $filter refused on the virtual table ----
await M(() => { window.__mock.historyNoFilter = true; });
await page.evaluate(() => { document.querySelector("#fi-runs").replaceChildren(); document.querySelector("#fi-counts")?.remove(); });
await page.click("#fi-scan");
await page.waitForSelector("#fi-counts", { timeout: 15000 });
assert((await page.$$eval(".fi-run", (els) => els.length)) === 1, "history fallback: the failed run is found");
q = await M(() => window.__mock.queries);
assert(q.filter((x) => x.q.startsWith("msdyn_solutionhistories?")).at(-1).q.includes("$filter") === false, "solution history read unfiltered when $filter is refused, filtered client side");

// ---- markdown export ----
await page.click("#fi-export-md");
saved = await M(() => window.__mock.saved);
const md = saved.find((s) => s.name.endsWith(".md"));
assert(md && md.content.includes("# Failed import: SssCore in SSS Prod") && md.content.includes("- [ ] Process Notify → Connection reference SharePoint Old"), "Markdown export: checklist");

// ---- Run Upgrade blockers hands over to the other tab ----
await page.click("#fi-preflight");
assert(await page.isVisible("#tab-upgrade"), "Run Upgrade blockers opens the Upgrade blockers tab");
assert((await page.$eval("#ub-solution", (s) => s.selectedOptions[0]?.textContent ?? "")).includes("SssCore"), "…on SssCore");

await finish();

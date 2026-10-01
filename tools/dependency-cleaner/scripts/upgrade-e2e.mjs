// E2E for the Upgrade blockers tab (docs/UPGRADE-BLOCKERS-PLAN.md) on the dist build with a mocked PPTB host.
// Dev (primary): unmanaged SssCore 1.1 — table sss_order with all assets, forms F1 and F2, model-driven app Sales Hub
// (other id than in Test) that still lists the custom page Orders, which left the solution.
// Test (secondary): managed SssCore 1.0 + SssApps. The upgrade removes columns sss_oldfield / sss_gone / sss_shared,
// the pages Orders and Legacy, and a web resource. Expected: Sales Hub → Orders is a Dev blocker (fixable),
// Ops Hub → Legacy is "release SssApps first" (layers unavailable → membership fallback), F1 → sss_oldfield is a
// target unmanaged-layer blocker, F2 → sss_gone is resolved by the new version, sss_shared survives (SssApps holds it),
// sss_keep stays (all assets in Dev), JS + site map references are runtime breaks.
// Run: npm run build && node scripts/upgrade-e2e.mjs
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = resolve(new URL("..", import.meta.url).pathname);

const MOCK = `
(() => {
  const g = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
  const ID = {
    devCore: g(1), devDefault: g(6), tCore: g(21), tApps: g(22), tSystem: g(23), tDefault: g(24), pub: g(11),
    E1: g(101), C1: g(201), C2: g(202), C3: g(203), C4: g(204), F1: g(301), F2: g(302),
    P1d: g(401), P1t: g(402), P2: g(403), APP1d: g(501), APP1t: g(502), APP2: g(503), D1: g(601), WRJS: g(602), SM: g(701),
  };
  let seq = 5000;
  const row = (objectid, componenttype, behavior, root) => ({ solutioncomponentid: g(seq++), objectid, componenttype, rootcomponentbehavior: behavior, _rootsolutioncomponentid_value: root });
  // Dev SssCore: table with all assets + explicit form rows + the app
  const dE1 = row(ID.E1, 1, 0, null);
  const devMembers = [dE1, row(ID.F1, 60, null, dE1.solutioncomponentid), row(ID.F2, 60, null, dE1.solutioncomponentid), row(ID.APP1d, 80, null, null)];
  // Test SssCore 1.0
  const tE1 = row(ID.E1, 1, 0, null);
  const under = (id, t) => row(id, t, null, tE1.solutioncomponentid);
  const tMembers = [tE1, under(ID.C1, 2), under(ID.C2, 2), under(ID.C3, 2), under(ID.C4, 2), under(ID.F1, 60), under(ID.F2, 60), row(ID.P1t, 300, null, null), row(ID.P2, 300, null, null), row(ID.APP1t, 80, null, null), row(ID.D1, 61, null, null)];
  const B64 = (s) => btoa(s);
  const M = window.__mock = { ID, queries: [], executes: [], saved: [], notes: [], nextText: null, listeners: [], devAppHasPage: true };
  const envs = {
    primary: {
      conn: { id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' },
      solutions: [
        { solutionid: ID.devCore, uniquename: 'SssCore', friendlyname: 'SSS Core', version: '1.1.0.0', ismanaged: false, _publisherid_value: ID.pub },
        { solutionid: ID.devDefault, uniquename: 'Default', friendlyname: 'Default Solution', version: '1.0', ismanaged: false, _publisherid_value: ID.pub },
      ],
      members: { [ID.devCore]: devMembers },
      // every component that exists in Dev (Default has them all)
      holders: { [ID.E1]: [ID.devCore, ID.devDefault], [ID.F1]: [ID.devCore, ID.devDefault], [ID.F2]: [ID.devCore, ID.devDefault], [ID.APP1d]: [ID.devCore, ID.devDefault], [ID.P1d]: [ID.devDefault], [ID.C4]: [ID.devDefault] },
      entities: [{ LogicalName: 'sss_order', MetadataId: ID.E1, PrimaryNameAttribute: 'sss_name', IsCustomEntity: true }],
      attrs: { sss_order: [{ LogicalName: 'sss_keep', MetadataId: ID.C4, RequiredLevel: { Value: 'None' }, IsCustomAttribute: true }] },
      canvas: { [ID.P1d]: { canvasappid: ID.P1d, name: 'sss_pageorders_a1b2c', displayname: 'Orders', canvasapptype: 2 } },
      apps: { [ID.APP1d]: { appmoduleid: ID.APP1d, uniquename: 'sss_SalesHub', name: 'Sales Hub' } },
      forms: { [ID.F1]: { formid: ID.F1, name: 'Order Main', objecttypecode: 'sss_order' }, [ID.F2]: { formid: ID.F2, name: 'Order Quick', objecttypecode: 'sss_order' } },
    },
    secondary: {
      conn: { id: 'c2', name: 'SSS Test', url: 'https://sss-test.crm4.dynamics.com', environment: 'Test', environmentColor: '#92400e' },
      solutions: [
        { solutionid: ID.tCore, uniquename: 'SssCore', friendlyname: 'SSS Core', version: '1.0.0.0', ismanaged: true, _publisherid_value: ID.pub },
        { solutionid: ID.tApps, uniquename: 'SssApps', friendlyname: 'SSS Apps', version: '2.0.0.0', ismanaged: true, _publisherid_value: ID.pub },
        { solutionid: ID.tSystem, uniquename: 'System', friendlyname: 'System', version: '9.2', ismanaged: true, _publisherid_value: ID.pub },
        { solutionid: ID.tDefault, uniquename: 'Default', friendlyname: 'Default Solution', version: '1.0', ismanaged: false, _publisherid_value: ID.pub },
      ],
      members: { [ID.tCore]: tMembers },
      holders: Object.fromEntries([
        ...tMembers.map((r) => [r.objectid, [ID.tCore, ID.tDefault]]),
        [ID.C2, [ID.tCore, ID.tApps, ID.tDefault]],
        [ID.APP2, [ID.tApps, ID.tDefault]],
      ]),
      entities: [{ LogicalName: 'sss_order', MetadataId: ID.E1, PrimaryNameAttribute: 'sss_name', IsCustomEntity: true }],
      attrs: { sss_order: [
        { LogicalName: 'sss_oldfield', MetadataId: ID.C1, RequiredLevel: { Value: 'None' }, IsCustomAttribute: true },
        { LogicalName: 'sss_shared', MetadataId: ID.C2, RequiredLevel: { Value: 'None' }, IsCustomAttribute: true },
        { LogicalName: 'sss_gone', MetadataId: ID.C3, RequiredLevel: { Value: 'None' }, IsCustomAttribute: true },
        { LogicalName: 'sss_keep', MetadataId: ID.C4, RequiredLevel: { Value: 'None' }, IsCustomAttribute: true },
      ] },
      canvas: {
        [ID.P1t]: { canvasappid: ID.P1t, name: 'sss_pageorders_a1b2c', displayname: 'Orders', canvasapptype: 2 },
        [ID.P2]: { canvasappid: ID.P2, name: 'sss_pagelegacy_x9y8z', displayname: 'Legacy', canvasapptype: 2 },
      },
      apps: { [ID.APP1t]: { appmoduleid: ID.APP1t, uniquename: 'sss_SalesHub', name: 'Sales Hub' }, [ID.APP2]: { appmoduleid: ID.APP2, uniquename: 'sss_Ops', name: 'Ops Hub' } },
      forms: { [ID.F1]: { formid: ID.F1, name: 'Order Main', objecttypecode: 'sss_order' }, [ID.F2]: { formid: ID.F2, name: 'Order Quick', objecttypecode: 'sss_order' } },
      webresources: {
        [ID.D1]: { webresourceid: ID.D1, name: 'sss_/img/old.png' },
        [ID.WRJS]: { webresourceid: ID.WRJS, name: 'sss_/js/nav.js', content: B64("Xrm.Navigation.navigateTo({ pageType: 'custom', name: 'sss_pageorders_a1b2c' });") },
      },
      sitemaps: [{ sitemapid: ID.SM, sitemapname: 'Ops Hub', sitemapxml: '<SiteMap><Area Id="a"><Group Id="g"><SubArea Id="s" Type="PageType" Url="/main.aspx?pagetype=custom&amp;name=sss_pagelegacy_x9y8z" /></Group></Area></SiteMap>' }],
      // RetrieveDependenciesForDelete
      dependents: {
        [ID.C1]: [[ID.F1, 60, ID.E1]],
        [ID.C3]: [[ID.F2, 60, ID.E1]],
        [ID.P1t]: [[ID.APP1t, 80, null]],
        [ID.P2]: [[ID.APP2, 80, null]],
      },
      layers: {
        [ID.F1]: [['Active', 2], ['SssCore', 1]],
        [ID.F2]: [['SssCore', 1]],
        [ID.APP1t]: [['SssCore', 1]],
      },
    },
  };
  const idsIn = (q, field) => [...q.matchAll(new RegExp(field + ' eq ([0-9a-f-]{36})', 'g'))].map((m) => m[1]);
  const isGuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
  const sel = (q) => (q.match(/[$]select=([^&]+)/)?.[1] ?? '').split(',');
  const project = (o, q) => Object.fromEntries(sel(q).filter((k) => k in o).map((k) => [k, o[k]]));

  function answer(q, target) {
    const E = envs[target];
    let m;
    if ((m = q.match(/^RetrieveDependenciesForDelete[(]ObjectId=([^,]+),ComponentType=(\\d+)[)]$/))) {
      if (target !== 'secondary') throw new Error('mock: RetrieveDependenciesForDelete must run on the target');
      if (!isGuid(m[1])) throw new Error('mock: ObjectId must be an unquoted guid, got ' + m[1]);
      return { EntityCollection: (E.dependents[m[1]] ?? []).map(([id, t, p]) => ({ dependentcomponentobjectid: id, dependentcomponenttype: t, dependentcomponentparentid: p, dependencytype: 2 })) };
    }
    if ((m = q.match(/^RetrieveRequiredComponents[(]ObjectId=([^,]+),ComponentType=(\\d+)[)]$/))) {
      if (target !== 'primary') throw new Error('mock: RetrieveRequiredComponents expected on Dev');
      const out = [];
      if (m[1] === ID.APP1d && M.devAppHasPage) out.push({ requiredcomponentobjectid: ID.P1d, requiredcomponenttype: 300 });
      if (m[1] === ID.F2 || m[1] === ID.F1) out.push({ requiredcomponentobjectid: ID.E1, requiredcomponenttype: 1 });
      return { EntityCollection: out };
    }
    if (q.startsWith('publishers?')) return { value: [{ publisherid: ID.pub, uniquename: 'sss', customizationprefix: 'sss' }] };
    if (q.startsWith('solutions?')) return { value: idsIn(q, 'solutionid').map((id) => E.solutions.find((s) => s.solutionid === id)).filter(Boolean).map((s) => ({ solutionid: s.solutionid, uniquename: s.uniquename, ismanaged: s.ismanaged })) };
    if (q.startsWith('solutioncomponents?') && q.includes('_solutionid_value eq')) return { value: (E.members[idsIn(q, '_solutionid_value')[0]] ?? []).map((r) => ({ ...r })) };
    if (q.startsWith('solutioncomponents?') && q.includes('objectid eq')) {
      const out = [];
      for (const id of idsIn(q, 'objectid')) for (const s of E.holders[id] ?? []) out.push({ objectid: id, componenttype: 0, _solutionid_value: s });
      return { value: out };
    }
    if (q.startsWith('solutioncomponentdefinitions?')) return { value: [{ solutioncomponenttype: 10050, name: 'connectionreference' }] };
    if (q.startsWith('msdyn_componentlayers?')) {
      const id = q.match(/msdyn_componentid eq '([0-9a-f-]{36})'/)?.[1];
      const name = q.match(/msdyn_solutioncomponentname eq '([A-Za-z]+)'/)?.[1];
      if (!id || !name) throw new Error('mock: bad layer filter ' + q);
      if (id === ID.APP2) throw new Error('mock: msdyn_componentlayers unavailable');
      return { value: (E.layers?.[id] ?? []).map(([s, o]) => ({ msdyn_solutionname: s, msdyn_order: o })) };
    }
    if (q.startsWith('canvasapps?')) {
      if (q.includes('name eq ')) {
        const n = q.match(/name eq '([^']+)'/)[1];
        return { value: Object.values(E.canvas).filter((c) => c.name === n).map((c) => project(c, q)) };
      }
      return { value: idsIn(q, 'canvasappid').filter((id) => E.canvas[id]).map((id) => project(E.canvas[id], q)) };
    }
    if (q.startsWith('appmodules?')) {
      if (q.includes('uniquename eq ')) {
        const n = q.match(/uniquename eq '([^']+)'/)[1];
        return { value: Object.values(E.apps).filter((a) => a.uniquename === n).map((a) => project(a, q)) };
      }
      return { value: idsIn(q, 'appmoduleid').filter((id) => E.apps[id]).map((id) => project(E.apps[id], q)) };
    }
    if (q.startsWith('systemforms?')) return { value: idsIn(q, 'formid').filter((id) => E.forms[id]).map((id) => project(E.forms[id], q)) };
    if (q.startsWith('webresourceset?') && q.includes('webresourcetype eq 3')) return { value: Object.values(E.webresources ?? {}).filter((w) => w.content).map((w) => ({ ...w })) };
    if (q.startsWith('webresourceset?')) return { value: idsIn(q, 'webresourceid').filter((id) => E.webresources?.[id]).map((id) => project(E.webresources[id], q)) };
    if (q.startsWith('sitemaps?')) return { value: (E.sitemaps ?? []).map((s) => ({ ...s })) };
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
    getAllEntitiesMetadata: async (props, target = 'primary') => ({ value: envs[target].entities }),
    getEntityRelatedMetadata: async (table, path, props, target = 'primary') => ({ value: envs[target].attrs[table] ?? [] }),
    queryData: async (q, target = 'primary') => {
      M.queries.push({ q, target });
      await new Promise((r) => setTimeout(r, 5));
      return answer(q, target);
    },
    execute: async (req, target = 'primary') => {
      M.executes.push({ ...JSON.parse(JSON.stringify(req)), target });
      const p = req.parameters ?? {};
      if (req.operationName === 'RetrieveCurrentOrganization') return { Detail: { EnvironmentId: 'env-dev' } };
      if (target !== 'primary') throw new Error('mock: write on the target ' + req.operationName);
      if (req.operationName === 'RemoveAppComponents' || req.operationName === 'AddAppComponents') {
        if (p.AppId !== ID.APP1d) throw new Error('mock: unknown app ' + p.AppId);
        const c = p.Components?.[0];
        if (!c || c['@odata.type'] !== 'Microsoft.Dynamics.CRM.canvasapp' || c.canvasappid !== ID.P1d) throw new Error('mock: bad components ' + JSON.stringify(p.Components));
        M.devAppHasPage = req.operationName === 'AddAppComponents';
        return {};
      }
      if (req.operationName === 'PublishXml') return {};
      throw new Error('mock: unexpected execute ' + req.operationName);
    },
    update: async () => { throw new Error('mock: unexpected update'); },
  };
})();
`;

const { page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto("file://" + TOOL + "/dist/index.html");
const M = (fn, arg) => page.evaluate(fn, arg);
const ID = await M(() => window.__mock.ID);

// ---- load ----
await page.click('.tab[data-tab="upgrade"]');
await page.waitForFunction(() => document.querySelectorAll("#ub-solution option[value]:not([value=''])").length > 0);
const opts = await page.$$eval("#ub-solution option", (els) => els.map((e) => e.textContent));
assert(opts.length === 1 && opts[0].includes("SssCore") && opts[0].includes("managed 1.0.0.0 in target"), "picker: Dev unmanaged solutions with their version in the target: " + opts.join(" | "));

// ---- analyze ----
await page.click("#ub-run");
await page.waitForSelector("#ub-counts", { timeout: 15000 });
const counts = await page.textContent("#ub-counts");
assert(/6 removed/.test(counts) && /5 deleted/.test(counts) && /1 survive/.test(counts) && /3 blockers/.test(counts) && /2 runtime breaks/.test(counts), "counts: 6 removed, 5 deleted, 1 survives, 3 blockers, 2 runtime breaks: " + counts);

const q = await M(() => window.__mock.queries);
const ex = await M(() => window.__mock.executes);
const rdd = q.filter((x) => x.q.startsWith("RetrieveDependenciesForDelete("));
assert(rdd.length === 5 && rdd.every((x) => x.target === "secondary" && /ObjectId=0{8}-/.test(x.q)) && !ex.some((e) => e.operationName === "RetrieveDependenciesForDelete"), "RetrieveDependenciesForDelete: once per deleted component, on the target, unquoted guid, via queryData");
assert(!rdd.some((x) => x.q.includes(ID.C4)), "all assets: sss_keep still exists in Dev, so it stays in the solution (not deleted)");
assert(!rdd.some((x) => x.q.includes(ID.APP1t)), "app with another id in Dev matched by unique name (not removed)");
assert(!rdd.some((x) => x.q.includes(ID.C2)), "sss_shared held by SssApps: survives, no delete check");

// Dev blocker: Sales Hub still lists the page
const dev = await page.textContent("#ub-dev");
assert(dev.includes("Sales Hub") && dev.includes("Orders (sss_pageorders_a1b2c)") && dev.includes("Custom page"), "Dev blocker: Sales Hub references custom page Orders: " + dev.slice(0, 200));
const devOpts = await page.$$eval("#ub-dev select option", (els) => els.map((e) => e.value));
assert(devOpts.includes("remove-app-component") && !devOpts.includes("remove-dependent"), "Dev blocker on an app offers Remove from the app, not Remove the app: " + devOpts.join(","));

// release first: Ops Hub in SssApps, from membership (layers unavailable)
const rel = await page.textContent("#ub-release");
assert(rel.includes("Ops Hub") && rel.includes("Legacy") && rel.includes("SssApps") && rel.includes("order unknown"), "release blocker: Ops Hub (SssApps) → Legacy, placed by membership");
assert((await page.textContent("#ub-order")).includes("SssApps → SssCore"), "release order SssApps → SssCore");
assert((await page.textContent("#ub-summary")).includes("Solution layers unavailable for 1"), "warning: layers fell back to membership for 1 dependent");

// target unmanaged: F1 → sss_oldfield
const tgt = await page.textContent("#ub-target");
assert(tgt.includes("Order Main") && tgt.includes("sss_oldfield") && tgt.includes("Unmanaged customization") && tgt.includes("Active › SssCore"), "target blocker: Active layer on Order Main over SssCore: " + tgt.slice(0, 200));

// resolved, survives, runtime
const body = await page.textContent("#ub-body");
assert(body.includes("Resolved by the new version") && body.includes("Order Quick"), "F2 → sss_gone resolved (Dev's form no longer references it)");
assert(body.includes("sss_shared") && body.includes("SssApps"), "sss_shared survives, held by SssApps");
const rt = await page.textContent("#ub-runtime");
assert(rt.includes("sss_/js/nav.js") && rt.includes("Ops Hub") && rt.includes("Site map"), "runtime breaks: JS navigateTo and site map name the deleted pages: " + rt);

// ---- export ----
await page.click("#ub-export-md");
await page.click("#ub-export-csv");
let saved = await M(() => window.__mock.saved);
const md = saved.find((s) => s.name.endsWith(".md"));
const csv = saved.find((s) => s.name.endsWith(".csv"));
assert(md && md.content.includes("Release order: SssApps → SssCore") && md.content.includes("- [ ] Model-driven app Sales Hub → Custom page Orders"), "Markdown export: checklist and release order");
assert(csv && csv.content.startsWith("location,owner") && csv.content.split("\n").filter(Boolean).length === 6, "CSV export: header + 3 blockers + 2 runtime rows");

// ---- fix in Dev ----
const appKey = await page.$eval("#ub-dev .finding", (e) => e.dataset.key);
await page.selectOption(`#ub-dev .finding[data-key="${appKey}"] select`, "remove-app-component");
await page.click("#ub-preview");
await page.waitForSelector("#ub-ops li");
const ops = await page.$$eval("#ub-ops li", (els) => els.map((e) => e.textContent));
assert(ops.length === 2 && ops[0].startsWith("RemoveAppComponents Sales Hub") && ops[1].startsWith("PublishXml app Sales Hub"), "preview: RemoveAppComponents then PublishXml for the app: " + ops.join(" | "));
assert(await page.$eval("#ub-confirm", (b) => b.disabled), "Confirm disabled until the backup is saved");
await page.click("#ub-backup");
await page.waitForFunction(() => !document.querySelector("#ub-confirm").disabled);
saved = await M(() => window.__mock.saved);
const backup = saved.at(-1);
const bk = JSON.parse(backup.content);
assert(bk.kind === "sss-dependency-cleaner-backup" && bk.apps?.[0]?.id === ID.APP1d && bk.apps[0].components[0].id === ID.P1d && bk.membership.length === 4, "backup: Dev membership + app components to re-add (Dev ids)");
await page.click("#ub-confirm");
await page.waitForSelector("#ub-rerun", { timeout: 15000 });
const writes = (await M(() => window.__mock.executes)).filter((e) => e.operationName !== "RetrieveCurrentOrganization");
const rac = writes.find((e) => e.operationName === "RemoveAppComponents");
assert(rac && rac.target === "primary" && rac.parameters.AppId === ID.APP1d && rac.parameters.Components[0]["@odata.type"] === "Microsoft.Dynamics.CRM.canvasapp" && rac.parameters.Components[0].canvasappid === ID.P1d, "RemoveAppComponents on Dev: Dev app id, Dev canvas app id, @odata.type canvasapp");
const pub = writes.find((e) => e.operationName === "PublishXml");
assert(pub && pub.parameters.ParameterXml === `<importexportxml><appmodules><appmodule>${ID.APP1d}</appmodule></appmodules></importexportxml>`, "PublishXml publishes the Dev app");
assert(writes.every((e) => e.target === "primary"), "nothing written to the target");
assert((await page.textContent("#ub-rerun")).includes("3 → 2 blockers"), "analyzed again: 3 → 2 blockers");
assert(!(await page.$("#ub-dev")), "Dev section gone after the fix");

// ---- restore re-adds the app component ----
await page.click('.tab[data-tab="restore"]');
await M((t) => { window.__mock.nextText = t; }, backup.content);
await page.click("#btn-load-backup");
await page.waitForSelector("#restore-ops li");
const rops = await page.$$eval("#restore-ops > li .mono", (els) => els.map((e) => e.textContent));
assert(rops.length === 2 && rops[0].startsWith("AddAppComponents Sales Hub") && rops[1].startsWith("PublishXml app"), "restore plan: AddAppComponents + publish: " + rops.join(" | "));
await page.click("#btn-restore-apply");
await page.click("#dlg-ok");
await page.waitForFunction(() => window.__mock.notes.some((n) => n.title === "Restored"));
assert(await M(() => window.__mock.devAppHasPage), "restore put the page back in the app");

await finish();

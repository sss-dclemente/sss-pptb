// E2E for the Cycles tab (docs/CYCLES-PLAN.md) on the dist build with a mocked PPTB host.
// Dev, unmanaged: Sales (table sls_territory with all assets, incl. sls_name; opportunity (platform) with the form
// Opportunity main), Service (opportunity with the column svc_casecount; flow Case escalation), Reports (canvas app
// Territory app), Core (empty base). Required: Opportunity main → svc_casecount (Service) and a managed column;
// Case escalation → sls_territory (Sales) and the env var definition svc_url that nobody carries (orphan);
// Territory app → sls_territory + sls_name (Sales). Expected: one cycle Sales ⇄ Service, Reports after Sales,
// fixes into Core, a simulated plan, apply, re-analysis and undo.
// Run: npm run build && node scripts/cycles-e2e.mjs
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = resolve(new URL("..", import.meta.url).pathname);

const MOCK = `
(() => {
  const g = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
  const ID = {
    sales: g(1), service: g(2), reports: g(3), core: g(4), def: g(5), sys: g(6), msdyn: g(7), pub: g(11),
    active: 'fd140aae-4df4-11dd-bd17-0019b9312238',
    E1: g(101), E3: g(103), C1: g(201), C2: g(202), C9: g(209), F1: g(301), P1: g(601), W1: g(501), EV1: g(801),
  };
  let seq = 5000;
  const M = window.__mock = { ID, queries: [], executes: [], saved: [], notes: [], nextText: null, listeners: [] };
  const children = { [ID.E1]: [[2, ID.C1]], [ID.E3]: [[2, ID.C2], [2, ID.C9], [60, ID.F1]] };
  const tableOf = (type, id) => Object.keys(children).find((t) => children[t].some(([ty, i]) => ty === type && i === id)) ?? null;
  const members = {};
  const row = (objectid, componenttype, behavior, root) => ({ solutioncomponentid: g(seq++), objectid, componenttype, rootcomponentbehavior: behavior, rootsolutioncomponentid: root });
  function addRoot(sid, type, id, behavior) {
    const r = row(id, type, behavior, null);
    members[sid].push(r);
    if (type === 1 && behavior === 0) for (const [ty, i] of children[id] ?? []) members[sid].push(row(i, ty, null, r.solutioncomponentid));
    return r;
  }
  function addSub(sid, type, id) {
    const t = tableOf(type, id);
    let tr = members[sid].find((m) => m.componenttype === 1 && m.objectid === t);
    if (!tr) tr = addRoot(sid, 1, t, 1);
    if (!members[sid].some((m) => m.componenttype === type && m.objectid === id)) members[sid].push(row(id, type, null, tr.solutioncomponentid));
  }
  function reset() {
    for (const sid of [ID.sales, ID.service, ID.reports, ID.core]) members[sid] = [];
    addRoot(ID.sales, 1, ID.E1, 0);
    addSub(ID.sales, 60, ID.F1);
    addSub(ID.service, 2, ID.C2);
    addRoot(ID.service, 29, ID.W1, null);
    addRoot(ID.reports, 300, ID.P1, null);
  }
  reset();
  M.members = (sid) => members[sid].map((m) => ({ ...m }));
  M.reset = reset;
  const conn = { id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' };
  const solutions = [
    { solutionid: ID.sales, uniquename: 'Sales', friendlyname: 'Sales', version: '1.0.0.0', ismanaged: false, _publisherid_value: ID.pub },
    { solutionid: ID.service, uniquename: 'Service', friendlyname: 'Service', version: '1.0.0.0', ismanaged: false, _publisherid_value: ID.pub },
    { solutionid: ID.reports, uniquename: 'Reports', friendlyname: 'Reports', version: '1.0.0.0', ismanaged: false, _publisherid_value: ID.pub },
    { solutionid: ID.core, uniquename: 'Core', friendlyname: 'Core', version: '1.0.0.0', ismanaged: false, _publisherid_value: ID.pub },
    { solutionid: ID.def, uniquename: 'Default', friendlyname: 'Default Solution', version: '1.0', ismanaged: false, _publisherid_value: ID.pub },
    { solutionid: ID.sys, uniquename: 'System', friendlyname: 'System', version: '9.2', ismanaged: true, _publisherid_value: ID.pub },
    { solutionid: ID.msdyn, uniquename: 'msdynce_Sales', friendlyname: 'Dynamics 365 Sales', version: '9.1', ismanaged: true, _publisherid_value: ID.pub },
  ];
  const entities = [
    { LogicalName: 'sls_territory', MetadataId: ID.E1, PrimaryNameAttribute: 'sls_name', IsCustomEntity: true, IsManaged: false, EntitySetName: 'sls_territories', PrimaryIdAttribute: 'sls_territoryid' },
    { LogicalName: 'opportunity', MetadataId: ID.E3, PrimaryNameAttribute: 'name', IsCustomEntity: false, IsManaged: false, EntitySetName: 'opportunities', PrimaryIdAttribute: 'opportunityid' },
  ];
  const attr = (name, id) => ({ LogicalName: name, MetadataId: id, RequiredLevel: { Value: 'None' }, IsCustomAttribute: true, IsManaged: false });
  const attrs = { sls_territory: [attr('sls_name', ID.C1)], opportunity: [attr('svc_casecount', ID.C2), attr('msdyn_forecast', ID.C9)] };
  const records = {
    systemforms: ['formid', [{ formid: ID.F1, name: 'Opportunity main', objecttypecode: 'opportunity' }]],
    canvasapps: ['canvasappid', [{ canvasappid: ID.P1, name: 'sls_territoryapp' }]],
    workflows: ['workflowid', [{ workflowid: ID.W1, name: 'Case escalation', primaryentity: 'incident' }]],
    environmentvariabledefinitions: ['environmentvariabledefinitionid', [{ environmentvariabledefinitionid: ID.EV1, schemaname: 'svc_url' }]],
  };
  // RetrieveRequiredComponents: [required id, type, parent, base solution]
  const required = {
    [ID.F1]: [[ID.E3, 1, null, ID.sys], [ID.C2, 2, ID.E3, ID.active], [ID.C9, 2, ID.E3, ID.msdyn]],
    [ID.W1]: [[ID.E1, 1, null, ID.active], [ID.EV1, 380, null, ID.active]],
    [ID.P1]: [[ID.E1, 1, null, ID.active], [ID.C1, 2, ID.E1, ID.active]],
    [ID.C1]: [[ID.E1, 1, null, ID.active]],
    [ID.C2]: [[ID.E3, 1, null, ID.sys]],
  };
  const idsIn = (q, field) => [...q.matchAll(new RegExp(field + ' eq ([0-9a-f-]{36})', 'g'))].map((m) => m[1]);
  const sel = (q) => (q.match(/[$]select=([^&]+)/)?.[1] ?? '').split(',');
  const project = (o, q) => Object.fromEntries(sel(q).filter((k) => k in o).map((k) => [k, o[k]]));
  function answer(q) {
    let m;
    if ((m = q.match(/^RetrieveRequiredComponents[(]ObjectId=([^,]+),ComponentType=(\\d+)[)]$/))) {
      M.reqCalls = (M.reqCalls ?? 0) + 1;
      return { EntityCollection: (required[m[1]] ?? []).map(([id, t, p, b]) => ({ requiredcomponentobjectid: id, requiredcomponenttype: t, requiredcomponentparentid: p, requiredcomponentbasesolutionid: b })) };
    }
    if (q.startsWith('publishers?')) return { value: [{ publisherid: ID.pub, uniquename: 'sss', customizationprefix: 'sss' }] };
    if (q.startsWith('solutions?')) return { value: idsIn(q, 'solutionid').map((id) => solutions.find((s) => s.solutionid === id)).filter(Boolean).map((s) => project(s, q)) };
    if (q.startsWith('solutioncomponents?') && q.includes('_solutionid_value eq')) return { value: (members[idsIn(q, '_solutionid_value')[0]] ?? []).map((r) => ({ ...r })) };
    const set = q.split('?')[0];
    if (records[set]) {
      const [idCol, rows] = records[set];
      return { value: idsIn(q, idCol).map((id) => rows.find((r) => r[idCol] === id)).filter(Boolean).map((r) => project(r, q)) };
    }
    throw new Error('mock: unexpected query ' + q);
  }
  window.toolboxAPI = {
    connections: { getActiveConnection: async () => conn, getSecondaryConnection: async () => null },
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
    getSolutions: async () => ({ value: solutions.map((s) => ({ ...s })) }),
    getAllEntitiesMetadata: async (props) => ({ value: entities.map((e) => Object.fromEntries(props.map((p) => [p, e[p]]))) }),
    getEntityRelatedMetadata: async (table, path, props) => ({ value: (attrs[table] ?? []).map((a) => Object.fromEntries(props.map((p) => [p, a[p]]))) }),
    queryData: async (q, target = 'primary') => {
      M.queries.push({ q, target });
      await new Promise((r) => setTimeout(r, 2));
      return answer(q);
    },
    execute: async (req, target = 'primary') => {
      M.executes.push({ ...JSON.parse(JSON.stringify(req)), target });
      const p = req.parameters ?? {};
      if (req.operationName === 'RetrieveCurrentOrganization') return { Detail: { EnvironmentId: 'env-dev' } };
      const sol = solutions.find((s) => s.uniquename === p.SolutionUniqueName);
      if (!sol || sol.ismanaged || !members[sol.solutionid]) throw new Error('mock: bad solution ' + p.SolutionUniqueName);
      const sid = sol.solutionid;
      if (req.operationName === 'RemoveSolutionComponent') {
        const sc = p.SolutionComponent;
        if (!sc || sc['@odata.type'] !== 'Microsoft.Dynamics.CRM.solutioncomponent') throw new Error('mock: bad SolutionComponent');
        const r = members[sid].find((x) => x.componenttype === p.ComponentType && (x.objectid === sc.solutioncomponentid || x.solutioncomponentid === sc.solutioncomponentid));
        if (!r) throw new Error('mock: not in ' + sol.uniquename + ': ' + sc.solutioncomponentid);
        members[sid] = members[sid].filter((x) => x !== r && x.rootsolutioncomponentid !== r.solutioncomponentid);
        return {};
      }
      if (req.operationName === 'AddSolutionComponent') {
        if (p.AddRequiredComponents !== false) throw new Error('mock: AddRequiredComponents must be false');
        if (members[sid].some((x) => x.componenttype === p.ComponentType && x.objectid === p.ComponentId)) throw new Error('mock: already in ' + sol.uniquename);
        if (p.ComponentType === 1) addRoot(sid, 1, p.ComponentId, p.DoNotIncludeSubcomponents ? 1 : 0);
        else if (tableOf(p.ComponentType, p.ComponentId)) addSub(sid, p.ComponentType, p.ComponentId);
        else addRoot(sid, p.ComponentType, p.ComponentId, null);
        return {};
      }
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

// ---- pick ----
await page.click('.tab[data-tab="cycles"]');
await page.waitForFunction(() => document.querySelectorAll("#cy-solutions input").length > 0);
const pick = await page.$$eval("#cy-solutions label", (els) => els.map((e) => e.textContent));
assert(pick.length === 4 && !pick.some((t) => t.includes("Default")) && !pick.some((t) => t.includes("System")), "picker lists the unmanaged solutions only: " + pick.join(" | "));
assert(await page.$eval("#cy-run", (b) => b.disabled), "Analyze disabled with fewer than two solutions");
await page.click("#cy-picker > summary");
for (const id of [ID.sales, ID.service, ID.reports]) await page.check(`#cy-solutions input[value="${id}"]`);
assert((await page.textContent("#cy-picked")) === "3 selected" && !(await page.$eval("#cy-run", (b) => b.disabled)), "three solutions ticked, Analyze enabled");
await page.selectOption("#cy-base", ID.core);
await page.click("#cy-picker > summary");

// ---- analyze ----
await page.click("#cy-run");
await page.waitForSelector("#cy-counts", { timeout: 15000 });
const counts = await page.textContent("#cy-counts");
assert(/3 solutions · base Core/.test(counts) && /1 cycle/.test(counts) && /3 cross-solution edges/.test(counts) && /1 orphan/.test(counts) && /0 via base/.test(counts) && /1 managed/.test(counts), "counts: 1 cycle, 3 edges, 1 orphan, 1 managed requirement: " + counts);
assert((await page.textContent("#cy-order")).includes("No import order") && (await page.textContent("#cy-order")).includes("Sales ⇄ Service"), "no import order while Sales ⇄ Service: " + (await page.textContent("#cy-order")));
assert((await M(() => window.__mock.reqCalls)) === 7, "RetrieveRequiredComponents once per distinct member of the selected solutions (7: opportunity shared by two is read once), never for the base: " + (await M(() => window.__mock.reqCalls)));
const rowsOf = (sec) => page.$$eval(`#cy-${sec} li.cy-row`, (els) => els.map((e) => ({ key: e.dataset.key, head: e.querySelector(".head").textContent, cause: e.querySelector(".cause").textContent, fix: e.querySelector("select").value, opts: [...e.querySelectorAll("option")].map((o) => o.value + (o.disabled ? "!" : "")), also: { hidden: e.querySelector(".cy-also").hidden, disabled: e.querySelector(".cy-also input").disabled } })));
const cyc = await rowsOf("cycles");
assert(cyc.length === 2 && cyc.every((r) => r.fix === "base"), "cycle edges: 2 fix rows, both default to the base: " + JSON.stringify(cyc.map((r) => [r.head, r.fix])));
const c2 = cyc.find((r) => r.head.includes("svc_casecount"));
const e1 = cyc.find((r) => r.head.includes("sls_territory"));
assert(c2 && c2.head.startsWith("Sales") && c2.head.includes("from") && c2.head.includes("Service") && c2.cause.includes("Form Opportunity main"), "Sales needs Column svc_casecount from Service, for the form: " + c2?.head);
assert(e1 && e1.head.startsWith("Service") && e1.cause.includes("Process Case escalation"), "Service needs Table sls_territory from Sales, for the flow: " + e1?.head);
assert(c2.also.disabled && !c2.also.hidden && !e1.also.disabled, "also-remove: disabled for the column (included by its table in Service), enabled for the root table in Sales");
assert(c2.opts.join(",") === "none,base,copy,move!" && e1.opts.join(",") === "none,base,copy,move", "fix options: move disabled when the dependent is a subcomponent (the form under opportunity), enabled for the root flow: " + c2.opts.join(",") + " / " + e1.opts.join(","));
const acyc = await rowsOf("edges");
assert(acyc.length === 2 && acyc.every((r) => r.head.startsWith("Reports") && r.head.includes("Sales") && r.fix === "none" && r.cause.includes("Canvas app sls_territoryapp")), "Reports → Sales edges (table + column) outside the cycle, no default fix: " + JSON.stringify(acyc.map((r) => r.head)));
const orph = await page.$$eval("#cy-orphans li.cy-orphan", (els) => els.map((e) => ({ text: e.textContent, checked: e.querySelector("input").checked })));
assert(orph.length === 1 && orph[0].text.includes("svc_url") && orph[0].text.includes("Service: Process Case escalation") && orph[0].checked, "orphan: env var svc_url needed by the flow, ticked for the base by default");
assert((await page.textContent("#cy-sel-count")) === "3 fixes selected", "3 fixes selected (2 cycle rows + 1 orphan)");
const folds = await page.$$eval("#cy-body details.card[data-fold-key]", (els) => Object.fromEntries(els.map((e) => [e.dataset.foldKey, e.open])));
assert(folds["cy:cycles"] && folds["cy:orphans"] && !folds["cy:edges"], "fold cards: cycles + orphans open, acyclic edges closed: " + JSON.stringify(folds));

// E2E_SHOTS=1 refreshes the README screenshot (docs/img/cycles.png)
if (process.env.E2E_SHOTS) await page.screenshot({ path: resolve(TOOL, "docs/img/cycles.png"), fullPage: false });

// ---- export ----
await page.click("#cy-export-md");
await page.click("#cy-export-csv");
let saved = await M(() => window.__mock.saved);
const md = saved.find((s) => s.name.endsWith(".md"));
const csv = saved.find((s) => s.name.endsWith(".csv"));
assert(md && md.content.includes("## Cycle Sales ⇄ Service") && md.content.includes("- [ ] Sales needs Column svc_casecount from Service") && md.content.includes("carried by none (1)"), "Markdown: cycle checklist + orphans");
assert(csv && csv.content.startsWith("from,to,in cycle") && csv.content.split("\n").filter(Boolean).length === 6, "CSV: header + 4 edge rows + 1 orphan");

// ---- preview: default plan (everything to the base) ----
await page.click("#cy-preview");
await page.waitForSelector("#cy-ops li");
let ops = await page.$$eval("#cy-ops li .mono", (els) => els.map((e) => e.textContent));
assert(ops.length === 3 && ops.includes("AddSolutionComponent Column svc_casecount → Core") && ops.includes("AddSolutionComponent Table sls_territory → Core (DoNotIncludeSubcomponents)") && ops.includes("AddSolutionComponent Environment variable svc_url → Core"), "plan: three adds into Core, the table as a shell: " + ops.join(" | "));
let after = await page.textContent("#cy-after");
assert(/0 cycles/.test(after) && /1 edges/.test(after) && /0 orphans/.test(after), "simulation: 0 cycles, the Reports → Sales edge remains, 0 orphans: " + after);
assert((await page.textContent("#cy-after-order")) === "Import order:Core→Sales→Reports→Service", "simulated order: Core first, then the ready solutions by name (Sales; Reports after Sales; Service): " + (await page.textContent("#cy-after-order")));

// ---- preview: move the flow instead + also remove the table from Sales → the simulation shows the new orphan ----
await page.selectOption(`#cy-cycles li.cy-row[data-key="${e1.key}"] select`, "move");
assert(await page.isHidden("#cy-fix-actions"), "changing a fix drops the plan");
await page.click("#cy-preview");
await page.waitForSelector("#cy-ops li");
ops = await page.$$eval("#cy-ops li .mono", (els) => els.map((e) => e.textContent));
assert(ops.length === 4 && ops[0] !== undefined && ops.includes("AddSolutionComponent Process Case escalation → Sales") && ops.at(-1) === "RemoveSolutionComponent Process Case escalation ← Service", "move: add the flow to Sales, remove from Service last: " + ops.join(" | "));
assert(/0 cycles/.test(await page.textContent("#cy-after")), "moving the flow also breaks the cycle");
await page.selectOption(`#cy-cycles li.cy-row[data-key="${e1.key}"] select`, "base");
await page.check(`#cy-cycles li.cy-row[data-key="${e1.key}"] .cy-also input`);
await page.click("#cy-preview");
await page.waitForSelector("#cy-ops li");
ops = await page.$$eval("#cy-ops li .mono", (els) => els.map((e) => e.textContent));
assert(ops.at(-1) === "RemoveSolutionComponent Table sls_territory ← Sales", "also remove: the table leaves Sales after the adds: " + ops.join(" | "));
after = await page.textContent("#cy-after");
assert(/0 cycles/.test(after) && /1 orphans/.test(after), "simulation catches the side effect: sls_name leaves with its table and becomes an orphan for Reports: " + after);
await page.uncheck(`#cy-cycles li.cy-row[data-key="${e1.key}"] .cy-also input`);
await page.click("#cy-preview");
await page.waitForSelector("#cy-ops li");
assert((await page.$$eval("#cy-ops li", (els) => els.length)) === 3, "back to the three adds");

// ---- backup → confirm ----
assert(await page.$eval("#cy-confirm", (b) => b.disabled), "Confirm disabled until the backup is saved");
await page.click("#cy-backup");
await page.waitForFunction(() => !document.querySelector("#cy-confirm").disabled);
saved = await M(() => window.__mock.saved);
const backup = saved.at(-1);
const bk = JSON.parse(backup.content);
assert(bk.kind === "sss-dependency-cleaner-cycles-backup" && bk.operations.length === 3 && bk.operations.every((o) => o.kind === "add" && o.solution === "Core") && bk.environment.url === "https://sss-dev.crm4.dynamics.com", "backup records the three adds with their solution");
await page.click("#cy-confirm");
await page.waitForSelector("#cy-rerun", { timeout: 15000 });
const writes = (await M(() => window.__mock.executes)).filter((e) => e.operationName !== "RetrieveCurrentOrganization");
assert(writes.length === 3 && writes.every((e) => e.operationName === "AddSolutionComponent" && e.parameters.SolutionUniqueName === "Core" && e.parameters.AddRequiredComponents === false), "3 AddSolutionComponent into Core");
assert(writes.find((e) => e.parameters.ComponentType === 1).parameters.DoNotIncludeSubcomponents === true, "the table goes in as a shell");
const results = await page.$$eval("#cy-results-table tbody tr td:last-child", (els) => els.map((e) => e.textContent));
assert(results.length === 3 && results.every((r) => r === "ok"), "results: 3 ok");
assert((await page.textContent("#cy-rerun")).includes("1 → 0 cycles"), "analyzed again: 1 → 0 cycles");
assert((await page.textContent("#cy-order")).includes("Import order") && (await page.textContent("#cy-counts")).includes("4 via base"), "after apply: an import order exists, 4 requirements now satisfied via the base: " + (await page.textContent("#cy-counts")));
const core = await M((id) => window.__mock.members(id), ID.core);
assert(core.length === 4 && core.find((m) => m.objectid === ID.E1).rootcomponentbehavior === 1 && core.some((m) => m.objectid === ID.E3) && core.some((m) => m.objectid === ID.C2), "Core membership: sls_territory shell, opportunity shell + svc_casecount, svc_url");

// ---- undo ----
await M((t) => { window.__mock.nextText = t; }, backup.content);
await page.click("#cy-undo");
await page.waitForSelector("#cy-undo-ops li");
const uops = await page.$$eval("#cy-undo-ops li .mono", (els) => els.map((e) => e.textContent));
assert(uops.length === 3 && uops.every((o) => o.startsWith("RemoveSolutionComponent") && o.endsWith("← Core")) && uops[0].includes("svc_url"), "undo plan: the three removes, last add first: " + uops.join(" | "));
await page.click("#cy-undo-apply");
await page.waitForFunction(() => window.__mock.notes.some((n) => n.title === "Undone"));
const coreAfterUndo = await M((id) => window.__mock.members(id), ID.core);
assert(coreAfterUndo.length === 1 && coreAfterUndo[0].objectid === ID.E3, "undo removed the three components; the opportunity shell that came along with its column stays (documented)");
await page.click("#cy-run");
await page.waitForFunction(() => /1 cycle/.test(document.querySelector("#cy-counts")?.textContent ?? ""), null, { timeout: 15000 });
assert(true, "after undo the cycle is back");

// ---- no base: report only ----
await page.selectOption("#cy-base", "");
await page.click("#cy-run");
await page.waitForFunction(() => /base none/.test(document.querySelector("#cy-counts")?.textContent ?? ""), null, { timeout: 15000 });
const noBase = await rowsOf("cycles");
assert(noBase.every((r) => r.fix === "none" && r.opts.includes("base!")), "without a base the base fix is disabled and nothing is preselected: " + JSON.stringify(noBase.map((r) => [r.fix, r.opts])));
assert((await page.textContent("#cy-summary")).includes("No base solution picked"), "warning asks for a base solution");
assert(await page.$eval("#cy-orphans input", (b) => b.disabled && !b.checked), "orphan tick disabled without a base");

await finish();

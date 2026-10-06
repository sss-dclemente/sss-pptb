// E2E for the Slim tab (docs/SOLUTION-SLIMMER-PLAN.md) on the dist build with a mocked PPTB host.
// Dev: unmanaged SssCore with
//   sss_order        unmanaged table, all assets: sss_name (unmanaged), msdyn_foo (managed → included by its table)
//   account          platform table (ismanaged false, not custom), all assets: sss_custom (yours, re-added), name (platform,
//                    Active layer with bookkeeping only, leaves), Account main form (platform, Active layer changes formxml,
//                    re-added), Active Accounts view (platform, pristine, leaves)                              → shell
//   msdyn_workorder  managed table, all assets, only msdyn_x (pristine)                                    → removed whole
//   contact          platform table, behaviour 1, phantom Active layer, with the pristine form Contact main → both removed
//   sss_flow (unmanaged), msdyn_managed_flow (Active layer, also in OtherTeam), Salesperson role (pristine, Sales),
//   sss_shared_office365 connection reference (dynamic type 10050, unmanaged), msdyn_url env var definition
//   (pristine) + its unmanaged value (→ definition kept as parent), sss_/old.js web resource (layers read fails → unknown).
// Run: npm run build && node scripts/slim-e2e.mjs
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = resolve(new URL("..", import.meta.url).pathname);

const MOCK = `
(() => {
  const g = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
  const ID = {
    core: g(1), other: g(2), def: g(3), sys: g(4), pub: g(11),
    E1: g(101), E2: g(102), E3: g(103), E4: g(104), ECR: g(105), EEVV: g(106),
    C1: g(201), C5: g(205), C2: g(202), C3: g(203), C4: g(204),
    F1: g(301), F2: g(302), V1: g(401), W1: g(501), W2: g(502), R1: g(601), CR1: g(701), EV1: g(801), EVV1: g(802), WR1: g(901),
  };
  let seq = 5000;
  const M = window.__mock = { ID, queries: [], executes: [], saved: [], notes: [], nextText: null, listeners: [], layerQueries: [] };
  // table → its subcomponents (type, objectid), used when a table is (re-)added with all assets
  const children = {
    [ID.E1]: [[2, ID.C1], [2, ID.C5]],
    [ID.E2]: [[2, ID.C2], [2, ID.C3], [60, ID.F1], [26, ID.V1]],
    [ID.E3]: [[2, ID.C4]],
    [ID.E4]: [[60, ID.F2]],
  };
  const tableOf = (type, id) => Object.keys(children).find((t) => children[t].some(([ty, i]) => ty === type && i === id)) ?? null;
  let members = [];
  const row = (objectid, componenttype, behavior, root) => ({ solutioncomponentid: g(seq++), objectid, componenttype, rootcomponentbehavior: behavior, rootsolutioncomponentid: root });
  function addRoot(type, id, behavior) {
    const r = row(id, type, behavior, null);
    members.push(r);
    if (type === 1 && behavior === 0) for (const [ty, i] of children[id] ?? []) members.push(row(i, ty, null, r.solutioncomponentid));
    return r;
  }
  function addSub(type, id) {
    const t = tableOf(type, id);
    let tr = members.find((m) => m.componenttype === 1 && m.objectid === t);
    if (!tr) tr = addRoot(1, t, 1);
    if (!members.some((m) => m.componenttype === type && m.objectid === id)) members.push(row(id, type, null, tr.solutioncomponentid));
  }
  function reset() {
    members = [];
    addRoot(1, ID.E1, 0);
    addRoot(1, ID.E2, 0);
    addRoot(1, ID.E3, 0);
    addRoot(1, ID.E4, 1);
    addSub(60, ID.F2);
    for (const [t, id] of [[29, ID.W1], [29, ID.W2], [20, ID.R1], [10050, ID.CR1], [380, ID.EV1], [381, ID.EVV1], [61, ID.WR1]]) addRoot(t, id, null);
  }
  reset();
  M.members = () => members.map((m) => ({ ...m }));
  M.reset = reset;
  const conn = { id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' };
  const solutions = [
    { solutionid: ID.core, uniquename: 'SssCore', friendlyname: 'SSS Core', version: '1.3.0.0', ismanaged: false, _publisherid_value: ID.pub },
    { solutionid: ID.other, uniquename: 'OtherTeam', friendlyname: 'Other Team', version: '1.0', ismanaged: false, _publisherid_value: ID.pub },
    { solutionid: ID.def, uniquename: 'Default', friendlyname: 'Default Solution', version: '1.0', ismanaged: false, _publisherid_value: ID.pub },
    { solutionid: ID.sys, uniquename: 'System', friendlyname: 'System', version: '9.2', ismanaged: true, _publisherid_value: ID.pub },
  ];
  const entities = [
    { LogicalName: 'sss_order', MetadataId: ID.E1, PrimaryNameAttribute: 'sss_name', IsCustomEntity: true, IsManaged: false, EntitySetName: 'sss_orders', PrimaryIdAttribute: 'sss_orderid' },
    { LogicalName: 'account', MetadataId: ID.E2, PrimaryNameAttribute: 'name', IsCustomEntity: false, IsManaged: false, EntitySetName: 'accounts', PrimaryIdAttribute: 'accountid' },
    { LogicalName: 'msdyn_workorder', MetadataId: ID.E3, PrimaryNameAttribute: 'msdyn_name', IsCustomEntity: true, IsManaged: true, EntitySetName: 'msdyn_workorders', PrimaryIdAttribute: 'msdyn_workorderid' },
    { LogicalName: 'contact', MetadataId: ID.E4, PrimaryNameAttribute: 'fullname', IsCustomEntity: false, IsManaged: false, EntitySetName: 'contacts', PrimaryIdAttribute: 'contactid' },
    { LogicalName: 'connectionreference', MetadataId: ID.ECR, PrimaryNameAttribute: 'connectionreferencelogicalname', IsCustomEntity: false, IsManaged: true, EntitySetName: 'connectionreferences', PrimaryIdAttribute: 'connectionreferenceid' },
    { LogicalName: 'environmentvariablevalue', MetadataId: ID.EEVV, PrimaryNameAttribute: 'schemaname', IsCustomEntity: false, IsManaged: true, EntitySetName: 'environmentvariablevalues', PrimaryIdAttribute: 'environmentvariablevalueid' },
  ];
  const attr = (name, id, managed, custom = true) => ({ LogicalName: name, MetadataId: id, RequiredLevel: { Value: 'None' }, IsCustomAttribute: custom, IsManaged: managed });
  const attrs = {
    sss_order: [attr('sss_name', ID.C1, false), attr('msdyn_foo', ID.C5, true)],
    account: [attr('sss_custom', ID.C2, false), attr('name', ID.C3, false, false)],
    msdyn_workorder: [attr('msdyn_x', ID.C4, true)],
    contact: [],
  };
  // record-backed components per entity set: [id column, rows]
  const records = {
    systemforms: ['formid', [{ formid: ID.F1, name: 'Account main form', objecttypecode: 'account', ismanaged: false }, { formid: ID.F2, name: 'Contact main', objecttypecode: 'contact', ismanaged: false }]],
    savedqueries: ['savedqueryid', [{ savedqueryid: ID.V1, name: 'Active Accounts', returnedtypecode: 'account', ismanaged: false }]],
    workflows: ['workflowid', [{ workflowid: ID.W1, name: 'sss_flow', primaryentity: 'sss_order', ismanaged: false }, { workflowid: ID.W2, name: 'msdyn_managed_flow', primaryentity: 'account', ismanaged: true }]],
    roles: ['roleid', [{ roleid: ID.R1, name: 'Salesperson', ismanaged: true }]],
    connectionreferences: ['connectionreferenceid', [{ connectionreferenceid: ID.CR1, connectionreferencelogicalname: 'sss_shared_office365', ismanaged: false }]],
    environmentvariabledefinitions: ['environmentvariabledefinitionid', [{ environmentvariabledefinitionid: ID.EV1, schemaname: 'msdyn_url', ismanaged: true }]],
    environmentvariablevalues: ['environmentvariablevalueid', [{ environmentvariablevalueid: ID.EVV1, schemaname: 'msdyn_url', ismanaged: false, _environmentvariabledefinitionid_value: ID.EV1 }]],
    webresourceset: ['webresourceid', [{ webresourceid: ID.WR1, name: 'sss_/old.js', ismanaged: true }]],
  };
  const defs = [
    [1, 'Entity', null], [2, 'Attribute', null], [20, 'Role', 'role'], [26, 'SavedQuery', 'savedquery'], [29, 'Workflow', 'workflow'], [60, 'SystemForm', 'systemform'],
    [61, 'WebResource', 'webresource'], [380, 'EnvironmentVariableDefinition', 'environmentvariabledefinition'], [381, 'EnvironmentVariableValue', 'environmentvariablevalue'],
    [10050, 'connectionreference', 'connectionreference'],
  ];
  const typeOfId = (id) => { for (const m of members) if (m.objectid === id) return m.componenttype; return [...Object.values(children)].flat().find(([, i]) => i === id)?.[0]; };
  // layers per component, bottom first as msdyn_order 1..n: [solution name, attributes the layer changes]
  const layers = {
    [ID.C5]: [['msdyn_Sales'], ['Active', ['modifiedon', 'overwritetime']]],
    [ID.E2]: [['System'], ['Active', []]],
    [ID.C3]: [['System'], ['Active', ['modifiedon']]],
    [ID.F1]: [['System'], ['Active', ['formxml', 'modifiedon']]],
    [ID.V1]: [['System']],
    [ID.E3]: [['msdyn_FieldService'], ['Active', []]],
    [ID.C4]: [['msdyn_FieldService']],
    [ID.E4]: [['System'], ['Active', []]],
    [ID.F2]: [['System']],
    [ID.W2]: [['msdyn_Sales'], ['Active', ['xaml']]],
    [ID.R1]: [['Sales']],
    [ID.EV1]: [['msdyn_Sales']],
  };
  // platform records sit in the System solution too
  const holders = { [ID.F1]: [ID.core, ID.sys, ID.def], [ID.F2]: [ID.core, ID.sys, ID.def], [ID.V1]: [ID.core, ID.sys, ID.def], [ID.W2]: [ID.core, ID.other, ID.def] };
  const idsIn = (q, field) => [...q.matchAll(new RegExp(field + ' eq ([0-9a-f-]{36})', 'g'))].map((m) => m[1]);
  const sel = (q) => (q.match(/[$]select=([^&]+)/)?.[1] ?? '').split(',');
  const project = (o, q) => { const s = sel(q); for (const k of s) if (!(k in o)) throw new Error('mock: ' + q.split('?')[0] + ' has no column ' + k); return Object.fromEntries(s.map((k) => [k, o[k]])); };

  function answer(q, target) {
    if (target !== 'primary') throw new Error('mock: unexpected target ' + target);
    let m;
    if (q.includes('_rootsolutioncomponentid_value')) throw new Error("Dataverse queryData failed: 0x80060888: Could not find a property named '_rootsolutioncomponentid_value'");
    if (q.startsWith('publishers?')) return { value: [{ publisherid: ID.pub, uniquename: 'sss', customizationprefix: 'sss' }] };
    if (q.startsWith('solutions?')) return { value: idsIn(q, 'solutionid').map((id) => solutions.find((s) => s.solutionid === id)).filter(Boolean).map((s) => project(s, q)) };
    if (q.startsWith('solutioncomponents?') && q.includes('_solutionid_value eq')) {
      if (idsIn(q, '_solutionid_value')[0] !== ID.core) return { value: [] };
      return { value: members.map((r) => ({ ...r })) };
    }
    if (q.startsWith('solutioncomponents?') && q.includes('objectid eq')) {
      const out = [];
      for (const id of idsIn(q, 'objectid')) for (const s of holders[id] ?? [ID.core, ID.def]) out.push({ objectid: id, componenttype: typeOfId(id) ?? 0, _solutionid_value: s });
      return { value: out };
    }
    if (q.startsWith('solutioncomponentdefinitions?')) return { value: defs.map(([t, n, e]) => ({ solutioncomponenttype: t, name: n, primaryentityname: e })) };
    if (q.startsWith('msdyn_componentlayers?')) {
      const id = q.match(/msdyn_componentid eq '([0-9a-f-]{36})'/)?.[1];
      const name = q.match(/msdyn_solutioncomponentname eq '([A-Za-z]+)'/)?.[1];
      if (!id || !name) throw new Error('mock: bad layer filter ' + q);
      const expected = defs.find(([t]) => t === typeOfId(id))?.[1];
      if (name !== expected) throw new Error('mock: layer name ' + name + ' for a ' + expected);
      M.layerQueries.push({ id, name });
      if (id === ID.WR1) throw new Error('mock: msdyn_componentlayers unavailable for web resources');
      return { value: (layers[id] ?? []).map(([s, ch], i) => ({ msdyn_solutionname: s, msdyn_order: i + 1, msdyn_componentjson: '{}', msdyn_changes: JSON.stringify({ LogicalName: name, Id: id, Attributes: (ch ?? []).map((k) => ({ Key: k, Value: 1 })) }) })) };
    }
    if ((m = q.match(/^RelationshipDefinitions|^GlobalOptionSetDefinitions/))) throw new Error('mock: no relationships or choices in this solution: ' + q);
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
    getSolutions: async (cols, target = 'primary') => ({ value: solutions.map((s) => ({ ...s })) }),
    getAllEntitiesMetadata: async (props, target = 'primary') => {
      M.entityProps = props;
      return { value: entities.map((e) => Object.fromEntries(props.map((p) => [p, e[p]]))) };
    },
    getEntityRelatedMetadata: async (table, path, props, target = 'primary') => ({ value: (attrs[table] ?? []).map((a) => Object.fromEntries(props.map((p) => [p, a[p]]))) }),
    queryData: async (q, target = 'primary') => {
      M.queries.push({ q, target });
      await new Promise((r) => setTimeout(r, 2));
      return answer(q, target);
    },
    execute: async (req, target = 'primary') => {
      M.executes.push({ ...JSON.parse(JSON.stringify(req)), target });
      const p = req.parameters ?? {};
      if (req.operationName === 'RetrieveCurrentOrganization') return { Detail: { EnvironmentId: 'env-dev' } };
      if (target !== 'primary') throw new Error('mock: write on another target ' + req.operationName);
      if (p.SolutionUniqueName !== 'SssCore') throw new Error('mock: wrong solution ' + p.SolutionUniqueName);
      if (req.operationName === 'RemoveSolutionComponent') {
        if ('ComponentId' in p) throw new Error("Dataverse execute failed: 0x80048d19: The parameter 'ComponentId' in the request payload is not a valid parameter for the operation 'RemoveSolutionComponent'.");
        const sc = p.SolutionComponent;
        if (!sc || sc['@odata.type'] !== 'Microsoft.Dynamics.CRM.solutioncomponent' || !/^[0-9a-f-]{36}$/.test(sc.solutioncomponentid)) throw new Error('mock: bad SolutionComponent ' + JSON.stringify(sc));
        const r = members.find((x) => x.componenttype === p.ComponentType && (x.objectid === sc.solutioncomponentid || x.solutioncomponentid === sc.solutioncomponentid));
        if (!r) throw new Error('mock: not in the solution ' + p.ComponentType + ' ' + sc.solutioncomponentid);
        members = members.filter((x) => x !== r && x.rootsolutioncomponentid !== r.solutioncomponentid);
        return {};
      }
      if (req.operationName === 'AddSolutionComponent') {
        if (p.AddRequiredComponents !== false) throw new Error('mock: AddRequiredComponents must be false');
        if (members.some((x) => x.componenttype === p.ComponentType && x.objectid === p.ComponentId)) throw new Error('mock: already in the solution ' + p.ComponentId);
        if (p.ComponentType === 1) addRoot(1, p.ComponentId, p.DoNotIncludeSubcomponents ? 1 : 0);
        else if (tableOf(p.ComponentType, p.ComponentId)) addSub(p.ComponentType, p.ComponentId);
        else addRoot(p.ComponentType, p.ComponentId, null);
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
// the last confirmation before a write names the environment, the scope and the way back
const okWrite = async (env, url, scope, wayBack = /backup/i) => {
  await page.waitForSelector("#dlg[open] #dlg-write");
  const t = await page.textContent("#dlg-write");
  assert(t.includes(env) && t.includes(url) && t.includes(scope) && wayBack.test(t), "write confirmation names environment, scope and way back: " + t);
  await page.click("#dlg-ok");
};
const ID = await M(() => window.__mock.ID);

// ---- load ----
await page.click('.tab[data-tab="slim"]');
assert((await page.isHidden("#btn-export-json")) && (await page.isHidden("#btn-export-csv")), "Findings JSON / CSV (Diagnose only) hidden on the Slim tab");
await page.waitForFunction(() => document.querySelectorAll("#sl-solution option[value]:not([value=''])").length > 0);
const opts = await page.$$eval("#sl-solution option", (els) => els.map((e) => e.textContent));
assert(opts.length === 2 && opts.some((o) => o.includes("SssCore")) && !opts.some((o) => o.includes("Default")), "picker: unmanaged solutions without Default: " + opts.join(" | "));
assert(await page.isChecked("#sl-parents"), "Keep parents on by default");
await page.selectOption("#sl-solution", ID.core);

// ---- analyze ----
await page.click("#sl-run");
await page.waitForSelector("#sl-counts", { timeout: 15000 });
const counts = await page.textContent("#sl-counts");
assert(/19 components/.test(counts) && /6 to remove/.test(counts) && /2 tables → shell/.test(counts) && /2 customized/.test(counts) && /6 yours/.test(counts) && /1 parent kept/.test(counts) && /1 included/.test(counts) && /1 unknown/.test(counts), "counts: 19 components, 6 to remove, 2 shells, 2 customized, 6 yours, 1 parent, 1 included, 1 unknown: " + counts);
assert((await page.textContent("#sl-summary")).includes("2 component(s) carry an Active layer that changes nothing"), "phantom Active layers (name: modifiedon only; contact: empty) are counted as not customized, with a warning");
assert((await M(() => window.__mock.entityProps)).includes("IsManaged"), "entity metadata asks for IsManaged");

const lq = await M(() => window.__mock.layerQueries);
assert(lq.length === 13 && new Set(lq.map((x) => x.id)).size === 13, "layers read once per managed or platform component (13), never for yours: " + lq.length);
assert(!lq.some((x) => [ID.E1, ID.C1, ID.C2, ID.W1, ID.CR1, ID.EVV1].includes(x.id)) && lq.some((x) => x.id === ID.E2) && lq.some((x) => x.id === ID.V1), "no layer read for your components; platform ones (account, Active Accounts) are read");
assert(lq.some((x) => x.id === ID.R1 && x.name === "Role") && lq.some((x) => x.id === ID.F1 && x.name === "SystemForm"), "layer component names from solutioncomponentdefinitions (Role, SystemForm)");

const section = (v) => page.$$eval(`#sl-${v} li.slim-row`, (els) => els.map((e) => ({ name: e.querySelector(".name").textContent, checked: e.querySelector("input").checked, text: e.textContent, badges: [...e.querySelectorAll(".head .badge")].map((b) => b.textContent) })));
const rem = await section("remove");
assert(rem.length === 6 && rem.every((r) => r.checked), "Remove: 6 rows, all ticked: " + rem.map((r) => r.name).join(", "));
assert(rem.map((r) => r.name).sort().join(",") === ["name", "Active Accounts", "msdyn_x", "contact", "Contact main", "Salesperson"].sort().join(","), "Remove lists the pristine managed components: " + rem.map((r) => r.name).join(", "));
assert(rem.find((r) => r.name === "Salesperson").badges.includes("Sales") && rem.find((r) => r.name === "Salesperson").badges.includes("managed"), "owning managed solution badge from the base layer + managed origin");
assert(rem.find((r) => r.name === "name").badges.includes("platform") && !rem.find((r) => r.name === "name").badges.includes("System") && rem.find((r) => r.name === "name").text.includes("Active layer without changes"), "platform column (ismanaged false, not custom, in System): platform badge, phantom Active layer named: " + JSON.stringify(rem.find((r) => r.name === "name")));
assert(rem.find((r) => r.name === "Active Accounts").badges.includes("platform") && rem.find((r) => r.name === "Contact main").badges.includes("platform"), "platform view and form (ismanaged false, held by System) are not yours");
const sh = await section("shell");
assert(sh.length === 2 && sh.find((r) => r.name === "account").text.includes("2 of 4 subcomponents re-added") && sh.find((r) => r.name === "msdyn_workorder").text.includes("nothing of yours in it"), "Shell: account keeps 2 of 4, msdyn_workorder removed whole: " + sh.map((r) => r.text).join(" | "));
const unk = await section("unknown");
assert(unk.length === 1 && unk[0].name === "sss_/old.js" && !unk[0].checked && unk[0].badges.includes("unknown"), "Unknown: the web resource whose layers failed, not ticked (kept)");
const cus = await section("customized");
assert(cus.length === 2 && !cus.some((r) => r.checked) && cus.find((r) => r.name === "msdyn_managed_flow").badges.some((b) => b === "also in OtherTeam"), "Customized: form + flow kept, flow flagged as also in OtherTeam: " + JSON.stringify(cus.map((r) => [r.name, r.badges])));
assert(cus.find((r) => r.name === "Account main form").text.includes("changes formxml") && !cus.find((r) => r.name === "Account main form").text.includes("modifiedon") && cus.find((r) => r.name === "Account main form").badges.includes("platform"), "customized: the real change (formxml) is named, bookkeeping (modifiedon) is not: " + cus.find((r) => r.name === "Account main form").text);
const par = await section("parent");
assert(par.length === 1 && par[0].name === "msdyn_url" && par[0].text.includes("definition of 1 kept value"), "Parent: env var definition kept for its unmanaged value");
const inc = await section("included");
assert(inc.length === 1 && inc[0].name === "msdyn_foo", "Included: msdyn_foo under the unmanaged all-assets table");
assert((await page.$$eval("#sl-unmanaged li.slim-row", (els) => els.length)) === 6, "Unmanaged: 6 rows");
const folds = await page.$$eval("#sl-body details.card[data-fold-key]", (els) => Object.fromEntries(els.map((e) => [e.dataset.foldKey, e.open])));
assert(folds["sl:remove"] && folds["sl:shell"] && folds["sl:unknown"] && !folds["sl:customized"] && !folds["sl:unmanaged"] && !folds["sl:parent"] && !folds["sl:included"], "fold cards: actionable sections open, kept ones closed: " + JSON.stringify(folds));
assert((await page.textContent("#sl-summary")).includes("State could not be read for 1 component(s)"), "error list names the failed read");
assert((await page.textContent("#sl-sel-count")) === "8 to remove", "8 to remove (6 + 2 shells)");

// ---- find / type filter ----
await page.fill("#sl-find", "salesperson");
assert((await page.textContent("#sl-shown")) === "1 of 19 components", "search: 1 of 19: " + (await page.textContent("#sl-shown")));
assert(await page.isHidden("#sl-shell"), "sections with no match are hidden while filtering");
await page.fill("#sl-find", "");
await page.selectOption("#sl-type", "60");
assert((await page.textContent("#sl-shown")) === "2 of 19 components", "type filter Form: 2 of 19");
await page.selectOption("#sl-type", "");
assert((await page.textContent("#sl-shown")) === "19 components", "filters cleared: 19 components");

// E2E_SHOTS=1 writes a synthetic screenshot (docs/img-synthetic/slim.png, gitignored; not for the README)
if (process.env.E2E_SHOTS) await page.screenshot({ path: resolve(TOOL, "docs/img-synthetic/slim.png"), fullPage: false });

// ---- export ----
await page.click("#sl-export-md");
await page.click("#sl-export-csv");
let saved = await M(() => window.__mock.saved);
const md = saved.find((s) => s.name.endsWith(".md"));
const csv = saved.find((s) => s.name.endsWith(".csv"));
assert(md && md.content.includes("- [ ] Security role Salesperson") && md.content.includes("## Convert to shell (2)"), "Markdown export lists removals and shells");
assert(csv && csv.content.startsWith("verdict,type,name") && csv.content.split("\n").filter(Boolean).length === 20, "CSV export: header + 19 rows");

// ---- overrides + preview ----
await page.uncheck(`#sl-remove li.slim-row[data-key="20:${ID.R1}"] input`);
assert((await page.textContent("#sl-sel-count")) === "7 to remove (1 changed by hand)", "untick Salesperson: 7 to remove, 1 changed by hand");
await page.click("#sl-preview");
await page.waitForSelector("#sl-ops li");
let ops = await page.$$eval("#sl-ops li .mono", (els) => els.map((e) => e.textContent));
assert(ops.length === 7 && !ops.some((o) => o.includes("Salesperson")), "preview honours the override: 7 operations, none on Salesperson");
await page.check(`#sl-remove li.slim-row[data-key="20:${ID.R1}"] input`);
assert(await page.isHidden("#sl-fix-actions"), "changing a tick drops the plan");
await page.click("#sl-preview");
await page.waitForSelector("#sl-ops li");
ops = await page.$$eval("#sl-ops li .mono", (els) => els.map((e) => e.textContent));
const expected = [
  "RemoveSolutionComponent Table account",
  "AddSolutionComponent Table account (DoNotIncludeSubcomponents)",
  "AddSolutionComponent Column sss_custom",
  "AddSolutionComponent Form Account main form",
  "RemoveSolutionComponent Table msdyn_workorder",
  "RemoveSolutionComponent Form Contact main",
  "RemoveSolutionComponent Table contact",
  "RemoveSolutionComponent Security role Salesperson",
];
assert(JSON.stringify(ops) === JSON.stringify(expected), "plan: shell account (remove, add shell, re-add kept), remove msdyn_workorder whole, subcomponent before its table, then roots: " + ops.join(" | "));
assert((await page.textContent("#sl-plan")).includes("7 components leave the solution, 2 tables converted"), "plan header counts leaving components and shells");

// ---- backup → confirm ----
assert(await page.$eval("#sl-confirm", (b) => b.disabled), "Confirm disabled until the backup is saved");
await page.click("#sl-backup");
await page.waitForFunction(() => !document.querySelector("#sl-confirm").disabled);
saved = await M(() => window.__mock.saved);
const backup = saved.at(-1);
const bk = JSON.parse(backup.content);
assert(bk.kind === "sss-dependency-cleaner-backup" && bk.membership.length === 19 && bk.operations.length === 8 && bk.environment.url === "https://sss-dev.crm4.dynamics.com", "backup: full membership (19) + the 8 operations");
await page.click("#sl-confirm");
await okWrite("SSS Dev", "https://sss-dev.crm4.dynamics.com", "8 operations on solution SssCore: 7 components leave the solution, 2 tables converted to shells");
await page.waitForSelector("#sl-rerun", { timeout: 15000 });
const writes = (await M(() => window.__mock.executes)).filter((e) => e.operationName !== "RetrieveCurrentOrganization");
assert(writes.length === 8 && writes.every((e) => e.target === "primary" && e.parameters.SolutionUniqueName === "SssCore"), "8 writes on Dev, all on SssCore");
assert(writes[0].operationName === "RemoveSolutionComponent" && writes[0].parameters.ComponentType === 1 && writes[0].parameters.SolutionComponent?.solutioncomponentid === ID.E2 && writes[0].parameters.SolutionComponent["@odata.type"] === "Microsoft.Dynamics.CRM.solutioncomponent" && !("ComponentId" in writes[0].parameters) && writes[1].parameters.DoNotIncludeSubcomponents === true && writes[2].parameters.ComponentId === ID.C2, "request shapes: SolutionComponent reference for Remove, ComponentId for Add, DoNotIncludeSubcomponents");
const results = await page.$$eval("#sl-results-table tbody tr", (els) => els.map((e) => e.querySelector("td:last-child").textContent));
assert(results.length === 8 && results.every((r) => r === "ok"), "results: 8 ok");
assert((await page.textContent("#sl-rerun")).includes("8 → 0 to remove"), "analyzed again: 8 → 0 to remove: " + (await page.textContent("#sl-rerun")));
const after = await M(() => window.__mock.members());
assert(after.length === 12 && after.find((m) => m.objectid === ID.E2).rootcomponentbehavior === 1 && !after.some((m) => [ID.E3, ID.E4, ID.F2, ID.R1, ID.C3, ID.V1, ID.C4].includes(m.objectid)), "membership after: 12 rows, account as a shell, the 7 leavers gone");
assert((await page.textContent("#sl-counts")).includes("2 parents kept") && (await page.textContent("#sl-parent")).includes("account"), "after: account (shell, pristine) kept as parent of sss_custom and the form");

// ---- restore from the backup puts everything back ----
await page.click('.tab[data-tab="restore"]');
await M((t) => { window.__mock.nextText = t; }, backup.content);
await page.click("#btn-load-backup");
await page.waitForSelector("#restore-ops li");
const rops = await page.$$eval("#restore-ops > li .mono", (els) => els.map((e) => e.textContent));
assert(rops.some((o) => o.startsWith("RemoveSolutionComponent Table account")) && rops.some((o) => o === "AddSolutionComponent Table account") && rops.some((o) => o === "AddSolutionComponent Table msdyn_workorder") && rops.some((o) => o === "AddSolutionComponent Table contact (DoNotIncludeSubcomponents)") && rops.some((o) => o.includes("Contact main")) && rops.some((o) => o.includes("Salesperson")), "restore plan: account back to all assets, tables and components re-added: " + rops.join(" | "));
await page.click("#btn-restore-apply");
await okWrite("SSS Dev", "https://sss-dev.crm4.dynamics.com", "on solution SssCore, back to the backup of");
await page.waitForFunction(() => window.__mock.notes.some((n) => n.title === "Restored"));
const restored = await M(() => window.__mock.members());
assert(restored.length === 19 && restored.find((m) => m.objectid === ID.E2).rootcomponentbehavior === 0, "membership restored: 19 rows, account with all assets");
await page.click('.tab[data-tab="slim"]');
await page.click("#sl-run");
await page.waitForFunction(() => /6 to remove/.test(document.querySelector("#sl-counts")?.textContent ?? ""), null, { timeout: 15000 });
assert(true, "after restore the analysis lists the 6 removals again");

// ---- the option survives reopening the tool ----
await page.uncheck("#sl-parents");
assert(await page.isVisible("#sl-parents-note"), "changing the option after an analysis asks to analyze again");
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#sl-solution option[value]:not([value=''])").length > 0);
assert(!(await page.isChecked("#sl-parents")), "Keep parents unticked is restored after reload");
await page.click('.tab[data-tab="slim"]');
await page.selectOption("#sl-solution", ID.core);
await page.click("#sl-run");
await page.waitForSelector("#sl-counts", { timeout: 15000 });
assert(/7 to remove/.test(await page.textContent("#sl-counts")) && !/parent kept/.test(await page.textContent("#sl-counts")), "Keep parents off: the env var definition moves to Remove (7)");
await page.check("#sl-parents");

await finish();

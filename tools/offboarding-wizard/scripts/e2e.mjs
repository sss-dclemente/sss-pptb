// E2E smoke test for the dist build with a mocked PPTB host (window.toolboxAPI / window.dataverseAPI).
//
// Fixture: leaver Ana Silva (Sales BU, manager Zoe, enabled) holds
//   - 3 accounts + 2 contacts (two scanned tables; a third table "sss_locked" rejects the owner filter)
//   - 1 active modern flow + 1 draft classic workflow, plus an activation copy the OData filter excludes
//   - 1 personal view, 1 personal chart, 1 owned queue, 1 queue membership
//   - 1 owner team ("Sales EU") and 1 Entra group team (skipped by the planner)
//   - 3 security roles, 1 field security profile, 1 connection reference, 1 connection, 1 direct report
// Successor: Bruno Costa. One account (ACC_3) always fails its update so a failed row surfaces.
//
// One mock serves three fixture variants, picked with ?v= on the URL, so behaviours that need a
// different environment can be asserted without a second mock:
//   (none)  successor in the leaver's business unit and holding nothing of theirs; "share to previous
//           owner on assign" ON; OwnershipType as the Web API's string.
//   v=bu    successor in ANOTHER business unit, so every role must be remapped through
//           parentrootroleid, and already holding one role, one field security profile and one team;
//           "share to previous owner on assign" OFF; OwnershipType as the metadata API's flags integer.
//   v=big   one table with more rows than a single page, so @odata.count saturates at 5 000.
//
// Run: npm run build && node scripts/e2e.mjs   (needs playwright + chromium available)
// Set E2E_SHOTS=1 to refresh docs/img/*.png from this run.
import { mkdirSync } from "node:fs";
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SHOTS = process.env.E2E_SHOTS ? `${TOOL}/docs/img` : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const MOCK = `
(() => {
  const VARIANT = new URLSearchParams(location.search).get('v') ?? '';
  const OTHER_BU = VARIANT === 'bu';
  // Dataverse returns at most this many rows per request and its @odata.count saturates here too.
  const PAGE_LIMIT = 5000;

  const BU_SALES = 'b0000000-0000-0000-0000-000000000002', BU_OPS = 'b0000000-0000-0000-0000-000000000003';
  const ANA = 'a0000000-0000-0000-0000-000000000001', BRUNO = 'a0000000-0000-0000-0000-000000000002';
  const ZOE = 'a0000000-0000-0000-0000-000000000003', DANI = 'a0000000-0000-0000-0000-000000000004';
  const ACC = (n) => 'e0000000-0000-0000-0000-00000000000' + n;
  const CON = (n) => 'e1000000-0000-0000-0000-00000000000' + n;
  const BIG = (n) => 'e2000000-0000-0000-0000-' + String(n).padStart(12, '0');
  const T_EU = 'd0000000-0000-0000-0000-000000000001', T_AAD = 'd0000000-0000-0000-0000-000000000002';
  // The leaver's roles live in Sales; the same roles exist once more in Ops sharing a root role id.
  // The root ids deliberately start with a digit: a $filter on them must not parse as a number.
  const R_SALES = 'c0000000-0000-0000-0000-000000000001', R_BASIC = 'c0000000-0000-0000-0000-000000000002';
  const R_LOCAL = 'c0000000-0000-0000-0000-000000000003';
  const R_SALES_OPS = 'c1000000-0000-0000-0000-000000000001', R_BASIC_OPS = 'c1000000-0000-0000-0000-000000000002';
  const ROOT_SALES = '12000000-0000-0000-0000-000000000001', ROOT_BASIC = '12000000-0000-0000-0000-000000000002';
  const ROOT_LOCAL = '12000000-0000-0000-0000-000000000003';
  const FSP = 'f0000000-0000-0000-0000-000000000001';
  const FLOW_MODERN = '10000000-0000-0000-0000-000000000001', FLOW_CLASSIC = '10000000-0000-0000-0000-000000000002';
  const VIEW = '20000000-0000-0000-0000-000000000001', CHART = '30000000-0000-0000-0000-000000000001';
  const QUEUE_OWNED = '40000000-0000-0000-0000-000000000001', QUEUE_MEMBER = '40000000-0000-0000-0000-000000000002';
  const CONNREF = '50000000-0000-0000-0000-000000000001', CONN = '60000000-0000-0000-0000-000000000001';
  const ORG = '70000000-0000-0000-0000-000000000001';
  window.__ids = { ANA, BRUNO, T_EU, T_AAD, R_SALES, R_BASIC, R_LOCAL, R_SALES_OPS, R_BASIC_OPS, FSP, FLOW_MODERN, VIEW, CHART, QUEUE_OWNED, CONNREF, CONN, DANI, ACC3: ACC(3) };

  const user = (id, name, mgr, bu, extra) => Object.assign({
    systemuserid: id, fullname: name, domainname: name.split(' ')[0].toLowerCase() + '@sss.test',
    internalemailaddress: name.split(' ')[0].toLowerCase() + '@sss.test', _businessunitid_value: bu,
    _parentsystemuserid_value: mgr, isdisabled: false, accessmode: 0, applicationid: null,
  }, extra ?? {});
  const users = [
    user(ANA, 'Ana Silva', ZOE, BU_SALES),
    user(BRUNO, 'Bruno Costa', ZOE, OTHER_BU ? BU_OPS : BU_SALES),
    user(ZOE, 'Zoe Martins', null, BU_SALES),
    user(DANI, 'Dani Lopes', ANA, BU_SALES),
  ];

  const accounts = [1, 2, 3].map((n) => ({ accountid: ACC(n), name: 'Account ' + n, _ownerid_value: ANA }));
  const contacts = [1, 2].map((n) => ({ contactid: CON(n), fullname: 'Contact ' + n, _ownerid_value: ANA }));

  const sets = {
    systemusers: { key: 'systemuserid', rows: users },
    businessunits: { key: 'businessunitid', rows: [{ businessunitid: BU_SALES, name: 'Sales' }, { businessunitid: BU_OPS, name: 'Operations' }] },
    organizations: { key: 'organizationid', rows: [{ organizationid: ORG, name: 'SSS Dev', sharetopreviousowneronassign: !OTHER_BU }] },
    teams: { key: 'teamid', rows: [{ teamid: T_EU, name: 'Sales EU', teamtype: 0, _businessunitid_value: BU_SALES }, { teamid: T_AAD, name: 'Entra Sales', teamtype: 2, _businessunitid_value: BU_SALES }] },
    roles: { key: 'roleid', rows: [
      { roleid: R_SALES, name: 'Sales Person', _businessunitid_value: BU_SALES, _parentrootroleid_value: ROOT_SALES },
      { roleid: R_BASIC, name: 'Basic User', _businessunitid_value: BU_SALES, _parentrootroleid_value: ROOT_BASIC },
      { roleid: R_LOCAL, name: 'Sales Only', _businessunitid_value: BU_SALES, _parentrootroleid_value: ROOT_LOCAL },
      { roleid: R_SALES_OPS, name: 'Sales Person', _businessunitid_value: BU_OPS, _parentrootroleid_value: ROOT_SALES },
      { roleid: R_BASIC_OPS, name: 'Basic User', _businessunitid_value: BU_OPS, _parentrootroleid_value: ROOT_BASIC },
    ] },
    accounts: { key: 'accountid', rows: accounts },
    contacts: { key: 'contactid', rows: contacts },
    sss_lockeds: { key: 'sss_lockedid', rows: [], reject: 'owner filter not supported on sss_locked' },
    workflows: { key: 'workflowid', rows: [
      { workflowid: FLOW_MODERN, name: 'Notify on new lead', category: 5, statecode: 1, type: 1, _ownerid_value: ANA },
      { workflowid: FLOW_CLASSIC, name: 'Legacy escalation', category: 0, statecode: 0, type: 1, _ownerid_value: ANA },
      { workflowid: 'x', name: 'activation copy', category: 5, statecode: 1, type: 2, _ownerid_value: ANA },
    ] },
    userqueries: { key: 'userqueryid', rows: [{ userqueryid: VIEW, name: 'My open accounts', returnedtypecode: 'account', _ownerid_value: ANA }] },
    userqueryvisualizations: { key: 'userqueryvisualizationid', rows: [{ userqueryvisualizationid: CHART, name: 'Pipeline by owner', primaryentitytypecode: 'opportunity', _ownerid_value: ANA }] },
    queues: { key: 'queueid', rows: [{ queueid: QUEUE_OWNED, name: 'Ana inbox', queuetypecode: 1, _ownerid_value: ANA }] },
    connectionreferences: { key: 'connectionreferenceid', rows: [{ connectionreferenceid: CONNREF, connectionreferencedisplayname: 'SharePoint (Ana)', connectionreferencelogicalname: 'sss_sharepoint', connectorid: 'shared_sharepointonline', _ownerid_value: ANA }] },
    connections: { key: 'connectionid', rows: [{ connectionid: CONN, name: 'Ana SharePoint connection', statuscode: 1, _ownerid_value: ANA }] },
  };
  // In the other-business-unit variant the successor already holds the Ops copy of "Basic User", the
  // field security profile and the owner team: each of those must be skipped rather than planned.
  const expand = {
    teammembership_association: Object.assign({ [ANA]: [sets.teams.rows[0], sets.teams.rows[1]] }, OTHER_BU ? { [BRUNO]: [sets.teams.rows[0]] } : {}),
    systemuserroles_association: Object.assign({ [ANA]: sets.roles.rows.slice(0, 3) }, OTHER_BU ? { [BRUNO]: [sets.roles.rows[4]] } : {}),
    systemuserprofiles_association: Object.assign({ [ANA]: [{ fieldsecurityprofileid: FSP, name: 'Margin Readers' }] }, OTHER_BU ? { [BRUNO]: [{ fieldsecurityprofileid: FSP, name: 'Margin Readers' }] } : {}),
    queuemembership_association: { [ANA]: [{ queueid: QUEUE_MEMBER, name: 'Support triage' }] },
  };

  // The $filter subset this tool emits: conjuncts joined by "and", each one a single predicate or a
  // parenthesised "or" list, over GUID equality, numeric equality, "eq null" and contains(). The real
  // service ANDs and ORs properly and so must the mock: "roles in this business unit whose root is one
  // of these" is exactly an "A and (B or C)" filter, and treating it as one flat OR would hand back
  // roles from the wrong business unit. An unsupported term throws rather than silently matching
  // everything. (A search term containing " and " / " or " would confuse the split; none does here.)
  const term = (t, r) => {
    let m = /^(\\w+) eq ([0-9a-f-]{36})$/i.exec(t);
    if (m) return String(r[m[1]] ?? '').toLowerCase() === m[2].toLowerCase();
    // Anchored on both ends on purpose: without the trailing anchor a GUID like
    // 12000000-0000-... would be read as the number 12000000 and match nothing.
    m = /^(\\w+) eq (\\d{1,9})$/.exec(t);
    if (m) return Number(r[m[1]]) === Number(m[2]);
    m = /^(\\w+) eq null$/.exec(t);
    if (m) return r[m[1]] == null;
    m = /^contains\\((\\w+),'([^']*)'\\)$/.exec(t);
    if (m) return String(r[m[1]] ?? '').toLowerCase().includes(m[2].toLowerCase());
    throw new Error('mock: unsupported $filter term "' + t + '"');
  };
  const matches = (f, r) =>
    f.split(/ and /).every((conj) => {
      const inner = conj.startsWith('(') && conj.endsWith(')') ? conj.slice(1, -1) : conj;
      return inner.split(/ or /).some((t) => term(t.trim(), r));
    });

  window.__calls = [];
  window.__writes = [];
  const queryData = async (q) => {
    window.__calls.push(q);
    const [set, rest = ''] = q.split('?');
    const src = sets[set];
    if (!src) throw new Error('mock: unknown set ' + set);
    if (src.reject) throw new Error(src.reject);
    const params = Object.fromEntries(rest.split('&').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]; }));
    let rows = src.rows;
    const f = (params.$filter ?? '').trim();
    if (f) rows = rows.filter((r) => matches(f, r));
    if (params.$expand) {
      const name = params.$expand.split('(')[0];
      rows = rows.map((r) => ({ ...r, [name]: (expand[name] ?? {})[r[src.key]] ?? [] }));
    }
    const out = { value: [] };
    // The count annotation saturates at one page: a table with 5 000 rows and one with a million both
    // report exactly 5 000, which is why the tool has to call such a count approximate.
    if (params.$count === 'true') out['@odata.count'] = Math.min(rows.length, PAGE_LIMIT);
    if (params.$top) rows = rows.slice(0, Number(params.$top));
    out.value = rows.map((r) => ({ ...r }));
    return out;
  };
  const lbl = (s) => ({ UserLocalizedLabel: { Label: s }, LocalizedLabels: [{ Label: s, LanguageCode: 1033 }] });
  // The Web API returns OwnershipType as a string, the client metadata API as the OwnershipTypes flags
  // integer (UserOwned 1, TeamOwned 2, OrganizationOwned 8). The v=bu variant serves the integers.
  const OWNED = OTHER_BU ? 1 : 'UserOwned', ORG_OWNED = OTHER_BU ? 8 : 'OrganizationOwned', NO_OWNER = OTHER_BU ? 0 : 'None';
  const entities = [
    { LogicalName: 'account', DisplayName: lbl('Account'), EntitySetName: 'accounts', PrimaryNameAttribute: 'name', PrimaryIdAttribute: 'accountid', OwnershipType: OWNED, IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'contact', DisplayName: lbl('Contact'), EntitySetName: 'contacts', PrimaryNameAttribute: 'fullname', PrimaryIdAttribute: 'contactid', OwnershipType: OWNED, IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'sss_locked', DisplayName: lbl('Locked thing'), EntitySetName: 'sss_lockeds', PrimaryNameAttribute: 'sss_name', PrimaryIdAttribute: 'sss_lockedid', OwnershipType: OWNED, IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'sss_config', DisplayName: lbl('Config'), EntitySetName: 'sss_configs', PrimaryIdAttribute: 'sss_configid', OwnershipType: ORG_OWNED, IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'accountleads', DisplayName: lbl('Account Leads'), EntitySetName: 'accountleadscollection', PrimaryIdAttribute: 'accountleadid', OwnershipType: NO_OWNER, IsIntersect: true, IsPrivate: false, IsLogicalEntity: false },
  ];
  if (VARIANT === 'big') {
    sets.sss_bigs = { key: 'sss_bigid', rows: Array.from({ length: PAGE_LIMIT + 1 }, (_, i) => ({ sss_bigid: BIG(i), sss_name: 'Big ' + i, _ownerid_value: ANA })) };
    entities.push({ LogicalName: 'sss_big', DisplayName: lbl('Big table'), EntitySetName: 'sss_bigs', PrimaryNameAttribute: 'sss_name', PrimaryIdAttribute: 'sss_bigid', OwnershipType: OWNED, IsIntersect: false, IsPrivate: false, IsLogicalEntity: false });
  }
  window.__saved = [];
  window.__handlers = [];
  window.__emit = (payload) => window.__handlers.forEach((h) => h({}, payload));
  window.dataverseAPI = {
    queryData,
    getAllEntitiesMetadata: async () => ({ value: entities }),
    update: async (entity, id, record) => {
      window.__writes.push({ op: 'update', entity, id, record });
      if (id === ACC(3)) throw new Error('privilege denied on Account 3');
    },
    associate: async (entity, id, relationship, relatedEntity, relatedId) => { window.__writes.push({ op: 'associate', entity, id, relationship, relatedEntity, relatedId }); },
    disassociate: async (entity, id, relationship, relatedId) => { window.__writes.push({ op: 'disassociate', entity, id, relationship, relatedId }); },
    execute: async () => { throw new Error('mock: execute must not be used'); },
  };
  window.toolboxAPI = {
    connections: { getActiveConnection: async () => ({ id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' }), getSecondaryConnection: async () => null },
    utils: { getCurrentTheme: async () => 'light', showNotification: async (o) => { (window.__notes ??= []).push(o); } },
    events: { on: (h) => window.__handlers.push(h) },
    fileSystem: { selectPath: async () => null, readBinary: async () => new Uint8Array(), readText: async () => '', saveFile: async (name, content) => { window.__saved.push({ name, content }); return '/tmp/' + name; } },
  };
})();
`;

const { browser, page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto("file://" + TOOL + "/dist/index.html");

const text = (sel) => page.textContent(sel);
const tab = (name) => page.click(`.tab[data-tab='${name}']`);
const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
};
/** "N operations" out of a summary line, so the estimate and the plan can be compared as numbers. */
const opCount = (s) => Number((s.match(/(\d+) operation/) ?? [])[1] ?? NaN);

assert((await text("#host-mode")).includes("inside Power Platform ToolBox"), "toolbox host detected");
assert((await text("#conn")).includes("SSS Dev"), "connection chip");
assert((await text("#tab-leaver")).includes("No leaver selected"), "leaver empty state");

// ---- 1. leaver ----
await page.fill("#leaver-q", "ana");
await page.waitForSelector("#leaver-results li button");
assert((await text("#leaver-results")).includes("Ana Silva"), "leaver suggestions");
await page.click("#leaver-results li button");
await page.waitForFunction(() => document.querySelector("#leaver-kv")?.textContent.includes("Ana Silva"));
const kv = await text("#leaver-kv");
assert(kv.includes("Sales") && kv.includes("Zoe Martins") && kv.includes("Read-Write"), "leaver BU, manager and access mode");
assert((await text("#leaver-reports")) === "1", "direct report count");
assert((await text("#leaver-chip")).includes("Ana Silva"), "leaver chip in the topbar");

// ---- 2. inventory (categories load without a scan) ----
await tab("inventory");
const inv = await text("#inventory-body");
assert(inv.includes("Notify on new lead") && inv.includes("active modern flow"), "active modern flow flagged as high risk");
assert(!inv.includes("activation copy"), "workflow activation copies filtered out");
assert(inv.includes("My open accounts") && inv.includes("Pipeline by owner"), "personal view and chart listed");
assert(inv.includes("Ana inbox") && inv.includes("Support triage"), "owned queue and queue membership listed");
assert(inv.includes("Sales EU") && inv.includes("owner team: records owned by the team stay"), "owner team flagged");
assert(inv.includes("Entra Sales") && inv.includes("membership comes from Entra"), "Entra team flagged");
assert(inv.includes("Sales Person") && inv.includes("Basic User") && inv.includes("Margin Readers"), "roles and field profile listed");
assert(inv.includes("SharePoint (Ana)") && inv.includes("re-authenticate"), "connection reference listed with its caveat");
assert(inv.includes("Ana SharePoint connection") && inv.includes("does not re-authenticate it"), "connection listed with its sign-in caveat");
assert(inv.includes("Dani Lopes"), "direct report listed");
assert(inv.includes("Not scanned yet"), "records category starts unscanned");

// ---- records scan ----
await page.click("#btn-scan");
await page.waitForSelector("dialog[open]");
assert((await text("#dlg-body")).includes("3 requests"), "scan dialog states the request count (user/team owned tables only)");
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#scan-note"));
const note = await text("#scan-note");
assert(note.includes("3 of 3 tables scanned") && note.includes("2 with records") && note.includes("1 not scanned"), "scan summary: " + note);
const scanRows = await page.$$eval("table.scan tbody tr", (r) => r.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
assert(scanRows.length === 2 && scanRows[0].includes("Account") && scanRows[0].includes("3") && scanRows[1].includes("Contact"), "scan rows sorted by count");
await page.uncheck("#scan-hide-empty");
await page.waitForFunction(() => document.querySelectorAll("table.scan tbody tr").length === 3);
assert((await text("table.scan")).includes("not scanned: owner filter not supported"), "failing table listed as not scanned, run not broken");
await shot("inventory");

// ---- 3. plan ----
await tab("plan");
assert((await text("#plan-summary")).includes("Records"), "records in the plan summary");
assert(await page.$eval("#btn-preview", (b) => b.disabled), "preview disabled without a successor");
await page.fill("#successor-q", "bruno");
await page.waitForSelector("#successor-results li button");
await page.click("#successor-results li button");
await page.waitForFunction(() => document.querySelector("#successor-chip")?.textContent.includes("Bruno Costa"));
assert(!(await page.$eval("#btn-preview", (b) => b.disabled)), "preview enabled with a successor");
// default options: copy roles + profiles, remove from teams, do not remove from leaver
const summary = await text("#plan-summary");
assert(summary.includes("Security roles") && summary.includes("Team memberships"), "summary lists the selected categories");
await page.check("input[data-opt='roleRemove']");
await page.check("input[data-opt='teamAdd']");
await shot("plan");

// preview
const estimated = opCount(await page.$$eval("#plan-summary p.caption", (e) => e[e.length - 1].textContent));
await page.click("#btn-preview");
await page.waitForSelector("dialog[open]");
const dlg = await text("#dlg-body");
const planned = opCount(await page.$eval("#dlg-body p", (e) => e.textContent));
assert(dlg.includes("Records") && dlg.includes("Flows & classic processes") && dlg.includes("Security roles"), "preview counts per category");
assert(dlg.includes('update account(') && dlg.includes('"ownerid@odata.bind":"/systemusers('), "preview shows the exact owner update call");
assert(dlg.includes("associate systemuser(") && dlg.includes("systemuserroles_association"), "preview shows the role associate call");
assert(dlg.includes("Entra ID and cannot be changed"), "Entra team skip explained in the preview");
assert(dlg.includes("connection behind them still belongs to the leaver"), "connection reference warning in the preview");
assert(dlg.includes('"share to previous owner on assign" enabled') && dlg.includes("shared back to the leaver with full rights"), "share-back warning when the organization row has the setting on");
assert(dlg.includes("deactivates any workflow or business rule currently active on it"), "record moves warn that active workflows and business rules are deactivated");
assert(dlg.includes("only solution-aware cloud flows can change owner this way") && dlg.includes("remains a co-owner") && dlg.includes("up to 7 days"), "flow moves warn about solution-aware flows, co-ownership and the licensing lag");
assert(planned > 0 && estimated === planned, `the estimate matches the plan, Entra group team excluded: ${estimated} vs ${planned}`);
assert(await page.$eval("#dlg-ok", (b) => b.className.includes("btn-danger")), "confirm button uses danger styling");
assert((await page.textContent("#dlg-ok")).startsWith("Apply "), "confirm labels the op count");
assert((await page.evaluate(() => window.__writes.length)) === 0, "nothing written before confirm");

// cancel first: still nothing written
await page.click("#dlg-cancel");
await page.waitForFunction(() => !document.querySelector("dialog[open]"));
assert((await page.evaluate(() => window.__writes.length)) === 0, "cancel writes nothing");

// confirm
await page.click("#btn-preview");
await page.waitForSelector("dialog[open]");
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#result-summary"));

// ---- 4. writes recorded by the mock ----
const writes = await page.evaluate(() => window.__writes);
const ids = await page.evaluate(() => window.__ids);
const has = (p) => writes.some((w) => Object.entries(p).every(([k, v]) => JSON.stringify(w[k]) === JSON.stringify(v)));
assert(writes.filter((w) => w.entity === "account" && w.op === "update").length === 3, "3 account records reassigned");
assert(writes.filter((w) => w.entity === "contact").length === 2, "2 contact records reassigned");
assert(has({ op: "update", entity: "account", record: { "ownerid@odata.bind": `/systemusers(${ids.BRUNO})` } }), "records bound to the successor user");
assert(has({ op: "update", entity: "workflow", id: ids.FLOW_MODERN }), "modern flow reassigned");
assert(has({ op: "update", entity: "userquery", id: ids.VIEW }) && has({ op: "update", entity: "userqueryvisualization", id: ids.CHART }), "personal view and chart reassigned");
assert(has({ op: "update", entity: "queue", id: ids.QUEUE_OWNED }), "owned queue reassigned");
assert(has({ op: "update", entity: "connectionreference", id: ids.CONNREF }), "connection reference reassigned");
assert(has({ op: "update", entity: "connection", id: ids.CONN }), "connection reassigned");
assert(has({ op: "update", entity: "systemuser", id: ids.DANI, record: { "parentsystemuserid@odata.bind": `/systemusers(${ids.BRUNO})` } }), "direct report manager reassigned");
assert(has({ op: "associate", entity: "systemuser", id: ids.BRUNO, relationship: "systemuserroles_association", relatedEntity: "role", relatedId: ids.R_SALES }), "role copied to the successor");
assert(has({ op: "disassociate", entity: "systemuser", id: ids.ANA, relationship: "systemuserroles_association", relatedId: ids.R_BASIC }), "role removed from the leaver");
assert(has({ op: "associate", entity: "systemuser", id: ids.BRUNO, relationship: "systemuserprofiles_association", relatedEntity: "fieldsecurityprofile", relatedId: ids.FSP }), "field security profile copied");
assert(has({ op: "associate", entity: "team", id: ids.T_EU, relationship: "teammembership_association", relatedEntity: "systemuser", relatedId: ids.BRUNO }), "successor added to the owner team");
assert(has({ op: "disassociate", entity: "team", id: ids.T_EU, relationship: "teammembership_association", relatedId: ids.ANA }), "leaver removed from the owner team");
assert(!writes.some((w) => w.id === ids.T_AAD), "Entra group team never touched");
assert(!writes.some((w) => w.entity === "systemuser" && w.id === ids.ANA && w.op === "update"), "the leaver's own user row is never updated (no disable, no licence)");

// ---- failed row ----
const resultRows = await page.$$eval("table.results tbody tr", (r) => r.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
const failedRow = resultRows.find((r) => r.includes("privilege denied on Account 3"));
assert(!!failedRow, "the failing write surfaces as a failed row");
assert((await text("#result-summary")).match(/^\d+ ok · 1 failed$/), "result summary counts one failure: " + (await text("#result-summary")));
assert(resultRows.length === writes.length, "one result row per operation");

// ---- exports ----
await page.click("#btn-export-inv-json");
await page.click("#btn-export-inv-csv");
await page.click("#btn-export-res-json");
await page.click("#btn-export-res-csv");
await page.waitForFunction(() => window.__saved.length === 4);
const saved = await page.evaluate(() => window.__saved);
const invJson = JSON.parse(saved[0].content);
const cat = (k) => invJson.categories.find((c) => c.key === k);
assert(saved[0].name === "ana_sss.test.offboarding-inventory.json", "inventory JSON file name: " + saved[0].name);
assert(invJson.leaver.name === "Ana Silva" && invJson.environment.includes("SSS Dev"), "inventory JSON header");
assert(invJson.recordScan.withRecords.length === 2 && invJson.recordScan.notScanned[0].table === "sss_locked", "inventory JSON scan section");
assert(cat("workflows").items.length === 2 && cat("connections").items.length === 1, "inventory JSON categories");
assert(invJson.categories.every((c) => c.error === null), "every inventory category read cleanly");
assert(invJson.remainingManualSteps.some((s) => s.includes("Disable the leaver")), "inventory JSON lists the manual steps");
assert(saved[1].content.includes("records,account,,Account,3 owned,") && saved[1].content.includes("not scanned"), "inventory CSV");
const resJson = JSON.parse(saved[2].content);
assert(resJson.summary.failed === 1 && resJson.summary.ok === writes.length - 1 && resJson.successor.name === "Bruno Costa", "results JSON summary");
assert(resJson.operations.some((o) => o.call.startsWith("associate systemuser(") && o.ok), "results JSON keeps the exact call");
assert(saved[3].content.startsWith("category,kind,target,detail,call,result,error") && saved[3].content.includes("privilege denied on Account 3"), "results CSV");

// ---- theme ----
await page.evaluate(() => window.__emit({ event: "settings:updated", data: { theme: "dark" } }));
assert((await page.getAttribute("html", "data-theme")) === "dark", "dark theme applied from settings:updated");
await tab("report");
await shot("report-dark");

// ---- other fixture variants ----
/** A fresh page on one fixture variant, walked from the leaver to an open preview dialog. */
const previewRun = async (variant, { cap = null, options = ["roleRemove", "teamAdd"] } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(MOCK);
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  p.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text());
  });
  await p.goto(`file://${TOOL}/dist/index.html?v=${variant}`);
  await p.fill("#leaver-q", "ana");
  await p.waitForSelector("#leaver-results li button");
  await p.click("#leaver-results li button");
  await p.waitForFunction(() => document.querySelector("#leaver-kv")?.textContent.includes("Ana Silva"));
  await p.click(".tab[data-tab='inventory']");
  await p.click("#btn-scan");
  await p.waitForSelector("dialog[open]");
  const scanDialog = await p.textContent("#dlg-body");
  await p.click("#dlg-ok");
  await p.waitForFunction(() => document.querySelector("#scan-note"));
  const rows = await p.$$eval("table.scan tbody tr", (r) => r.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
  await p.click(".tab[data-tab='plan']");
  await p.fill("#successor-q", "bruno");
  await p.waitForSelector("#successor-results li button");
  await p.click("#successor-results li button");
  await p.waitForFunction(() => document.querySelector("#successor-chip")?.textContent.includes("Bruno Costa"));
  for (const o of options) await p.check(`input[data-opt='${o}']`);
  if (cap != null) {
    await p.fill("#record-cap", String(cap));
    await p.dispatchEvent("#record-cap", "change");
  }
  await p.click("#btn-preview");
  await p.waitForSelector("dialog[open]");
  const body = await p.textContent("#dlg-body");
  const calls = await p.$$eval("table.preview tbody tr td:last-child", (c) => c.map((x) => x.textContent));
  await ctx.close();
  return { scanDialog, rows, body, calls, errs };
};

// ---- 5. successor in another business unit: role remapping, duplicates, setting off, int metadata ----
const bu = await previewRun("bu");
assert(bu.errs.length === 0, "no errors in the other-business-unit run: " + bu.errs.join(" | "));
assert(bu.calls.some((c) => c.startsWith("update account(")) && !bu.body.includes("share to previous owner on assign"), "no share-back warning when the organization row has the setting off");
const roleCopies = bu.calls.filter((c) => c.startsWith(`associate systemuser(${ids.BRUNO}) systemuserroles_association`));
assert(roleCopies.length === 1 && roleCopies[0].includes(`role(${ids.R_SALES_OPS})`) && !roleCopies[0].includes(ids.R_SALES), "a remappable role is granted as the successor's business unit copy, not the leaver's role id");
assert(bu.body.includes(`Role "Sales Only": no equivalent role exists in Bruno Costa's business unit`), "a role with no equivalent in the successor's business unit is skipped with that reason");
const roleRemovals = bu.calls.filter((c) => c.startsWith(`disassociate systemuser(${ids.ANA}) systemuserroles_association`));
assert(
  roleRemovals.length === 3 &&
    roleRemovals.every((c) => [ids.R_SALES, ids.R_BASIC, ids.R_LOCAL].some((r) => c.includes(`(${r})`))) &&
    !roleRemovals.some((c) => c.includes(ids.R_SALES_OPS) || c.includes(ids.R_BASIC_OPS)),
  "the disassociate still uses the leaver's own role ids, not the remapped ones",
);
assert(bu.body.includes('Security role "Basic User": Bruno Costa already has it.') && !bu.calls.some((c) => c.includes(ids.R_BASIC_OPS)), "a role the successor already holds is skipped, not planned");
assert(bu.body.includes('Field security profile "Margin Readers": Bruno Costa already has it.') && !bu.calls.some((c) => c.includes("systemuserprofiles_association")), "a field security profile the successor already holds is skipped, not planned");
assert(bu.body.includes('Team "Sales EU": Bruno Costa is already a member.') && !bu.calls.some((c) => c.startsWith("associate team(")), "a team the successor is already a member of is skipped, not planned");
assert(bu.scanDialog.includes("3 requests"), "OwnershipType as the flags integer: the same 3 user-owned tables are offered");
assert(bu.rows.length === 2 && JSON.stringify(bu.rows) === JSON.stringify(scanRows), "OwnershipType as the flags integer: the scan finds the same tables and counts");

// ---- 6. a table whose @odata.count saturated at the page limit ----
const big = await previewRun("big", { cap: 5 });
assert(big.errs.length === 0, "no errors in the saturated-count run: " + big.errs.join(" | "));
const bigRow = big.rows.find((r) => r.includes("Big table"));
assert(!!bigRow && bigRow.includes("5000+"), "a count saturated at the page limit is marked approximate in the inventory, not shown as an exact 5000");
assert(big.body.includes("Big table: 5000 or more records owned, only the first 5 are in this plan"), "the plan reports a saturated count as “or more”");

// ---- no host: the tool still renders ----
const bareCtx = await browser.newContext();
const bare = await bareCtx.newPage();
const bareErrors = [];
bare.on("pageerror", (e) => bareErrors.push(e.message));
await bare.goto("file://" + TOOL + "/dist/index.html");
await bare.waitForSelector("#host-mode");
assert((await bare.textContent("#host-mode")).includes("Not running inside ToolBox"), "degrades outside ToolBox");
assert((await bare.textContent("#tab-leaver")).includes("No leaver selected"), "renders its empty state with no host");
assert(bareErrors.length === 0, "no errors without a host: " + bareErrors.join(" | "));
await bareCtx.close();

await finish();

// E2E smoke test for the dist build with a mocked PPTB host (window.toolboxAPI / window.dataverseAPI).
//
// Fixture: leaver Ana Silva (Sales BU, manager Zoe, enabled) holds
//   - 3 accounts + 2 contacts (two scanned tables; a third table "sss_locked" rejects the owner filter)
//   - 1 active modern flow + 1 draft classic workflow
//   - 1 personal view, 1 personal chart, 1 owned queue, 1 queue membership
//   - 1 owner team ("Sales EU") and 1 Entra group team (skipped by the planner)
//   - 2 security roles, 1 field security profile, 1 connection reference, 1 direct report
// Successor: Bruno Costa. One account (ACC_3) always fails its update so a failed row surfaces.
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
  const BU_SALES = 'b0000000-0000-0000-0000-000000000002';
  const ANA = 'a0000000-0000-0000-0000-000000000001', BRUNO = 'a0000000-0000-0000-0000-000000000002';
  const ZOE = 'a0000000-0000-0000-0000-000000000003', DANI = 'a0000000-0000-0000-0000-000000000004';
  const ACC = (n) => 'e0000000-0000-0000-0000-00000000000' + n;
  const CON = (n) => 'e1000000-0000-0000-0000-00000000000' + n;
  const T_EU = 'd0000000-0000-0000-0000-000000000001', T_AAD = 'd0000000-0000-0000-0000-000000000002';
  const R_SALES = 'c0000000-0000-0000-0000-000000000001', R_BASIC = 'c0000000-0000-0000-0000-000000000002';
  const FSP = 'f0000000-0000-0000-0000-000000000001';
  const FLOW_MODERN = '10000000-0000-0000-0000-000000000001', FLOW_CLASSIC = '10000000-0000-0000-0000-000000000002';
  const VIEW = '20000000-0000-0000-0000-000000000001', CHART = '30000000-0000-0000-0000-000000000001';
  const QUEUE_OWNED = '40000000-0000-0000-0000-000000000001', QUEUE_MEMBER = '40000000-0000-0000-0000-000000000002';
  const CONNREF = '50000000-0000-0000-0000-000000000001';
  window.__ids = { ANA, BRUNO, T_EU, T_AAD, R_SALES, R_BASIC, FSP, FLOW_MODERN, VIEW, CHART, QUEUE_OWNED, CONNREF, DANI, ACC3: ACC(3) };

  const user = (id, name, mgr, extra) => Object.assign({
    systemuserid: id, fullname: name, domainname: name.split(' ')[0].toLowerCase() + '@sss.test',
    internalemailaddress: name.split(' ')[0].toLowerCase() + '@sss.test', _businessunitid_value: BU_SALES,
    _parentsystemuserid_value: mgr, isdisabled: false, accessmode: 0, applicationid: null,
  }, extra ?? {});
  const users = [user(ANA, 'Ana Silva', ZOE), user(BRUNO, 'Bruno Costa', ZOE), user(ZOE, 'Zoe Martins', null), user(DANI, 'Dani Lopes', ANA)];

  const accounts = [1, 2, 3].map((n) => ({ accountid: ACC(n), name: 'Account ' + n, _ownerid_value: ANA }));
  const contacts = [1, 2].map((n) => ({ contactid: CON(n), fullname: 'Contact ' + n, _ownerid_value: ANA }));

  const sets = {
    systemusers: { key: 'systemuserid', rows: users },
    businessunits: { key: 'businessunitid', rows: [{ businessunitid: BU_SALES, name: 'Sales' }] },
    teams: { key: 'teamid', rows: [{ teamid: T_EU, name: 'Sales EU', teamtype: 0, _businessunitid_value: BU_SALES }, { teamid: T_AAD, name: 'Entra Sales', teamtype: 2, _businessunitid_value: BU_SALES }] },
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
  };
  const expand = {
    teammembership_association: { [ANA]: [sets.teams.rows[0], sets.teams.rows[1]] },
    systemuserroles_association: { [ANA]: [{ roleid: R_SALES, name: 'Sales Person', _businessunitid_value: BU_SALES }, { roleid: R_BASIC, name: 'Basic User', _businessunitid_value: BU_SALES }] },
    systemuserprofiles_association: { [ANA]: [{ fieldsecurityprofileid: FSP, name: 'Margin Readers' }] },
    queuemembership_association: { [ANA]: [{ queueid: QUEUE_MEMBER, name: 'Support triage' }] },
  };

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
    const f = params.$filter ?? '';
    const ids = [...f.matchAll(/(\\w+) eq ([0-9a-f-]{36})/g)];
    const contains = [...f.matchAll(/contains\\((\\w+),'([^']*)'\\)/g)];
    if (ids.length) rows = rows.filter((r) => ids.some(([, k, v]) => String(r[k]).toLowerCase() === v.toLowerCase()));
    if (contains.length) rows = rows.filter((r) => contains.some(([, k, v]) => String(r[k] ?? '').toLowerCase().includes(v.toLowerCase())));
    if (params.$expand) {
      const name = params.$expand.split('(')[0];
      rows = rows.map((r) => ({ ...r, [name]: (expand[name] ?? {})[r[src.key]] ?? [] }));
    }
    const out = { value: [] };
    if (params.$count === 'true') out['@odata.count'] = rows.length;
    if (params.$top) rows = rows.slice(0, Number(params.$top));
    out.value = rows.map((r) => ({ ...r }));
    return out;
  };
  const lbl = (s) => ({ UserLocalizedLabel: { Label: s }, LocalizedLabels: [{ Label: s, LanguageCode: 1033 }] });
  const entities = [
    { LogicalName: 'account', DisplayName: lbl('Account'), EntitySetName: 'accounts', PrimaryNameAttribute: 'name', PrimaryIdAttribute: 'accountid', OwnershipType: 'UserOwned', IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'contact', DisplayName: lbl('Contact'), EntitySetName: 'contacts', PrimaryNameAttribute: 'fullname', PrimaryIdAttribute: 'contactid', OwnershipType: 'UserOwned', IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'sss_locked', DisplayName: lbl('Locked thing'), EntitySetName: 'sss_lockeds', PrimaryNameAttribute: 'sss_name', PrimaryIdAttribute: 'sss_lockedid', OwnershipType: 'UserOwned', IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'sss_config', DisplayName: lbl('Config'), EntitySetName: 'sss_configs', PrimaryIdAttribute: 'sss_configid', OwnershipType: 'OrganizationOwned', IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'accountleads', DisplayName: lbl('Account Leads'), EntitySetName: 'accountleadscollection', PrimaryIdAttribute: 'accountleadid', OwnershipType: 'None', IsIntersect: true, IsPrivate: false, IsLogicalEntity: false },
  ];
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
await page.click("#btn-preview");
await page.waitForSelector("dialog[open]");
const dlg = await text("#dlg-body");
assert(dlg.includes("Records") && dlg.includes("Flows & classic processes") && dlg.includes("Security roles"), "preview counts per category");
assert(dlg.includes('update account(') && dlg.includes('"ownerid@odata.bind":"/systemusers('), "preview shows the exact owner update call");
assert(dlg.includes("associate systemuser(") && dlg.includes("systemuserroles_association"), "preview shows the role associate call");
assert(dlg.includes("Entra ID and cannot be changed"), "Entra team skip explained in the preview");
assert(dlg.includes("connection behind them still belongs to the leaver"), "connection reference warning in the preview");
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
assert(saved[0].name === "ana_sss.test.offboarding-inventory.json", "inventory JSON file name: " + saved[0].name);
assert(invJson.leaver.name === "Ana Silva" && invJson.environment.includes("SSS Dev"), "inventory JSON header");
assert(invJson.recordScan.withRecords.length === 2 && invJson.recordScan.notScanned[0].table === "sss_locked", "inventory JSON scan section");
assert(invJson.categories.find((c) => c.key === "workflows").items.length === 2, "inventory JSON categories");
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

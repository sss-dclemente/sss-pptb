// E2E smoke test for the dist build with a mocked PPTB host (window.toolboxAPI / window.dataverseAPI).
// Fixture: BUs Root > Sales. Ana (Sales) holds "Sales Person" directly (Read Deep, Write/Create Basic,
// Append/AppendTo Local on account) and "Sharer" (Share Local) via owner team "Sales EU". Accounts owned by
// Bruno (Sales, reports to Ana) and Carla (Root); Carla's account shared Write with team Sales EU.
// One secured column (sss_margin) readable through profile "Margin Readers" held by the team.
// Run: npm run build && node scripts/e2e.mjs   (needs playwright + chromium available)
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const MOCK = `
(() => {
  const BU_ROOT = 'b0000000-0000-0000-0000-000000000001', BU_SALES = 'b0000000-0000-0000-0000-000000000002';
  const ANA = 'a0000000-0000-0000-0000-000000000001', BRUNO = 'a0000000-0000-0000-0000-000000000002', CARLA = 'a0000000-0000-0000-0000-000000000003';
  const R_SALES = 'c0000000-0000-0000-0000-000000000001', R_SHARER = 'c0000000-0000-0000-0000-000000000002';
  const T_EU = 'd0000000-0000-0000-0000-000000000001';
  const ACC_B = 'e0000000-0000-0000-0000-000000000001', ACC_C = 'e0000000-0000-0000-0000-000000000002';
  const FSP = 'f0000000-0000-0000-0000-000000000001';
  const P = (n) => 'p' + n.toLowerCase().replace(/[^a-z]/g, '').padEnd(31, '0').slice(0, 31) + '1';
  window.__ids = { ACC_B, ACC_C };

  const privileges = ['prvReadAccount','prvWriteAccount','prvCreateAccount','prvDeleteAccount','prvAppendAccount','prvAppendToAccount','prvAssignAccount','prvShareAccount','prvReadContact']
    .map((name) => ({ privilegeid: P(name), name }));
  const rolePrivs = {
    [R_SALES]: [['prvReadAccount','Deep'],['prvWriteAccount','Basic'],['prvCreateAccount','Basic'],['prvAppendAccount','Local'],['prvAppendToAccount','Local'],['prvReadContact','Global']],
    [R_SHARER]: [['prvShareAccount','Local']],
  };
  const users = [
    { systemuserid: ANA, fullname: 'Ana Silva', domainname: 'ana@sss.test', internalemailaddress: 'ana@sss.test', _businessunitid_value: BU_SALES, _parentsystemuserid_value: null, isdisabled: false, applicationid: null },
    { systemuserid: BRUNO, fullname: 'Bruno Costa', domainname: 'bruno@sss.test', internalemailaddress: 'bruno@sss.test', _businessunitid_value: BU_SALES, _parentsystemuserid_value: ANA, isdisabled: false, applicationid: null },
    { systemuserid: CARLA, fullname: 'Carla Reis', domainname: 'carla@sss.test', internalemailaddress: 'carla@sss.test', _businessunitid_value: BU_ROOT, _parentsystemuserid_value: null, isdisabled: false, applicationid: null },
  ];
  const roles = { [R_SALES]: { roleid: R_SALES, name: 'Sales Person', _businessunitid_value: BU_SALES }, [R_SHARER]: { roleid: R_SHARER, name: 'Sharer', _businessunitid_value: BU_SALES } };
  const teams = [{ teamid: T_EU, name: 'Sales EU', teamtype: 0, _businessunitid_value: BU_SALES }];
  const expand = {
    systemuserroles_association: { [ANA]: [roles[R_SALES]] },
    teammembership_association: { [ANA]: teams },
    systemuserprofiles_association: { [ANA]: [] },
    teamroles_association: { [T_EU]: [roles[R_SHARER]] },
    teamprofiles_association: { [T_EU]: [{ fieldsecurityprofileid: FSP, name: 'Margin Readers' }] },
  };
  const accounts = [
    { accountid: ACC_B, name: 'Bruno Corp', _ownerid_value: BRUNO, '_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'systemuser', '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Bruno Costa', _owningbusinessunit_value: BU_SALES },
    { accountid: ACC_C, name: 'Carla Holdings', _ownerid_value: CARLA, '_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'systemuser', '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Carla Reis', _owningbusinessunit_value: BU_ROOT },
  ];
  const sets = {
    systemusers: { key: 'systemuserid', rows: users },
    teams: { key: 'teamid', rows: teams },
    businessunits: { key: 'businessunitid', rows: [{ businessunitid: BU_ROOT, name: 'Root', _parentbusinessunitid_value: null }, { businessunitid: BU_SALES, name: 'Sales', _parentbusinessunitid_value: BU_ROOT }] },
    privileges: { key: 'privilegeid', rows: privileges },
    organizations: { key: 'organizationid', rows: [{ organizationid: '00000000-0000-0000-0000-000000000009', ishierarchicalsecuritymodelenabled: true }] },
    accounts: { key: 'accountid', rows: accounts },
    fieldpermissions: { key: 'fieldpermissionid', rows: [{ fieldpermissionid: '11111111-0000-0000-0000-000000000001', entityname: 'account', attributelogicalname: 'sss_margin', canread: 4, canupdate: 0, cancreate: 0, _fieldsecurityprofileid_value: FSP }] },
  };
  window.__calls = [];
  const queryData = async (q) => {
    window.__calls.push(q);
    // RetrieveRolePrivilegesRole goes through queryData, not execute: it is an unbound
    // function whose RoleId is an Edm.Guid, and execute quotes every string parameter.
    // Require the unquoted guid here so neither wrong shape can pass again.
    const fn = /^RetrieveRolePrivilegesRole\\((.*)\\)$/.exec(q);
    if (fn) {
      const m = /^RoleId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(fn[1]);
      if (!m) throw new Error('mock: RetrieveRolePrivilegesRole needs RoleId=<unquoted guid>, got ' + fn[1]);
      return { RolePrivileges: (rolePrivs[m[1]] ?? []).map(([n, d]) => ({ PrivilegeId: P(n), Depth: d, BusinessUnitId: BU_SALES })) };
    }
    const [set, rest = ''] = q.split('?');
    const src = sets[set];
    if (!src) throw new Error('mock: unknown set ' + set);
    const params = Object.fromEntries(rest.split('&').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]; }));
    let rows = src.rows;
    const f = params.$filter ?? '';
    const ids = [...f.matchAll(/(\\w+) eq ([0-9a-f-]{36})/g)];
    const contains = [...f.matchAll(/contains\\((\\w+),'([^']*)'\\)/g)];
    const eqStr = [...f.matchAll(/(\\w+) eq '([^']*)'/g)];
    if (ids.length) rows = rows.filter((r) => ids.some(([, k, v]) => String(r[k]).toLowerCase() === v.toLowerCase()));
    if (contains.length) rows = rows.filter((r) => contains.some(([, k, v]) => String(r[k] ?? '').toLowerCase().includes(v.toLowerCase())));
    if (eqStr.length) rows = rows.filter((r) => eqStr.every(([, k, v]) => String(r[k]) === v));
    if (params.$expand) {
      const name = params.$expand.split('(')[0];
      rows = rows.map((r) => ({ ...r, [name]: (expand[name] ?? {})[r[src.key]] ?? [] }));
    }
    if (params.$top) rows = rows.slice(0, Number(params.$top));
    return { value: rows.map((r) => ({ ...r })) };
  };
  const execute = async (req) => {
    window.__calls.push(req.operationName + ':' + (req.entityId ?? ''));
    switch (req.operationName) {
      case 'RetrieveRolePrivilegesRole':
        // Whatever shape it takes, execute() cannot send an unquoted Edm.Guid. Both
        // attempts failed against a real environment; the call belongs in queryData.
        throw new Error('mock: RetrieveRolePrivilegesRole must go through queryData, not execute');
      case 'RetrieveUserPrivileges':
        return { RolePrivileges: [...rolePrivs[R_SALES], ...rolePrivs[R_SHARER]].map(([n, d]) => ({ PrivilegeId: P(n), Depth: { Basic: 0, Local: 1, Deep: 2, Global: 3 }[d] })) };
      case 'RetrievePrincipalAccess': {
        const id = req.parameters.Target.id;
        if (req.parameters.Target.entityLogicalName !== 'account') throw new Error('mock: bad target');
        return { AccessRights: id === ACC_B ? 'ReadAccess, AppendAccess, AppendToAccess, ShareAccess' : id === ACC_C ? 'WriteAccess' : 'None' };
      }
      case 'RetrieveSharedPrincipalsAndAccess':
        return { PrincipalAccesses: req.entityId === ACC_C ? [{ Principal: { '@odata.type': '#Microsoft.Dynamics.CRM.team', teamid: T_EU }, AccessMask: 'WriteAccess' }, { Principal: { '@odata.type': '#Microsoft.Dynamics.CRM.systemuser', systemuserid: BRUNO }, AccessMask: 'ReadAccess' }] : [] };
      default:
        throw new Error('mock: unknown operation ' + req.operationName);
    }
  };
  const lbl = (s) => ({ UserLocalizedLabel: { Label: s }, LocalizedLabels: [{ Label: s, LanguageCode: 1033 }] });
  const entities = [
    { LogicalName: 'account', SchemaName: 'Account', DisplayName: lbl('Account'), EntitySetName: 'accounts', PrimaryNameAttribute: 'name', PrimaryIdAttribute: 'accountid', OwnershipType: 'UserOwned', IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'contact', SchemaName: 'Contact', DisplayName: lbl('Contact'), EntitySetName: 'contacts', PrimaryNameAttribute: 'fullname', PrimaryIdAttribute: 'contactid', OwnershipType: 'UserOwned', IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'sss_setting', SchemaName: 'sss_Setting', DisplayName: lbl('Setting'), EntitySetName: 'sss_settings', PrimaryNameAttribute: 'sss_name', PrimaryIdAttribute: 'sss_settingid', OwnershipType: 'OrganizationOwned', IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'accountleads', SchemaName: 'AccountLeads', DisplayName: lbl('x'), EntitySetName: 'accountleadscollection', PrimaryIdAttribute: 'accountleadid', OwnershipType: 'None', IsIntersect: true, IsPrivate: false, IsLogicalEntity: false },
  ];
  window.__saved = [];
  window.__handlers = [];
  window.__emit = (payload) => window.__handlers.forEach((h) => h({}, payload));
  window.dataverseAPI = {
    queryData, execute,
    getAllEntitiesMetadata: async () => ({ value: entities }),
    getEntityRelatedMetadata: async (e, path) => ({ value: e === 'account' && path === 'Attributes' ? [{ LogicalName: 'name', DisplayName: lbl('Account Name'), IsSecured: false }, { LogicalName: 'sss_margin', DisplayName: lbl('Margin'), IsSecured: true }] : [] }),
  };
  window.toolboxAPI = {
    connections: { getActiveConnection: async () => ({ id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' }), getSecondaryConnection: async () => null },
    utils: { getCurrentTheme: async () => 'light', showNotification: async (o) => { (window.__notes ??= []).push(o); } },
    events: { on: (h) => window.__handlers.push(h) },
    fileSystem: { selectPath: async () => null, readBinary: async () => new Uint8Array(), readText: async () => '', saveFile: async (name, content) => { window.__saved.push({ name, content }); return '/tmp/' + name; } },
  };
})();
`;

const { page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto("file://" + TOOL + "/dist/index.html");

const text = (sel) => page.textContent(sel);
const chip = async (right) => (await page.textContent(`#verdicts .verdict[data-right="${right}"]`)).replace(/\s+/g, " ").trim();

assert((await text("#host-mode")).includes("inside Power Platform ToolBox"), "toolbox host detected");
assert((await text("#conn")).includes("SSS Dev"), "connection chip");
await page.waitForFunction(() => document.querySelectorAll("#table option").length > 1);
const opts = await page.$$eval("#table option", (o) => o.map((x) => x.value));
assert(opts.includes("account") && opts.includes("sss_setting") && !opts.includes("accountleads"), "tables loaded, intersect filtered");
assert((await text("#tab-check")).includes("No check yet"), "empty state");

// user typeahead
await page.fill("#user-q", "ana");
await page.waitForSelector("#user-results li button");
assert((await text("#user-results")).includes("Ana Silva") && (await text("#user-results")).includes("BU Sales"), "user suggestions with BU");
await page.click("#user-results li button");
assert((await text("#user-sel")).includes("Ana Silva"), "user selected");
assert(await page.$eval("#btn-check", (b) => b.disabled), "check disabled until table");
await page.selectOption("#table", "account");
assert(!(await page.$eval("#btn-check", (b) => b.disabled)), "check enabled");

// table-level check
await page.click("#btn-check");
await page.waitForSelector("#verdicts");
await page.waitForFunction(() => document.querySelector("#tab-columns table.columns"));
assert((await chip("Read")).includes("granted") && (await chip("Read")).includes("Deep"), "table-level Read Deep");
assert((await chip("Share")).includes("granted") && (await chip("Share")).includes("Local"), "table-level Share Local via team");
assert((await chip("Delete")).includes("denied") && (await chip("Assign")).includes("denied"), "table-level Delete/Assign denied");
const why1 = await text("#why");
assert(why1.includes("Deep via Sales Person") && why1.includes("Local via Sharer (team Sales EU)"), "why summaries name roles and team");
assert(why1.includes("agrees") && !why1.includes("platform says otherwise"), "tool agrees with RetrieveUserPrivileges");
assert((await text("#tab-check table.roles")).includes("via team Sales EU (owner team)"), "roles table shows team role");
assert((await text("#tab-shares")).includes("Table-level check"), "shares tab explains table-level");
const cols = await text("#tab-columns table.columns");
assert(cols.includes("sss_margin") && cols.includes("Margin Readers (team Sales EU)"), "column security via team profile");
const colCells = await page.$$eval("#tab-columns table.columns tbody td .badge", (b) => b.map((x) => x.textContent));
assert(colCells.join(",") === "yes,no,no", "column read yes / update no / create no");

// record check: Bruno's account (same BU, Ana is Bruno's manager)
await page.fill("#record-q", "bruno");
await page.waitForSelector("#record-results li button");
assert((await text("#record-results")).includes("Bruno Corp") && (await text("#record-results")).includes("owner Bruno Costa"), "record suggestions");
await page.click("#record-results li button");
assert((await text("#record-sel")).includes("Bruno Corp"), "record selected");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Bruno Corp"));
assert((await chip("Read")).includes("granted") && (await chip("Write")).includes("denied") && (await chip("Share")).includes("granted") && (await chip("Append")).includes("granted"), "record verdicts from platform");
const why2 = await text("#why");
assert(why2.includes("Deep depth: record BU Sales is under Sales"), "Read reach explained");
assert(why2.includes("Basic depth covers only records the user"), "Write miss explained");
assert(why2.includes("Sharer via team Sales EU: Local depth: record is in the same BU"), "Share via team explained");
assert(!why2.includes("platform says otherwise"), "tool agrees with RetrievePrincipalAccess");
assert((await text("#relation")).includes("record in the user's BU"), "BU relation");
assert((await text("#hierarchy")).includes("direct manager"), "hierarchy hint for manager");
assert(!(await page.$("#tab-check .warnings")), "no warnings on a clean case");

// record check by GUID: Carla's account (Root BU, shared Write with team)
await page.fill("#record-q", "{" + (await page.evaluate(() => window.__ids.ACC_C)).toUpperCase() + "}");
await page.waitForFunction(() => !document.querySelector("#record-sel").hidden && document.querySelector("#record-sel").textContent.includes("Record by id"));
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Carla Holdings"));
assert((await chip("Read")).includes("denied") && (await chip("Write")).includes("granted"), "Carla: Read denied, Write granted");
const why3 = await text("#why");
assert(why3.includes("Deep depth stops at Sales and its children; record is in Root"), "Deep miss explained");
assert(why3.includes("shared with team Sales EU"), "Write via share explained");
assert((await text("#relation")).includes("outside the user's BU subtree"), "BU relation outside");
assert((await text("#tab-check")).includes("Shares affecting this user") && (await text("#tab-check")).includes("team Sales EU"), "share affecting user listed");
await page.click(".tab[data-tab='shares']");
const sharesRows = await page.$$eval("#tab-shares table.shares tbody tr", (r) => r.map((x) => x.textContent));
assert(sharesRows.length === 2 && sharesRows[0].includes("Sales EU") && sharesRows[0].includes("via team") && sharesRows[1].includes("Bruno Costa") && !sharesRows[1].includes("via"), "shares table with affects badge");

// exports
await page.click("#btn-export-shares");
await page.click("#btn-export-json");
await page.waitForFunction(() => window.__saved.length === 2);
const saved = await page.evaluate(() => window.__saved);
assert(saved[0].name.endsWith("_shares.csv") && saved[0].content.includes("team,Sales EU") && saved[0].content.includes("via team"), "shares CSV");
const json = JSON.parse(saved[1].content);
assert(saved[1].name.endsWith(".access.json") && json.verdicts.length === 8 && json.verdicts.find((v) => v.right === "Write").shares.length === 1 && json.environment.includes("SSS Dev"), "JSON export");
await page.click(".tab[data-tab='columns']");
await page.click("#btn-export-columns");
await page.waitForFunction(() => window.__saved.length === 3);
assert((await page.evaluate(() => window.__saved[2].content)).includes("sss_margin,Margin,true,false,false"), "columns CSV");

// org-owned table: Assign/Share n/a
await page.click(".tab[data-tab='check']");
await page.selectOption("#table", "sss_setting");
assert(await page.$eval("#record-sel", (e) => e.hidden), "record cleared on table change");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("table Setting"));
assert((await chip("Assign")).includes("n/a") && (await chip("Share")).includes("n/a") && (await chip("Read")).includes("denied"), "org-owned: Assign/Share n/a");

// theme + cache reuse
await page.evaluate(() => window.__emit({ event: "settings:updated", data: { theme: "dark" } }));
assert((await page.getAttribute("html", "data-theme")) === "dark", "dark theme applied from settings:updated");
const calls = await page.evaluate(() => window.__calls);
assert(calls.filter((c) => c === "RetrieveRolePrivilegesRole(RoleId=" + "c0000000-0000-0000-0000-000000000001" + ")").length === 1, "role privileges cached across checks");
assert(calls.filter((c) => c.startsWith("privileges?")).length === 1, "privilege list fetched once");

await finish();

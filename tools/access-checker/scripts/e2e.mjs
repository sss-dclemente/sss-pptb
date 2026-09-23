// E2E smoke test for the dist build with a mocked PPTB host (window.toolboxAPI / window.dataverseAPI).
// Fixture: BUs Root > Sales. Ana (Sales, reports to Carla) holds "Sales Person" directly (Read Deep,
// Write/Create Basic, Append/AppendTo Local on account, Read Global on task = prvReadActivity) and
// "Root Appender" directly from BU Root (AppendTo Local: record ownership across BUs), plus via owner
// team "Sales EU" "Sharer" (Share Local) and "Team Assigner" (Assign Basic, isinherited = 0 "Team
// privileges only"). Accounts owned by Ana (shared Read with 60 users), Bruno (Sales, reports to Ana)
// and Carla (Root); Carla's account shared Write + Delete with team Sales EU (Ana holds no Delete
// privilege, so the Delete share has no effect). Organization hierarchy depth 1.
// Diego (Root) holds a System Administrator copy under a localized name: detected by roletemplateid.
// One secured column (sss_margin) readable through profile "Margin Readers" held by the team.
// privileges and systemusers are paged (@odata.nextLink); `or` filters over 50 ids are rejected.
// Run: npm run build && node scripts/e2e.mjs   (needs playwright + chromium available)
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const MOCK = `
(() => {
  const BU_ROOT = 'b0000000-0000-0000-0000-000000000001', BU_SALES = 'b0000000-0000-0000-0000-000000000002';
  const ANA = 'a0000000-0000-0000-0000-000000000001', BRUNO = 'a0000000-0000-0000-0000-000000000002', CARLA = 'a0000000-0000-0000-0000-000000000003', DIEGO = 'a0000000-0000-0000-0000-000000000004';
  const R_SALES = 'c0000000-0000-0000-0000-000000000001', R_SHARER = 'c0000000-0000-0000-0000-000000000002', R_TEAMONLY = 'c0000000-0000-0000-0000-000000000003', R_ROOTAPP = 'c0000000-0000-0000-0000-000000000004', R_ADMIN = 'c0000000-0000-0000-0000-000000000005';
  const SYSADMIN_TEMPLATE = '627090ff-40a3-4053-8790-584edc5be201';
  const T_EU = 'd0000000-0000-0000-0000-000000000001';
  const ACC_B = 'e0000000-0000-0000-0000-000000000001', ACC_C = 'e0000000-0000-0000-0000-000000000002', ACC_A = 'e0000000-0000-0000-0000-000000000003';
  const FSP = 'f0000000-0000-0000-0000-000000000001';
  const P = (n) => 'p' + n.toLowerCase().replace(/[^a-z]/g, '').padEnd(31, '0').slice(0, 31) + '1';
  const DUMMIES = Array.from({ length: 60 }, (_, i) => ({ id: 'a1000000-0000-0000-0000-' + String(i + 1).padStart(12, '0'), name: 'Dummy ' + String(i + 1).padStart(2, '0') }));
  window.__ids = { ACC_A, ACC_B, ACC_C, CARLA };

  const lbl = (s) => ({ UserLocalizedLabel: { Label: s }, LocalizedLabels: [{ Label: s, LanguageCode: 1033 }] });
  const entities = [
    { LogicalName: 'account', SchemaName: 'Account', DisplayName: lbl('Account'), EntitySetName: 'accounts', PrimaryNameAttribute: 'name', PrimaryIdAttribute: 'accountid', OwnershipType: 'UserOwned', IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'contact', SchemaName: 'Contact', DisplayName: lbl('Contact'), EntitySetName: 'contacts', PrimaryNameAttribute: 'fullname', PrimaryIdAttribute: 'contactid', OwnershipType: 'UserOwned', IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'task', SchemaName: 'Task', DisplayName: lbl('Task'), EntitySetName: 'tasks', PrimaryNameAttribute: 'subject', PrimaryIdAttribute: 'activityid', OwnershipType: 'UserOwned', IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'sss_setting', SchemaName: 'sss_Setting', DisplayName: lbl('Setting'), EntitySetName: 'sss_settings', PrimaryNameAttribute: 'sss_name', PrimaryIdAttribute: 'sss_settingid', OwnershipType: 'OrganizationOwned', IsIntersect: false, IsPrivate: false, IsLogicalEntity: false },
    { LogicalName: 'accountleads', SchemaName: 'AccountLeads', DisplayName: lbl('x'), EntitySetName: 'accountleadscollection', PrimaryIdAttribute: 'accountleadid', OwnershipType: 'None', IsIntersect: true, IsPrivate: false, IsLogicalEntity: false },
  ];
  // EntityMetadata.Privileges as the Web API returns them: PrivilegeType is the enum name. Activity
  // tables share prv*Activity, which the old prv{Right}{table} convention got wrong (prvReadTask).
  const RIGHTS = ['Create', 'Read', 'Write', 'Delete', 'Append', 'AppendTo', 'Assign', 'Share'];
  const entityPrivileges = (e) => (e.OwnershipType === 'OrganizationOwned' ? RIGHTS.filter((r) => r !== 'Assign' && r !== 'Share') : RIGHTS)
    .map((r) => ({ PrivilegeType: r, Name: 'prv' + r + (e.LogicalName === 'task' ? 'Activity' : e.SchemaName) }))
    .map((p) => ({ ...p, PrivilegeId: P(p.Name) }));
  const privNames = [...new Set(entities.filter((e) => !e.IsIntersect).flatMap((e) => entityPrivileges(e).map((p) => p.Name)))];
  const privileges = privNames.map((name) => ({ privilegeid: P(name), name }));
  const rolePrivs = {
    [R_SALES]: [['prvReadAccount','Deep'],['prvWriteAccount','Basic'],['prvCreateAccount','Basic'],['prvAppendAccount','Local'],['prvAppendToAccount','Local'],['prvReadContact','Global'],['prvReadActivity','Global']],
    [R_SHARER]: [['prvShareAccount','Local']],
    [R_TEAMONLY]: [['prvAssignAccount','Basic']],
    [R_ROOTAPP]: [['prvAppendToAccount','Local']],
    [R_ADMIN]: privNames.map((n) => [n, 'Global']),
  };
  const users = [
    { systemuserid: ANA, fullname: 'Ana Silva', domainname: 'ana@sss.test', internalemailaddress: 'ana@sss.test', _businessunitid_value: BU_SALES, _parentsystemuserid_value: CARLA, isdisabled: false, applicationid: null },
    { systemuserid: BRUNO, fullname: 'Bruno Costa', domainname: 'bruno@sss.test', internalemailaddress: 'bruno@sss.test', _businessunitid_value: BU_SALES, _parentsystemuserid_value: ANA, isdisabled: false, applicationid: null },
    { systemuserid: CARLA, fullname: 'Carla Reis', domainname: 'carla@sss.test', internalemailaddress: 'carla@sss.test', _businessunitid_value: BU_ROOT, _parentsystemuserid_value: null, isdisabled: false, applicationid: null },
    { systemuserid: DIEGO, fullname: 'Diego Admin', domainname: 'diego@sss.test', internalemailaddress: 'diego@sss.test', _businessunitid_value: BU_ROOT, _parentsystemuserid_value: null, isdisabled: false, applicationid: null },
    ...DUMMIES.map((d) => ({ systemuserid: d.id, fullname: d.name, domainname: d.id + '@x.test', internalemailaddress: null, _businessunitid_value: BU_SALES, _parentsystemuserid_value: null, isdisabled: false, applicationid: null })),
  ];
  const role = (roleid, name, bu, isinherited, tpl = null) => ({ roleid, name, _businessunitid_value: bu, _roletemplateid_value: tpl, isinherited });
  const roles = {
    [R_SALES]: role(R_SALES, 'Sales Person', BU_SALES, 1),
    [R_SHARER]: role(R_SHARER, 'Sharer', BU_SALES, 1),
    [R_TEAMONLY]: role(R_TEAMONLY, 'Team Assigner', BU_SALES, 0),
    [R_ROOTAPP]: role(R_ROOTAPP, 'Root Appender', BU_ROOT, 1),
    [R_ADMIN]: role(R_ADMIN, 'Administrador do Sistema', BU_ROOT, 1, SYSADMIN_TEMPLATE),
  };
  const teams = [{ teamid: T_EU, name: 'Sales EU', teamtype: 0, _businessunitid_value: BU_SALES }];
  const expand = {
    systemuserroles_association: { [ANA]: [roles[R_SALES], roles[R_ROOTAPP]], [DIEGO]: [roles[R_ADMIN]] },
    teammembership_association: { [ANA]: teams },
    systemuserprofiles_association: { [ANA]: [] },
    teamroles_association: { [T_EU]: [roles[R_SHARER], roles[R_TEAMONLY]] },
    teamprofiles_association: { [T_EU]: [{ fieldsecurityprofileid: FSP, name: 'Margin Readers' }] },
  };
  // Roles a user holds directly or through teams, for RetrieveUserPrivilegeByPrivilegeName.
  const heldBy = { [ANA]: [R_SALES, R_ROOTAPP, R_SHARER, R_TEAMONLY], [DIEGO]: [R_ADMIN] };
  const acc = (accountid, name, owner, ownerName, bu) => ({ accountid, name, _ownerid_value: owner, '_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'systemuser', '_ownerid_value@OData.Community.Display.V1.FormattedValue': ownerName, _owningbusinessunit_value: bu });
  const accounts = [acc(ACC_B, 'Bruno Corp', BRUNO, 'Bruno Costa', BU_SALES), acc(ACC_C, 'Carla Holdings', CARLA, 'Carla Reis', BU_ROOT), acc(ACC_A, 'Ana Ventures', ANA, 'Ana Silva', BU_SALES)];
  const sets = {
    systemusers: { key: 'systemuserid', rows: users, pageSize: 25 },
    teams: { key: 'teamid', rows: teams },
    businessunits: { key: 'businessunitid', rows: [{ businessunitid: BU_ROOT, name: 'Root', _parentbusinessunitid_value: null }, { businessunitid: BU_SALES, name: 'Sales', _parentbusinessunitid_value: BU_ROOT }] },
    privileges: { key: 'privilegeid', rows: privileges, pageSize: 10 },
    organizations: { key: 'organizationid', rows: [{ organizationid: '00000000-0000-0000-0000-000000000009', ishierarchicalsecuritymodelenabled: true, maxdepthforhierarchicalsecuritymodel: 1 }] },
    accounts: { key: 'accountid', rows: accounts },
    fieldpermissions: { key: 'fieldpermissionid', rows: [{ fieldpermissionid: '11111111-0000-0000-0000-000000000001', entityname: 'account', attributelogicalname: 'sss_margin', canread: 4, canupdate: 0, cancreate: 0, _fieldsecurityprofileid_value: FSP }] },
  };
  const pick = (row, cols) => (cols ? Object.fromEntries(cols.map((c) => [c, row[c] ?? null])) : row);
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
      return { RolePrivileges: (rolePrivs[m[1]] ?? []).map(([n, d]) => ({ PrivilegeId: P(n), Depth: d, BusinessUnitId: roles[m[1]]._businessunitid_value })) };
    }
    // Single-entity metadata read: the body is the EntityMetadata itself, not { value }.
    const ed = /^EntityDefinitions\\(LogicalName='(\\w+)'\\)\\?\\$select=Privileges$/.exec(q);
    if (ed) {
      const e = entities.find((x) => x.LogicalName === ed[1]);
      if (!e) throw new Error('mock: no entity ' + ed[1]);
      return { '@odata.context': 'https://sss-dev.crm4.dynamics.com/api/data/v9.2/$metadata#EntityDefinitions(Privileges)/$entity', LogicalName: e.LogicalName, MetadataId: P(e.LogicalName), Privileges: entityPrivileges(e) };
    }
    const [set, rest = ''] = q.split('?');
    const src = sets[set];
    if (!src) throw new Error('mock: unknown set ' + set);
    const params = Object.fromEntries(rest.split('&').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]; }));
    let rows = src.rows;
    const f = params.$filter ?? '';
    const ids = [...f.matchAll(/(\\w+) eq ([0-9a-f-]{36})/g)];
    // Stand-in for the URL length limit: a long enough "or" chain fails for real (414 / 400).
    if (ids.length > 50) throw new Error('mock: URL too long (' + ids.length + ' or-terms)');
    const contains = [...f.matchAll(/contains\\((\\w+),'([^']*)'\\)/g)];
    const eqStr = [...f.matchAll(/(\\w+) eq '([^']*)'/g)];
    if (ids.length) rows = rows.filter((r) => ids.some(([, k, v]) => String(r[k]).toLowerCase() === v.toLowerCase()));
    if (contains.length) rows = rows.filter((r) => contains.some(([, k, v]) => String(r[k] ?? '').toLowerCase().includes(v.toLowerCase())));
    if (eqStr.length) rows = rows.filter((r) => eqStr.every(([, k, v]) => String(r[k]) === v));
    if (params.$expand) {
      // Expanded rows carry only the columns in the nested $select, as the Web API does.
      const [, name, sel] = /^(\\w+)(?:\\(\\$select=([^)]*)\\))?/.exec(params.$expand);
      const cols = sel ? sel.split(',') : null;
      rows = rows.map((r) => ({ ...r, [name]: ((expand[name] ?? {})[r[src.key]] ?? []).map((x) => pick(x, cols)) }));
    }
    if (params.$top) rows = rows.slice(0, Number(params.$top));
    // Server-side paging: a page of pageSize rows plus an absolute @odata.nextLink carrying $skiptoken.
    else if (src.pageSize) {
      const skip = Number(params.$skiptoken ?? 0);
      const page = rows.slice(skip, skip + src.pageSize);
      const out = { value: page.map((r) => ({ ...r })) };
      if (skip + src.pageSize < rows.length) out['@odata.nextLink'] = 'https://sss-dev.crm4.dynamics.com/api/data/v9.2/' + set + '?' + rest.split('&').filter((p) => !p.startsWith('$skiptoken=')).join('&') + '&$skiptoken=' + (skip + src.pageSize);
      return out;
    }
    return { value: rows.map((r) => ({ ...r })) };
  };
  const D = { Basic: 0, Local: 1, Deep: 2, Global: 3 };
  const execute = async (req) => {
    window.__calls.push(req.operationName + ':' + (req.parameters?.PrivilegeName ?? req.entityId ?? ''));
    switch (req.operationName) {
      case 'RetrieveRolePrivilegesRole':
        // Whatever shape it takes, execute() cannot send an unquoted Edm.Guid. Both
        // attempts failed against a real environment; the call belongs in queryData.
        throw new Error('mock: RetrieveRolePrivilegesRole must go through queryData, not execute');
      case 'RetrieveUserPrivileges': {
        // Modelled faithfully, defect included: privileges inherited through team membership
        // come back at Basic depth whatever the team's roles grant. That understatement is why
        // the tool no longer uses this message — see the assertion that it is never called.
        const direct = [...rolePrivs[R_SALES], ...rolePrivs[R_ROOTAPP]].map(([n, d]) => ({ PrivilegeId: P(n), Depth: D[d] }));
        const viaTeam = [...rolePrivs[R_SHARER], ...rolePrivs[R_TEAMONLY]].map(([n]) => ({ PrivilegeId: P(n), Depth: D.Basic }));
        return { RolePrivileges: [...direct, ...viaTeam] };
      }
      case 'RetrieveUserPrivilegeByPrivilegeName': {
        if (!req.entityId || req.entityName !== 'systemuser') throw new Error('mock: RetrieveUserPrivilegeByPrivilegeName is bound to systemuser');
        const want = req.parameters?.PrivilegeName;
        if (typeof want !== 'string' || !want) throw new Error('mock: RetrieveUserPrivilegeByPrivilegeName needs a PrivilegeName');
        if (want !== want.trim() || !/^prv/.test(want)) throw new Error('mock: PrivilegeName should be the stored spelling, got ' + want);
        if (!privNames.includes(want)) throw new Error('mock: no privilege named ' + want);
        // Real behaviour: best depth across every role held, directly or through a team.
        let best = null;
        for (const r of heldBy[req.entityId] ?? []) {
          for (const [n, d] of rolePrivs[r]) {
            if (n.toLowerCase() !== want.toLowerCase()) continue;
            if (best === null || D[d] > best) best = D[d];
          }
        }
        return { RolePrivileges: best === null ? [] : [{ PrivilegeId: P(want), Depth: best, BusinessUnitId: BU_SALES }] };
      }
      case 'RetrievePrincipalAccess': {
        const id = req.parameters.Target.id;
        if (req.parameters.Target.entityLogicalName !== 'account') throw new Error('mock: bad target');
        // Platform truth per record for Ana. ACC_A: "Team privileges only" Assign Basic does not reach her own
        // record. ACC_C: the Delete share is ignored (no Delete privilege); AppendTo comes from Root Appender (BU Root).
        return { AccessRights: id === ACC_B ? 'ReadAccess, AppendAccess, AppendToAccess, ShareAccess' : id === ACC_C ? 'WriteAccess, AppendToAccess' : id === ACC_A ? 'ReadAccess, WriteAccess, AppendAccess, AppendToAccess, CreateAccess, ShareAccess' : 'None' };
      }
      case 'RetrieveSharedPrincipalsAndAccess':
        return {
          PrincipalAccesses:
            req.entityId === ACC_C
              ? [{ Principal: { '@odata.type': '#Microsoft.Dynamics.CRM.team', teamid: T_EU }, AccessMask: 'WriteAccess, DeleteAccess' }, { Principal: { '@odata.type': '#Microsoft.Dynamics.CRM.systemuser', systemuserid: BRUNO }, AccessMask: 'ReadAccess' }]
              : req.entityId === ACC_A
                ? DUMMIES.map((d) => ({ Principal: { '@odata.type': '#Microsoft.Dynamics.CRM.systemuser', systemuserid: d.id }, AccessMask: 'ReadAccess' }))
                : [],
        };
      default:
        throw new Error('mock: unknown operation ' + req.operationName);
    }
  };
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
assert((await chip("Delete")).includes("denied"), "table-level Delete denied");
assert((await chip("Assign")).includes("granted") && (await chip("Assign")).includes("Basic"), "table-level Assign Basic from the team-only role");
const why1 = await text("#why");
assert(why1.includes("Deep via Sales Person") && why1.includes("Local via Sharer (team Sales EU)"), "why summaries name roles and team");
assert(why1.includes("agrees") && !why1.includes("platform says otherwise"), "tool agrees with RetrieveUserPrivilegeByPrivilegeName");
// The point of moving off RetrieveUserPrivileges: prvShareAccount comes from a role held
// through a team, and its real depth is Local. The old message reports team-inherited
// privileges as Basic, which would have shown "Basic" here and flagged a disagreement.
assert((await chip("Share")).includes("Local") && !(await chip("Share")).includes("Basic"), "team-inherited depth is the real depth, not Basic");
assert((await text("#tab-check table.roles")).includes("via team Sales EU (owner team)"), "roles table shows team role");
assert((await text("#tab-check table.roles")).includes("Team Assigner") && (await text("#tab-check table.roles")).includes("team privileges only"), "roles table flags the isinherited = 0 team role");
// Privilege names now come from EntityDefinitions(...)/Privileges; privileges list is paged (10 per page).
assert((await page.evaluate(() => window.__calls)).includes("EntityDefinitions(LogicalName='account')?$select=Privileges"), "privilege names read from entity metadata");
assert((await page.evaluate(() => window.__calls)).some((c) => c.startsWith("privileges?") && c.includes("$skiptoken=")), "privilege list follows @odata.nextLink");
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
assert(!why2.includes("platform says otherwise") && !(await text("#tab-check")).includes("Platform verdict differs"), "no disagreement on a clean case");
assert((await text("#tab-check .warnings")).includes("Team privileges only") && (await text("#tab-check .warnings")).includes("Direct role Root Appender belongs to BU Root"), "notes explain team-only role and cross-BU direct role");
// organization.maxdepthforhierarchicalsecuritymodel = 1: the chain above Bruno stops at Ana, Carla (Ana's manager) is never fetched.
{
  const c = await page.evaluate(() => window.__calls);
  const carla = await page.evaluate(() => window.__ids.CARLA);
  const from = c.lastIndexOf("RetrieveSharedPrincipalsAndAccess:" + (await page.evaluate(() => window.__ids.ACC_B)));
  assert(c.some((q) => q.includes("maxdepthforhierarchicalsecuritymodel")), "hierarchy depth read from organization");
  assert(from >= 0 && !c.slice(from).some((q) => q.includes("systemuserid eq " + carla)), "manager chain stops at the organization hierarchy depth");
}

// record check by GUID: Carla's account (Root BU, shared Write with team)
await page.fill("#record-q", "{" + (await page.evaluate(() => window.__ids.ACC_C)).toUpperCase() + "}");
await page.waitForFunction(() => !document.querySelector("#record-sel").hidden && document.querySelector("#record-sel").textContent.includes("Record by id"));
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Carla Holdings"));
assert((await chip("Read")).includes("denied") && (await chip("Write")).includes("granted"), "Carla: Read denied, Write granted");
const why3 = await text("#why");
assert(why3.includes("Deep depth stops at Sales and its children; record is in Root"), "Deep miss explained");
assert(why3.includes("shared with team Sales EU (user holds prvWriteAccount at Basic"), "Write via share explained, privilege held");
assert((await chip("Delete")).includes("denied") && why3.includes("but no role grants prvDeleteAccount"), "Delete share without the privilege has no effect");
assert((await chip("AppendTo")).includes("granted") && why3.includes("Root Appender: Local depth: record is in the same BU (Root)"), "direct role from BU Root: Local evaluated against the role's BU");
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

// record check: Ana's own account. "Team privileges only" Assign Basic must not reach it; 60 shares resolve in chunks.
await page.click(".tab[data-tab='check']");
await page.fill("#record-q", "ventures");
await page.waitForSelector("#record-results li button");
await page.click("#record-results li button");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Ana Ventures"));
const why4 = await text("#why");
assert((await chip("Write")).includes("granted") && why4.includes("Basic depth: user owns the record"), "own record: Write Basic reaches");
assert((await chip("Assign")).includes("denied") && why4.includes('Basic depth from a "Team privileges only" role covers only records owned by team Sales EU, not the user\'s own records'), "team-only Basic does not reach the user's own record");
assert(!why4.includes("platform says otherwise"), "tool agrees with RetrievePrincipalAccess on own record");
await page.click(".tab[data-tab='shares']");
const dummyRows = await page.$$eval("#tab-shares table.shares tbody tr", (r) => r.map((x) => x.textContent));
assert(dummyRows.length === 60 && dummyRows.every((r) => r.includes("Dummy ")) && dummyRows.some((r) => r.includes("Dummy 60")), "60 share principals resolved by name");
{
  const c = await page.evaluate(() => window.__calls);
  const byId = c.filter((q) => q.startsWith("systemusers?") && (q.match(/systemuserid eq /g) ?? []).length > 1);
  assert(byId.length >= 2 && byId.every((q) => (q.match(/systemuserid eq /g) ?? []).length <= 40), "long or-filter chunked (<= 40 ids per request)");
  assert(c.some((q) => q.startsWith("systemusers?") && q.includes("$skiptoken=")), "chunk query follows @odata.nextLink");
}
await page.click(".tab[data-tab='check']");

// org-owned table: Assign/Share n/a
await page.click(".tab[data-tab='check']");
await page.selectOption("#table", "sss_setting");
assert(await page.$eval("#record-sel", (e) => e.hidden), "record cleared on table change");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("table Setting"));
assert((await chip("Assign")).includes("n/a") && (await chip("Share")).includes("n/a") && (await chip("Read")).includes("denied"), "org-owned: Assign/Share n/a");

// activity table: privileges are prv*Activity, not prv*Task
await page.selectOption("#table", "task");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("table Task"));
assert((await chip("Read")).includes("granted") && (await chip("Read")).includes("Global") && (await text("#why")).includes("Global via Sales Person"), "task Read Global via prvReadActivity");
assert((await chip("Write")).includes("denied") && (await text("#why")).includes("agrees") && !(await text("#why")).includes("platform says otherwise"), "task: tool agrees with platform");

// theme + cache reuse
await page.evaluate(() => window.__emit({ event: "settings:updated", data: { theme: "dark" } }));
assert((await page.getAttribute("html", "data-theme")) === "dark", "dark theme applied from settings:updated");
const calls = await page.evaluate(() => window.__calls);
assert(calls.filter((c) => c === "RetrieveRolePrivilegesRole(RoleId=" + "c0000000-0000-0000-0000-000000000001" + ")").length === 1, "role privileges cached across checks");
assert(calls.filter((c) => c === "RetrieveUserPrivilegeByPrivilegeName:prvShareAccount").length === 1, "user privileges cached per privilege");
assert(!calls.some((c) => c.startsWith("RetrieveUserPrivileges:")), "RetrieveUserPrivileges is never called");
assert(calls.filter((c) => c.startsWith("RetrieveUserPrivilegeByPrivilegeName:")).every((c) => /:prv\w+(Account|Activity|sss_Setting)$/.test(c)), "only the checked tables' privileges are fetched");
assert(calls.includes("RetrieveUserPrivilegeByPrivilegeName:prvReadActivity") && !calls.some((c) => /prv\w+Task$/.test(c)), "activity privilege names from metadata, not the convention");
assert(calls.filter((c) => c.startsWith("privileges?") && !c.includes("$skiptoken")).length === 1, "privilege list fetched once");
assert(calls.filter((c) => c === "EntityDefinitions(LogicalName='account')?$select=Privileges").length === 1, "table privileges cached per table");

// System Administrator detected by roletemplateid under a localized role name
await page.fill("#user-q", "diego");
await page.waitForSelector("#user-results li button");
await page.click("#user-results li button");
await page.waitForFunction(() => document.querySelector("#user-sel")?.textContent.includes("Diego Admin"));
await page.selectOption("#table", "account");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Diego Admin"));
assert((await text("#tab-check .warnings")).includes("User holds System Administrator"), "sysadmin by role template, not name");
await page.waitForFunction(() => document.querySelector("#tab-columns table.columns"));
assert((await text("#tab-columns table.columns")).includes("System Administrator (bypasses column security)"), "column security bypass for template-detected sysadmin");

await finish();

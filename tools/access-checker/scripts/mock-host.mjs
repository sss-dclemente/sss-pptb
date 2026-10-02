// Mocked PPTB host (window.toolboxAPI / window.dataverseAPI) shared by e2e.mjs and screenshots.mjs.
// The fixture is described at the top of e2e.mjs. Returns the init script as a string.
// Options only add to the fixture (the e2e uses the defaults): extra secured columns on account,
// as [logicalName, displayName] pairs, and fieldpermissions rows for them under profile "Margin Readers".
export const mockHost = ({ securedColumns = [], fieldPermissions = [] } = {}) => `
(() => {
  const EXTRA = ${JSON.stringify({ securedColumns, fieldPermissions })};
  const BU_ROOT = 'b0000000-0000-0000-0000-000000000001', BU_SALES = 'b0000000-0000-0000-0000-000000000002', BU_OPS = 'b0000000-0000-0000-0000-000000000003';
  // Eva (BU Ops) reads contacts through team "Sales Readers" (BU Sales, Read Local + Write Deep) and holds
  // "Contact Appender" (BU Sales, Append Local) directly. She owns a contact in Ops: Basic ⊂ Local ⊂ Deep.
  const EVA = 'a0000000-0000-0000-0000-000000000005', PLUS = 'a0000000-0000-0000-0000-000000000006';
  const R_CREADER = 'c0000000-0000-0000-0000-000000000006', R_CAPP = 'c0000000-0000-0000-0000-000000000007';
  const T_READERS = 'd0000000-0000-0000-0000-000000000002';
  // "Report Viewer" (held by Ana directly) grants nothing on any table: the Roles table hides it by default.
  const R_NOPRIV = 'c0000000-0000-0000-0000-000000000008';
  const CON_E = 'e1000000-0000-0000-0000-000000000001', ACC_T = 'e0000000-0000-0000-0000-000000000004';
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
    [R_CREADER]: [['prvReadContact','Local'],['prvWriteContact','Deep']],
    [R_CAPP]: [['prvAppendContact','Local']],
    [R_NOPRIV]: [],
  };
  const users = [
    { systemuserid: ANA, fullname: 'Ana Silva', domainname: 'ana@sss.test', internalemailaddress: 'ana@sss.test', _businessunitid_value: BU_SALES, _parentsystemuserid_value: CARLA, isdisabled: false, applicationid: null },
    { systemuserid: BRUNO, fullname: 'Bruno Costa', domainname: 'bruno@sss.test', internalemailaddress: 'bruno@sss.test', _businessunitid_value: BU_SALES, _parentsystemuserid_value: ANA, isdisabled: false, applicationid: null },
    { systemuserid: CARLA, fullname: 'Carla Reis', domainname: 'carla@sss.test', internalemailaddress: 'carla@sss.test', _businessunitid_value: BU_ROOT, _parentsystemuserid_value: null, isdisabled: false, applicationid: null },
    { systemuserid: DIEGO, fullname: 'Diego Admin', domainname: 'diego@sss.test', internalemailaddress: 'diego@sss.test', _businessunitid_value: BU_ROOT, _parentsystemuserid_value: null, isdisabled: false, applicationid: null },
    { systemuserid: EVA, fullname: 'Eva Nunes', domainname: 'eva@sss.test', internalemailaddress: 'eva@sss.test', _businessunitid_value: BU_OPS, _parentsystemuserid_value: null, isdisabled: false, applicationid: null },
    { systemuserid: PLUS, fullname: 'Plus User', domainname: 'a+b@x.com', internalemailaddress: 'a+b@x.com', _businessunitid_value: BU_SALES, _parentsystemuserid_value: null, isdisabled: false, applicationid: null },
    ...DUMMIES.map((d) => ({ systemuserid: d.id, fullname: d.name, domainname: d.id + '@x.test', internalemailaddress: null, _businessunitid_value: BU_SALES, _parentsystemuserid_value: null, isdisabled: false, applicationid: null })),
  ];
  const role = (roleid, name, bu, isinherited, tpl = null) => ({ roleid, name, _businessunitid_value: bu, _roletemplateid_value: tpl, isinherited });
  const roles = {
    [R_SALES]: role(R_SALES, 'Sales Person', BU_SALES, 1),
    [R_SHARER]: role(R_SHARER, 'Sharer', BU_SALES, 1),
    [R_TEAMONLY]: role(R_TEAMONLY, 'Team Assigner', BU_SALES, 0),
    [R_ROOTAPP]: role(R_ROOTAPP, 'Root Appender', BU_ROOT, 1),
    [R_ADMIN]: role(R_ADMIN, 'Administrador do Sistema', BU_ROOT, 1, SYSADMIN_TEMPLATE),
    [R_CREADER]: role(R_CREADER, 'Contact Reader', BU_SALES, 1),
    [R_CAPP]: role(R_CAPP, 'Contact Appender', BU_SALES, 1),
    [R_NOPRIV]: role(R_NOPRIV, 'Report Viewer', BU_SALES, 1),
  };
  const teams = [{ teamid: T_EU, name: 'Sales EU', teamtype: 0, _businessunitid_value: BU_SALES }];
  const readers = { teamid: T_READERS, name: 'Sales Readers', teamtype: 0, _businessunitid_value: BU_SALES };
  // Plus User belongs to 7 role-less teams: the user details show 5 and a "+2 more" button.
  const many = Array.from({ length: 7 }, (_, i) => ({ teamid: 'd1000000-0000-0000-0000-' + String(i + 1).padStart(12, '0'), name: 'Team ' + (i + 1), teamtype: 0, _businessunitid_value: BU_SALES }));
  const expand = {
    systemuserroles_association: { [ANA]: [roles[R_SALES], roles[R_ROOTAPP], roles[R_NOPRIV]], [DIEGO]: [roles[R_ADMIN]], [EVA]: [roles[R_CAPP]] },
    teammembership_association: { [ANA]: teams, [EVA]: [readers], [PLUS]: many },
    systemuserprofiles_association: { [ANA]: [] },
    teamroles_association: { [T_EU]: [roles[R_SHARER], roles[R_TEAMONLY]], [T_READERS]: [roles[R_CREADER]] },
    teamprofiles_association: { [T_EU]: [{ fieldsecurityprofileid: FSP, name: 'Margin Readers' }] },
  };
  // Roles a user holds directly or through teams, for RetrieveUserPrivilegeByPrivilegeName.
  const heldBy = { [ANA]: [R_SALES, R_ROOTAPP, R_SHARER, R_TEAMONLY, R_NOPRIV], [DIEGO]: [R_ADMIN], [EVA]: [R_CAPP, R_CREADER] };
  // Tests mutate these to model a role change between two checks.
  window.__mock = { rolePrivs, R_SALES };
  const acc = (accountid, name, owner, ownerName, bu) => ({ accountid, name, _ownerid_value: owner, '_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'systemuser', '_ownerid_value@OData.Community.Display.V1.FormattedValue': ownerName, _owningbusinessunit_value: bu });
  const accounts = [acc(ACC_B, 'Bruno Corp', BRUNO, 'Bruno Costa', BU_SALES), acc(ACC_C, 'Carla Holdings', CARLA, 'Carla Reis', BU_ROOT), acc(ACC_A, 'Ana Ventures', ANA, 'Ana Silva', BU_SALES), acc(ACC_T, 'AT&T Wireless', CARLA, 'Carla Reis', BU_ROOT)];
  const contacts = [{ contactid: CON_E, fullname: 'Eva Contact', _ownerid_value: EVA, '_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'systemuser', '_ownerid_value@OData.Community.Display.V1.FormattedValue': 'Eva Nunes', _owningbusinessunit_value: BU_OPS }];
  const sets = {
    systemusers: { key: 'systemuserid', rows: users, pageSize: 25 },
    teams: { key: 'teamid', rows: [...teams, readers] },
    businessunits: { key: 'businessunitid', rows: [{ businessunitid: BU_ROOT, name: 'Root', _parentbusinessunitid_value: null }, { businessunitid: BU_SALES, name: 'Sales', _parentbusinessunitid_value: BU_ROOT }, { businessunitid: BU_OPS, name: 'Ops', _parentbusinessunitid_value: BU_ROOT }] },
    privileges: { key: 'privilegeid', rows: privileges, pageSize: 10 },
    organizations: { key: 'organizationid', rows: [{ organizationid: '00000000-0000-0000-0000-000000000009', ishierarchicalsecuritymodelenabled: true, maxdepthforhierarchicalsecuritymodel: 1 }] },
    accounts: { key: 'accountid', rows: accounts },
    contacts: { key: 'contactid', rows: contacts },
    fieldpermissions: { key: 'fieldpermissionid', rows: [{ fieldpermissionid: '11111111-0000-0000-0000-000000000001', entityname: 'account', attributelogicalname: 'sss_margin', canread: 4, canupdate: 0, cancreate: 0, _fieldsecurityprofileid_value: FSP }, ...EXTRA.fieldPermissions.map((p, i) => ({ fieldpermissionid: '11111111-0000-0000-0000-' + String(i + 2).padStart(12, '0'), entityname: 'account', _fieldsecurityprofileid_value: FSP, ...p }))] },
  };
  const pick = (row, cols) => (cols ? Object.fromEntries(cols.map((c) => [c, row[c] ?? null])) : row);
  window.__calls = [];
  window.__filters = [];
  // substring of a query (or 'attrs:<table>') → ms; lets a test hold a request in flight.
  window.__delays = {};
  const hold = async (key) => {
    const hit = Object.entries(window.__delays).find(([k]) => key.includes(k));
    if (hit) await new Promise((r) => setTimeout(r, hit[1]));
  };
  const queryData = async (q) => {
    window.__calls.push(q);
    await hold(q);
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
    // Parsed the way the server parses a URL: '#' starts a fragment (never sent), '&' separates
    // parameters, '+' is a space and %XX is decoded.
    const [set, rest = ''] = q.split('#')[0].split('?');
    const src = sets[set];
    if (!src) throw new Error('mock: unknown set ' + set);
    const params = Object.fromEntries(rest.split('&').map((p) => { const i = p.indexOf('='); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1).replace(/\\+/g, ' '))]; }));
    if (params.$filter) window.__filters.push(params.$filter);
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
        if (window.__failPrincipalAccess) throw new Error('mock: RetrievePrincipalAccess unavailable');
        const id = req.parameters.Target.id;
        if (req.parameters.Target.entityLogicalName === 'contact') return { AccessRights: id === CON_E && req.entityId === EVA ? 'ReadAccess, WriteAccess, AppendAccess' : 'None' };
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
    getEntityRelatedMetadata: async (e, path) => {
      await hold('attrs:' + e);
      if (window.__failAttrs) throw new Error('mock: attribute metadata unavailable');
      return { value: e === 'account' && path === 'Attributes' ? [{ LogicalName: 'name', DisplayName: lbl('Account Name'), IsSecured: false }, { LogicalName: 'sss_margin', DisplayName: lbl('Margin'), IsSecured: true }, ...EXTRA.securedColumns.map(([n, d]) => ({ LogicalName: n, DisplayName: lbl(d), IsSecured: true }))] : [] };
    },
  };
  window.toolboxAPI = {
    connections: { getActiveConnection: async () => ({ id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' }), getSecondaryConnection: async () => null },
    utils: { getCurrentTheme: async () => 'light', showNotification: async (o) => { (window.__notes ??= []).push(o); } },
    events: { on: (h) => window.__handlers.push(h) },
    fileSystem: { selectPath: async () => null, readBinary: async () => new Uint8Array(), readText: async () => '', saveFile: async (name, content) => { window.__saved.push({ name, content }); return '/tmp/' + name; } },
  };
})();
`;

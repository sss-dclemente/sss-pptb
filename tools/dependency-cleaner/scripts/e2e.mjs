// E2E smoke test for the dist build with a mocked PPTB host (window.toolboxAPI / window.dataverseAPI).
// Dev env (primary): unmanaged solution SssCore with table account added with all assets (behavior 0),
// two msdyn_ columns owned by FieldService, a main form with a msdyn_workorderid field, a quick create
// form with a required msdyn column, and a view with a link-entity to msdyn_workorder.
// Target env (secondary): no Field Service. Covers diagnosis, grouping, shell conversion, form/view edits,
// mandatory backup, PublishXml, re-diagnosis, Restore, managed refusal, offline zip, exports.
// Run: npm run build && node scripts/e2e.mjs   (needs playwright + chromium available)
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";
import { checkDebugLog } from "../../_shared/e2e-debug.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = resolve(TOOL, "scripts/.e2e-out");
mkdirSync(OUT, { recursive: true });
const require = createRequire(TOOL + "/package.json");
const JSZip = require("jszip");

// ---- offline zip ----
const solXml = `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.24" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive">
  <SolutionManifest>
    <UniqueName>SssCore</UniqueName>
    <LocalizedNames><LocalizedName description="SSS Core" languagecode="1033" /></LocalizedNames>
    <Version>1.0.0.3</Version>
    <Managed>0</Managed>
    <Publisher><UniqueName>sss</UniqueName><CustomizationPrefix>sss</CustomizationPrefix></Publisher>
    <RootComponents><RootComponent type="1" schemaName="account" behavior="0" /></RootComponents>
    <MissingDependencies>
      <MissingDependency>
        <Required type="1" schemaName="msdyn_workorder" displayName="Work Order" solution="FieldService (9.0.1.1)" />
        <Dependent type="60" id="{00000000-0000-0000-0000-000000000301}" displayName="Account" parentSchemaName="account" />
      </MissingDependency>
      <MissingDependency>
        <Required type="2" schemaName="msdyn_workorderid" displayName="Work Order" parentSchemaName="account" solution="FieldService (9.0.1.1)" />
        <Dependent type="60" id="{00000000-0000-0000-0000-000000000301}" displayName="Account" parentSchemaName="account" />
      </MissingDependency>
      <MissingDependency>
        <Required type="1" schemaName="contact" solution="System (9.2.0.0)" />
        <Dependent type="26" id="{00000000-0000-0000-0000-000000000401}" displayName="View" parentSchemaName="account" />
      </MissingDependency>
      <MissingDependency>
        <Required type="1" schemaName="msdyn_anchor" solution="msdynce_Anchor (1.0.0.0)" />
        <Dependent type="2" schemaName="sss_lookup" parentSchemaName="account" />
      </MissingDependency>
    </MissingDependencies>
  </SolutionManifest>
</ImportExportXml>`;
const zip = new JSZip();
zip.file("solution.xml", solXml);
zip.file("customizations.xml", "<ImportExportXml />");
const zipBytes = Array.from(await zip.generateAsync({ type: "uint8array" }));

// ---- mock host ----
const MOCK = `
(() => {
  const g = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
  const SOL = { core: g(1), fs: g(2), sys: g(3), managed: g(4), common: g(5), def: g(6), sales: g(7), other: g(8) };
  const PUB = { sss: g(11), ms: g(12), sys: g(13) };
  const E = { acc: g(101), wo: g(102), common: g(103), contact: g(104) };
  const A = { name: g(201), woid: g(202), st: g(203), sss: g(204) };
  const FORM_A = g(301), FORM_B = g(302), VIEW = g(401), FORM_FS = g(303), CHART = g(501);
  const FORM_A_XML = '<form><tabs><tab name="general"><labels><label description="General" languagecode="1033"/></labels><columns><column width="100%"><sections>'
    + '<section name="s1"><labels><label description="Summary" languagecode="1033"/></labels><rows>'
    + '<row><cell id="{c1}"><labels><label description="Name" languagecode="1033"/></labels><control id="name" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="name"/></cell></row>'
    + '<row><cell id="{c2}"><labels><label description="Work Order" languagecode="1033"/></labels><control id="msdyn_workorderid" classid="{270BD3DB-D9AF-4782-9025-509E298DEC0A}" datafieldname="msdyn_workorderid"/></cell></row>'
    + '<row><cell id="{c3}"><control id="SubAccounts" classid="{E7A81278-8635-4d9e-8D4D-59480B391C5B}" indicationOfSubgrid="true"><parameters><TargetEntityType>account</TargetEntityType><RelationshipName>account_parent_account</RelationshipName></parameters></control></cell></row>'
    + '<row><cell id="{c4}"><control id="Contacts" classid="{E7A81278-8635-4d9e-8D4D-59480B391C5B}" indicationOfSubgrid="true"><parameters><TargetEntityType>contact</TargetEntityType><RelationshipName>contact_customer_accounts</RelationshipName></parameters></control></cell></row>'
    + '</rows></section></sections></column></columns></tab></tabs></form>';
  const FORM_B_XML = '<form><tabs><tab name="qc"><columns><column width="100%"><sections><section name="q1"><rows>'
    + '<row><cell id="{q1}"><control id="msdyn_serviceterritory" classid="{270BD3DB-D9AF-4782-9025-509E298DEC0A}" datafieldname="msdyn_serviceterritory"/></cell></row>'
    + '</rows></section></sections></column></columns></tab></tabs></form>';
  const VIEW_FETCH = '<fetch version="1.0" mapping="logical"><entity name="account"><attribute name="name"/><attribute name="accountid"/><order attribute="name" descending="false"/>'
    + '<link-entity name="msdyn_workorder" from="msdyn_workorderid" to="msdyn_workorderid" alias="wo" link-type="outer"><attribute name="msdyn_name"/></link-entity></entity></fetch>';
  const VIEW_LAYOUT = '<grid name="resultset" object="1" jump="name" select="1" icon="1" preview="1"><row name="result" id="accountid"><cell name="name" width="300"/><cell name="wo.msdyn_name" width="150"/></row></grid>';

  // component catalog: every subcomponent of account and which solutions have a solutioncomponent row for it.
  // As in a D365 dev environment, the out-of-box account main form has rows in System and in every msdyn app that extends it.
  const catalog = {
    [A.woid]: { type: 2, table: 'account', owners: [SOL.fs] },
    [A.st]: { type: 2, table: 'account', owners: [SOL.fs] },
    [A.sss]: { type: 2, table: 'account', owners: [] },
    [FORM_A]: { type: 60, table: 'account', owners: [SOL.sys, SOL.fs, SOL.sales] },
    [FORM_B]: { type: 60, table: 'account', owners: [] },
    [VIEW]: { type: 26, table: 'account', owners: [] },
  };
  // extra subcomponents a test can add to account: a Field Service form and your own chart (both named by display name)
  const extra = {
    [FORM_FS]: { type: 60, table: 'account', owners: [SOL.fs] },
    [CHART]: { type: 59, table: 'account', owners: [] },
  };
  // account / contact: System created them; Sales and Field Service extend them, so they carry rows too
  const owners = { [E.acc]: [SOL.fs, SOL.sys, SOL.sales], [E.contact]: [SOL.sales, SOL.sys, SOL.fs], [E.wo]: [SOL.fs], [E.common]: [SOL.common] };
  let seq = 1000;
  const row = (objectid, componenttype, behavior, root) => ({ solutioncomponentid: g(seq++), objectid, componenttype, rootcomponentbehavior: behavior, rootsolutioncomponentid: root });
  const accRow = row(E.acc, 1, 0, null);
  const members = [accRow, ...Object.entries(catalog).map(([id, c]) => row(id, c.type, null, accRow.solutioncomponentid))];

  const envs = {
    primary: {
      conn: { id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' },
      solutions: [
        { solutionid: SOL.core, uniquename: 'SssCore', friendlyname: 'SSS Core', version: '1.0.0.3', ismanaged: false, _publisherid_value: PUB.sss },
        { solutionid: SOL.fs, uniquename: 'FieldService', friendlyname: 'Field Service', version: '9.0.1.1', ismanaged: true, _publisherid_value: PUB.ms },
        { solutionid: SOL.sys, uniquename: 'System', friendlyname: 'System', version: '9.2.0.0', ismanaged: true, _publisherid_value: PUB.sys },
        { solutionid: SOL.managed, uniquename: 'SssManaged', friendlyname: 'SSS Managed', version: '2.0.0.0', ismanaged: true, _publisherid_value: PUB.sss },
        { solutionid: SOL.common, uniquename: 'msdyn_AppCommon', friendlyname: 'App Common', version: '1.0', ismanaged: true, _publisherid_value: PUB.ms },
        { solutionid: SOL.def, uniquename: 'Default', friendlyname: 'Default Solution', version: '1.0', ismanaged: false, _publisherid_value: PUB.sys },
        { solutionid: SOL.sales, uniquename: 'msdynce_Sales', friendlyname: 'Sales', version: '9.0.2', ismanaged: true, _publisherid_value: PUB.ms },
      ],
    },
    secondary: {
      conn: { id: 'c2', name: 'SSS Test', url: 'https://sss-test.crm4.dynamics.com', environment: 'Test', environmentColor: '#92400e' },
      solutions: [
        { solutionid: g(90), uniquename: 'System', friendlyname: 'System', version: '9.2', ismanaged: true, _publisherid_value: PUB.sys },
        { solutionid: g(91), uniquename: 'msdyn_AppCommon', friendlyname: 'App Common', version: '1.0', ismanaged: true, _publisherid_value: PUB.ms },
      ],
    },
  };
  const publishers = [
    { publisherid: PUB.sss, uniquename: 'sss', customizationprefix: 'sss' },
    { publisherid: PUB.ms, uniquename: 'microsoftdynamics', customizationprefix: 'msdyn' },
    { publisherid: PUB.sys, uniquename: 'MicrosoftCorporation', customizationprefix: 'none' },
  ];
  const forms = { [FORM_A]: { formid: FORM_A, name: 'Account', objecttypecode: 'account', formxml: FORM_A_XML }, [FORM_B]: { formid: FORM_B, name: '=Quick Create', objecttypecode: 'account', formxml: FORM_B_XML },
    [FORM_FS]: { formid: FORM_FS, name: 'Work Order Summary', objecttypecode: 'account', formxml: '<form><tabs><tab name="t"><columns><column width="100%"><sections><section name="s"><rows><row><cell id="{f1}"><control id="name" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form>' } };
  const charts = { [CHART]: { savedqueryvisualizationid: CHART, name: 'Accounts by Industry', primaryentitytypecode: 'account' } };
  const views = { [VIEW]: { savedqueryid: VIEW, name: 'Accounts with work orders', returnedtypecode: 'account', fetchxml: VIEW_FETCH, layoutxml: VIEW_LAYOUT } };
  const attrs = { account: [
    { LogicalName: 'name', MetadataId: A.name, RequiredLevel: { Value: 'ApplicationRequired' }, IsCustomAttribute: false },
    { LogicalName: 'msdyn_workorderid', MetadataId: A.woid, RequiredLevel: { Value: 'None' }, IsCustomAttribute: true },
    { LogicalName: 'msdyn_serviceterritory', MetadataId: A.st, RequiredLevel: { Value: 'ApplicationRequired' }, IsCustomAttribute: true },
    { LogicalName: 'sss_custom', MetadataId: A.sss, RequiredLevel: { Value: 'None' }, IsCustomAttribute: true },
  ], contact: [], msdyn_workorder: [], msdyn_common: [] };
  const entityByName = { account: E.acc, contact: E.contact, msdyn_workorder: E.wo, msdyn_common: E.common };
  const attrByName = Object.fromEntries(attrs.account.map((a) => [a.LogicalName, a.MetadataId]));
  const dep = (id, type, parent) => ({ '@odata.type': '#Microsoft.Dynamics.CRM.dependency', requiredcomponentobjectid: id, requiredcomponenttype: type, requiredcomponentparentid: parent ?? null, dependencytype: 1 });
  function required(id, type) {
    if (M.extraReq[id]) return M.extraReq[id].map(([i, t, p]) => dep(i, t, p));
    if (type === 60) {
      const xml = forms[id]?.formxml ?? '';
      const out = [dep(E.acc, 1)];
      for (const m of xml.matchAll(/datafieldname="([^"]+)"/g)) if (attrByName[m[1]] && m[1] !== 'name') out.push(dep(attrByName[m[1]], 2, E.acc));
      for (const m of xml.matchAll(/<TargetEntityType>([^<]+)<[/]TargetEntityType>/g)) if (entityByName[m[1]]) out.push(dep(entityByName[m[1]], 1));
      return out;
    }
    if (type === 26) return /link-entity name="msdyn_workorder"/.test(views[id]?.fetchxml ?? '') ? [dep(E.wo, 1), dep(E.acc, 1)] : [dep(E.acc, 1)];
    if (type === 2 && id === A.woid) return [dep(E.wo, 1), dep(E.acc, 1)];
    if (type === 2 && id === A.sss) return [dep(E.common, 1)];
    return [];
  }

  const M = window.__mock = { envs, members, forms, views, queries: [], executes: [], updates: [], log: [], saved: [], notes: [], rrc: 0, managedFlip: false, nextText: null, nextBinary: null, FORM_A_XML, VIEW_FETCH, VIEW_LAYOUT, ids: { FORM_A, FORM_B, VIEW, FORM_FS, CHART, A, E, SOL },
    listeners: [], extraReq: {}, attrFail: false, formsFail: false, throttleOnce: false, throttled: 0, writeDelay: 0, inflight: 0, maxInflight: 0, byIdsCalls: 0 };
  M.owners = owners;
  M.emit = (event) => { for (const cb of M.listeners) cb(null, { event }); };
  // D2: many columns on account, msdyn_colNN owned by Field Service (they leave a shell), sss_colN yours (kept)
  M.addMany = (msdyn, own) => {
    const add = (name, i) => {
      const id = g(7000 + i);
      attrs.account.push({ LogicalName: name, MetadataId: id, RequiredLevel: { Value: 'None' }, IsCustomAttribute: true });
      attrByName[name] = id;
      catalog[id] = { type: 2, table: 'account', owners: name.startsWith('msdyn_') ? [SOL.fs] : [] };
      members.push(row(id, 2, null, accRow.solutioncomponentid));
    };
    for (let i = 0; i < msdyn; i++) add('msdyn_col' + String(i).padStart(2, '0'), i);
    for (let i = 0; i < own; i++) add('sss_col' + i, 500 + i);
  };
  M.addExtra = () => { for (const [id, c] of Object.entries(extra)) { catalog[id] = c; members.push(row(id, c.type, null, accRow.solutioncomponentid)); } };

  const page = (q, target, rows) => {
    const m = q.match(/&\\$skiptoken=(\\d+)/);
    const start = m ? Number(m[1]) : 0;
    const out = { value: rows.slice(start, start + 3) };
    if (start + 3 < rows.length) out['@odata.nextLink'] = envs[target].conn.url + '/api/data/v9.2/' + q.replace(/&\\$skiptoken=\\d+/, '') + '&$skiptoken=' + (start + 3);
    return out;
  };
  const idsIn = (q, field) => [...q.matchAll(new RegExp(field + ' eq ([0-9a-f-]{36})', 'g'))].map((m) => m[1]);
  const isGuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);

  window.toolboxAPI = {
    connections: { getActiveConnection: async () => envs.primary.conn, getSecondaryConnection: async () => envs.secondary.conn },
    utils: { getCurrentTheme: async () => 'light', showNotification: async (o) => { M.notes.push(o); } },
    events: { on(cb) { M.listeners.push(cb); } },
    fileSystem: {
      saveFile: async (name, content) => { M.saved.push({ name, content }); return '/tmp/' + name; },
      selectPath: async () => (M.nextText != null ? '/tmp/backup.json' : M.nextBinary ? '/tmp/SssCore.zip' : null),
      readText: async () => { const t = M.nextText; M.nextText = null; return t; },
      readBinary: async () => { const b = M.nextBinary; M.nextBinary = null; return b; },
    },
  };
  window.dataverseAPI = {
    getSolutions: async (cols, target = 'primary') => ({ value: envs[target].solutions.map((s) => ({ ...s, ismanaged: s.solutionid === SOL.core && M.managedFlip ? true : s.ismanaged })) }),
    getAllEntitiesMetadata: async () => ({ value: [
      { LogicalName: 'account', MetadataId: E.acc, PrimaryNameAttribute: 'name', IsCustomEntity: false },
      { LogicalName: 'contact', MetadataId: E.contact, PrimaryNameAttribute: 'fullname', IsCustomEntity: false },
      { LogicalName: 'msdyn_workorder', MetadataId: E.wo, PrimaryNameAttribute: 'msdyn_name', IsCustomEntity: true },
      { LogicalName: 'msdyn_common', MetadataId: E.common, PrimaryNameAttribute: 'msdyn_name', IsCustomEntity: true },
    ] }),
    getEntityRelatedMetadata: async (table) => {
      if (M.attrFail) throw new Error('mock: attribute metadata unavailable');
      return { value: attrs[table] ?? [] };
    },
    queryData: async (q, target = 'primary') => {
      M.queries.push({ q, target });
      // concurrency of id-chunked reads (owning solutions, record names)
      const byIds = / or |objectid eq|formid eq|savedqueryid eq/.test(q) && !q.includes('_solutionid_value eq');
      if (byIds) { M.byIdsCalls++; M.inflight++; M.maxInflight = Math.max(M.maxInflight, M.inflight); }
      try {
        await new Promise((r) => setTimeout(r, 10));
        if (byIds && M.throttleOnce && q.includes('objectid eq')) {
          M.throttleOnce = false;
          M.throttled++;
          throw Object.assign(new Error('mock: 429 Too Many Requests. Retry-After: 0'), { status: 429 });
        }
        if (M.formsFail && q.startsWith('systemforms?')) throw new Error('mock: systemforms unavailable');
        return await answer(q, target);
      } finally {
        if (byIds) M.inflight--;
      }
    },
  };
  async function answer(q, target) {
      let m;
      if (q.includes('_rootsolutioncomponentid_value')) throw new Error("Dataverse queryData failed: 0x80060888: Could not find a property named '_rootsolutioncomponentid_value' on type 'Microsoft.Dynamics.CRM.solutioncomponent'.");
      if ((m = q.match(/^RetrieveRequiredComponents\\(ObjectId=([^,]+),ComponentType=(\\d+)\\)$/))) {
        if (!isGuid(m[1])) throw new Error('mock: ObjectId must be an unquoted guid, got ' + m[1]);
        M.rrc++;
        if (M.rrcFail) throw new Error('mock: RetrieveRequiredComponents unavailable');
        if (M.onRrc) { const f = M.onRrc; M.onRrc = null; f(); }
        return { '@odata.context': 'x#Microsoft.Dynamics.CRM.RetrieveRequiredComponentsResponse', EntityCollection: required(m[1], Number(m[2])) };
      }
      if (q.startsWith('publishers?')) return { value: publishers };
      if (q.startsWith('solutions?')) {
        const id = idsIn(q, 'solutionid')[0];
        const s = envs.primary.solutions.find((x) => x.solutionid === id);
        return { value: s ? [{ solutionid: s.solutionid, uniquename: s.uniquename, ismanaged: s.solutionid === SOL.core && M.managedFlip ? true : s.ismanaged }] : [] };
      }
      if (q.startsWith('solutioncomponents?') && q.includes('_solutionid_value eq')) {
        const sid = idsIn(q, '_solutionid_value')[0];
        return page(q, target, sid === SOL.core ? members.map((r) => ({ ...r })) : []);
      }
      if (q.startsWith('solutioncomponents?') && q.includes('objectid eq')) {
        const out = [];
        for (const id of idsIn(q, 'objectid')) {
          const own = [...(catalog[id]?.owners ?? owners[id] ?? [])];
          if (members.some((r) => r.objectid === id)) own.push(SOL.core);
          for (const s of own) out.push({ objectid: id, componenttype: catalog[id]?.type ?? 1, _solutionid_value: s });
        }
        return { value: out };
      }
      if (q.startsWith('systemforms?')) return { value: idsIn(q, 'formid').filter((id) => forms[id]).map((id) => ({ ...forms[id] })) };
      if (q.startsWith('savedqueryvisualizations?')) return { value: idsIn(q, 'savedqueryvisualizationid').filter((id) => charts[id]).map((id) => ({ ...charts[id] })) };
      if (q.startsWith('savedqueries?')) return { value: idsIn(q, 'savedqueryid').filter((id) => views[id]).map((id) => ({ ...views[id] })) };
      throw new Error('mock: unexpected query ' + q);
  }
  Object.assign(window.dataverseAPI, {
    execute: async (req) => {
      M.executes.push(JSON.parse(JSON.stringify(req)));
      const p = req.parameters ?? {};
      if (req.operationName === 'RetrieveRequiredComponents') throw new Error('mock: RetrieveRequiredComponents must go through queryData, not execute');
      if (req.operationName === 'RetrieveCurrentOrganization') return { Detail: { EnvironmentId: 'env-123' } };
      if (req.operationName === 'RemoveSolutionComponent') {
        const sc = p.SolutionComponent;
        if ('ComponentId' in p) throw new Error("mock: The parameter 'ComponentId' in the request payload is not a valid parameter for the operation 'RemoveSolutionComponent'.");
        if (!sc || sc['@odata.type'] !== 'Microsoft.Dynamics.CRM.solutioncomponent' || !isGuid(sc.solutioncomponentid)) throw new Error('mock: bad SolutionComponent ' + JSON.stringify(sc));
        p.ComponentId = sc.solutioncomponentid;
      }
      if (req.operationName === 'RemoveSolutionComponent' || req.operationName === 'AddSolutionComponent') {
        M.log.push(req.operationName);
        if (p.SolutionUniqueName !== 'SssCore') throw new Error('mock: wrong solution ' + p.SolutionUniqueName);
        if (!isGuid(p.ComponentId)) throw new Error('mock: bad ComponentId');
      }
      if (req.operationName === 'RemoveSolutionComponent') {
        const r = members.find((x) => x.objectid === p.ComponentId);
        if (!r) throw new Error('mock: not a member ' + p.ComponentId);
        for (let i = members.length - 1; i >= 0; i--) if (members[i] === r || members[i].rootsolutioncomponentid === r.solutioncomponentid) members.splice(i, 1);
        return {};
      }
      if (req.operationName === 'AddSolutionComponent') {
        if (p.AddRequiredComponents !== false) throw new Error('mock: AddRequiredComponents must be false');
        if (p.ComponentType === 1) {
          let r = members.find((x) => x.objectid === p.ComponentId);
          if (!r) members.push((r = row(p.ComponentId, 1, p.DoNotIncludeSubcomponents ? 1 : 0, null)));
          else r.rootcomponentbehavior = p.DoNotIncludeSubcomponents ? 1 : 0;
          if (!p.DoNotIncludeSubcomponents) for (const [id, c] of Object.entries(catalog)) if (!members.some((x) => x.objectid === id)) members.push(row(id, c.type, null, r.solutioncomponentid));
        } else if (!members.some((x) => x.objectid === p.ComponentId)) {
          const root = members.find((x) => x.objectid === E.acc);
          members.push(row(p.ComponentId, p.ComponentType, null, root ? root.solutioncomponentid : null));
        }
        return {};
      }
      if (req.operationName === 'PublishXml') { M.log.push('PublishXml'); return {}; }
      throw new Error('mock: unexpected execute ' + req.operationName);
    },
    update: async (entity, id, rec) => {
      if (M.writeDelay) await new Promise((r) => setTimeout(r, M.writeDelay));
      M.updates.push({ entity, id, rec: { ...rec } });
      M.log.push('update:' + entity);
      if (entity === 'systemform') forms[id].formxml = rec.formxml;
      else if (entity === 'savedquery') Object.assign(views[id], rec);
      else throw new Error('mock: unexpected update ' + entity);
    },
  });
})();
`;

const { page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto("file://" + TOOL + "/dist/index.html");
const M = (fn) => page.evaluate(fn);
// the last confirmation before a write names the environment, the scope and the way back
const okWrite = async (scope) => {
  await page.waitForSelector("#dlg[open] #dlg-write");
  const t = await page.textContent("#dlg-write");
  assert(t.includes("SSS Dev") && t.includes("https://sss-dev.crm4.dynamics.com") && t.includes(scope) && /backup/i.test(t), "write confirmation names environment, scope and way back: " + t);
  await page.click("#dlg-ok");
};

// ---- load ----
await page.waitForFunction(() => document.querySelectorAll("#solution option[value]:not([value=''])").length > 0);
const opts = await page.$$eval("#solution option", (els) => els.map((e) => e.textContent));
assert(opts.length === 1 && opts[0].includes("SssCore"), "picker lists unmanaged only (no managed, no Default): " + opts.join(" | "));
assert((await page.$$eval("#conn .connchip", (els) => els.length)) === 2, "dev + target connection chips");

// ---- cancel, then full run reuses the cache ----
await page.evaluate(() => {
  window.__mock.onRrc = () => document.querySelector("#btn-cancel").click();
  document.querySelector("#btn-run").click();
});
await page.waitForFunction(() => window.__mock.notes.some((n) => n.title === "Cancelled"));
const rrcAfterCancel = await M(() => window.__mock.rrc);
assert(rrcAfterCancel > 0 && rrcAfterCancel < 7, `cancel stops new RetrieveRequiredComponents calls (${rrcAfterCancel} of 7)`);
await page.click("#btn-run");
await page.waitForFunction(() => document.querySelectorAll("#findings .finding").length > 0);
assert((await M(() => window.__mock.rrc)) === 7, "session cache: 7 components → 7 RetrieveRequiredComponents calls across cancel + rerun");
const q0 = await M(() => window.__mock.queries);
const ex0 = await M(() => window.__mock.executes);
assert(q0.some((x) => x.q.startsWith("RetrieveRequiredComponents(ObjectId=00000000-")) && !ex0.some((e) => e.operationName === "RetrieveRequiredComponents"), "RetrieveRequiredComponents goes through queryData with an unquoted guid, never execute");
assert(q0.some((x) => x.q.startsWith("solutioncomponents?") && x.q.includes("$skiptoken=3")) && !q0.some((x) => x.q.startsWith("http")), "solution components paged via nextLink (relative)");
const ownQ = q0.filter((x) => x.q.includes("objectid eq"));
assert(ownQ.length >= 1 && ownQ.every((x) => (x.q.match(/objectid eq/g) || []).length <= 40), "owning solutions resolved with chunked or-filters (≤40)");

// ---- findings ----
const cards = await page.$$eval("#findings .finding", (els) => els.map((e) => ({ key: e.dataset.key, text: e.textContent })));
assert(cards.length === 5, "5 blocker findings shown (safe one hidden): " + cards.map((c) => c.key).join(","));
const byName = (n) => cards.find((c) => c.text.includes(n));
// bug 1: account / contact and the account main form have solutioncomponent rows in System, Sales and Field Service.
// Ownership is the solution that created them (System), not any msdyn solution that extends them.
const ids0 = await M(() => window.__mock.ids);
assert(!cards.some((c) => c.key === `1:${ids0.E.acc}`) && !cards.some((c) => /Remove this table|Table account belongs to/.test(c.text)), "bug 1: account (System table extended by Sales + Field Service) is not reported as msdyn-owned / 'Remove this table'");
const formAOpts = await page.$$eval(`.finding[data-key="60:${ids0.FORM_A}"] select option`, (els) => els.map((e) => e.value));
assert(formAOpts.includes("edit-form"), "bug 1: customized System main form is not msdyn-owned (edit-form offered): " + formAOpts.join(","));
const formAChips = await page.$$eval(`.finding[data-key="60:${ids0.FORM_A}"] .req`, (els) => els.map((e) => e.textContent));
assert(formAChips.length > 0 && !formAChips.some((t) => /Table (account|contact)\b/.test(t)), "bug 1: account / contact are not required msdyn components of the account form: " + formAChips.join(" | "));
assert(byName("msdyn_workorderid")?.text.includes("FieldService") && byName("msdyn_workorderid").text.includes("msdyn_workorder"), "column msdyn_workorderid: owned by FieldService, requires msdyn_workorder");
const formCard = cards.find((c) => c.text.includes("Form") && c.text.includes("Account") && !c.text.includes("Quick"));
assert(formCard && formCard.text.includes("Column msdyn_workorderid") && formCard.text.includes("blocker"), "form grouped as dependent with required column chip");
assert(byName("Accounts with work orders")?.text.includes("Table msdyn_workorder"), "view requires table msdyn_workorder");
assert((await page.textContent("#diag-summary")).includes("5 blockers") && (await page.textContent("#diag-summary")).includes("1 present in target"), "summary: 5 blockers, 1 present in target");
await page.check("#show-safe");
const safeCard = await page.$eval("#findings .finding.is-safe", (e) => ({ text: e.textContent, href: e.querySelector("a")?.getAttribute("href") }));
assert(safeCard.text.includes("sss_custom") && safeCard.text.includes("msdyn_AppCommon"), "D4: dependency on a solution present in target is marked safe");
assert(safeCard.href === "https://make.powerapps.com/environments/env-123/solutions/00000000-0000-0000-0000-000000000001", "report-only finding deep-links to the maker portal solution");
await page.uncheck("#show-safe");
await page.screenshot({ path: resolve(OUT, "01-diagnose.png"), fullPage: true });

// ---- exports ----
assert((await page.isVisible("#btn-export-json")) && (await page.isVisible("#btn-export-csv")), "D8: Findings JSON / CSV shown on the Diagnose tab");
await page.click("#btn-export-csv");
await page.click("#btn-export-json");
let saved = await M(() => window.__mock.saved);
assert(saved[0].name.endsWith(".csv") && saved[0].content.startsWith("status,dependent type") && saved[0].content.includes("'=Quick Create") && !/,=Quick/.test(saved[0].content), "CSV export, formula cell neutralised");
assert(JSON.parse(saved[1].content).findings.length === 6, "JSON export has all findings incl. safe");

// ---- select fixes → preview ----
const sel = async (key, fix) => page.selectOption(`.finding[data-key="${key}"] select`, fix);
const ids = await M(() => window.__mock.ids);
await sel(`2:${ids.A.woid}`, "shell");
await sel(`60:${ids.FORM_A}`, "edit-form");
await sel(`60:${ids.FORM_B}`, "edit-form");
await sel(`26:${ids.VIEW}`, "edit-view");
assert((await page.textContent("#sel-count")) === "4 selected", "4 fixes selected");
await page.click("#btn-to-fix");
await page.waitForSelector("#ops li");
// the quick create form is yours (unmanaged) and kept by default (see B1); this run lets it leave with the shell
await page.uncheck('input[aria-label="Keep =Quick Create"]');
const opsText = await page.$$eval("#ops > li", (els) => els.map((e) => e.querySelector(".mono").textContent));
assert(opsText[0] === "RemoveSolutionComponent Table account" && opsText[1] === "AddSolutionComponent Table account (DoNotIncludeSubcomponents)", "shell: remove, then add with DoNotIncludeSubcomponents");
assert(opsText.includes("AddSolutionComponent Column sss_custom") && opsText.some((t) => t.startsWith("AddSolutionComponent Form Account")) && opsText.some((t) => t.startsWith("AddSolutionComponent View")), "re-adds own-prefix column and edited form/view");
assert(!opsText.some((t) => t.includes("msdyn_workorderid") || t.includes("msdyn_serviceterritory") || t.includes("Quick")), "msdyn columns and unedited quick create form leave");
assert(opsText.at(-1) === "PublishXml account", "PublishXml last, with touched tables");
const leaving = await page.textContent("#fix-body");
assert(leaving.includes("Shell conversion: account") && leaving.includes("msdyn_serviceterritory"), "preview lists subcomponents leaving");
assert(leaving.includes("=Quick Create (nothing to strip: kept msdyn_serviceterritory"), "required column kept on quick create form (reported, not stripped)");
const diff = await page.$eval('pre[aria-label="formxml diff Account"]', (e) => ({ del: [...e.querySelectorAll(".del")].map((x) => x.textContent).join("\n"), add: e.querySelectorAll(".add").length }));
assert(diff.del.includes('datafieldname="msdyn_workorderid"') && !diff.del.includes('datafieldname="name"'), "form diff shows the msdyn control removed, name kept");
assert(await page.$('pre[aria-label="fetchxml diff Accounts with work orders"] .del'), "view fetchxml diff shown");

// ---- D1: diff blocks are closed folds with line counts; expand / collapse all; open state survives a re-render ----
const folds = () => page.$$eval("#ops details.diff-fold", (els) => els.map((d) => ({ open: d.open, summary: d.querySelector("summary").textContent, chev: d.querySelector("summary").classList.contains("chev"), del: d.querySelectorAll("pre .del").length, add: d.querySelectorAll("pre .add").length, label: d.querySelector("pre").getAttribute("aria-label") })));
let fl = await folds();
assert(fl.length === 3 && fl.every((f) => !f.open && f.chev), "D1: 3 diff folds (form + view fetch/layout), all closed by default: " + JSON.stringify(fl.map((f) => f.open)));
const formFold = fl.find((f) => f.label === "formxml diff Account");
assert(formFold && formFold.summary === `Show form XML diff (−${formFold.del} / +${formFold.add} lines)` && formFold.del > 0, "D1: summary counts the removed / added lines: " + formFold?.summary);
assert(fl.some((f) => /^Show view FetchXML diff \(−[1-9]\d* \/ \+\d+ lines\)$/.test(f.summary)) && fl.some((f) => f.summary.startsWith("Show view LayoutXML diff")), "D1: view folds name FetchXML / LayoutXML: " + fl.map((f) => f.summary).join(" | "));
assert(!(await page.isVisible('pre[aria-label="formxml diff Account"]')), "D1: closed fold hides the diff");
await page.click("#ops-head .fold-all >> text=Expand all");
assert((await folds()).every((f) => f.open), "D1: Expand all opens every diff");
await page.click("#ops-head .fold-all >> text=Collapse all");
assert((await folds()).every((f) => !f.open), "D1: Collapse all closes every diff");
await page.click('#ops details.diff-fold:has(pre[aria-label="formxml diff Account"]) > summary');
assert(await page.isVisible('pre[aria-label="formxml diff Account"]'), "D1: clicking the summary opens the diff");
// a keep tick re-renders the operations list: the opened fold stays open, the others stay closed
await page.check('input[aria-label="Keep =Quick Create"]');
await page.uncheck('input[aria-label="Keep =Quick Create"]');
fl = await folds();
assert(fl.find((f) => f.label === "formxml diff Account").open && fl.filter((f) => f.open).length === 1, "D1: opened fold kept open after the ops re-render");

// ---- backup gate ----
assert(await page.isDisabled("#btn-confirm"), "confirm disabled before backup");
await page.click("#btn-backup");
await page.waitForFunction(() => !document.querySelector("#btn-confirm").disabled);
saved = await M(() => window.__mock.saved);
const backup = saved.at(-1);
const bk = JSON.parse(backup.content);
assert(/^dependency-cleaner-backup-SssCore-\d{4}-\d\d-\d\dT[\d-]+\.json$/.test(backup.name) && bk.kind === "sss-dependency-cleaner-backup", "backup file saved: " + backup.name);
assert(bk.forms.length === 1 && bk.forms[0].formxml.includes("msdyn_workorderid") && bk.views[0].fetchxml.includes("link-entity") && bk.membership.length === 7, "backup holds original XML and full membership");
assert((await M(() => window.__mock.executes.filter((e) => e.operationName !== "RetrieveCurrentOrganization").length)) === 0 && (await M(() => window.__mock.updates.length)) === 0, "nothing written before confirm");
await page.screenshot({ path: resolve(OUT, "02-fix-preview.png"), fullPage: true });

// ---- confirm ----
await page.click("#btn-confirm");
await page.waitForSelector("#dlg[open] #dlg-write");
await page.click("#dlg-cancel");
await page.waitForTimeout(200);
assert((await M(() => window.__mock.updates.length)) === 0 && !(await page.isDisabled("#btn-confirm")), "write confirmation cancelled: nothing written, Confirm available again");
await page.click("#btn-confirm");
await okWrite("operations on solution SssCore");
await page.waitForSelector("#rediag", { timeout: 15000 });
const log = await M(() => window.__mock.log);
const ex = await M(() => window.__mock.executes.filter((e) => /SolutionComponent|PublishXml/.test(e.operationName)));
assert(ex[0].operationName === "RemoveSolutionComponent" && ex[0].parameters.ComponentType === 1 && ex[0].parameters.SolutionComponent?.solutioncomponentid === ids.E.acc && !("ComponentId" in ex[0].parameters) && !("DoNotIncludeSubcomponents" in ex[0].parameters), "RemoveSolutionComponent(account)");
assert(ex[1].operationName === "AddSolutionComponent" && ex[1].parameters.DoNotIncludeSubcomponents === true && ex[1].parameters.AddRequiredComponents === false && ex[1].parameters.SolutionUniqueName === "SssCore", "AddSolutionComponent(account, DoNotIncludeSubcomponents=true, AddRequiredComponents=false)");
const firstUpdate = log.findIndex((x) => x.startsWith("update:"));
assert(log.lastIndexOf("AddSolutionComponent") < firstUpdate && log.at(-1) === "PublishXml", "order: membership → form/view updates → PublishXml: " + log.join(","));
const pub = ex.find((e) => e.operationName === "PublishXml");
assert(pub.parameters.ParameterXml === "<importexportxml><entities><entity>account</entity></entities></importexportxml>", "PublishXml with touched tables");
const ups = await M(() => window.__mock.updates);
const fu = ups.find((u) => u.entity === "systemform");
const vu = ups.find((u) => u.entity === "savedquery");
assert(ups.length === 2 && fu.id === ids.FORM_A && !fu.rec.formxml.includes("msdyn_workorderid") && fu.rec.formxml.includes('datafieldname="name"'), "form updateRecord: msdyn control stripped, primary name kept");
assert(fu.rec.formxml.includes("<TargetEntityType>account</TargetEntityType>") && fu.rec.formxml.includes("<TargetEntityType>contact</TargetEntityType>"), "bug 1: subgrids targeting account / contact are not stripped from the form");
assert(!vu.rec.fetchxml.includes("link-entity") && vu.rec.fetchxml.includes('attribute name="name"') && !vu.rec.layoutxml.includes("wo.msdyn_name") && vu.rec.layoutxml.includes('cell name="name"'), "view updateRecord: link-entity and its layout cell stripped");
const members = await M(() => window.__mock.members.map((m) => m.objectid + ":" + m.rootcomponentbehavior));
assert(members.includes(ids.E.acc + ":1") && !members.some((m) => m.startsWith(ids.A.woid)) && !members.some((m) => m.startsWith(ids.FORM_B)) && members.some((m) => m.startsWith(ids.A.sss)), "solution: account shell, msdyn columns gone, own column kept");
const rediag = await page.textContent("#rediag");
assert(rediag.includes("5 fixed") && rediag.includes("0 still present") && rediag.includes("0 blockers now"), "re-diagnosis clean: " + rediag);
assert((await page.$$eval("#findings .finding", (els) => els.length)) === 0, "no blocker findings after fix");
await page.screenshot({ path: resolve(OUT, "03-results.png"), fullPage: true });

// ---- restore ----
await page.click('.tab[data-tab="restore"]');
assert((await page.isHidden("#btn-export-json")) && (await page.isHidden("#btn-export-csv")), "D8: Findings JSON / CSV hidden off the Diagnose tab (Restore, after Fix)");
await page.evaluate((t) => { window.__mock.nextText = t; }, backup.content);
await page.click("#btn-load-backup");
await page.waitForSelector("#restore-ops li");
const rops = await page.$$eval("#restore-ops > li .mono", (els) => els.map((e) => e.textContent));
const rfolds = await page.$$eval("#restore-ops details.diff-fold", (els) => els.map((d) => d.open));
assert(rfolds.length === 3 && rfolds.every((o) => !o) && (await page.$("#restore-ops-head .fold-all")), "D1: restore diffs closed by default, with Expand all / Collapse all");
await page.click("#restore-ops-head .fold-all >> text=Expand all");
assert((await page.$$eval("#restore-ops details.diff-fold", (els) => els.every((d) => d.open))) && (await page.$eval("#restore-ops pre.diff", (e) => e.querySelectorAll(".del, .add").length > 0)), "D1: restore Expand all opens the diffs");
assert(rops[0] === "RemoveSolutionComponent Table account" && rops[1] === "AddSolutionComponent Table account" && rops.some((t) => t.startsWith("Update form Account")) && rops.some((t) => t.startsWith("Update view")) && rops.at(-1) === "PublishXml account", "restore plan: table back to all assets, XML back, publish: " + rops.join(" | "));
await page.click("#btn-restore-apply");
await okWrite("on solution SssCore, back to the backup of");
await page.waitForSelector("#restore-results table");
const after = await M(() => ({ form: window.__mock.forms[window.__mock.ids.FORM_A].formxml === window.__mock.FORM_A_XML, fetch: window.__mock.views[window.__mock.ids.VIEW].fetchxml === window.__mock.VIEW_FETCH, layout: window.__mock.views[window.__mock.ids.VIEW].layoutxml === window.__mock.VIEW_LAYOUT, members: window.__mock.members.map((m) => m.objectid + ":" + m.rootcomponentbehavior), pubs: window.__mock.log.filter((x) => x === "PublishXml").length }));
assert(after.form && after.fetch && after.layout, "restore writes original formxml / fetchxml / layoutxml back");
assert(after.members.includes(ids.E.acc + ":0") && after.members.length === 7, "restore puts account back with all assets (7 members)");
assert(after.pubs === 2, "restore publishes");
await page.click('.tab[data-tab="diagnose"]');
assert((await page.isVisible("#btn-export-json")) && (await page.isVisible("#btn-export-csv")), "D8: Findings JSON / CSV shown again back on Diagnose");
await page.click("#btn-run");
await page.waitForFunction(() => document.querySelectorAll("#findings .finding").length === 5);
assert(true, "after restore the 5 blockers are back");

// ---- managed refusal: restore of a managed solution ----
await page.click('.tab[data-tab="restore"]');
await page.evaluate((t) => { window.__mock.nextText = t; }, JSON.stringify({ ...bk, solution: { ...bk.solution, uniqueName: "SssManaged" } }));
await page.click("#btn-load-backup");
await page.waitForSelector("#restore-error");
assert((await page.textContent("#restore-error")).includes("managed") && (await page.isHidden("#restore-actions")), "restore refuses a managed solution");

// ---- managed refusal: fix re-checks the managed flag right before writing ----
const writesBefore = await M(() => window.__mock.log.length);
await page.click('.tab[data-tab="diagnose"]');
await sel(`26:${ids.VIEW}`, "edit-view");
await page.click("#btn-to-fix");
await page.waitForSelector("#ops li");
await page.click("#btn-backup");
await page.waitForFunction(() => !document.querySelector("#btn-confirm").disabled);
await page.evaluate(() => { window.__mock.managedFlip = true; });
await page.click("#btn-confirm");
await page.waitForFunction(() => window.__mock.notes.some((n) => n.title === "Refused"));
assert((await M(() => window.__mock.log.length)) === writesBefore, "managed solution: nothing written");
assert((await page.textContent("#fix-banners")).includes("managed") && (await page.isDisabled("#btn-confirm")), "managed banner shown, confirm disabled");
await page.evaluate(() => { window.__mock.managedFlip = false; });

// ---- offline ----
await page.click('.tab[data-tab="offline"]');
assert(await page.isHidden("#btn-export-json"), "D8: Findings JSON hidden on the Offline tab");
await page.evaluate((b) => { window.__mock.nextBinary = b; }, zipBytes);
await page.click("#btn-open-zip");
await page.waitForSelector("#offline-summary");
const off = await page.textContent("#offline-body");
assert(off.includes("4 missing dependencies") && off.includes("2 dependents in scope") && off.includes("2 blocking"), "offline: 4 missing, 2 dependents in scope (System filtered out)");
const offCards = await page.$$eval("#offline-body .finding", (els) => els.map((e) => e.querySelectorAll(".req").length));
assert(JSON.stringify(offCards.sort()) === "[1,2]", "offline: grouped by dependent (form has 2 required)");
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.screenshot({ path: resolve(OUT, "04-offline-dark.png"), fullPage: true });

// ---- S5 / S4: only present-in-target findings → filtered empty state; "Show present in target" persisted ----
await page.click('.tab[data-tab="diagnose"]');
assert((await page.getAttribute('.tab[data-tab="diagnose"]', "aria-selected")) === "true" && (await page.getAttribute('.tab[data-tab="offline"]', "aria-selected")) === "false", "S6: tabs aria-selected follows the clicked tab");
// the target gets Field Service and Sales too: every dependency is then present in the target
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#solution option[value]:not([value=''])").length > 0);
await page.evaluate(() => {
  const m = window.__mock;
  for (const u of ["FieldService", "msdynce_Sales"]) m.envs.secondary.solutions.push({ ...m.envs.primary.solutions.find((s) => s.uniquename === u), solutionid: "00000000-0000-0000-0000-0000000009" + (u === "FieldService" ? "92" : "93") });
  m.emit("connection:updated");
});
await page.waitForTimeout(300);
await page.waitForFunction(() => !document.querySelector("#btn-run").disabled);
await page.evaluate(() => document.querySelector("#diag-summary").replaceChildren());
await page.click("#btn-run");
await page.waitForSelector("#diag-summary .summary");
const s5 = await page.$eval("#findings", (e) => ({ text: e.textContent, btn: !!e.querySelector(".empty-actions button"), cards: e.querySelectorAll(".finding").length }));
assert(s5.cards === 0 && s5.btn && s5.text.includes("Tick “Show present in target”"), "S5: every finding present in target → filtered empty state with explanation + button: " + s5.text);
await page.click("#findings .empty-actions button");
const s5after = await page.$$eval("#findings .finding", (els) => els.map((e) => e.classList.contains("is-safe")));
assert((await page.isChecked("#show-safe")) && s5after.length > 0 && s5after.every(Boolean), "S5: the button ticks “Show present in target” and shows the present-in-target findings: " + s5after.length);
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#solution option[value]:not([value=''])").length > 0);
assert(await page.isChecked("#show-safe"), "S4: “Show present in target” is restored after reload");
await page.uncheck("#show-safe");
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#solution option[value]:not([value=''])").length > 0);
assert(!(await page.isChecked("#show-safe")), "S4: unticked again after reload");

// ---- regression cases (fresh page each: the init script resets the mock) ----
const fresh = async () => {
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll("#solution option[value]:not([value=''])").length > 0);
};
const diagnoseNow = async () => {
  await page.click('.tab[data-tab="diagnose"]');
  await page.evaluate(() => document.querySelector("#diag-summary").replaceChildren());
  await page.click("#btn-run");
  await page.waitForSelector("#diag-summary .summary");
};
const previewNow = async () => {
  await page.evaluate(() => document.querySelector("#fix-body").replaceChildren());
  await page.click("#btn-to-fix");
  await page.waitForFunction(() => document.querySelector("#preview-error") || document.querySelector("#ops-wrap h3"));
};
const selD = async (key, fix) => {
  await page.click('.tab[data-tab="diagnose"]');
  await sel(key, fix);
};
const opLabels = () => page.$$eval("#ops > li .mono", (els) => els.map((e) => e.textContent));
const keepBox = (name) => page.isChecked(`input[aria-label="Keep ${name}"]`);

// ---- B1: shell conversion keeps your forms / views / charts by ownership, not by name prefix ----
await fresh();
await M(() => window.__mock.addExtra());
await diagnoseNow();
await selD(`2:${ids.A.woid}`, "shell");
await previewNow();
const keep = {
  quick: await keepBox("=Quick Create"),
  mainForm: await keepBox("Account"),
  view: await keepBox("Accounts with work orders"),
  chart: await keepBox("Accounts by Industry"),
  fsForm: await keepBox("Work Order Summary"),
  msdynCol: await keepBox("msdyn_workorderid"),
  ownCol: await keepBox("sss_custom"),
};
assert(keep.quick && keep.mainForm && keep.view && keep.chart, "B1: unmanaged / non-filtered forms, views and charts are kept by default: " + JSON.stringify(keep));
assert(keep.mainForm, "bug 1: shell keeps the customized System main form (rows in System + Sales + Field Service)");
assert(!keep.fsForm && !keep.msdynCol && keep.ownCol, "B1: form owned by filtered FieldService and msdyn column leave; own-prefix column kept: " + JSON.stringify(keep));
const b1ops = await opLabels();
assert(b1ops.some((t) => t.startsWith("AddSolutionComponent Chart Accounts by Industry")) && b1ops.some((t) => t.startsWith("AddSolutionComponent Form =Quick Create")) && !b1ops.some((t) => t.includes("Work Order Summary")), "B1: re-add ops for kept chart and quick create form, none for the Field Service form");

assert(!(await page.isChecked(".card.shell-card .shell-only")) && (await page.textContent(".card.shell-card .shell-count")) === "8 subcomponents shown", "D2: a short leaving list (8) opens with every row, Only leaving off");

// ---- D2: shell leaving list: search, type filter, Only leaving, Keep / Drop all shown ----
await fresh();
await M(() => window.__mock.addMany(30, 6));
await diagnoseNow();
await selD(`2:${ids.A.woid}`, "shell");
await previewNow();
const SH = ".card.shell-card";
const shown = () => page.$$eval(`${SH} .leaving label:not([hidden])`, (els) => els.map((e) => ({ name: e.querySelector(".mono").textContent, keep: e.querySelector("input").checked })));
const shCount = () => page.textContent(`${SH} .shell-count`);
const leaveBadge = () => page.textContent(`${SH} .card-head .badge`);
const keepState = () => page.$$eval(`${SH} .leaving label`, (els) => Object.fromEntries(els.map((e) => [e.querySelector(".mono").textContent, e.querySelector("input").checked])));
let rowsNow = await shown();
assert(await page.isChecked(`${SH} .shell-only`), "D2: a long leaving list (42 > 30) opens on Only leaving");
assert((await shCount()) === "32 of 42 subcomponents shown" && rowsNow.length === 32 && rowsNow.every((r) => !r.keep), "D2: Only leaving shows the 32 unticked rows: " + (await shCount()));
assert((await leaveBadge()) === "32 leave", "D2: header badge counts the rows that leave");
const typeOpts = await page.$$eval(`${SH} .shell-type option`, (els) => els.map((e) => e.textContent));
assert(JSON.stringify(typeOpts) === JSON.stringify(["All types", "Column (39)", "View (1)", "Form (2)"]), "D2: type filter options derived from the rows: " + typeOpts.join(", "));
await page.uncheck(`${SH} .shell-only`);
assert((await shCount()) === "42 subcomponents shown", "D2: Only leaving off shows all 42");
await page.selectOption(`${SH} .shell-type`, { label: "Form (2)" });
rowsNow = await shown();
assert((await shCount()) === "2 of 42 subcomponents shown" && rowsNow.map((r) => r.name).sort().join() === "=Quick Create,Account", "D2: type filter narrows to forms: " + rowsNow.map((r) => r.name).join());
await page.selectOption(`${SH} .shell-type`, "");
await page.fill(`${SH} .shell-search`, "sss_");
rowsNow = await shown();
assert((await shCount()) === "7 of 42 subcomponents shown" && rowsNow.every((r) => r.name.startsWith("sss_") && r.keep), "D2: search narrows to the 7 sss_ columns, all kept: " + (await shCount()));
const beforeDrop = await keepState();
await page.click(`${SH} button:text-is("Drop all shown")`);
const afterDrop = await keepState();
const changedRows = Object.keys(afterDrop).filter((k) => afterDrop[k] !== beforeDrop[k]);
assert(changedRows.length === 7 && changedRows.every((k) => k.startsWith("sss_")) && afterDrop["Account"] && afterDrop["=Quick Create"] && afterDrop["Accounts with work orders"], "D2: Drop all shown unticks only the 7 shown rows; hidden forms / view stay ticked: " + changedRows.join());
assert((await leaveBadge()) === "39 leave", "D2: badge follows Drop all shown: " + (await leaveBadge()));
let d2ops = await opLabels();
assert(!d2ops.some((t) => t.includes("sss_")) && d2ops.some((t) => t.startsWith("AddSolutionComponent Form Account")), "D2: dropped columns get no re-add; hidden kept form still re-added");
await page.fill(`${SH} .shell-search`, "msdyn_col0");
assert((await shCount()) === "10 of 42 subcomponents shown", "D2: search msdyn_col0 shows 10");
await page.click(`${SH} button:text-is("Keep all shown")`);
const afterKeep = await keepState();
const kept = Object.keys(afterKeep).filter((k) => afterKeep[k] !== afterDrop[k]);
assert(kept.length === 10 && kept.every((k) => k.startsWith("msdyn_col0")) && !afterKeep["msdyn_col10"] && !afterKeep["sss_col0"], "D2: Keep all shown ticks only the 10 shown rows: " + kept.join());
d2ops = await opLabels();
assert(d2ops.some((t) => t.startsWith("AddSolutionComponent Column msdyn_col05")) && !d2ops.some((t) => t.includes("msdyn_col15")), "D2: kept rows are re-added, hidden ones are not");
// a tick does not re-filter: under Only leaving, a row just ticked stays in view
await page.fill(`${SH} .shell-search`, "");
await page.check(`${SH} .shell-only`);
assert((await shCount()) === "29 of 42 subcomponents shown", "D2: Only leaving after the bulk changes: " + (await shCount()));
await page.check('input[aria-label="Keep msdyn_col15"]');
assert((await page.isVisible('input[aria-label="Keep msdyn_col15"]')) && (await shCount()) === "29 of 42 subcomponents shown", "D2: ticking a row under Only leaving keeps it shown until a filter changes");
await page.fill(`${SH} .shell-search`, "zzz");
assert((await page.isVisible(`${SH} .empty-state`)) && (await page.isHidden(`${SH} .leaving`)) && (await page.isDisabled(`${SH} button:text-is("Drop all shown")`)), "D2: no match → filtered empty state, bulk buttons disabled");
await page.click(`${SH} .empty-state button`);
assert((await shCount()) === "42 subcomponents shown" && (await page.inputValue(`${SH} .shell-search`)) === "" && !(await page.isChecked(`${SH} .shell-only`)) && (await page.isHidden(`${SH} .empty-state`)), "D2: Clear filters resets search, type and Only leaving");
assert((await leaveBadge()) === "28 leave", "D2: filters never changed a tick: " + (await leaveBadge()));
await page.screenshot({ path: resolve(OUT, "05-shell-filters.png"), fullPage: true });

// ---- B2: shell on a column + remove on its table conflict; identical ops are deduped ----
await fresh();
await M(() => { const m = window.__mock; m.extraReq[m.ids.E.acc] = [[m.ids.E.wo, 1]]; });
await diagnoseNow();
await selD(`1:${ids.E.acc}`, "remove");
await selD(`2:${ids.A.woid}`, "shell");
await previewNow();
const b2 = { err: await page.$eval("#preview-error", (e) => e.textContent).catch(() => ""), removes: (await opLabels()).filter((t) => t === "RemoveSolutionComponent Table account").length };
assert(/conflict/i.test(b2.err) && b2.err.includes("account") && b2.removes === 0 && (await page.isDisabled("#btn-confirm")), "B2: shell + remove on the same table refused in preview: " + JSON.stringify(b2));
await selD(`1:${ids.E.acc}`, "shell");
await previewNow();
const b2ops = await opLabels();
assert(b2ops.filter((t) => t.startsWith("RemoveSolutionComponent Table account")).length === 1 && b2ops.filter((t) => t.startsWith("AddSolutionComponent Table account")).length === 1, "B2: table shell selected twice → one remove + one add: " + b2ops.join(" | "));

// ---- B3: a selection no longer offered after re-diagnosis is dropped ----
await fresh();
await M(() => { window.__mock.members[0].rootcomponentbehavior = 1; });
await diagnoseNow();
await selD(`60:${ids.FORM_B}`, "remove");
assert((await page.textContent("#sel-count")) === "1 selected", "B3: remove picked while the table is not all assets");
await M(() => { window.__mock.members[0].rootcomponentbehavior = 0; });
await diagnoseNow();
const b3 = { value: await page.$eval(`.finding[data-key="60:${ids.FORM_B}"] select`, (e) => e.value), count: await page.textContent("#sel-count") };
assert(b3.value === "" && b3.count === "0 selected", "B3: stale 'remove' pruned after re-diagnosis: " + JSON.stringify(b3));
await selD(`26:${ids.VIEW}`, "edit-view");
await previewNow();
assert(!(await opLabels()).some((t) => t.includes("Quick Create")), "B3: preview does not apply the stale remove");

// ---- B4: connection change ----
const planToConfirm = async () => {
  await diagnoseNow();
  await selD(`26:${ids.VIEW}`, "edit-view");
  await previewNow();
  await page.click("#btn-backup");
  await page.waitForFunction(() => !document.querySelector("#btn-confirm").disabled);
};
const OTHER = { id: "c3", name: "SSS Other", url: "https://sss-other.crm4.dynamics.com", environment: "Dev", environmentColor: "#1d4ed8" };
// a: the host switches connection without an event → Confirm re-checks and refuses
await fresh();
await planToConfirm();
let w0 = await M(() => window.__mock.log.length);
await page.evaluate((c) => { window.__mock.envs.primary.conn = c; }, OTHER);
await page.click("#btn-confirm");
await page.waitForFunction(() => window.__mock.notes.some((n) => ["Refused", "Applied", "Some operations failed"].includes(n.title)));
const b4a = await M(() => ({ writes: window.__mock.log.length, note: window.__mock.notes.find((n) => n.title === "Refused")?.body ?? "" }));
assert(b4a.writes === w0 && /connection/i.test(b4a.note), "B4: Confirm refuses a plan made on another connection: " + JSON.stringify(b4a) + " " + w0);
// b: connection change event clears diagnosis, preview and backup flag
await fresh();
await planToConfirm();
w0 = await M(() => window.__mock.log.length);
await page.evaluate((c) => { window.__mock.envs.primary.conn = c; window.__mock.emit("connection:updated"); }, OTHER);
await page.waitForFunction(() => document.querySelector("#conn").textContent.includes("SSS Other"));
await page.waitForTimeout(100);
await page.evaluate(() => document.querySelector("#btn-confirm").click());
await page.waitForTimeout(300);
const b4b = { confirmDisabled: await page.isDisabled("#btn-confirm"), findings: await page.$$eval("#findings .finding", (e) => e.length), ops: await page.$$eval("#ops li", (e) => e.length), writes: await M(() => window.__mock.log.length) };
assert(b4b.confirmDisabled && b4b.findings === 0 && b4b.ops === 0 && b4b.writes === w0, "B4: connection change clears diagnosis / preview / backup; nothing written: " + JSON.stringify(b4b));
// c: restore refuses a backup taken in another environment
await fresh();
await page.click('.tab[data-tab="restore"]');
await page.evaluate((t) => { window.__mock.nextText = t; }, JSON.stringify({ ...bk, environment: { name: "SSS Prod", url: "https://sss-prod.crm4.dynamics.com" } }));
await page.click("#btn-load-backup");
await page.waitForFunction(() => document.querySelector("#restore-error") || !document.querySelector("#restore-actions").hidden);
assert(/environment/i.test((await page.textContent("#restore-error").catch(() => "")) ?? "") && (await page.isHidden("#restore-actions")), "B4: restore refuses a backup from another environment");
// d: restore apply re-checks the connection
await fresh();
await M(() => { const m = window.__mock; m.forms[m.ids.FORM_A].formxml = m.FORM_A_XML.replace("Work Order", "WO"); });
await page.click('.tab[data-tab="restore"]');
await page.evaluate((t) => { window.__mock.nextText = t; }, backup.content);
await page.click("#btn-load-backup");
await page.waitForSelector("#restore-ops li");
w0 = await M(() => window.__mock.log.length);
await page.evaluate((c) => { window.__mock.envs.primary.conn = c; }, OTHER);
await page.click("#btn-restore-apply");
await page.waitForFunction(() => document.querySelector("dialog[open]") || window.__mock.notes.some((n) => n.title === "Refused"));
if (await page.$("dialog[open]")) await page.click("#dlg-ok");
await page.waitForTimeout(300);
const b4d = await M(() => ({ writes: window.__mock.log.length, refused: window.__mock.notes.some((n) => n.title === "Refused" && /connection|environment/i.test(n.body)) }));
assert(b4d.writes === w0 && b4d.refused, "B4: restore apply refuses after the connection changed: " + JSON.stringify(b4d));

// ---- B5: column metadata unavailable → required columns never stripped from a form ----
await fresh();
await M(() => { window.__mock.attrFail = true; });
await diagnoseNow();
const optsOf = (key) => page.$$eval(`.finding[data-key="${key}"] select option`, (els) => els.map((e) => e.value));
const b5opts = await optsOf(`60:${ids.FORM_B}`);
let b5 = [];
if (b5opts.includes("edit-form")) {
  await selD(`60:${ids.FORM_B}`, "edit-form");
  await previewNow();
  b5 = await opLabels();
}
assert(!b5.some((t) => t.startsWith("Update form =Quick Create")), "B5: quick create form (required msdyn column) not edited when column metadata fails: " + b5.join(" | "));
assert(JSON.stringify(b5opts) === '["","report"]' && /Name lookup failed/.test(await page.textContent("#diag-summary")), "bug 4: column metadata failure → warning shown and the finding is report-only: " + b5opts.join(","));

// ---- bug 4: id-chunked reads run at most 4 at a time, retry once on 429, name failures are not silent ----
await fresh();
await M(() => {
  const m = window.__mock;
  const g = (n) => "00000000-0000-0000-0000-" + String(n).padStart(12, "0");
  // the view requires 400 unknown forms: 400+ ids → 11 chunks of ≤40 for owning solutions and again for names
  m.extraReq[m.ids.VIEW] = [[m.ids.E.wo, 1], [m.ids.E.acc, 1], ...Array.from({ length: 400 }, (_, i) => [g(700000 + i), 60])];
  m.throttleOnce = true;
  m.maxInflight = 0;
  m.byIdsCalls = 0;
});
await page.click('.tab[data-tab="diagnose"]');
await page.evaluate(() => document.querySelector("#diag-summary").replaceChildren());
await page.click("#btn-run");
await page.waitForFunction(() => document.querySelector("#diag-summary .summary") || window.__mock.notes.some((n) => n.title === "Diagnosis failed"));
const b6 = await M(() => ({ max: window.__mock.maxInflight, calls: window.__mock.byIdsCalls, throttled: window.__mock.throttled, failed: window.__mock.notes.filter((n) => n.title === "Diagnosis failed").map((n) => n.body) }));
assert(b6.calls >= 22 && b6.max <= 4 && b6.max >= 2, "bug 4: many ids → chunked reads with ≤4 in flight: " + JSON.stringify(b6));
assert(b6.throttled === 1 && b6.failed.length === 0 && (await page.$$eval("#findings .finding", (e) => e.length)) === 5, "bug 4: a 429 is retried once and the diagnosis completes: " + JSON.stringify(b6));
// a failed name lookup → warning + the affected findings are report-only (an edit would match nothing)
await fresh();
await M(() => { window.__mock.formsFail = true; });
await diagnoseNow();
const b6opts = await optsOf(`60:${ids.FORM_A}`);
assert(JSON.stringify(b6opts) === '["","report"]' && /Name lookup failed/.test(await page.textContent("#diag-summary")), "bug 4: form name lookup failure → warning shown and the form finding is report-only: " + b6opts.join(","));

// ---- bug 5: re-diagnosis after a fix uses the diagnosed solution, not the dropdown ----
await fresh();
await M(() => {
  const m = window.__mock;
  m.envs.primary.solutions.push({ solutionid: m.ids.SOL.other, uniquename: "SssOther", friendlyname: "SSS Other", version: "1.0", ismanaged: false, _publisherid_value: m.envs.primary.solutions[0]._publisherid_value });
  m.emit("connection:updated");
});
await page.waitForFunction(() => document.querySelectorAll("#solution option").length === 2);
await page.selectOption("#solution", ids.SOL.core);
await planToConfirm();
await page.click('.tab[data-tab="diagnose"]');
await page.selectOption("#solution", ids.SOL.other);
await page.click('.tab[data-tab="fix"]');
const q5 = await M(() => window.__mock.queries.length);
await page.click("#btn-confirm");
await okWrite("on solution SssCore");
await page.waitForSelector("#rediag", { timeout: 15000 });
const b7 = await page.evaluate((n) => window.__mock.queries.slice(n).filter((x) => x.q.includes("_solutionid_value eq")).map((x) => x.q.match(/_solutionid_value eq ([0-9a-f-]{36})/)[1]), q5);
const b7sum = await page.textContent("#diag-summary");
assert(b7.length > 0 && b7.every((x) => x === ids.SOL.core) && b7sum.includes("SSS Core"), "bug 5: re-diagnosis read the diagnosed solution (SssCore), not the dropdown: " + JSON.stringify(b7) + " " + b7sum);

// ---- bug 6: double-click on Confirm runs the operations once ----
await fresh();
await planToConfirm();
await M(() => { window.__mock.writeDelay = 50; });
const w6 = await M(() => ({ updates: window.__mock.updates.length, pubs: window.__mock.log.filter((x) => x === "PublishXml").length }));
await page.evaluate(() => {
  const b = document.querySelector("#btn-confirm");
  b.click();
  b.click();
});
await okWrite("on solution SssCore");
await page.waitForSelector("#rediag", { timeout: 15000 });
await page.waitForTimeout(300);
const b8 = await page.evaluate((w) => ({ updates: window.__mock.updates.length - w.updates, pubs: window.__mock.log.filter((x) => x === "PublishXml").length - w.pubs }), w6);
assert(b8.updates === 1 && b8.pubs === 1, "bug 6: double-click on Confirm → one view update and one PublishXml: " + JSON.stringify(b8));

// ---- D3: Diagnose find + type filter, applied to the results without re-running; "12 of 80"; Clear; persisted ----
await fresh();
await diagnoseNow();
const diagCards = () => page.$$eval("#findings .finding", (els) => els.map((e) => e.querySelector(".head .name").textContent));
const diagShown = () => page.textContent("#diag-shown");
assert(await page.isVisible("#diag-tools"), "D3: find + type tools shown with the results");
assert((await diagShown()) === "5 of 6 findings shown", "D3: summary counts the shown findings (the present-in-target one hidden): " + (await diagShown()));
const d3types = await page.$$eval("#diag-type option", (els) => els.map((e) => e.textContent));
assert(JSON.stringify(d3types) === JSON.stringify(["All types", "Column (3)", "View (1)", "Form (2)"]), "D3: type options built from the findings: " + d3types.join(", "));
const rrcD3 = await M(() => window.__mock.rrc);
const qD3 = await M(() => window.__mock.queries.length);
await page.selectOption("#diag-type", { label: "Form (2)" });
let d3 = await diagCards();
assert(d3.length === 2 && d3.includes("=Quick Create") && d3.includes("Account") && (await diagShown()) === "2 of 6 findings shown", "D3: type Form narrows to the 2 forms: " + d3.join(", ") + " / " + (await diagShown()));
await page.selectOption("#diag-type", "");
await page.fill("#diag-find", "quick");
d3 = await diagCards();
assert(d3.length === 1 && d3[0] === "=Quick Create" && (await diagShown()) === "1 of 6 findings shown", "D3: find matches the component name: " + d3.join(", "));
await page.fill("#diag-find", "msdyn_workorder");
d3 = await diagCards();
assert(d3.length === 3 && d3.includes("msdyn_workorderid") && d3.includes("Account") && d3.includes("Accounts with work orders"), "D3: find matches required components (msdyn_workorder): " + d3.join(", "));
await page.fill("#diag-find", "msdyn_appcommon");
assert((await diagCards()).length === 0 && (await page.textContent("#findings")).includes("Tick “Show present in target”"), "D3: a match only among present-in-target findings points to the toggle");
await page.check("#show-safe");
d3 = await diagCards();
assert(d3.length === 1 && d3[0] === "sss_custom" && (await diagShown()) === "1 of 6 findings shown", "D3: find matches the required solution (msdyn_AppCommon): " + d3.join(", "));
await page.uncheck("#show-safe");
await page.fill("#diag-find", "account");
assert((await diagCards()).length === 5, "D3: find matches the table (account)");
assert((await M(() => window.__mock.rrc)) === rrcD3 && (await M(() => window.__mock.queries.length)) === qD3, "D3: filtering never re-runs the diagnosis (no new calls)");
await page.fill("#diag-find", "zzz");
const d3empty = await page.$eval("#findings", (e) => ({ text: e.textContent, btn: e.querySelector(".empty-actions button")?.textContent }));
assert(d3empty.text.includes("No findings match") && d3empty.btn === "Clear filters" && (await diagShown()) === "0 of 6 findings shown", "D3: nothing matches → filtered empty state with Clear: " + JSON.stringify(d3empty));
await page.click("#findings .empty-actions button");
assert((await page.inputValue("#diag-find")) === "" && (await page.inputValue("#diag-type")) === "" && (await diagCards()).length === 5 && (await diagShown()) === "5 of 6 findings shown", "D3: Clear empties find and type and shows the findings again");
// persisted: the type and search come back after reopening the tool, once a diagnosis offers the type
await page.selectOption("#diag-type", { label: "Form (2)" });
await page.fill("#diag-find", "quick");
await fresh();
assert((await page.inputValue("#diag-find")) === "quick", "D3: search restored after reload");
await diagnoseNow();
assert((await page.inputValue("#diag-type")) === "60" && (await diagCards()).join() === "=Quick Create", "D3: type restored once the new diagnosis offers it, results filtered");
await page.fill("#diag-find", "");
await page.selectOption("#diag-type", "");
assert((await diagCards()).length === 5, "D3: back to every blocker");

// ---- D7: owning solutions revealed inline by the chip (button, aria-expanded), title kept; same for connection chips ----
await M(() => { const m = window.__mock; m.owners[m.ids.E.wo].push(m.ids.SOL.sales); });
await diagnoseNow();
const woChip = `.finding[data-key="2:${ids.A.woid}"] button.req:has-text("Table msdyn_workorder")`;
const chipState = () => page.$eval(woChip, (b) => { const line = document.getElementById(b.getAttribute("aria-controls")); return { expanded: b.getAttribute("aria-expanded"), title: b.title, hidden: line?.hidden, line: line?.textContent, inCard: !!line && b.closest(".finding").contains(line) }; });
let d7 = await chipState();
assert(d7.expanded === "false" && d7.hidden === true && d7.inCard && d7.title === "FieldService, msdynce_Sales", "D7: required-solution chip is a button, collapsed, title kept: " + JSON.stringify(d7));
await page.click(woChip);
d7 = await chipState();
assert(d7.expanded === "true" && d7.hidden === false && d7.line.includes("2 managed solutions") && d7.line.includes("FieldService, msdynce_Sales"), "D7: click reveals every owning solution inline: " + JSON.stringify(d7));
await page.fill("#diag-find", "workorder");
d7 = await chipState();
assert(d7.expanded === "true" && d7.hidden === false, "D7: the revealed line stays open when a filter re-renders the findings");
await page.fill("#diag-find", "");
await page.click(woChip);
d7 = await chipState();
assert(d7.expanded === "false" && d7.hidden === true, "D7: a second click hides the line");
const connState = () => page.$eval("#conn .connchip", (b) => { const line = document.getElementById(b.getAttribute("aria-controls")); return { tag: b.tagName, expanded: b.getAttribute("aria-expanded"), title: b.title, hidden: line?.hidden, line: line?.textContent }; });
let d7c = await connState();
assert(d7c.tag === "BUTTON" && d7c.expanded === "false" && d7c.hidden && d7c.title === "https://sss-dev.crm4.dynamics.com", "D7: connection chip is a button with the URL in its title: " + JSON.stringify(d7c));
await page.click("#conn .connchip >> nth=0");
d7c = await connState();
assert(d7c.expanded === "true" && !d7c.hidden && d7c.line === "https://sss-dev.crm4.dynamics.com", "D7: clicking the connection chip shows its URL inline: " + JSON.stringify(d7c));

// ---- D6: failed lookups: the first 3 inline, all of them behind "Show all N" ----
await fresh();
await M(() => { window.__mock.rrcFail = true; });
await diagnoseNow();
const d6 = await page.$eval("#diag-summary .error-list", (e) => ({ text: e.firstChild.textContent, summary: e.querySelector("details > summary")?.textContent, chev: e.querySelector("details > summary")?.classList.contains("chev"), open: e.querySelector("details")?.open, n: e.querySelectorAll("details li").length }));
assert(d6.text.startsWith("RetrieveRequiredComponents failed for 7 component(s): ") && d6.text.split("(mock: RetrieveRequiredComponents unavailable)").length - 1 === 3 && d6.text.endsWith("; …"), "D6: the first 3 failures inline: " + d6.text);
assert(d6.summary === "Show all 7" && d6.chev && !d6.open && d6.n === 7, "D6: “Show all 7” fold (chevron, closed) lists every failure: " + JSON.stringify(d6));
await page.click("#diag-summary .error-list details > summary");
assert(await page.isVisible("#diag-summary .error-list details li >> nth=6"), "D6: opening it shows the seventh failure");
await page.check("#show-safe");
assert(await page.$eval("#diag-summary .error-list details", (d) => d.open), "D6: “Show all” stays open across a re-render");
await page.uncheck("#show-safe");

// ---- D4 + D3 offline: "Show present in target" twin (off by default), find + type, count, Clear ----
await fresh();
await page.evaluate(() => {
  const m = window.__mock;
  m.envs.secondary.solutions.push({ ...m.envs.primary.solutions.find((s) => s.uniquename === "FieldService"), solutionid: "00000000-0000-0000-0000-000000000992" });
  m.emit("connection:updated");
});
await page.waitForTimeout(300);
const openOffline = async () => {
  await page.click('.tab[data-tab="offline"]');
  await page.evaluate(() => document.querySelector("#offline-head").replaceChildren());
  await page.evaluate((b) => { window.__mock.nextBinary = b; }, zipBytes);
  await page.click("#btn-open-zip");
  await page.waitForSelector("#offline-summary");
};
await openOffline();
const offNames = () => page.$$eval("#offline-list .finding", (els) => els.map((e) => e.querySelector(".head .name").textContent + (e.classList.contains("is-safe") ? ":safe" : "")));
const offShown = () => page.textContent("#offline-shown");
assert(!(await page.isChecked("#off-show-safe")) && (await page.isVisible("#off-tools")), "D4: Offline “Show present in target” off by default");
let d4 = await offNames();
assert(d4.join() === "sss_lookup" && (await offShown()) === "1 of 2 dependents shown" && (await page.textContent("#offline-summary")).includes("1 blocking"), "D4: the dependent whose solution the target has (FieldService) is hidden: " + d4.join() + " / " + (await offShown()));
await page.check("#off-show-safe");
d4 = await offNames();
assert(d4.length === 2 && d4.includes("Account:safe") && (await offShown()) === "2 dependents shown", "D4: ticking it shows the present-in-target dependent too: " + d4.join());
assert(!(await page.isChecked("#show-safe")), "D4: the Offline toggle is its own, Diagnose's stays as it was");
const offTypes = await page.$$eval("#off-type option", (els) => els.map((e) => e.textContent));
assert(JSON.stringify(offTypes) === JSON.stringify(["All types", "Column (1)", "Form (1)"]), "D3 offline: type options from the dependents: " + offTypes.join(", "));
await page.selectOption("#off-type", { label: "Form (1)" });
assert((await offNames()).join() === "Account:safe" && (await offShown()) === "1 of 2 dependents shown", "D3 offline: type filter");
await page.selectOption("#off-type", "");
await page.fill("#off-find", "anchor");
assert((await offNames()).join() === "sss_lookup", "D3 offline: find matches the required solution (msdynce_Anchor)");
await page.fill("#off-find", "zzz");
const offEmpty = await page.$eval("#offline-list", (e) => ({ text: e.textContent, btn: e.querySelector(".empty-actions button")?.textContent }));
assert(offEmpty.text.includes("No dependents match") && offEmpty.btn === "Clear filters" && (await offShown()) === "0 of 2 dependents shown", "D3 offline: nothing matches → filtered empty state: " + JSON.stringify(offEmpty));
await page.click("#offline-list .empty-actions button");
assert((await page.inputValue("#off-find")) === "" && (await offNames()).length === 2 && (await page.isChecked("#off-show-safe")), "D3 offline: Clear empties the search, keeps the toggle");
// persisted toggle; with every dependent present in the target the empty state offers the toggle
await page.reload();
await page.waitForFunction(() => document.querySelectorAll("#solution option[value]:not([value=''])").length > 0);
assert(await page.isChecked("#off-show-safe"), "D4: Offline toggle restored after reload");
await page.evaluate(() => {
  const m = window.__mock;
  for (const u of ["FieldService", "msdynce_Anchor"]) m.envs.secondary.solutions.push({ solutionid: "00000000-0000-0000-0000-00000000099" + (u === "FieldService" ? "4" : "5"), uniquename: u, friendlyname: u, version: "1.0", ismanaged: true, _publisherid_value: null });
  m.emit("connection:updated");
});
await page.waitForTimeout(300);
await openOffline();
assert((await offNames()).length === 2, "D4: toggle on → both present-in-target dependents listed");
await page.uncheck("#off-show-safe");
const allSafe = await page.$eval("#offline-list", (e) => ({ text: e.textContent, btn: e.querySelector(".empty-actions button")?.textContent }));
assert(allSafe.text.includes("No blocking dependencies") && allSafe.btn === "Show present in target" && (await page.textContent("#offline-summary")).includes("0 blocking"), "D4: every dependent present in target → empty state offers the toggle: " + JSON.stringify(allSafe));
await page.click("#offline-list .empty-actions button");
assert((await page.isChecked("#off-show-safe")) && (await offNames()).every((n) => n.endsWith(":safe")) && (await offNames()).length === 2, "D4: the button ticks the Offline toggle and lists them");
await page.uncheck("#off-show-safe");

// ---- debug mode: calls, results, failures and notifications; secrets redacted ----
await page.click('.tab[data-tab="diagnose"]');
await M(() => {
  const m = window.__mock;
  m.envs.primary.conn.clientSecret = "s3cret-value";
  m.envs.primary.conn.accessToken = "eyJ-token-value";
});
const dbg = await checkDebugLog(page, assert, {
  tool: "dependency-cleaner",
  act: async () => {
    await M(() => window.__mock.emit("connection:updated"));
    await page.waitForFunction(() => !document.querySelector("#btn-run").disabled);
    await M(() => { window.__mock.formsFail = true; });
    await page.click("#btn-run");
    await page.waitForFunction(() => !document.querySelector("#progress") || document.querySelector("#progress").hidden);
    await page.waitForTimeout(300);
    await M(() => { window.__mock.formsFail = false; });
  },
  readSaved: async (click) => {
    const n = await M(() => window.__mock.saved.length);
    await click();
    await page.waitForFunction((k) => window.__mock.saved.length > k, n);
    const f = await M(() => window.__mock.saved.at(-1));
    assert(/^dependency-cleaner-debug-\d{4}-\d\d-\d\dT[\d-]+\.txt$/.test(f.name), "dependency-cleaner: debug log file name " + f.name);
    return f.content;
  },
  expect: [
    [/\[event\] connection:updated/, "records connection events"],
    [/\[call\] #\d+ dataverseAPI\.queryData \["solutioncomponents\?\$select=[^"]*_solutionid_value eq 0{8}-/, "records the exact query text"],
    [/\[call\] #\d+ dataverseAPI\.queryData ok \d+ ms \{"value":\[\{"solutioncomponentid"/, "records the response body"],
    [/ERROR \[call\] #\d+ dataverseAPI\.queryData failed after \d+ ms \{"name":"Error","message":"mock: systemforms unavailable"/, "records failed calls with the error"],
    [/\[redacted\]/, "marks redacted secrets"],
  ],
});
assert(!dbg.includes("s3cret-value") && !dbg.includes("eyJ-token-value"), "dependency-cleaner: connection secrets never reach the log");
const lines = dbg.split("\n").length;
await M(() => window.__mock.emit("connection:updated"));
await page.waitForTimeout(300);
assert(await page.$eval("#debug-save", (e) => e.hidden) && lines > 20, "dependency-cleaner: nothing is recorded while debug mode is off");

await finish();

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
  const SOL = { core: g(1), fs: g(2), sys: g(3), managed: g(4), common: g(5), def: g(6) };
  const PUB = { sss: g(11), ms: g(12), sys: g(13) };
  const E = { acc: g(101), wo: g(102), common: g(103) };
  const A = { name: g(201), woid: g(202), st: g(203), sss: g(204) };
  const FORM_A = g(301), FORM_B = g(302), VIEW = g(401), FORM_FS = g(303), CHART = g(501);
  const FORM_A_XML = '<form><tabs><tab name="general"><labels><label description="General" languagecode="1033"/></labels><columns><column width="100%"><sections>'
    + '<section name="s1"><labels><label description="Summary" languagecode="1033"/></labels><rows>'
    + '<row><cell id="{c1}"><labels><label description="Name" languagecode="1033"/></labels><control id="name" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="name"/></cell></row>'
    + '<row><cell id="{c2}"><labels><label description="Work Order" languagecode="1033"/></labels><control id="msdyn_workorderid" classid="{270BD3DB-D9AF-4782-9025-509E298DEC0A}" datafieldname="msdyn_workorderid"/></cell></row>'
    + '</rows></section></sections></column></columns></tab></tabs></form>';
  const FORM_B_XML = '<form><tabs><tab name="qc"><columns><column width="100%"><sections><section name="q1"><rows>'
    + '<row><cell id="{q1}"><control id="msdyn_serviceterritory" classid="{270BD3DB-D9AF-4782-9025-509E298DEC0A}" datafieldname="msdyn_serviceterritory"/></cell></row>'
    + '</rows></section></sections></column></columns></tab></tabs></form>';
  const VIEW_FETCH = '<fetch version="1.0" mapping="logical"><entity name="account"><attribute name="name"/><attribute name="accountid"/><order attribute="name" descending="false"/>'
    + '<link-entity name="msdyn_workorder" from="msdyn_workorderid" to="msdyn_workorderid" alias="wo" link-type="outer"><attribute name="msdyn_name"/></link-entity></entity></fetch>';
  const VIEW_LAYOUT = '<grid name="resultset" object="1" jump="name" select="1" icon="1" preview="1"><row name="result" id="accountid"><cell name="name" width="300"/><cell name="wo.msdyn_name" width="150"/></row></grid>';

  // component catalog: every subcomponent of account and who owns it (managed layers)
  const catalog = {
    [A.woid]: { type: 2, table: 'account', owners: [SOL.fs] },
    [A.st]: { type: 2, table: 'account', owners: [SOL.fs] },
    [A.sss]: { type: 2, table: 'account', owners: [] },
    [FORM_A]: { type: 60, table: 'account', owners: [SOL.sys] },
    [FORM_B]: { type: 60, table: 'account', owners: [] },
    [VIEW]: { type: 26, table: 'account', owners: [] },
  };
  // extra subcomponents a test can add to account: a Field Service form and your own chart (both named by display name)
  const extra = {
    [FORM_FS]: { type: 60, table: 'account', owners: [SOL.fs] },
    [CHART]: { type: 59, table: 'account', owners: [] },
  };
  const owners = { [E.acc]: [SOL.sys], [E.wo]: [SOL.fs], [E.common]: [SOL.common] };
  let seq = 1000;
  const row = (objectid, componenttype, behavior, root) => ({ solutioncomponentid: g(seq++), objectid, componenttype, rootcomponentbehavior: behavior, _rootsolutioncomponentid_value: root });
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
    { LogicalName: 'name', MetadataId: A.name, RequiredLevel: { Value: 'ApplicationRequired' } },
    { LogicalName: 'msdyn_workorderid', MetadataId: A.woid, RequiredLevel: { Value: 'None' } },
    { LogicalName: 'msdyn_serviceterritory', MetadataId: A.st, RequiredLevel: { Value: 'ApplicationRequired' } },
    { LogicalName: 'sss_custom', MetadataId: A.sss, RequiredLevel: { Value: 'None' } },
  ], msdyn_workorder: [], msdyn_common: [] };
  const attrByName = Object.fromEntries(attrs.account.map((a) => [a.LogicalName, a.MetadataId]));
  const dep = (id, type, parent) => ({ '@odata.type': '#Microsoft.Dynamics.CRM.dependency', requiredcomponentobjectid: id, requiredcomponenttype: type, requiredcomponentparentid: parent ?? null, dependencytype: 1 });
  function required(id, type) {
    if (M.extraReq[id]) return M.extraReq[id].map(([i, t, p]) => dep(i, t, p));
    if (type === 60) {
      const xml = forms[id]?.formxml ?? '';
      const out = [dep(E.acc, 1)];
      for (const m of xml.matchAll(/datafieldname="([^"]+)"/g)) if (attrByName[m[1]] && m[1] !== 'name') out.push(dep(attrByName[m[1]], 2, E.acc));
      return out;
    }
    if (type === 26) return /link-entity name="msdyn_workorder"/.test(views[id]?.fetchxml ?? '') ? [dep(E.wo, 1), dep(E.acc, 1)] : [dep(E.acc, 1)];
    if (type === 2 && id === A.woid) return [dep(E.wo, 1), dep(E.acc, 1)];
    if (type === 2 && id === A.sss) return [dep(E.common, 1)];
    return [];
  }

  const M = window.__mock = { envs, members, forms, views, queries: [], executes: [], updates: [], log: [], saved: [], notes: [], rrc: 0, managedFlip: false, nextText: null, nextBinary: null, FORM_A_XML, VIEW_FETCH, VIEW_LAYOUT, ids: { FORM_A, FORM_B, VIEW, FORM_FS, CHART, A, E, SOL },
    listeners: [], extraReq: {}, attrFail: false };
  M.emit = (event) => { for (const cb of M.listeners) cb(null, { event }); };
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
      { LogicalName: 'account', MetadataId: E.acc, PrimaryNameAttribute: 'name' },
      { LogicalName: 'msdyn_workorder', MetadataId: E.wo, PrimaryNameAttribute: 'msdyn_name' },
      { LogicalName: 'msdyn_common', MetadataId: E.common, PrimaryNameAttribute: 'msdyn_name' },
    ] }),
    getEntityRelatedMetadata: async (table) => {
      if (M.attrFail) throw new Error('mock: attribute metadata unavailable');
      return { value: attrs[table] ?? [] };
    },
    queryData: async (q, target = 'primary') => {
      M.queries.push({ q, target });
      await new Promise((r) => setTimeout(r, 10));
      let m;
      if ((m = q.match(/^RetrieveRequiredComponents\\(ObjectId=([^,]+),ComponentType=(\\d+)\\)$/))) {
        if (!isGuid(m[1])) throw new Error('mock: ObjectId must be an unquoted guid, got ' + m[1]);
        M.rrc++;
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
    },
    execute: async (req) => {
      M.executes.push(JSON.parse(JSON.stringify(req)));
      const p = req.parameters ?? {};
      if (req.operationName === 'RetrieveRequiredComponents') throw new Error('mock: RetrieveRequiredComponents must go through queryData, not execute');
      if (req.operationName === 'RetrieveCurrentOrganization') return { Detail: { EnvironmentId: 'env-123' } };
      if (req.operationName === 'RemoveSolutionComponent' || req.operationName === 'AddSolutionComponent') {
        M.log.push(req.operationName);
        if (p.SolutionUniqueName !== 'SssCore') throw new Error('mock: wrong solution ' + p.SolutionUniqueName);
        if (!isGuid(p.ComponentId)) throw new Error('mock: bad ComponentId');
      }
      if (req.operationName === 'RemoveSolutionComponent') {
        const r = members.find((x) => x.objectid === p.ComponentId);
        if (!r) throw new Error('mock: not a member ' + p.ComponentId);
        for (let i = members.length - 1; i >= 0; i--) if (members[i] === r || members[i]._rootsolutioncomponentid_value === r.solutioncomponentid) members.splice(i, 1);
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
      M.updates.push({ entity, id, rec: { ...rec } });
      M.log.push('update:' + entity);
      if (entity === 'systemform') forms[id].formxml = rec.formxml;
      else if (entity === 'savedquery') Object.assign(views[id], rec);
      else throw new Error('mock: unexpected update ' + entity);
    },
  };
})();
`;

const { page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto("file://" + TOOL + "/dist/index.html");
const M = (fn) => page.evaluate(fn);

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
await page.waitForSelector("#rediag", { timeout: 15000 });
const log = await M(() => window.__mock.log);
const ex = await M(() => window.__mock.executes.filter((e) => /SolutionComponent|PublishXml/.test(e.operationName)));
assert(ex[0].operationName === "RemoveSolutionComponent" && ex[0].parameters.ComponentType === 1 && ex[0].parameters.ComponentId === ids.E.acc && !("DoNotIncludeSubcomponents" in ex[0].parameters), "RemoveSolutionComponent(account)");
assert(ex[1].operationName === "AddSolutionComponent" && ex[1].parameters.DoNotIncludeSubcomponents === true && ex[1].parameters.AddRequiredComponents === false && ex[1].parameters.SolutionUniqueName === "SssCore", "AddSolutionComponent(account, DoNotIncludeSubcomponents=true, AddRequiredComponents=false)");
const firstUpdate = log.findIndex((x) => x.startsWith("update:"));
assert(log.lastIndexOf("AddSolutionComponent") < firstUpdate && log.at(-1) === "PublishXml", "order: membership → form/view updates → PublishXml: " + log.join(","));
const pub = ex.find((e) => e.operationName === "PublishXml");
assert(pub.parameters.ParameterXml === "<importexportxml><entities><entity>account</entity></entities></importexportxml>", "PublishXml with touched tables");
const ups = await M(() => window.__mock.updates);
const fu = ups.find((u) => u.entity === "systemform");
const vu = ups.find((u) => u.entity === "savedquery");
assert(ups.length === 2 && fu.id === ids.FORM_A && !fu.rec.formxml.includes("msdyn_workorderid") && fu.rec.formxml.includes('datafieldname="name"'), "form updateRecord: msdyn control stripped, primary name kept");
assert(!vu.rec.fetchxml.includes("link-entity") && vu.rec.fetchxml.includes('attribute name="name"') && !vu.rec.layoutxml.includes("wo.msdyn_name") && vu.rec.layoutxml.includes('cell name="name"'), "view updateRecord: link-entity and its layout cell stripped");
const members = await M(() => window.__mock.members.map((m) => m.objectid + ":" + m.rootcomponentbehavior));
assert(members.includes(ids.E.acc + ":1") && !members.some((m) => m.startsWith(ids.A.woid)) && !members.some((m) => m.startsWith(ids.FORM_B)) && members.some((m) => m.startsWith(ids.A.sss)), "solution: account shell, msdyn columns gone, own column kept");
const rediag = await page.textContent("#rediag");
assert(rediag.includes("5 fixed") && rediag.includes("0 still present") && rediag.includes("0 blockers now"), "re-diagnosis clean: " + rediag);
assert((await page.$$eval("#findings .finding", (els) => els.length)) === 0, "no blocker findings after fix");
await page.screenshot({ path: resolve(OUT, "03-results.png"), fullPage: true });

// ---- restore ----
await page.click('.tab[data-tab="restore"]');
await page.evaluate((t) => { window.__mock.nextText = t; }, backup.content);
await page.click("#btn-load-backup");
await page.waitForSelector("#restore-ops li");
const rops = await page.$$eval("#restore-ops > li .mono", (els) => els.map((e) => e.textContent));
assert(rops[0] === "RemoveSolutionComponent Table account" && rops[1] === "AddSolutionComponent Table account" && rops.some((t) => t.startsWith("Update form Account")) && rops.some((t) => t.startsWith("Update view")) && rops.at(-1) === "PublishXml account", "restore plan: table back to all assets, XML back, publish: " + rops.join(" | "));
await page.click("#btn-restore-apply");
await page.waitForSelector("dialog[open]");
await page.click("#dlg-ok");
await page.waitForSelector("#restore-results table");
const after = await M(() => ({ form: window.__mock.forms[window.__mock.ids.FORM_A].formxml === window.__mock.FORM_A_XML, fetch: window.__mock.views[window.__mock.ids.VIEW].fetchxml === window.__mock.VIEW_FETCH, layout: window.__mock.views[window.__mock.ids.VIEW].layoutxml === window.__mock.VIEW_LAYOUT, members: window.__mock.members.map((m) => m.objectid + ":" + m.rootcomponentbehavior), pubs: window.__mock.log.filter((x) => x === "PublishXml").length }));
assert(after.form && after.fetch && after.layout, "restore writes original formxml / fetchxml / layoutxml back");
assert(after.members.includes(ids.E.acc + ":0") && after.members.length === 7, "restore puts account back with all assets (7 members)");
assert(after.pubs === 2, "restore publishes");
await page.click('.tab[data-tab="diagnose"]');
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
await page.evaluate((b) => { window.__mock.nextBinary = b; }, zipBytes);
await page.click("#btn-open-zip");
await page.waitForSelector("#offline-summary");
const off = await page.textContent("#offline-body");
assert(off.includes("4 missing dependencies") && off.includes("2 dependents in scope") && off.includes("2 blocking"), "offline: 4 missing, 2 dependents in scope (System filtered out)");
const offCards = await page.$$eval("#offline-body .finding", (els) => els.map((e) => e.querySelectorAll(".req").length));
assert(JSON.stringify(offCards.sort()) === "[1,2]", "offline: grouped by dependent (form has 2 required)");
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.screenshot({ path: resolve(OUT, "04-offline-dark.png"), fullPage: true });

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
assert(!keep.fsForm && !keep.msdynCol && keep.ownCol, "B1: form owned by filtered FieldService and msdyn column leave; own-prefix column kept: " + JSON.stringify(keep));
const b1ops = await opLabels();
assert(b1ops.some((t) => t.startsWith("AddSolutionComponent Chart Accounts by Industry")) && b1ops.some((t) => t.startsWith("AddSolutionComponent Form =Quick Create")) && !b1ops.some((t) => t.includes("Work Order Summary")), "B1: re-add ops for kept chart and quick create form, none for the Field Service form");

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
await selD(`60:${ids.FORM_B}`, "edit-form");
await previewNow();
const b5 = await opLabels();
assert(!b5.some((t) => t.startsWith("Update form =Quick Create")), "B5: quick create form (required msdyn column) not edited when column metadata fails: " + b5.join(" | "));

await finish();

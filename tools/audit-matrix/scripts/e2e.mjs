// E2E smoke test for the dist build with a mocked PPTB host (window.toolboxAPI / window.dataverseAPI).
// Two fake environments (Dev = primary, Test = secondary) whose audit configuration differs:
// a table audited in Dev but not in Test, a column audited only in Test, a locked table
// (CanBeChanged: false), a table whose write fails, and differing org-level switches.
// Covers: load -> counts + diff markers -> filter to differences -> expand columns ->
// exports -> snapshot as comparison column -> "match other environment" plan -> preview ->
// confirm -> apply -> recorded metadata writes -> scoped publish -> failed row.
//
// One mock serves three fixture variants, picked with ?v= on the URL, so behaviours that need a
// different environment can be asserted without a second mock:
//   (none)     organization auditing ON in the primary and OFF in the comparison; retention in
//              auditretentionperiodv2 on the primary and only in the legacy auditretentionperiod
//              on the comparison; OwnershipType as the Web API's string.
//   v=orgoff   organization auditing OFF in the PRIMARY: the banner, the inert columns and the
//              preview warning are all about the primary, so the comparison cannot stand in for it.
//   v=int      OwnershipType as the client metadata API's OwnershipTypes flags integer.
//   v=many     150 extra Microsoft tables in the primary (155 > ORIGIN_DEFAULT_THRESHOLD = 100), so a
//              first-time viewer starts on Origin: custom.
//   v=manyunknown  the same, with IsCustomEntity missing from every table: no default is applied.
//   v=nosec    no secondary connection: no comparison until a snapshot is loaded.
// Screenshots go to scripts/.e2e-out/; a few are also copied into docs/img-synthetic/ (gitignored).
// They show mocked data, so they are never published: the README shows real ToolBox captures only. Run: npm run build && node scripts/e2e.mjs (needs playwright + chromium).
// Usability: Only changeable (M6), expanded rows kept across Refresh / Apply (M7), "expand to load"
// button + focus kept across re-renders (M8), grouped plan / preview / results (M9), locked reason
// tooltips + no comparison / Diff columns without a comparison (M10).
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";
import { checkDebugLog } from "../../_shared/e2e-debug.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = resolve(TOOL, "scripts/.e2e-out");
const IMG = resolve(TOOL, "docs/img-synthetic");
mkdirSync(OUT, { recursive: true });
mkdirSync(IMG, { recursive: true });
const PAGE = "file://" + TOOL + "/dist/index.html";

// ---- mock host, serialized into the page before load ----
const MOCK = `
(() => {
  const VARIANT = new URLSearchParams(location.search).get('v') ?? '';
  const MANY = VARIANT === 'many' || VARIANT === 'manyunknown';
  const ORG_OFF = VARIANT === 'orgoff';
  const NO_SEC = VARIANT === 'nosec';
  // OwnershipTypes is a flags enum on the client metadata API: 1 user, 2 team, 4 business, 8 organization.
  const OWN_INT = { UserOwned: 1, TeamOwned: 2, BusinessOwned: 4, OrganizationOwned: 8, None: 0 };
  const own = (s) => (VARIANT === 'int' ? OWN_INT[s] : s);
  const lbl = (t) => ({ LocalizedLabels: [{ Label: t, LanguageCode: 1033 }], UserLocalizedLabel: { Label: t, LanguageCode: 1033 } });
  const mp = (value, canBeChanged = true) => ({ Value: value, CanBeChanged: canBeChanged, ManagedPropertyLogicalName: 'canmodifyauditsettings' });
  const tbl = (LogicalName, display, audit, opts = {}) => ({
    MetadataId: 'meta-' + LogicalName,
    LogicalName, SchemaName: LogicalName.replace(/^(.)/, (c) => c.toUpperCase()),
    DisplayName: lbl(display),
    IsAuditEnabled: mp(audit, opts.canBeChanged !== false),
    IsManaged: !!opts.managed, IsCustomizable: mp(true), OwnershipType: own(opts.ownership || 'UserOwned'),
    IsIntersect: !!opts.intersect, IsPrivate: !!opts.private, IsLogicalEntity: !!opts.logical,
    // custom tables are the sss_ ones; every other table here is one Microsoft ships
    ...(VARIANT === 'manyunknown' ? {} : { IsCustomEntity: LogicalName.startsWith('sss_') }),
  });
  // enough out-of-the-box tables to cross the origin default threshold (100)
  const oob = MANY ? Array.from({ length: 150 }, (_, i) => tbl('msdyn_oob' + String(i).padStart(3, '0'), 'OOB ' + String(i).padStart(3, '0'), false, { managed: true })) : [];
  const attr = (LogicalName, display, audit, opts = {}) => ({
    MetadataId: 'attr-' + LogicalName,
    '@odata.type': '#Microsoft.Dynamics.CRM.' + (opts.odata || 'String') + 'AttributeMetadata',
    LogicalName, DisplayName: lbl(display),
    IsAuditEnabled: mp(audit, opts.canBeChanged !== false),
    IsValidForRead: opts.validForRead !== false, IsSecured: !!opts.secured,
    AttributeType: opts.type || 'String', IsManaged: !!opts.managed,
  });

  const envs = {
    primary: {
      conn: { id: 'c1', name: 'SSS Dev', url: 'https://sss-dev.crm4.dynamics.com', environment: 'Dev', environmentColor: '#0f766e' },
      // v2 carries the retention and wins over the legacy column when both are set.
      org: { organizationid: 'org-dev', name: 'SSS Dev', isauditenabled: !ORG_OFF, isuseraccessauditenabled: true, auditretentionperiodv2: 90, auditretentionperiod: 365 },
      tables: [
        tbl('account', 'Account', true, { managed: true }),
        tbl('contact', 'Contact', true, { managed: true, ownership: 'OrganizationOwned' }),
        tbl('sss_case', 'SSS Case', false, { ownership: 'BusinessOwned' }),
        tbl('sss_locked', 'SSS Locked', false, { managed: true, canBeChanged: false }),
        tbl('sss_fails', 'SSS Fails', false, { ownership: 'TeamOwned' }),
        tbl('accountleads', 'Account Leads', false, { intersect: true }),
        tbl('sss_private', 'SSS Private', false, { private: true }),
        ...oob,
      ],
      attrs: {
        account: [
          attr('name', 'Account Name', true),
          attr('telephone1', 'Main Phone', false),
          attr('creditlimit', 'Credit Limit', false, { secured: true, type: 'Money', odata: 'Money' }),
          attr('lockedcol', 'Locked Column', false, { canBeChanged: false, managed: true }),
          attr('calculatedcol', 'Calculated', false, { type: 'Virtual' }),
          attr('hiddencol', 'Hidden', false, { validForRead: false }),
        ],
        // sss_case's own flag is off, so this audited column captures nothing: inert, not a win.
        sss_case: [attr('sss_name', 'Name', false), attr('sss_note', 'Note', true)],
      },
    },
    secondary: {
      conn: { id: 'c2', name: 'SSS Test', url: 'https://sss-test.crm4.dynamics.com', environment: 'Test', environmentColor: '#92400e' },
      // the retention lives only in the legacy column here, as it still does on plenty of environments
      org: { organizationid: 'org-test', name: 'SSS Test', isauditenabled: false, isuseraccessauditenabled: false, auditretentionperiodv2: null, auditretentionperiod: 30 },
      tables: [
        tbl('account', 'Account', false, { managed: true }),
        tbl('contact', 'Contact', true, { managed: true }),
        tbl('sss_case', 'SSS Case', false),
        tbl('sss_locked', 'SSS Locked', true, { managed: true, canBeChanged: false }),
        tbl('sss_fails', 'SSS Fails', true),
      ],
      attrs: {
        account: [
          attr('name', 'Account Name', true),
          attr('telephone1', 'Main Phone', true),
          attr('creditlimit', 'Credit Limit', false, { secured: true, type: 'Money', odata: 'Money' }),
          attr('lockedcol', 'Locked Column', true, { canBeChanged: false, managed: true }),
        ],
        sss_case: [attr('sss_name', 'Name', false), attr('sss_note', 'Note', true)],
      },
    },
  };

  // attrCalls: every Attributes read; delay: ms each one takes; maxInFlight: peak parallel reads per target
  window.__mock = { envs, writes: [], published: [], saved: [], notes: [], nextOpen: null, orgQueries: [], attrCalls: [], delay: 0, inFlight: {}, maxInFlight: {} };

  window.toolboxAPI = {
    connections: {
      getActiveConnection: async () => envs.primary.conn,
      getSecondaryConnection: async () => (NO_SEC ? null : envs.secondary.conn),
    },
    utils: { getCurrentTheme: async () => 'light', showNotification: async (o) => { window.__mock.notes.push(o); } },
    events: { on() {} },
    fileSystem: {
      // cancelSave: the viewer cancels the save dialog (saveFile resolves to no path)
      saveFile: async (name, content) => { if (window.__mock.cancelSave) return null; window.__mock.saved.push({ name, content }); return '/tmp/' + name; },
      selectPath: async () => (window.__mock.nextOpen ? '/tmp/snapshot.json' : null),
      readText: async () => window.__mock.nextOpen,
    },
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const findTable = (e, n) => e.tables.find((t) => t.LogicalName === n);
  const findAttr = (e, t, a) => (e.attrs[t] || []).find((x) => x.LogicalName === a);

  window.dataverseAPI = {
    queryData: async (q, target = 'primary') => {
      window.__mock.orgQueries.push(q);
      if (q.startsWith('organizations')) {
        // this environment does not expose isreadauditenabled: force the fallback $select
        if (q.includes('isreadauditenabled')) throw new Error("Could not find a property named 'isreadauditenabled'");
        return { value: [clone(envs[target].org)] };
      }
      throw new Error('unexpected query ' + q);
    },
    getAllEntitiesMetadata: async (_props, target = 'primary') => ({ value: clone(envs[target].tables) }),
    getEntityMetadata: async (name, _byLogical, _props, target = 'primary') => {
      const t = findTable(envs[target], name);
      if (!t) throw new Error('no such table ' + name);
      return Object.assign(clone(t), { '@odata.context': 'https://x/$metadata#EntityDefinitions/$entity', '@odata.etag': 'W/"1"' });
    },
    getEntityRelatedMetadata: async (name, path, _props, target = 'primary') => {
      const m = /^Attributes\\(LogicalName='(.+)'\\)$/.exec(path);
      if (m) {
        const a = findAttr(envs[target], name, m[1]);
        if (!a) throw new Error('no such attribute ' + m[1]);
        return Object.assign(clone(a), { '@odata.context': 'https://x/$metadata#Attributes/$entity', '@odata.etag': 'W/"1"' });
      }
      if (path !== 'Attributes') throw new Error('unexpected related path ' + path);
      const m2 = window.__mock;
      m2.attrCalls.push({ name, target });
      m2.inFlight[target] = (m2.inFlight[target] || 0) + 1;
      m2.maxInFlight[target] = Math.max(m2.maxInFlight[target] || 0, m2.inFlight[target]);
      try {
        if (m2.delay) await new Promise((r) => setTimeout(r, m2.delay));
        return { value: clone(envs[target].attrs[name] || []) };
      } finally {
        m2.inFlight[target]--;
      }
    },
    updateEntityDefinition: async (name, def, options, target = 'primary') => {
      window.__mock.writes.push({ kind: 'table', name, def, options, target });
      if (name === 'sss_fails') throw new Error('simulated failure: insufficient privileges');
      if (def['@odata.context'] || def['@odata.etag']) throw new Error('response annotations were sent back');
      const t = findTable(envs[target], name);
      t.IsAuditEnabled = def.IsAuditEnabled;
    },
    updateAttribute: async (name, attribute, def, options, target = 'primary') => {
      window.__mock.writes.push({ kind: 'column', name, attribute, def, options, target });
      if (String(def['@odata.type'] || '').startsWith('#')) throw new Error('@odata.type was not normalised');
      const a = findAttr(envs[target], name, attribute);
      a.IsAuditEnabled = def.IsAuditEnabled;
    },
    publishCustomizations: async (table, target = 'primary') => { window.__mock.published.push({ table, target }); },
  };
})();
`;

// ---------------------------------------------------------------- standalone
{
  const bare = await launchPage(import.meta.url);
  await bare.page.goto(PAGE);
  await bare.page.waitForSelector("#matrix-body .empty-state");
  bare.assert((await bare.page.textContent("#host-mode")).includes("Not running inside ToolBox"), "standalone: host mode stated");
  bare.assert((await bare.page.textContent("#matrix-body")).includes("Nothing loaded"), "standalone: empty state rendered");
  bare.assert((await bare.page.textContent("#org-body")).includes("No environment loaded"), "standalone: org tab empty state");
  bare.assert(!(await bare.page.$("table.matrix th")), "standalone: no comparison / Diff column headers rendered");
  await bare.finish();
}

// ---------------------------------------------------------------- with host
const { browser, page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto(PAGE);

const tableNames = () => page.$$eval("table.matrix > tbody > tr:not(.colrow) td.name .mono", (els) => els.map((e) => e.textContent));
/** The ownership badge of every visible table row, in row order. */
const ownershipLabels = (p) => p.$$eval("table.matrix > tbody > tr:not(.colrow) td:nth-child(3) .badge:last-child", (els) => els.map((e) => e.textContent));
/** The rows of one org card's settings table, as [label, value] pairs. */
const orgCardRows = (n) =>
  page.$$eval(`#org-body .orggrid > .card:nth-child(${n}) table tbody tr`, (rs) => rs.map((r) => [...r.children].map((c) => c.textContent.trim())));
/** The matrix header cells' text, in order. */
const matrixHeads = (p) => p.$$eval("table.matrix > thead th", (ths) => ths.map((t) => t.textContent.trim()));
const shot = async (file, readme) => {
  await page.screenshot({ path: resolve(OUT, file) });
  if (readme) copyFileSync(resolve(OUT, file), resolve(IMG, readme));
};

await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 2);
assert(true, "primary + secondary chips");
assert((await page.textContent("#host-mode")).includes("inside"), "host mode detected");
assert((await page.inputValue("#compare")) === "secondary", "secondary preselected as comparison");

// ---- matrix, counts, diff markers
let names = await tableNames();
assert(JSON.stringify(names) === JSON.stringify(["account", "contact", "sss_case", "sss_fails", "sss_locked"]), "intersect/private tables filtered out: " + names.join(","));
const ownStrings = await ownershipLabels(page);
assert(JSON.stringify(ownStrings) === JSON.stringify(["user", "org", "bu", "team", "user"]), "OwnershipType as the Web API string maps to an ownership label per table: " + ownStrings.join(","));
assert(await page.$eval("#org-banner", (e) => e.hidden), "no organization banner while the primary's organization auditing is on (the comparison's is off)");
const counts = await page.textContent("#counts");
assert(counts.includes("2 / 5") && counts.includes("tables audited"), "counts: 2 of 5 tables audited — " + counts);
assert(/3\s*table differences/.test(counts.replace(/\s+/g, " ")), "counts: 3 table differences — " + counts);
assert((await page.$$eval("table.matrix .diffmark", (e) => e.length)) === 3, "three diff markers");
assert(await page.isDisabled('input[aria-label="Select table sss_locked"]'), "locked table cannot be selected");
// M10: the reason a row is locked is on the badge and the checkbox, from the flag's managed property
const LOCK_REASON = "Can't change: CanBeChanged is false (managed property canmodifyauditsettings)";
const lockedTitles = await page.$$eval("table.matrix > tbody > tr:not(.colrow)", (rs) => {
  const tr = rs.find((r) => r.textContent.includes("sss_locked"));
  return [tr.querySelector("td.sel input").title, tr.querySelector(".flag .badge-warn").title];
});
assert(lockedTitles.every((t) => t === LOCK_REASON), "locked table: checkbox and badge say why — " + lockedTitles.join(" | "));
assert((await page.$eval('input[aria-label="Select table account"]', (e) => e.title)) === "", "an unlocked table's checkbox carries no lock tooltip");
assert(JSON.stringify(await matrixHeads(page)) === JSON.stringify(["", "Table", "Origin · layer", "primarySSS Dev", "secondarySSS Test", "Diff", "Columns"]), "comparison + Diff columns with a comparison: " + (await matrixHeads(page)).join(","));
await shot("01-matrix.png", "matrix.png");

// ---- filter to differences
await page.check("#filter-diff");
names = await tableNames();
assert(JSON.stringify(names) === JSON.stringify(["account", "sss_fails", "sss_locked"]), "only differences → 3 rows: " + names.join(","));
await page.selectOption("#filter-managed", "unmanaged");
names = await tableNames();
assert(JSON.stringify(names) === JSON.stringify(["sss_fails"]), "unmanaged layer filter: " + names.join(","));
await page.selectOption("#filter-managed", "all");

// ---- expand a row to its columns (the "only differences" filter is still on)
await page.click('button[aria-label="Expand account"]');
await page.waitForSelector("table.matrix tr.colrow");
let colNames = await page.$$eval("tr.colrow tbody td.name .mono", (els) => els.map((e) => e.textContent));
assert(JSON.stringify(colNames) === JSON.stringify(["lockedcol", "telephone1"]), "only differing columns while the diff filter is on: " + colNames.join(","));
assert((await page.$$eval("tr.colrow .diffmark", (e) => e.length)) === 2, "telephone1 + lockedcol differ");
assert(await page.isDisabled('input[aria-label="Select column account.lockedcol"]'), "locked column cannot be selected");
const lockedColTitles = await page.$$eval("tr.colrow tbody tr", (rs) => {
  const tr = rs.find((r) => r.textContent.includes("lockedcol"));
  return [tr.querySelector("td.sel input").title, tr.querySelector(".flag .badge-warn").title];
});
assert(lockedColTitles.every((t) => t === LOCK_REASON), "locked column: checkbox and badge say why — " + lockedColTitles.join(" | "));
assert((await page.$$eval("tr.colrow thead th", (e) => e.length)) === 6 && (await page.$eval("tr.colrow > td", (e) => e.colSpan)) === 7, "column sub-table carries the comparison + Diff columns");
await shot("02-differences.png", "differences.png");

await page.uncheck("#filter-diff");
await page.waitForFunction(() => document.querySelectorAll("tr.colrow tbody tr").length === 4);
colNames = await page.$$eval("tr.colrow tbody td.name .mono", (els) => els.map((e) => e.textContent));
assert(JSON.stringify(colNames) === JSON.stringify(["name", "creditlimit", "lockedcol", "telephone1"]), "virtual / non-readable attributes skipped: " + colNames.join(","));
assert((await page.textContent("tr.colrow")).includes("secured"), "secured column badge");
const countsAfter = (await page.textContent("#counts")).replace(/\s+/g, " ");
assert(countsAfter.includes("1columns audited in 1 loaded table") || countsAfter.includes("1 columns audited in 1 loaded table"), "column counts scoped to loaded tables — " + countsAfter);
assert(!countsAfter.includes("capturing nothing"), "no “capturing nothing” metric while every audited column sits under an on table in an on organization — " + countsAfter);
assert((await page.$$eval("tr.colrow td.col-inert", (e) => e.length)) === 0, "an audited column under an on table in an on organization is not marked inert");
await shot("02-columns.png", "columns.png");

// ---- exports (matrix CSV + snapshot of the primary environment)
await page.click("#btn-export-csv");
await page.click("#btn-export-snap");
let saved = await page.evaluate(() => window.__mock.saved);
assert(saved.length === 2, "two exports saved");
const csv = saved[0].content;
const csvLines = csv.split("\n");
assert(csvLines[0] === "# organization auditing is on for SSS Dev", "matrix CSV states the organization switch: " + csvLines[0]);
assert(saved[0].name === "audit-matrix.csv" && csvLines[1].startsWith("level,table,column,type,SSS Dev audit,captures,SSS Test audit,differs,locked"), "matrix CSV header: " + csvLines[1]);
assert(/^table,account,,user,on,yes,off,true,false/m.test(csv), "CSV table row for account, capturing");
assert(/^column,account,telephone1,String,off,no,on,true,false/m.test(csv), "CSV column row for telephone1, off so captures nothing");
assert(/^table,sss_locked,,user,off,no,on,true,true/m.test(csv), "CSV marks sss_locked locked");
assert(/^table,sss_case,,bu,off,no,/m.test(csv), "CSV says a table with its flag off captures nothing");
const snapJson = saved[1].content;
const snap = JSON.parse(snapJson);
assert(snap.kind === "sss-audit-matrix-snapshot" && snap.version === 1, "snapshot kind + version");
assert(snap.tables.length === 5 && snap.tables.find((t) => t.logicalName === "account").columns.length === 4, "snapshot carries the loaded columns");
assert(snap.org.isAuditEnabled === true && snap.org.retentionDays === 90, "snapshot carries org settings");
assert(snap.tables.find((t) => t.logicalName === "account").isCustom === false && snap.tables.find((t) => t.logicalName === "sss_case").isCustom === true, "snapshot carries each table's origin");

// ---- snapshot as the comparison column
await page.evaluate((c) => { window.__mock.nextOpen = c; }, snapJson);
await page.click("#btn-load-snap");
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 3);
assert((await page.inputValue("#compare")).startsWith("snap:"), "snapshot selected as comparison");
await page.waitForFunction(() => document.querySelectorAll("table.matrix .diffmark").length === 0);
assert(true, "snapshot of the primary environment shows no differences");
await page.selectOption("#compare", "secondary");
await page.waitForFunction(() => document.querySelectorAll("table.matrix .diffmark").length > 0);
assert(true, "back to the live secondary comparison");

// ---- auditing is an AND: an audited column under an un-audited table captures nothing
await page.click('button[aria-label="Expand sss_case"]');
await page.waitForSelector("td.col-inert");
assert((await page.$$eval("td.col-inert", (e) => e.length)) === 1, "only sss_note, whose table flag is off, is marked inert — account's audited column is not");
const inertCell = await page.$("td.col-inert");
assert((await inertCell.textContent()).includes("inert"), "the inert column cell carries an “inert” badge next to its on flag");
assert(
  (await inertCell.getAttribute("title")).includes("this table's audit flag is off"),
  "the inert tooltip names the level that is off — " + (await inertCell.getAttribute("title")),
);
const caseStats = await page.$$eval("table.matrix > tbody > tr:not(.colrow)", (rs) => {
  const tr = rs.find((r) => r.textContent.includes("sss_case"));
  return tr ? tr.lastElementChild.textContent : "";
});
assert(caseStats.includes("1 / 2 audited (1 capturing nothing)"), "the table row's column stats say how many audited columns capture nothing — " + caseStats);
const countsInert = (await page.textContent("#counts")).replace(/\s+/g, " ");
assert(/1\s*audited columns capturing nothing/.test(countsInert), "the counts bar gains the “capturing nothing” metric once there are any — " + countsInert);
await shot("05-inert.png");

// ---- org settings tab
await page.click('.tab[data-tab="org"]');
const org = await page.textContent("#org-body");
assert(org.includes("SSS Dev") && org.includes("SSS Test") && org.includes("90") && org.includes("30"), "org cards for both environments with their retention");
assert(org.includes("unknown") && org.includes("isreadauditenabled"), "missing org field degrades to unknown");
const devRows = await orgCardRows(1);
const testRows = await orgCardRows(2);
const retRow = (rows) => rows.find((r) => r[0].startsWith("Retention")) ?? ["", ""];
assert(JSON.stringify(retRow(devRows)) === JSON.stringify(["Retention, days (auditretentionperiodv2)", "90"]), "retention read from v2 and the column named — " + retRow(devRows).join(" = "));
assert(
  JSON.stringify(retRow(testRows)) === JSON.stringify(["Retention, days (auditretentionperiod, legacy)", "30"]),
  "an environment with v2 null reports the legacy column's value and says it is the legacy one — " + retRow(testRows).join(" = "),
);
assert((devRows.find((r) => r[0].includes("isreadauditenabled")) ?? [])[1] === "unknown" && retRow(devRows)[1] === "90", "the $select that loses isreadauditenabled still returns a retention, not “unknown”");
const orgSelects = [...new Set(await page.evaluate(() => window.__mock.orgQueries.filter((q) => q.startsWith("organizations"))))];
assert(orgSelects.length === 3, "the $select chain narrowed twice before one was accepted, got " + orgSelects.length + ": " + orgSelects.join(" | "));
assert(
  orgSelects[1].includes("isreadauditenabled") && !orgSelects[1].includes("auditretentionperiodv2,auditretentionperiod"),
  "the chain narrows one field at a time: the legacy retention is dropped before read auditing — " + orgSelects[1],
);
assert(
  !orgSelects[2].includes("isreadauditenabled") && orgSelects[2].includes("auditretentionperiodv2,auditretentionperiod"),
  "dropping read auditing does not cost either retention column — " + orgSelects[2],
);
assert(org.includes("Read-only in v1"), "org tab states it is read-only");
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await shot("03-org-dark.png", "org-dark.png");
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

// ---- build the "match other environment" plan
await page.click('.tab[data-tab="matrix"]');
await page.click("#btn-plan-match");
await page.waitForFunction(() => document.querySelector("#plan-count").textContent === "3");
assert(true, "plan has 3 items");
await page.click('.tab[data-tab="apply"]');
const planText = await page.textContent("#apply-body");
assert(planText.includes("account") && planText.includes("telephone1") && planText.includes("sss_fails"), "plan lists the differing table and column");
assert(!planText.includes("sss_locked"), "locked table is never planned");
assert((await page.textContent("#apply-target")).includes("SSS Dev"), "plan target is the primary connection");

// ---- preview -> confirm -> apply
await page.click("#btn-apply");
await page.waitForSelector("dialog[open]");
assert((await page.textContent("#dlg-title")) === "Preview changes", "preview dialog");
assert((await page.textContent("#dlg-body")).includes("3 metadata writes"), "preview counts the writes");
const previewTarget = await page.textContent("#preview-target");
assert(previewTarget.includes("SSS Dev (Dev)") && previewTarget.includes("https://sss-dev.crm4.dynamics.com"), "preview names the target environment and its URL — " + previewTarget);
const previewScope = await page.textContent("#preview-scope");
assert(previewScope.includes("2 table flags and 1 column flag, across 2 tables"), "preview states the scope in tables and columns — " + previewScope);
assert(await page.isChecked("#backup-first"), "“Save backup snapshot first” is on by default");
assert((await page.textContent("#preview-backup")).includes("2 tables (1 column) from SSS Dev"), "the backup step says what it saves — " + (await page.textContent("#preview-backup")));
const undo = await page.textContent("#preview-undo");
assert(undo.includes("Load snapshot…") && undo.includes("Plan: match other env") && undo.includes("cannot be recovered"), "the preview says how to undo, and that lost audit history cannot be recovered — " + undo);
assert(!(await page.textContent("#dlg-body")).includes("nothing will be captured"), "no organization warning in the preview while the primary's organization auditing is on");
await shot("04-preview.png", "preview.png");
await page.click("#dlg-ok");

// ---- the backup is saved before anything is written, in the snapshot format, scoped to the plan
await page.waitForFunction(() => window.__mock.saved.length === 3);
const backupFile = (await page.evaluate(() => window.__mock.saved))[2];
assert(/^audit-backup\.SSS_Dev\..+\.json$/.test(backupFile.name), "backup file name names the environment — " + backupFile.name);
const backupDoc = JSON.parse(backupFile.content);
assert(backupDoc.kind === "sss-audit-matrix-snapshot" && backupDoc.scope === "backup" && backupDoc.environment.url === "https://sss-dev.crm4.dynamics.com", "backup is a snapshot of the target, marked as a backup");
assert(
  JSON.stringify(backupDoc.tables.map((t) => [t.logicalName, t.audit.value, (t.columns ?? []).map((c) => [c.logicalName, c.audit.value])])) ===
    JSON.stringify([["account", true, [["telephone1", false]]], ["sss_fails", false, []]]),
  "backup records the current flags of exactly the planned tables and columns",
);

await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results");
const results = await page.textContent("#dlg-body");
assert(results.includes("simulated failure"), "failing write surfaces as a failed row");
await page.click("#dlg-cancel");

// ---- scoped publish behind its own confirm
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Publish customizations");
assert((await page.textContent("#dlg-body")).includes("account"), "publish dialog names the touched tables");
const publishTarget = await page.textContent("#publish-target");
assert(publishTarget.includes("SSS Dev (Dev)") && publishTarget.includes("https://sss-dev.crm4.dynamics.com"), "publish confirm names the target environment and its URL — " + publishTarget);
assert((await page.textContent("#publish-scope")).includes("Publish 1 table in SSS Dev"), "publish confirm counts the tables — " + (await page.textContent("#publish-scope")));
assert((await page.textContent("#publish-undo")).includes("cannot be undone") && (await page.textContent("#publish-undo")).includes("publish again"), "publish confirm says publishing cannot be undone, only re-published after reverting");
await page.click("#dlg-ok");
await page.waitForFunction(() => window.__mock.published.length > 0);
const published = await page.evaluate(() => window.__mock.published);
assert(published.length === 1 && published[0].table === "account" && published[0].target === "primary", "publish scoped to the successfully written table");

// ---- assert the recorded metadata writes
const writes = await page.evaluate(() => window.__mock.writes);
assert(writes.length === 3, "three metadata writes attempted, got " + writes.length);
const tableWrite = writes.find((w) => w.kind === "table" && w.name === "account");
assert(!!tableWrite && tableWrite.target === "primary", "account written on the primary connection");
assert(JSON.stringify(tableWrite.def.IsAuditEnabled) === JSON.stringify({ Value: false, CanBeChanged: true, ManagedPropertyLogicalName: "canmodifyauditsettings" }), "table IsAuditEnabled managed property shape");
assert(tableWrite.def.SchemaName === "Account" && tableWrite.def.OwnershipType === "UserOwned", "table write sends the full definition, not a projection");
assert(tableWrite.options && tableWrite.options.mergeLabels === true, "MSCRM.MergeLabels kept on the table write");
const colWrite = writes.find((w) => w.kind === "column");
assert(colWrite.name === "account" && colWrite.attribute === "telephone1", "column write targets account.telephone1");
assert(JSON.stringify(colWrite.def.IsAuditEnabled) === JSON.stringify({ Value: true, CanBeChanged: true, ManagedPropertyLogicalName: "canmodifyauditsettings" }), "column IsAuditEnabled managed property shape");
assert(colWrite.def["@odata.type"] === "Microsoft.Dynamics.CRM.StringAttributeMetadata", "column write keeps a normalised @odata.type");
assert(colWrite.options && colWrite.options.mergeLabels === true, "MSCRM.MergeLabels kept on the column write");
assert(writes.every((w) => !w.def["@odata.context"] && !w.def["@odata.etag"]), "response annotations stripped before writing");

// ---- the failed item stays in the plan, successes leave it
await page.waitForFunction(() => document.querySelector("#plan-count").textContent === "1");
assert((await page.textContent("#apply-body")).includes("sss_fails"), "only the failed write is left in the plan");

// ---- plan exports
await page.click("#btn-export-plan-csv");
await page.click("#btn-export-plan-ps");
saved = await page.evaluate(() => window.__mock.saved);
assert(saved.length === 5, "plan CSV + plan script saved");
assert(saved[3].name === "audit-plan.csv" && saved[3].content.includes("table,sss_fails,,off,on"), "plan CSV rows");
assert(saved[4].name === "audit-plan.ps1" && saved[4].content.includes("EntityDefinitions(LogicalName=") && saved[4].content.includes("Table = 'sss_fails'"), "plan script is a runnable list");
assert(saved[4].content.startsWith("# Audit Config Matrix - exported plan"), "plan script header carries the tool name without a publisher prefix");

// Applying the plan reloaded the matrix; the rows expanded before it come back expanded, their columns
// read again (M7). The CSV only carries the columns of expanded tables: an audited column under a
// table whose own flag is off must not read as a win in the file an auditor is handed.
await page.click('.tab[data-tab="matrix"]');
await page.waitForFunction(() => !!document.querySelector("td.col-inert") && document.querySelector("#status").hidden);
assert(
  !!(await page.$('button[aria-label="Collapse sss_case"]')) && !!(await page.$('button[aria-label="Collapse account"]')),
  "rows expanded before Apply are still expanded after the reload that follows it",
);
assert((await page.$$("table.matrix tr.colrow")).length === 2, "their columns were read again after Apply");
await page.click("#btn-export-csv");
const csv2 = (await page.evaluate(() => window.__mock.saved)).at(-1).content;
assert(/^column,sss_case,sss_note,String,on,no — a level above is off,/m.test(csv2), "CSV says an audited column under an off table captures nothing");

// ---- the matrix reflects the applied change after the refresh
await page.click('.tab[data-tab="matrix"]');
await page.waitForFunction(() => {
  const tr = [...document.querySelectorAll("table.matrix > tbody > tr:not(.colrow)")].find((r) => r.textContent.includes("account"));
  return tr && !tr.querySelector(".diffmark");
});
assert(true, "account no longer differs after the write");

// ---- revert: the backup loaded as the comparison + "Plan: match other env" puts the flags back
await page.evaluate((c) => { window.__mock.nextOpen = c; }, backupFile.content);
const chipsBefore = await page.$$eval("#columns .colchip", (e) => e.length);
await page.click("#btn-load-snap");
await page.waitForFunction((n) => document.querySelectorAll("#columns .colchip").length === n + 1, chipsBefore);
assert((await page.$$eval("#columns .colchip .kind", (e) => e.map((k) => k.textContent))).some((k) => k.startsWith("backup snapshot")), "the backup's chip says it is a backup snapshot");
await page.waitForFunction(() => document.querySelectorAll("table.matrix .diffmark").length === 2);
const revertDiffs = await page.$$eval("table.matrix tr.differs td.name .mono", (e) => e.map((x) => x.textContent));
assert(
  JSON.stringify(revertDiffs) === JSON.stringify(["account", "telephone1"]),
  "against the backup only what the apply changed differs; tables and columns the backup does not record do not — " + revertDiffs.join(","),
);
await page.click('.tab[data-tab="apply"]');
await page.click("#btn-clear-plan");
await page.click('.tab[data-tab="matrix"]');
await page.click("#btn-plan-match");
await page.waitForFunction(() => document.querySelector("#plan-count").textContent === "2");
await page.click('.tab[data-tab="apply"]');
assert((await page.textContent("#plan-summary")) === "2 pending changes: 1 table on / 0 off, 1 column (0 on / 1 off)", "the revert plan turns account back on and telephone1 back off — " + (await page.textContent("#plan-summary")));
// cancelling the backup save writes nothing
const writesBefore = await page.evaluate(() => window.__mock.writes.length);
await page.evaluate(() => { window.__mock.cancelSave = true; });
await page.click("#btn-apply");
await page.waitForSelector("dialog[open]");
await page.click("#dlg-ok");
await page.waitForFunction(() => window.__mock.notes.some((n) => n.title === "Backup not saved"));
assert((await page.evaluate(() => window.__mock.writes.length)) === writesBefore, "a cancelled backup save writes nothing");
assert((await page.textContent("#plan-count")) === "2", "the plan is kept when the backup was not saved");
await page.evaluate(() => { window.__mock.cancelSave = false; });
await page.click("#btn-apply");
await page.waitForSelector("dialog[open]");
await page.click("#dlg-ok");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results");
assert((await page.textContent("#results-summary")) === "2 ok · 0 failed", "the revert writes succeed — " + (await page.textContent("#results-summary")));
await page.click("#dlg-cancel");
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Publish customizations");
await page.click("#dlg-ok");
await page.waitForFunction(() => window.__mock.published.length === 2);
const reverted = await page.evaluate(() => [window.__mock.envs.primary.tables.find((t) => t.LogicalName === "account").IsAuditEnabled.Value, window.__mock.envs.primary.attrs.account.find((a) => a.LogicalName === "telephone1").IsAuditEnabled.Value]);
assert(JSON.stringify(reverted) === JSON.stringify([true, false]), "account and telephone1 are back to their backed-up flags — " + reverted.join(","));
await page.click('.tab[data-tab="matrix"]');
await page.waitForFunction(() => document.querySelector("#status").hidden && document.querySelectorAll("table.matrix tr.colrow").length === 2 && document.querySelectorAll("table.matrix .diffmark").length === 0);
assert(true, "after the revert nothing differs from the backup");

// ---------------------------------------------------------------- fixture variants
/** A fresh context on one fixture variant, loaded and handed to `fn`; its page errors are asserted too. */
const runVariant = async (variant, fn, chips = 2) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(MOCK);
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  p.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text());
  });
  await p.goto(`${PAGE}?v=${variant}`);
  await p.waitForFunction((n) => document.querySelectorAll("#columns .colchip").length === n, chips);
  const out = await fn(p);
  assert(errs.length === 0, `no page/console errors in the ?v=${variant} run: ` + errs.join(" | "));
  await ctx.close();
  return out;
};

// ---- organization auditing off in the PRIMARY: banner, inert columns, preview warning
await runVariant("orgoff", async (p) => {
  assert(!(await p.$eval("#org-banner", (e) => e.hidden)), "organization banner shown on the matrix when the primary's organization auditing is off");
  const banner = await p.textContent("#org-banner");
  assert(banner.includes("SSS Dev") && banner.includes("organization level"), "the banner names the primary environment — " + banner);
  assert(banner.includes("2 tables whose flag reads on"), "the banner counts the table flags that read on while capturing nothing — " + banner);

  await p.click('button[aria-label="Expand account"]');
  await p.waitForSelector("td.col-inert");
  assert((await p.$$eval("td.col-inert", (e) => e.length)) === 1, "an audited column under an on table is still inert when the organization switch is off");
  const title = await p.$eval("td.col-inert", (e) => e.getAttribute("title"));
  assert(title.includes("auditing is off for the organization"), "the inert tooltip names the organization as the level that is off — " + title);
  const counts = (await p.textContent("#counts")).replace(/\s+/g, " ");
  assert(/1\s*audited columns capturing nothing/.test(counts), "the counts bar reports the organization-inert column — " + counts);
  await p.screenshot({ path: resolve(OUT, "06-org-off.png") });

  await p.click("#btn-plan-match");
  await p.waitForFunction(() => document.querySelector("#plan-count").textContent === "3");
  await p.click('.tab[data-tab="apply"]');
  await p.click("#btn-apply");
  await p.waitForSelector("dialog[open]");
  const warnings = await p.$$eval("#dlg-body .warnings", (ws) => ws.map((w) => w.textContent));
  assert(
    warnings.some((w) => w.includes("These writes will set the flags, but nothing will be captured")),
    "the preview warns that a plan turning flags on captures nothing while the organization switch is off — " + warnings.join(" | "),
  );
  assert(warnings.some((w) => w.includes("Auditing is off for SSS Dev at the organization level")), "the preview warning names the environment whose organization switch is off");
  await p.click("#dlg-cancel");
});

// ---- OwnershipType as the metadata API's flags integer
await runVariant("int", async (p) => {
  const ownInts = await ownershipLabels(p);
  assert(JSON.stringify(ownInts) === JSON.stringify(ownStrings), "OwnershipType as a flags integer yields the same labels as the string form: " + ownInts.join(","));
  assert(new Set(ownInts).size === 4 && !ownInts.includes("none"), "the integer form is decoded, not labelled “none” across the board: " + ownInts.join(","));
});

// ---- show / hide: column-name search, hidden selections, counts, Clear filters, persisted filters
await runVariant("", async (p) => {
  const rowNames = () => p.$$eval("table.matrix > tbody > tr:not(.colrow) td.name .mono", (els) => els.map((e) => e.textContent));
  const colNamesOf = () => p.$$eval("tr.colrow tbody td.name .mono", (els) => els.map((e) => e.textContent));
  const shown = () => p.textContent("#shown-count");
  const lastNote = () => p.evaluate(() => JSON.stringify(window.__mock.notes.at(-1) ?? {}));
  assert((await shown()) === "5 tables shown", "count caption without filters — " + (await shown()));
  assert(!(await p.textContent("#counts")).includes("Clear filters"), "no Clear filters in the counts bar while no filter is on");
  assert(await p.$eval("#filter-text-hint", (e) => e.hidden), "column-name hint hidden while the search is empty");

  // a column name cannot find a table whose columns were never loaded: filtered empty state with Clear filters
  await p.fill("#filter-text", "telephone1");
  await p.waitForSelector("#matrix-body .empty-state");
  assert((await p.textContent("#matrix-body")).includes("No tables match"), "column name of an unexpanded table matches nothing");
  assert(!(await p.$eval("#filter-text-hint", (e) => e.hidden)) && (await p.textContent("#filter-text-hint")).includes("Column names match loaded tables only"), "column-name hint shown while searching");
  assert((await shown()) === "0 of 5 tables shown", "count caption reflects the filter — " + (await shown()));
  await p.click("#matrix-body .empty-state button");
  await p.waitForSelector("table.matrix");
  assert((await p.inputValue("#filter-text")) === "" && (await rowNames()).length === 5, "Clear filters in the empty state resets the search");

  // once account is expanded, its column name keeps the table and narrows its columns
  await p.click('button[aria-label="Expand account"]');
  await p.waitForSelector("table.matrix tr.colrow");
  await p.fill("#filter-text", "telephone1");
  await p.waitForFunction(() => document.querySelectorAll("table.matrix > tbody > tr:not(.colrow)").length === 1);
  assert(JSON.stringify(await rowNames()) === JSON.stringify(["account"]), "column-name search keeps the expanded table: " + (await rowNames()).join(","));
  assert(JSON.stringify(await colNamesOf()) === JSON.stringify(["telephone1"]), "column-name search shows only the matching columns: " + (await colNamesOf()).join(","));
  assert((await shown()) === "1 of 5 tables shown", "count caption 1 of 5 — " + (await shown()));
  assert((await p.textContent("#counts")).includes("Clear filters"), "Clear filters in the counts bar while a filter is on");
  assert((await p.textContent("#btn-plan-match")) === "Plan: match (visible 1)", "match plan names the visible rows — " + (await p.textContent("#btn-plan-match")));
  await p.screenshot({ path: resolve(OUT, "07-column-search.png") });
  await p.fill("#filter-text", "account");
  await p.waitForFunction(() => document.querySelectorAll("tr.colrow tbody tr").length === 4);
  assert((await colNamesOf()).length === 4, "a search matching the table itself keeps every column");

  // selections hidden by a filter are counted and not planned
  await p.fill("#filter-text", "");
  await p.check('input[aria-label="Select table sss_case"]');
  await p.check('input[aria-label="Select table sss_fails"]');
  await p.fill("#filter-text", "sss_case");
  await p.waitForFunction(() => document.querySelectorAll("table.matrix > tbody > tr:not(.colrow)").length === 1);
  const bulk = (await p.textContent("#bulkbar .count")).replace(/\s+/g, " ").trim();
  assert(bulk === "2 selected (1 hidden)", "bulk bar counts the hidden selection — " + bulk);
  await p.click("#btn-plan-on");
  await p.waitForFunction(() => document.querySelector("#plan-count").textContent === "1");
  let planText = await p.textContent("#apply-body");
  assert(planText.includes("sss_case") && !planText.includes("sss_fails"), "audit-on plan covers the visible selection only");
  const note = await lastNote();
  assert(note.includes("1 hidden selection not planned"), "the plan notification says the hidden selection was left out — " + note);

  // "match other env" plans only the visible rows while a filter is on
  await p.fill("#filter-text", "account");
  await p.waitForFunction(() => document.querySelector("#btn-plan-match").textContent === "Plan: match (visible 1)");
  await p.click("#btn-plan-match");
  await p.waitForFunction(() => document.querySelector("#plan-count").textContent === "3");
  planText = await p.textContent("#apply-body");
  assert(planText.includes("telephone1") && !planText.includes("sss_fails"), "visible match plan adds account + telephone1, not the hidden sss_fails");

  // select all visible tables from the header checkbox
  await p.click("#btn-clear-sel");
  await p.fill("#filter-text", "");
  await p.selectOption("#filter-managed", "unmanaged");
  await p.waitForFunction(() => document.querySelectorAll("table.matrix > tbody > tr:not(.colrow)").length === 2);
  await p.check("#sel-all");
  assert((await p.textContent("#sel-count")) === "2", "select-all-visible selects the 2 visible tables");
  await p.click("#counts button");
  await p.waitForFunction(() => document.querySelectorAll("table.matrix > tbody > tr:not(.colrow)").length === 5);
  assert((await p.inputValue("#filter-managed")) === "all", "Clear filters in the counts bar resets the layer filter");
  assert(await p.$eval("#sel-all", (e) => e.indeterminate), "header checkbox is indeterminate once only some visible tables are selected");
  assert((await p.textContent("#btn-plan-match")) === "Plan: match other env", "match label back to the whole matrix with no filter");

  // filters survive a reload
  await p.fill("#filter-text", "sss");
  await p.check("#filter-diff");
  await p.reload();
  await p.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 2);
  await p.waitForSelector("table.matrix");
  assert((await p.inputValue("#filter-text")) === "sss" && (await p.isChecked("#filter-diff")), "search and Only differences restored after a reload");
  assert(JSON.stringify(await rowNames()) === JSON.stringify(["sss_fails", "sss_locked"]), "restored filters applied on load: " + (await rowNames()).join(","));
  assert((await shown()) === "2 of 5 tables shown", "count caption after reload — " + (await shown()));
  await p.click("#counts button");
  await p.reload();
  await p.waitForFunction(() => document.querySelectorAll("table.matrix > tbody > tr:not(.colrow)").length === 5);
  assert((await p.inputValue("#filter-text")) === "" && !(await p.isChecked("#filter-diff")), "cleared filters stay cleared after a reload");
});

// ---- origin filter + relabelled filters; small environment keeps Origin: all
await runVariant("", async (p) => {
  const rowNames = () => p.$$eval("table.matrix > tbody > tr:not(.colrow) td.name .mono", (els) => els.map((e) => e.textContent));
  const optionsOf = (sel) => p.$$eval(sel + " option", (os) => os.map((o) => o.textContent));
  assert((await p.inputValue("#filter-origin")) === "all", "5 tables (≤ 100): Origin stays all on first load");
  assert(JSON.stringify(await optionsOf("#filter-origin")) === JSON.stringify(["all", "custom", "Microsoft"]), "origin options: " + (await optionsOf("#filter-origin")).join(","));
  assert(JSON.stringify(await optionsOf("#filter-managed")) === JSON.stringify(["all", "unmanaged", "managed"]), "layer options say unmanaged, not custom: " + (await optionsOf("#filter-managed")).join(","));
  const colsLabel = await p.$eval("#filter-cols", (e) => e.closest("label").textContent.trim());
  assert(colsLabel === "Has audited / secured columns (loaded tables)", "column filter says it covers loaded tables — " + colsLabel);
  const diffTitle = await p.$eval("#filter-diff", (e) => e.closest("label").title);
  assert(diffTitle.includes("only for tables whose columns are loaded"), "Only differences explains its column scope — " + diffTitle);
  const layerBadges = await p.$$eval("table.matrix > tbody > tr:not(.colrow) td:nth-child(3)", (tds) => tds.map((t) => t.textContent.replace(/\s+/g, " ").trim()));
  assert(layerBadges[0] === "Microsoft managed user" && layerBadges[2] === "custom unmanaged bu", "rows carry origin + layer badges — " + layerBadges.join(" | "));

  await p.selectOption("#filter-origin", "custom");
  assert(JSON.stringify(await rowNames()) === JSON.stringify(["sss_case", "sss_fails", "sss_locked"]), "Origin custom narrows to custom tables: " + (await rowNames()).join(","));
  assert((await p.textContent("#shown-count")) === "3 of 5 tables shown", "count caption under the origin filter");
  await p.selectOption("#filter-origin", "microsoft");
  assert(JSON.stringify(await rowNames()) === JSON.stringify(["account", "contact"]), "Origin Microsoft narrows to the tables Microsoft ships: " + (await rowNames()).join(","));
  await p.selectOption("#filter-managed", "managed");
  await p.selectOption("#filter-origin", "custom");
  assert(JSON.stringify(await rowNames()) === JSON.stringify(["sss_locked"]), "origin and layer combine (a custom table installed managed): " + (await rowNames()).join(","));
  await p.click("#counts button");
  await p.waitForFunction(() => document.querySelectorAll("table.matrix > tbody > tr:not(.colrow)").length === 5);
  assert((await p.inputValue("#filter-origin")) === "all", "Clear filters resets the origin");
  await p.reload();
  await p.waitForSelector("table.matrix");
  assert((await p.inputValue("#filter-origin")) === "all", "Origin still all after a reload of the small environment");
});

// ---- Load columns for N visible tables: only those, three at a time, rows stay collapsed
await runVariant("", async (p) => {
  const rowNames = () => p.$$eval("table.matrix > tbody > tr:not(.colrow) td.name .mono", (els) => els.map((e) => e.textContent));
  const btn = () => p.$eval("#btn-load-cols", (b) => (b.hidden ? null : b.textContent));
  assert((await btn()) === "Load columns for 5 visible tables", "load button counts every visible unloaded table — " + (await btn()));
  await p.selectOption("#filter-origin", "custom");
  assert((await btn()) === "Load columns for 3 visible tables", "load button follows the filters — " + (await btn()));

  // the gap this closes: no column is loaded, so "Has audited columns" shows nothing at all
  await p.check("#filter-cols");
  await p.waitForSelector("#matrix-body .empty-state");
  assert((await btn()) === "Load columns for 3 tables to check", "with the column filter on, the button names the tables it cannot judge yet — " + (await btn()));
  assert(!(await p.$eval("#filter-loaded-hint", (e) => e.hidden)), "column filters say they see loaded tables only");

  await p.evaluate(() => { window.__mock.delay = 150; window.__mock.attrCalls = []; });
  await p.click("#btn-load-cols");
  await p.waitForFunction(() => /Loading columns \d+ \/ 3…/.test(document.querySelector("#status").textContent));
  assert(!!(await p.$("#status button")), "progress in the status line carries a Cancel button");
  await p.waitForFunction(() => document.querySelector("#status").hidden);
  const calls = await p.evaluate(() => window.__mock.attrCalls);
  const loaded = [...new Set(calls.map((c) => c.name))].sort();
  assert(JSON.stringify(loaded) === JSON.stringify(["sss_case", "sss_fails", "sss_locked"]), "only the tables the filters leave in play are read: " + loaded.join(","));
  assert(calls.length === 6 && calls.filter((c) => c.target === "secondary").length === 3, "columns read from the primary and the live comparison, once each — " + calls.length);
  const peak = await p.evaluate(() => window.__mock.maxInFlight);
  assert((peak.primary ?? 0) <= 3 && (peak.primary ?? 0) >= 2, "at most three tables at a time — peak " + JSON.stringify(peak));

  await p.waitForSelector("table.matrix");
  assert(JSON.stringify(await rowNames()) === JSON.stringify(["sss_case"]), "after loading, “Has audited columns” finds sss_case, which qualifies only by its columns: " + (await rowNames()).join(","));
  assert((await p.$$("table.matrix tr.colrow")).length === 0, "loading does not expand the rows");
  assert((await btn()) === null && (await p.$eval("#filter-loaded-hint", (e) => e.hidden)), "button and hint go once nothing is left to load");
  const stats = await p.$eval("table.matrix > tbody > tr:not(.colrow) td:last-child", (e) => e.textContent);
  assert(stats.includes("1 / 2 audited"), "the collapsed row shows its column stats — " + stats);

  await p.uncheck("#filter-cols");
  await p.selectOption("#filter-origin", "all");
  assert((await btn()) === "Load columns for 2 visible tables", "already loaded tables are not counted again — " + (await btn()));
  await p.check("#filter-diff");
  const diffRows = await rowNames();
  assert(JSON.stringify(diffRows) === JSON.stringify(["account", "sss_fails", "sss_locked"]), "Only differences: table differences shown, unloaded tables kept as candidates — " + diffRows.join(","));
  assert((await btn()) === "Load columns for 2 tables to check", "contact is not shown but may differ by its columns — " + (await btn()));
  await p.screenshot({ path: resolve(OUT, "08-load-columns.png") });
});

// ---- M6: Only changeable hides locked tables and columns; off by default, saved with the other filters
await runVariant("", async (p) => {
  const rowNames = () => p.$$eval("table.matrix > tbody > tr:not(.colrow) td.name .mono", (els) => els.map((e) => e.textContent));
  const colNamesOf = () => p.$$eval("tr.colrow tbody td.name .mono", (els) => els.map((e) => e.textContent));
  assert(!(await p.isChecked("#filter-changeable")), "Only changeable is off by default");
  await p.click('button[aria-label="Expand account"]');
  await p.waitForFunction(() => document.querySelectorAll("tr.colrow tbody tr").length === 4);
  await p.check("#filter-changeable");
  assert(JSON.stringify(await rowNames()) === JSON.stringify(["account", "contact", "sss_case", "sss_fails"]), "Only changeable hides the locked table: " + (await rowNames()).join(","));
  assert(JSON.stringify(await colNamesOf()) === JSON.stringify(["name", "creditlimit", "telephone1"]), "…and the locked column under an expanded table: " + (await colNamesOf()).join(","));
  assert((await p.textContent("#shown-count")) === "4 of 5 tables shown", "count caption under Only changeable — " + (await p.textContent("#shown-count")));
  await p.check("#filter-diff");
  assert(JSON.stringify(await rowNames()) === JSON.stringify(["account", "sss_fails"]), "with Only differences: the differences this tool can act on — " + (await rowNames()).join(","));
  assert(JSON.stringify(await colNamesOf()) === JSON.stringify(["telephone1"]), "a locked differing column is left out too: " + (await colNamesOf()).join(","));
  await p.uncheck("#filter-diff");
  await p.reload();
  await p.waitForSelector("table.matrix");
  assert(await p.isChecked("#filter-changeable"), "Only changeable restored after a reload");
  assert(!(await rowNames()).includes("sss_locked"), "and applied on load");
  await p.click("#counts button");
  assert(!(await p.isChecked("#filter-changeable")) && (await rowNames()).includes("sss_locked"), "Clear filters turns Only changeable off");
  // a locked table flag with a changeable column under it: the table stays, so that column can still be reached
  await p.evaluate(() => {
    const prim = window.__mock.envs.primary.attrs;
    const col = JSON.parse(JSON.stringify(prim.account.find((x) => x.LogicalName === "telephone1")));
    Object.assign(col, { LogicalName: "sss_free", MetadataId: "attr-sss_free" });
    prim.sss_locked = [col];
  });
  await p.click('button[aria-label="Expand sss_locked"]');
  await p.waitForFunction(() => [...document.querySelectorAll("tr.colrow tbody td.name .mono")].some((e) => e.textContent === "sss_free"));
  await p.check("#filter-changeable");
  assert((await rowNames()).includes("sss_locked") && (await colNamesOf()).includes("sss_free"), "Only changeable keeps a locked table that has a changeable column: " + (await rowNames()).join(","));
});

// ---- M7: Refresh keeps expanded rows expanded and reads their columns again, three at a time
await runVariant("", async (p) => {
  await p.click('button[aria-label="Expand account"]');
  await p.waitForSelector("tr.colrow");
  await p.click('button[aria-label="Expand sss_case"]');
  await p.waitForFunction(() => document.querySelectorAll("tr.colrow").length === 2);
  await p.check('input[aria-label="Select column account.telephone1"]');
  await p.evaluate(() => { window.__mock.delay = 150; window.__mock.attrCalls = []; window.__mock.maxInFlight = {}; });
  await p.click("#btn-refresh");
  await p.waitForFunction(() => /Reloading columns of expanded tables \d+ \/ 2…/.test(document.querySelector("#status").textContent));
  assert(!!(await p.$("#status button")), "the column reload after Refresh can be cancelled");
  await p.waitForFunction(() => document.querySelector("#status").hidden);
  assert((await p.$$("table.matrix tr.colrow")).length === 2, "both rows expanded again after Refresh, with their columns");
  assert(!!(await p.$('button[aria-label="Collapse account"]')) && !!(await p.$('button[aria-label="Collapse sss_case"]')), "expanders read Collapse after Refresh");
  const calls = await p.evaluate(() => window.__mock.attrCalls.map((c) => c.name + "@" + c.target).sort());
  assert(JSON.stringify(calls) === JSON.stringify(["account@primary", "account@secondary", "sss_case@primary", "sss_case@secondary"]), "only the expanded tables' columns are read again — " + calls.join(","));
  assert(await p.isChecked('input[aria-label="Select column account.telephone1"]'), "a column selection survives the Refresh");

  // a Refresh while "Load columns" runs cancels that run instead of racing it
  await p.click('button[aria-label="Collapse sss_case"]');
  await p.evaluate(() => { window.__mock.delay = 200; });
  await p.click("#btn-load-cols");
  await p.waitForFunction(() => /Loading columns \d+ \/ 3…/.test(document.querySelector("#status").textContent));
  await p.click("#btn-refresh");
  await p.waitForFunction(() => document.querySelector("#status").hidden && document.querySelectorAll("tr.colrow").length === 1);
  assert(!!(await p.$('button[aria-label="Collapse account"]')) && !!(await p.$('button[aria-label="Expand sss_case"]')), "a row collapsed before the Refresh stays collapsed");
});

// ---- M8: "expand to load" is a button too; focus survives the re-render
await runVariant("", async (p) => {
  const focused = () => p.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.id ?? "");
  const load = await p.$('button.load-link[aria-label="Expand to load account"]');
  assert(!!load && (await load.textContent()) === "expand to load", "the Columns cell's “expand to load” is a button");
  await load.focus();
  await p.keyboard.press("Enter");
  await p.waitForSelector("tr.colrow");
  assert((await focused()) === "Collapse account", "after loading by keyboard, focus lands on the row's expander (the link became stats) — " + (await focused()));
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => !document.querySelector("tr.colrow"));
  assert((await focused()) === "Expand account", "collapsing keeps focus on the same row's expander — " + (await focused()));
  await p.focus('button[aria-label="Expand sss_case"]');
  await p.keyboard.press("Enter");
  await p.waitForSelector("tr.colrow");
  assert((await focused()) === "Collapse sss_case", "expanding keeps focus on the expander — " + (await focused()));
  await p.focus("#sel-all");
  await p.keyboard.press("Space");
  assert((await focused()) === "Select all visible tables", "select-all keeps focus after the re-render — " + (await focused()));
  const size = await p.$eval('button[aria-label="Expand account"]', (b) => { const r = b.getBoundingClientRect(); return [r.width, r.height]; });
  assert(size[0] >= 24 && size[1] >= 24, "the expander is a 24px target, not a caption glyph — " + size.join("x"));
});

// ---- M9: plan as a summary + one closed fold per table with ×; preview grouped; results failures first
await runVariant("", async (p) => {
  await p.click('button[aria-label="Expand account"]');
  await p.waitForSelector("tr.colrow");
  await p.click("#btn-plan-match");
  await p.waitForFunction(() => document.querySelector("#plan-count").textContent === "3");
  await p.click('.tab[data-tab="apply"]');
  const summary = await p.textContent("#plan-summary");
  assert(summary === "3 pending changes: 1 table on / 1 off, 1 column (1 on / 0 off)", "plan summary line first — " + summary);
  const folds = await p.$$eval("#apply-body details.card", (ds) => ds.map((d) => [d.dataset.table, d.open, d.querySelector(".count .badge:last-child").textContent]));
  assert(JSON.stringify(folds) === JSON.stringify([["account", false, "2"], ["sss_fails", false, "1"]]), "one closed fold per table with its item count — " + JSON.stringify(folds));
  const head = (await p.textContent('#apply-body details[data-table="account"] summary')).replace(/\s+/g, " ");
  assert(head.includes("Account") && head.includes("table → off") && head.includes("1 column"), "a closed fold says what it holds — " + head);
  await p.click('#apply-body details[data-table="account"] summary');
  await p.screenshot({ path: resolve(OUT, "10-plan-folds.png") });
  await p.click('button[aria-label="Remove account.telephone1 from the plan"]');
  await p.waitForFunction(() => document.querySelector("#plan-count").textContent === "2");
  assert(await p.$eval('#apply-body details[data-table="account"]', (d) => d.open), "the fold stays open after removing an item from it");
  const f = await p.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
  assert(f === "Remove table account from the plan", "focus moves to the next × in the same table — " + f);
  assert((await p.textContent("#plan-summary")) === "2 pending changes: 1 table on / 1 off, 0 columns", "summary follows the removal — " + (await p.textContent("#plan-summary")));
  await p.click("#apply-body .fold-all button:first-child");
  assert(await p.$$eval("#apply-body details.card", (ds) => ds.every((d) => d.open)), "Expand all opens every table's fold");

  // put the column back to have a 3-item plan, then preview
  await p.click('.tab[data-tab="matrix"]');
  await p.click("#btn-plan-match");
  await p.waitForFunction(() => document.querySelector("#plan-count").textContent === "3");
  await p.click('.tab[data-tab="apply"]');
  await p.click("#btn-apply");
  await p.waitForSelector("dialog[open]");
  assert((await p.textContent("#preview-summary")) === "1 table on / 1 off, 1 column (1 on / 0 off)", "preview starts with the summary — " + (await p.textContent("#preview-summary")));
  const pf = await p.$$eval("#dlg-body details.card", (ds) => ds.map((d) => [d.dataset.table, d.open]));
  assert(JSON.stringify(pf) === JSON.stringify([["account", true], ["sss_fails", true]]), "preview groups by table, open while the plan is short — " + JSON.stringify(pf));
  assert((await p.$$("#dlg-body button[data-remove]")).length === 0, "no × in the preview");
  await p.click("#dlg-ok");

  await p.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results");
  assert((await p.textContent("#results-summary")) === "2 ok · 1 failed", "results summary — " + (await p.textContent("#results-summary")));
  assert(await p.isChecked("#results-only-failed"), "Only failures is on when something failed");
  const resRows = () => p.$$eval("#dlg-body .results-list tbody tr", (rs) => rs.map((r) => r.children[1].textContent + (r.classList.contains("is-failed") ? "!" : "")));
  assert(JSON.stringify(await resRows()) === JSON.stringify(["sss_fails!"]), "only the failure listed — " + (await resRows()).join(","));
  assert((await p.textContent("#results-count")) === "1 of 3 writes", "results count caption — " + (await p.textContent("#results-count")));
  await p.uncheck("#results-only-failed");
  assert(JSON.stringify(await resRows()) === JSON.stringify(["sss_fails!", "account", "account"]), "all results, failures first — " + (await resRows()).join(","));
  await p.screenshot({ path: resolve(OUT, "11-results.png") });
  await p.click("#dlg-cancel");
  await p.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Publish customizations");
  await p.click("#dlg-cancel");
  await p.waitForFunction(() => document.querySelector("#plan-count").textContent === "1");
});

// ---- M10: no comparison → no comparison / Diff columns; a table missing from the primary says so
await runVariant("", async (p) => {
  const heads = () => matrixHeads(p);
  const rowCells = () => p.$eval("table.matrix > tbody > tr:not(.colrow)", (tr) => tr.children.length);
  await p.click('button[aria-label="Expand account"]');
  await p.waitForSelector("tr.colrow");
  await p.selectOption("#compare", "");
  await p.waitForFunction(() => document.querySelectorAll("table.matrix > thead th").length === 5);
  assert(JSON.stringify(await heads()) === JSON.stringify(["", "Table", "Origin · layer", "primarySSS Dev", "Columns"]), "comparison “none”: no comparison or Diff header — " + (await heads()).join(","));
  assert((await rowCells()) === 5 && (await p.$$("table.matrix .diffmark")).length === 0, "table rows drop the comparison and Diff cells");
  const sub = await p.$$eval("tr.colrow thead th", (ths) => ths.map((t) => t.textContent));
  assert(JSON.stringify(sub) === JSON.stringify(["", "Column", "Type", "SSS Dev"]), "column sub-rows drop them too — " + sub.join(","));
  assert((await p.$eval("tr.colrow tbody tr", (tr) => tr.children.length)) === 4 && (await p.$eval("tr.colrow > td", (e) => e.colSpan)) === 5, "column sub-row cells and the colspan follow");
  await p.selectOption("#compare", "secondary");
  await p.waitForFunction(() => document.querySelectorAll("table.matrix > thead th").length === 7);
  assert((await rowCells()) === 7 && (await p.$$eval("tr.colrow thead th", (e) => e.length)) === 6, "choosing the secondary again brings the columns back");

  // a table only the comparison has: locked, and the tooltip says it is not in the primary
  await p.evaluate(() => {
    const e = window.__mock.envs.secondary;
    e.tables.push(JSON.parse(JSON.stringify(Object.assign({}, e.tables[2], { LogicalName: "sss_onlytest", SchemaName: "Sss_onlytest", MetadataId: "meta-sss_onlytest" }))));
  });
  await p.click("#btn-refresh");
  await p.waitForSelector('input[aria-label="Select table sss_onlytest"]');
  const t = await p.$eval('input[aria-label="Select table sss_onlytest"]', (e) => [e.disabled, e.title]);
  assert(t[0] === true && t[1] === "Not in the primary environment", "a table missing from the primary: disabled, with the reason as its tooltip — " + t.join(" | "));
});

await runVariant(
  "nosec",
  async (p) => {
    await p.waitForSelector("table.matrix");
    assert((await p.inputValue("#compare")) === "", "no secondary connection: comparison none");
    assert(JSON.stringify(await matrixHeads(p)) === JSON.stringify(["", "Table", "Origin · layer", "primarySSS Dev", "Columns"]), "no comparison loaded: no comparison or Diff column — " + (await matrixHeads(p)).join(","));
    const lock = await p.$$eval("table.matrix > tbody > tr:not(.colrow)", (rs) => rs.find((r) => r.textContent.includes("sss_locked")).querySelector(".flag .badge-warn").title);
    assert(lock === LOCK_REASON, "the lock reason does not need a comparison — " + lock);
    await p.click('button[aria-label="Expand account"]');
    await p.waitForSelector("tr.colrow");
    assert((await p.$$eval("tr.colrow thead th", (e) => e.length)) === 4, "no comparison: column sub-rows have no comparison or Diff column");
    await p.screenshot({ path: resolve(OUT, "12-no-comparison.png") });

    // the CSV keeps its fixed columns: an empty "other audit" column
    await p.click("#btn-export-csv");
    await p.click("#btn-export-snap");
    const [csvNo, snapNo] = await p.evaluate(() => window.__mock.saved.slice(-2).map((f) => f.content));
    assert(csvNo.split("\n")[1] === "level,table,column,type,SSS Dev audit,captures,other audit,differs,locked,managed", "CSV header unchanged without a comparison — " + csvNo.split("\n")[1]);
    assert(/^table,account,,user,on,yes,,false,false,true$/m.test(csvNo) && /^column,account,telephone1,String,off,no,,false,false,false$/m.test(csvNo), "CSV rows keep an empty comparison cell");

    // loading a snapshot gives a comparison: the columns come back
    await p.evaluate((c) => { window.__mock.nextOpen = c; }, snapNo);
    await p.click("#btn-load-snap");
    await p.waitForFunction(() => document.querySelectorAll("table.matrix > thead th").length === 7);
    const h = await matrixHeads(p);
    assert(h[4] === "snapshotSSS Dev" && h[5] === "Diff", "a loaded snapshot brings the comparison + Diff columns back — " + h.join(","));
    assert((await p.$$eval("tr.colrow thead th", (e) => e.length)) === 6 && (await p.$eval("tr.colrow > td", (e) => e.colSpan)) === 7, "…in the column sub-rows too");
  },
  1,
);

// ---- more than 100 tables: first-time viewers start on custom tables; any saved choice wins
await runVariant("many", async (p) => {
  const shown = () => p.textContent("#shown-count");
  await p.waitForSelector("table.matrix");
  assert((await p.inputValue("#filter-origin")) === "custom", "155 tables on first load: Origin defaults to custom");
  assert((await shown()) === "3 of 155 tables shown", "the count caption says how much the default hides — " + (await shown()));
  assert((await p.textContent("#counts")).includes("Clear filters"), "Clear filters offered next to the caption");
  await p.screenshot({ path: resolve(OUT, "09-origin-default.png") });

  await p.selectOption("#filter-origin", "all");
  await p.reload();
  await p.waitForFunction(() => document.querySelectorAll("table.matrix > tbody > tr:not(.colrow)").length === 155);
  assert((await p.inputValue("#filter-origin")) === "all", "a saved choice of all wins over the default after a reload");

  await p.selectOption("#filter-origin", "microsoft");
  await p.reload();
  await p.waitForSelector("table.matrix");
  assert((await p.inputValue("#filter-origin")) === "microsoft" && (await shown()) === "152 of 155 tables shown", "a saved Microsoft choice is restored, not replaced by the default — " + (await shown()));

  // Cancel stops the column load part-way; what was read stays
  await p.evaluate(() => { window.__mock.delay = 60; window.__mock.attrCalls = []; });
  assert((await p.textContent("#btn-load-cols")) === "Load columns for 152 visible tables", "load button over the Microsoft tables");
  await p.click("#btn-load-cols");
  await p.waitForFunction(() => /Loading columns [1-9]\d* \/ 152…/.test(document.querySelector("#status").textContent));
  await p.click("#status button");
  await p.waitForFunction(() => document.querySelector("#status").hidden);
  const n = await p.evaluate(() => new Set(window.__mock.attrCalls.map((c) => c.name)).size);
  assert(n > 0 && n < 152, "Cancel stops the load part-way: " + n + " of 152 tables read");
  const note = await p.evaluate(() => JSON.stringify(window.__mock.notes.at(-1) ?? {}));
  assert(note.includes("Loading cancelled"), "the cancel is reported — " + note);
  const left = await p.textContent("#btn-load-cols");
  assert(left === `Load columns for ${152 - n} visible tables`, "the button offers the rest — " + left);

  // Clear filters while the default is on also counts as a choice
  await p.click("#counts button");
  await p.reload();
  await p.waitForSelector("table.matrix");
  assert((await p.inputValue("#filter-origin")) === "all", "cleared filters are not overridden by the default");
});

// ---- IsCustomEntity missing everywhere: no origin default (it would hide every table)
await runVariant("manyunknown", async (p) => {
  await p.waitForSelector("table.matrix");
  assert((await p.inputValue("#filter-origin")) === "all", "no origin default when the environment does not say which tables are custom");
  assert((await p.textContent("#shown-count")) === "155 tables shown", "every table shown");
  const badges = await p.$eval("table.matrix > tbody > tr:not(.colrow) td:nth-child(3)", (t) => t.textContent.replace(/\s+/g, " ").trim());
  assert(badges === "managed user", "unknown origin shows no origin badge — " + badges);
  await p.selectOption("#filter-origin", "microsoft");
  await p.waitForSelector("#matrix-body .empty-state");
  assert(true, "a table of unknown origin is not passed off as Microsoft");
});

// ---- debug mode: the switch survives a reload, so start-up calls are in the log ----
await checkDebugLog(page, assert, {
  tool: "audit-matrix",
  act: async () => {
    await page.reload();
    await page.waitForSelector("#debug-toggle");
    assert(await page.$eval("#debug-toggle", (e) => e.checked), "audit-matrix: debug mode remembered across a reload");
    await page.waitForTimeout(500);
  },
  readSaved: async (click) => {
    const n = await page.evaluate(() => window.__mock.saved.length);
    await click();
    await page.waitForFunction((k) => window.__mock.saved.length > k, n);
    const f = await page.evaluate(() => window.__mock.saved.at(-1));
    assert(/^audit-matrix-debug-.*\.txt$/.test(f.name), "audit-matrix: debug log file name " + f.name);
    return f.content;
  },
  expect: [
    [/\[call\] #\d+ toolboxAPI\.connections\.getActiveConnection/, "records start-up host calls"],
    [/\[call\] #\d+ dataverseAPI\./, "records Dataverse calls"],
  ],
});

await finish();

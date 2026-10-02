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
// Screenshots go to scripts/.e2e-out/; the ones the README links are copied into docs/img/ so those
// links can never go stale. Run: npm run build && node scripts/e2e.mjs (needs playwright + chromium).
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = resolve(TOOL, "scripts/.e2e-out");
const IMG = resolve(TOOL, "docs/img");
mkdirSync(OUT, { recursive: true });
mkdirSync(IMG, { recursive: true });
const PAGE = "file://" + TOOL + "/dist/index.html";

// ---- mock host, serialized into the page before load ----
const MOCK = `
(() => {
  const VARIANT = new URLSearchParams(location.search).get('v') ?? '';
  const ORG_OFF = VARIANT === 'orgoff';
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
  });
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

  window.__mock = { envs, writes: [], published: [], saved: [], notes: [], nextOpen: null, orgQueries: [] };

  window.toolboxAPI = {
    connections: {
      getActiveConnection: async () => envs.primary.conn,
      getSecondaryConnection: async () => envs.secondary.conn,
    },
    utils: { getCurrentTheme: async () => 'light', showNotification: async (o) => { window.__mock.notes.push(o); } },
    events: { on() {} },
    fileSystem: {
      saveFile: async (name, content) => { window.__mock.saved.push({ name, content }); return '/tmp/' + name; },
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
      return { value: clone(envs[target].attrs[name] || []) };
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
await shot("01-matrix.png", "matrix.png");

// ---- filter to differences
await page.check("#filter-diff");
names = await tableNames();
assert(JSON.stringify(names) === JSON.stringify(["account", "sss_fails", "sss_locked"]), "only differences → 3 rows: " + names.join(","));
await page.selectOption("#filter-managed", "custom");
names = await tableNames();
assert(JSON.stringify(names) === JSON.stringify(["sss_fails"]), "custom layer filter: " + names.join(","));
await page.selectOption("#filter-managed", "all");

// ---- expand a row to its columns (the "only differences" filter is still on)
await page.click('button[aria-label="Expand account"]');
await page.waitForSelector("table.matrix tr.colrow");
let colNames = await page.$$eval("tr.colrow tbody td.name .mono", (els) => els.map((e) => e.textContent));
assert(JSON.stringify(colNames) === JSON.stringify(["lockedcol", "telephone1"]), "only differing columns while the diff filter is on: " + colNames.join(","));
assert((await page.$$eval("tr.colrow .diffmark", (e) => e.length)) === 2, "telephone1 + lockedcol differ");
assert(await page.isDisabled('input[aria-label="Select column account.lockedcol"]'), "locked column cannot be selected");
await shot("02-differences.png", "differences.png");

await page.uncheck("#filter-diff");
await page.waitForFunction(() => document.querySelectorAll("tr.colrow tbody tr").length === 4);
colNames = await page.$$eval("tr.colrow tbody td.name .mono", (els) => els.map((e) => e.textContent));
assert(JSON.stringify(colNames) === JSON.stringify(["name", "creditlimit", "lockedcol", "telephone1"]), "virtual / non-readable attributes skipped: " + colNames.join(","));
assert((await page.textContent("tr.colrow")).includes("secured"), "secured column badge");
const countsAfter = (await page.textContent("#counts")).replace(/\s+/g, " ");
assert(countsAfter.includes("1columns audited in 1 expanded table") || countsAfter.includes("1 columns audited in 1 expanded table"), "column counts scoped to expanded tables — " + countsAfter);
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
assert(!(await page.textContent("#dlg-body")).includes("nothing will be captured"), "no organization warning in the preview while the primary's organization auditing is on");
await shot("04-preview.png", "preview.png");
await page.click("#dlg-ok");

await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Results");
const results = await page.textContent("#dlg-body");
assert(results.includes("simulated failure"), "failing write surfaces as a failed row");
await page.click("#dlg-cancel");

// ---- scoped publish behind its own confirm
await page.waitForFunction(() => document.querySelector("#dlg-title").textContent === "Publish customizations");
assert((await page.textContent("#dlg-body")).includes("account"), "publish dialog names the touched tables");
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
assert(saved.length === 4, "plan CSV + plan script saved");
assert(saved[2].name === "audit-plan.csv" && saved[2].content.includes("table,sss_fails,,off,on"), "plan CSV rows");
assert(saved[3].name === "audit-plan.ps1" && saved[3].content.includes("EntityDefinitions(LogicalName=") && saved[3].content.includes("Table = 'sss_fails'"), "plan script is a runnable list");

// The CSV only carries the columns of expanded tables, and applying the plan reloaded the matrix,
// so expand sss_case again: an audited column under a table whose own flag is off must not read as
// a win in the file an auditor is handed.
await page.click('.tab[data-tab="matrix"]');
await page.click('button[aria-label="Expand sss_case"]');
await page.waitForFunction(() => !!document.querySelector("td.col-inert"));
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

// ---------------------------------------------------------------- fixture variants
/** A fresh context on one fixture variant, loaded and handed to `fn`; its page errors are asserted too. */
const runVariant = async (variant, fn) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(MOCK);
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  p.on("console", (m) => {
    if (m.type() === "error") errs.push("console: " + m.text());
  });
  await p.goto(`${PAGE}?v=${variant}`);
  await p.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 2);
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

await finish();

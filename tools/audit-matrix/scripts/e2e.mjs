// E2E smoke test for the dist build with a mocked PPTB host (window.toolboxAPI / window.dataverseAPI).
// Two fake environments (Dev = primary, Test = secondary) whose audit configuration differs:
// a table audited in Dev but not in Test, a column audited only in Test, a locked table
// (CanBeChanged: false), a table whose write fails, and differing org-level switches.
// Covers: load -> counts + diff markers -> filter to differences -> expand columns ->
// exports -> snapshot as comparison column -> "match other environment" plan -> preview ->
// confirm -> apply -> recorded metadata writes -> scoped publish -> failed row.
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
  const lbl = (t) => ({ LocalizedLabels: [{ Label: t, LanguageCode: 1033 }], UserLocalizedLabel: { Label: t, LanguageCode: 1033 } });
  const mp = (value, canBeChanged = true) => ({ Value: value, CanBeChanged: canBeChanged, ManagedPropertyLogicalName: 'canmodifyauditsettings' });
  const tbl = (LogicalName, display, audit, opts = {}) => ({
    MetadataId: 'meta-' + LogicalName,
    LogicalName, SchemaName: LogicalName.replace(/^(.)/, (c) => c.toUpperCase()),
    DisplayName: lbl(display),
    IsAuditEnabled: mp(audit, opts.canBeChanged !== false),
    IsManaged: !!opts.managed, IsCustomizable: mp(true), OwnershipType: opts.ownership || 'UserOwned',
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
      org: { organizationid: 'org-dev', name: 'SSS Dev', isauditenabled: true, isuseraccessauditenabled: true, auditretentionperiodv2: 90 },
      tables: [
        tbl('account', 'Account', true, { managed: true }),
        tbl('contact', 'Contact', true, { managed: true }),
        tbl('sss_case', 'SSS Case', false),
        tbl('sss_locked', 'SSS Locked', false, { managed: true, canBeChanged: false }),
        tbl('sss_fails', 'SSS Fails', false),
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
        sss_case: [attr('sss_name', 'Name', false)],
      },
    },
    secondary: {
      conn: { id: 'c2', name: 'SSS Test', url: 'https://sss-test.crm4.dynamics.com', environment: 'Test', environmentColor: '#92400e' },
      org: { organizationid: 'org-test', name: 'SSS Test', isauditenabled: false, isuseraccessauditenabled: false, auditretentionperiodv2: 30 },
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
        sss_case: [attr('sss_name', 'Name', false)],
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
const { page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto(PAGE);

const tableNames = () => page.$$eval("table.matrix > tbody > tr:not(.colrow) td.name .mono", (els) => els.map((e) => e.textContent));
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
await shot("02-columns.png", "columns.png");

// ---- exports (matrix CSV + snapshot of the primary environment)
await page.click("#btn-export-csv");
await page.click("#btn-export-snap");
let saved = await page.evaluate(() => window.__mock.saved);
assert(saved.length === 2, "two exports saved");
const csv = saved[0].content;
assert(saved[0].name === "audit-matrix.csv" && csv.split("\n")[0].startsWith("level,table,column,type,SSS Dev audit,SSS Test audit,differs,locked"), "matrix CSV header: " + csv.split("\n")[0]);
assert(/^table,account,,user,on,off,true,false/m.test(csv), "CSV table row for account");
assert(/^column,account,telephone1,String,off,on,true,false/m.test(csv), "CSV column row for telephone1");
assert(/^table,sss_locked,,user,off,on,true,true/m.test(csv), "CSV marks sss_locked locked");
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

// ---- org settings tab
await page.click('.tab[data-tab="org"]');
const org = await page.textContent("#org-body");
assert(org.includes("SSS Dev") && org.includes("SSS Test") && org.includes("90") && org.includes("30"), "org cards for both environments with their retention");
assert(org.includes("unknown") && org.includes("isreadauditenabled"), "missing org field degrades to unknown");
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

// ---- the matrix reflects the applied change after the refresh
await page.click('.tab[data-tab="matrix"]');
await page.waitForFunction(() => {
  const tr = [...document.querySelectorAll("table.matrix > tbody > tr:not(.colrow)")].find((r) => r.textContent.includes("account"));
  return tr && !tr.querySelector(".diffmark");
});
assert(true, "account no longer differs after the write");

await finish();

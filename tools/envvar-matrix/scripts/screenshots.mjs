// Marketplace screenshots of the real dist build against a mocked PPTB host with fictional sandbox data
// (Contoso Dev / Contoso UAT + a Contoso PROD snapshot file). Writes docs/img/{envvars,preview,connrefs,snapshot-dark}.png.
// Run: npm run build && npm run screenshots   (needs playwright + chromium available, see ../../_shared/e2e-loader.mjs)
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = resolve(TOOL, "docs/img");
mkdirSync(OUT, { recursive: true });
if (!existsSync(resolve(TOOL, "dist/index.html"))) {
  console.error("dist/index.html missing: run npm run build first");
  process.exit(1);
}

// ---- mock host, serialized into the page before load ----
const MOCK = `
(() => {
  const STR = 100000000, NUM = 100000001, BOOL = 100000002, JSONT = 100000003, SECRET = 100000005;
  const g = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
  const def = (id, schemaname, displayname, type, defaultvalue, ismanaged = false) => ({ environmentvariabledefinitionid: g(id), schemaname, displayname, type, defaultvalue, ismanaged });
  const val = (id, defId, value, ismanaged = false) => ({ environmentvariablevalueid: g(id), value, ismanaged, _environmentvariabledefinitionid_value: g(defId) });
  const cr = (id, name, display, connector, connectionid, ismanaged = false) => ({ connectionreferenceid: g(id), connectionreferencelogicalname: name, connectionreferencedisplayname: display, connectorid: '/providers/Microsoft.PowerApps/apis/' + connector, connectionid, ismanaged });
  const kvDev = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-contoso-dev/providers/Microsoft.KeyVault/vaults/kv-contoso-dev/secrets/ApiClientSecret';
  const kvUat = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-contoso-uat/providers/Microsoft.KeyVault/vaults/kv-contoso-uat/secrets/ApiClientSecret';
  const envs = {
    primary: {
      conn: { id: g(1), name: 'Contoso Dev', url: 'https://contoso-dev.crm4.dynamics.com', environment: 'Sandbox', environmentColor: '#0f766e' },
      defs: [
        def(101, 'cts_ApiBaseUrl', 'API base URL', STR, 'https://api-dev.contoso.com'),
        def(102, 'cts_ClientSecret', 'API client secret', SECRET, null),
        def(103, 'cts_KeyVaultUri', 'Key Vault URI', STR, null),
        def(104, 'cts_MaxRetries', 'Max retries', NUM, '3'),
        def(105, 'cts_FeatureNewPortal', 'Feature: new customer portal', BOOL, 'no'),
        def(106, 'cts_SharePointSite', 'SharePoint document site', STR, null),
        def(107, 'cts_ConfigJson', 'Integration settings', JSONT, null),
        def(108, 'cts_NotificationEmail', 'Notification mailbox', STR, null),
        def(109, 'cts_DevOnlyFlag', 'Dev diagnostics logging', BOOL, 'no'),
        def(110, 'cts_TimeoutSeconds', 'HTTP timeout (seconds)', NUM, '30'),
      ],
      vals: [
        val(201, 101, 'https://api-dev.contoso.com/v2'),
        val(202, 102, kvDev),
        val(203, 103, 'https://kv-contoso-dev.vault.azure.net/'),
        val(204, 104, '5'),
        val(205, 105, 'yes'),
        val(206, 106, 'https://contoso.sharepoint.com/sites/ProjectsDev'),
        val(207, 107, '{"region":"westeurope","batchSize":50}'),
        val(208, 108, 'crm-alerts@contoso.com'),
        val(209, 109, 'yes'),
      ],
      crs: [
        cr(301, 'cts_DataverseConn', 'Contoso Dataverse', 'shared_commondataserviceforapps', '00000000-0000-0000-0000-00000000a101'),
        cr(302, 'cts_OutlookMailbox', 'Outlook shared mailbox', 'shared_office365', '00000000-0000-0000-0000-00000000a102'),
        cr(303, 'cts_SharePointDocs', 'SharePoint documents', 'shared_sharepointonline', '00000000-0000-0000-0000-00000000a103'),
        cr(304, 'cts_TeamsAlerts', 'Teams alerts channel', 'shared_teams', '00000000-0000-0000-0000-00000000a104'),
        cr(305, 'cts_ApprovalMail', 'Approval notifications', 'shared_office365', '00000000-0000-0000-0000-00000000a105'),
      ],
    },
    secondary: {
      conn: { id: g(2), name: 'Contoso UAT', url: 'https://contoso-uat.crm4.dynamics.com', environment: 'Sandbox', environmentColor: '#b45309' },
      defs: [
        def(401, 'cts_ApiBaseUrl', 'API base URL', STR, 'https://api-dev.contoso.com'),
        def(402, 'cts_ClientSecret', 'API client secret', SECRET, null),
        def(403, 'cts_KeyVaultUri', 'Key Vault URI', STR, null),
        def(404, 'cts_MaxRetries', 'Max retries', NUM, '3'),
        def(405, 'cts_FeatureNewPortal', 'Feature: new customer portal', BOOL, 'no'),
        def(406, 'cts_SharePointSite', 'SharePoint document site', STR, null),
        def(407, 'cts_ConfigJson', 'Integration settings', JSONT, null),
        def(408, 'cts_NotificationEmail', 'Notification mailbox', STR, null, true),
        def(410, 'cts_TimeoutSeconds', 'HTTP timeout (seconds)', NUM, '30'),
      ],
      vals: [
        val(501, 401, 'https://api-uat.contoso.com/v2'),
        val(502, 402, kvUat),
        val(503, 403, 'https://kv-contoso-uat.vault.azure.net/'),
        val(505, 405, 'no'),
        val(507, 407, '{"region":"westeurope","batchSize":50}'),
        val(508, 408, 'crm-alerts@contoso.com', true),
      ],
      crs: [
        cr(601, 'cts_DataverseConn', 'Contoso Dataverse', 'shared_commondataserviceforapps', '00000000-0000-0000-0000-00000000b101'),
        cr(602, 'cts_OutlookMailbox', 'Outlook shared mailbox', 'shared_office365', null),
        cr(603, 'cts_SharePointDocs', 'SharePoint documents', 'shared_sharepointonline', '00000000-0000-0000-0000-00000000b103'),
        cr(604, 'cts_TeamsAlerts', 'Teams alerts channel', 'shared_teams', null),
        cr(605, 'cts_ApprovalMail', 'Approval notifications', 'shared_outlook', '00000000-0000-0000-0000-00000000b105'),
      ],
    },
  };
  window.__mock = { envs, nextOpen: null };
  window.toolboxAPI = {
    connections: {
      getActiveConnection: async () => envs.primary.conn,
      getSecondaryConnection: async () => envs.secondary.conn,
    },
    utils: { getCurrentTheme: async () => 'light', showNotification: async () => {} },
    events: { on() {} },
    fileSystem: {
      saveFile: async (name) => '/tmp/' + name,
      selectPath: async () => (window.__mock.nextOpen ? '/home/user/Contoso PROD snapshot.json' : null),
      readText: async () => window.__mock.nextOpen,
    },
  };
  window.dataverseAPI = {
    queryData: async (q, target = 'primary') => {
      const e = envs[target];
      if (q.startsWith('environmentvariabledefinitions')) return { value: e.defs };
      if (q.startsWith('environmentvariablevalues')) return { value: e.vals };
      if (q.startsWith('connectionreferences')) return { value: e.crs };
      if (q.startsWith('solutioncomponents'))
        return { value: [...e.defs.map((d) => ({ objectid: d.environmentvariabledefinitionid, componenttype: 380 })), ...e.crs.map((c) => ({ objectid: c.connectionreferenceid, componenttype: 371 }))] };
      throw new Error('unexpected query ' + q);
    },
    getSolutions: async () => ({ value: [{ solutionid: g(900), uniquename: 'ContosoCore', friendlyname: 'Contoso Core', version: '1.4.2.0', ismanaged: false, isvisible: true }] }),
    create: async () => ({ id: g(999) }),
    update: async () => {},
  };
})();
`;

// Snapshot file in the exact shape of the tool's Export snapshot (src/matrix/export.ts), secrets as "<secret>".
const STR = 100000000, NUM = 100000001, BOOL = 100000002, JSONT = 100000003, SECRET = 100000005;
const TYPE = { [STR]: "String", [NUM]: "Number", [BOOL]: "Boolean", [JSONT]: "JSON", [SECRET]: "Secret" };
const ev = (schemaName, displayName, typeCode, defaultValue, value, isManaged = true) => ({ schemaName, displayName, typeCode, type: TYPE[typeCode], defaultValue, value, isManaged });
const cref = (logicalName, displayName, connector, connectionId) => ({ logicalName, displayName, connectorId: "/providers/Microsoft.PowerApps/apis/" + connector, connectionId, isManaged: true });
const SNAPSHOT = JSON.stringify(
  {
    kind: "sss-envvar-matrix-snapshot",
    version: 1,
    environment: { name: "Contoso PROD snapshot", url: "https://contoso.crm4.dynamics.com", environment: "Production", takenAt: "2026-09-14T08:30:00.000Z" },
    environmentVariables: [
      ev("cts_ApiBaseUrl", "API base URL", STR, "https://api-dev.contoso.com", "https://api.contoso.com/v2"),
      ev("cts_ClientSecret", "API client secret", SECRET, null, "<secret>"),
      ev("cts_ConfigJson", "Integration settings", JSONT, null, '{"region":"westeurope","batchSize":200}'),
      ev("cts_FeatureNewPortal", "Feature: new customer portal", BOOL, "no", null),
      ev("cts_KeyVaultUri", "Key Vault URI", STR, null, "https://kv-contoso-prod.vault.azure.net/"),
      ev("cts_MaxRetries", "Max retries", NUM, "3", null),
      ev("cts_NotificationEmail", "Notification mailbox", STR, null, "crm-alerts@contoso.com"),
      ev("cts_SharePointSite", "SharePoint document site", STR, null, "https://contoso.sharepoint.com/sites/Projects"),
      ev("cts_TimeoutSeconds", "HTTP timeout (seconds)", NUM, "30", "60"),
    ],
    connectionReferences: [
      cref("cts_ApprovalMail", "Approval notifications", "shared_office365", "00000000-0000-0000-0000-00000000c105"),
      cref("cts_DataverseConn", "Contoso Dataverse", "shared_commondataserviceforapps", "00000000-0000-0000-0000-00000000c101"),
      cref("cts_OutlookMailbox", "Outlook shared mailbox", "shared_office365", "00000000-0000-0000-0000-00000000c102"),
      cref("cts_SharePointDocs", "SharePoint documents", "shared_sharepointonline", "00000000-0000-0000-0000-00000000c103"),
      cref("cts_TeamsAlerts", "Teams alerts channel", "shared_teams", "00000000-0000-0000-0000-00000000c104"),
    ],
  },
  null,
  2,
);

const { page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.goto("file://" + TOOL + "/dist/index.html");
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 2);
await page.waitForFunction(() => document.querySelectorAll("table.matrix tbody tr").length === 10);
const shot = async (name) => {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(OUT, name) });
  console.log("wrote docs/img/" + name);
};

// 1. env vars, light, both columns
await shot("envvars.png");

// 2. copy preview Dev -> UAT: update + create + skip (secret, absent in target)
for (const n of ["cts_ApiBaseUrl", "cts_ClientSecret", "cts_DevOnlyFlag", "cts_MaxRetries", "cts_SharePointSite"]) await page.check(`input[aria-label="Select ${n}"]`);
await page.selectOption("#copy-from", "primary");
await page.selectOption("#copy-to", "secondary");
await page.click("#btn-copy");
await page.waitForSelector("dialog[open]");
const preview = await page.textContent("#dlg-body");
assert(preview.includes("update") && preview.includes("create") && preview.includes("skip") && preview.includes("secret"), "preview has update + create + skip");
await shot("preview.png");
await page.click("#dlg-cancel");
await page.click("#btn-clear-sel");

// 3. connection references, light
await page.click('.tab[data-tab="connrefs"]');
await page.waitForFunction(() => document.querySelector("#matrix-body").textContent.includes("cts_TeamsAlerts"));
await shot("connrefs.png");
await page.click('.tab[data-tab="envvars"]');

// 4. snapshot as third column, dark
await page.evaluate((c) => { window.__mock.nextOpen = c; }, SNAPSHOT);
await page.click("#btn-load-snap");
await page.waitForFunction(() => document.querySelectorAll("#columns .colchip").length === 3);
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await shot("snapshot-dark.png");

await finish();

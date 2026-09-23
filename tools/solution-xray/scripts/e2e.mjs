// E2E smoke test for the dist build in browser-fallback mode.
// Generates synthetic Dataverse solution zips, opens dist/index.html in Chromium and drives the UI.
// Run: npm run build && node scripts/e2e.mjs   (needs playwright + chromium available)
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = resolve(TOOL, "scripts/.e2e-out");
mkdirSync(OUT, { recursive: true });
const require = createRequire(TOOL + "/package.json");
const JSZip = require("jszip");

const solutionXml = ({ name, version, managed, prefix = "sss", roots = [], missing = [] }) => `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.24" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive">
  <SolutionManifest>
    <UniqueName>${name}</UniqueName>
    <LocalizedNames><LocalizedName description="${name} Display" languagecode="1033" /></LocalizedNames>
    <Descriptions />
    <Version>${version}</Version>
    <Managed>${managed}</Managed>
    <Publisher>
      <UniqueName>${prefix}pub</UniqueName>
      <LocalizedNames><LocalizedName description="Simple Smooth Safe" languagecode="1033" /></LocalizedNames>
      <CustomizationPrefix>${prefix}</CustomizationPrefix>
      <CustomizationOptionValuePrefix>10000</CustomizationOptionValuePrefix>
    </Publisher>
    <RootComponents>
${roots.map((r) => `      <RootComponent type="${r.type}" ${r.schemaName ? `schemaName="${r.schemaName}"` : `id="${r.id}"`} behavior="${r.behavior ?? 0}" />`).join("\n")}
    </RootComponents>
    <MissingDependencies>
${missing.map((m) => `      <MissingDependency>
        <Required key="1" type="${m.type}" schemaName="${m.schemaName}" displayName="${m.schemaName}" solution="${m.solution}" />
        <Dependent key="2" type="${m.depType ?? 2}" schemaName="${m.depSchema ?? prefix + "_x"}" displayName="dep" parentSchemaName="${m.parent ?? ""}" solution="${name} (${version})" />
      </MissingDependency>`).join("\n")}
    </MissingDependencies>
  </SolutionManifest>
</ImportExportXml>`;

const entity = (name, display, attrs, forms = 1, views = 2) => `
    <Entity>
      <Name LocalizedName="${display}" OriginalName="${display}">${name}</Name>
      <EntityInfo><entity Name="${name}"><attributes>
${attrs.map(([a, t]) => `        <attribute PhysicalName="${a}"><Type>${t}</Type><Name>${a.toLowerCase()}</Name></attribute>`).join("\n")}
      </attributes></entity></EntityInfo>
      <FormXml><forms type="main">${"<systemform><formid>{1}</formid></systemform>".repeat(forms)}</forms></FormXml>
      <SavedQueries><savedqueries>${"<savedquery><savedqueryid>{1}</savedqueryid></savedquery>".repeat(views)}</savedqueries></SavedQueries>
    </Entity>`;

const customizationsXml = ({ entities = "", workflows = "", extra = "" }) => `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.24" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive">
  <Entities>${entities}
  </Entities>
  <Roles><Role name="SSS User" id="{aaa}" /></Roles>
  <Workflows>${workflows}</Workflows>
  <FieldSecurityProfiles />
  <Templates />
  <EntityMaps />
  <EntityRelationships />
  <OrganizationSettings />
  <optionsets><optionset Name="sss_status" localizedName="Status" /></optionsets>
  <CustomControls />
  <EntityDataProviders />
  ${extra}
  <Languages><Language>1033</Language></Languages>
</ImportExportXml>`;

const flowWf = (id, name, refs) => `
    <Workflow WorkflowId="{${id}}" Name="${name}">
      <JsonFileName>/Workflows/${name}-${id}.json</JsonFileName>
      <Type>1</Type><Category>5</Category><PrimaryEntity>none</PrimaryEntity>
    </Workflow>`;
const flowJson = (refs) => JSON.stringify({ properties: { connectionReferences: Object.fromEntries(refs.map((r, i) => [`shared_${i}`, { connection: { connectionReferenceLogicalName: r } }])) } });

async function zip(files) {
  const z = new JSZip();
  for (const [n, c] of Object.entries(files)) z.file(n, c);
  return z.generateAsync({ type: "nodebuffer" });
}

const FLOW_ID = "1b2c3d4e-0000-4000-8000-000000000001";

const solA1 = await zip({
  "solution.xml": solutionXml({
    name: "SolA", version: "1.0.0.0", managed: 0,
    roots: [{ type: 1, schemaName: "sss_project" }, { type: 1, schemaName: "account", behavior: 0 }, { type: 29, id: `{${FLOW_ID}}` }, { type: 380, schemaName: "sss_apikey" }],
    missing: [{ type: 1, schemaName: "contact", solution: "System" }],
  }),
  "customizations.xml": customizationsXml({
    entities: entity("sss_project", "Project", [["sss_name", "nvarchar"], ["sss_budget", "money"]]) + entity("account", "Account", [["sss_tier", "picklist"]], 2, 3),
    workflows: flowWf(FLOW_ID, "NotifyPM", []),
    extra: `<environmentvariabledefinitions><environmentvariabledefinition schemaname="sss_apikey"><displayname>API Key</displayname><type>100000005</type></environmentvariabledefinition></environmentvariabledefinitions>
    <SolutionPluginAssemblies><PluginAssembly FullName="SSS.Plugins, Version=1.0.0.0, Culture=neutral, PublicKeyToken=abc" /></SolutionPluginAssemblies>
    <SdkMessageProcessingSteps><SdkMessageProcessingStep Name="SSS.Plugins.OnCreate" PluginTypeName="SSS.Plugins.OnCreate"><SdkMessageId>Create</SdkMessageId><PrimaryEntity>sss_project</PrimaryEntity><Stage>40</Stage></SdkMessageProcessingStep></SdkMessageProcessingSteps>`,
  }),
  [`Workflows/NotifyPM-${FLOW_ID}.json`]: flowJson(["sss_sharedoffice365"]),
  "[Content_Types].xml": "<Types/>",
});

const solA2 = await zip({
  "solution.xml": solutionXml({
    name: "SolA", version: "1.1.0.0", managed: 1,
    roots: [{ type: 1, schemaName: "sss_project" }, { type: 1, schemaName: "sss_task" }, { type: 29, id: `{${FLOW_ID}}` }, { type: 380, schemaName: "sss_apikey" }, { type: 371, schemaName: "sss_sharedoffice365" }],
  }),
  "customizations.xml": customizationsXml({
    entities: entity("sss_project", "Project", [["sss_name", "nvarchar"], ["sss_status", "picklist"]], 2, 2) + entity("sss_task", "Task", [["sss_name", "nvarchar"], ["sss_projectid", "lookup"]]),
    workflows: flowWf(FLOW_ID, "NotifyPM", []),
    extra: `<environmentvariabledefinitions><environmentvariabledefinition schemaname="sss_apikey"><displayname>API Key</displayname><type>100000005</type><defaultvalue>x</defaultvalue></environmentvariabledefinition></environmentvariabledefinitions>
    <connectionreferences><connectionreference connectionreferencelogicalname="sss_sharedoffice365"><connectionreferencedisplayname>Office 365</connectionreferencedisplayname><connectorid>/providers/Microsoft.PowerApps/apis/shared_office365</connectorid></connectionreference></connectionreferences>`,
  }),
  [`Workflows/NotifyPM-${FLOW_ID}.json`]: flowJson(["sss_sharedoffice365"]),
  "[Content_Types].xml": "<Types/>",
});

const solB = await zip({
  "solution.xml": solutionXml({
    name: "SolB", version: "2.0.0.0", managed: 1,
    roots: [{ type: 1, schemaName: "sss_project", behavior: 2 }, { type: 1, schemaName: "sss_invoice" }, { type: 1, schemaName: "account", behavior: 0 }],
    missing: [{ type: 1, schemaName: "sss_project", solution: "SolA (1.1.0.0)", parent: "sss_project" }],
  }),
  "customizations.xml": customizationsXml({ entities: entity("sss_invoice", "Invoice", [["sss_name", "nvarchar"], ["sss_projectid", "lookup"]]) }),
  "[Content_Types].xml": "<Types/>",
});

const solC = await zip({
  "solution.xml": solutionXml({
    name: "SolC", version: "1.0.0.0", managed: 1,
    roots: [{ type: 1, schemaName: "sss_report" }, { type: 1, schemaName: "account", behavior: 2 }],
    missing: [{ type: 1, schemaName: "sss_invoice", solution: "SolB (2.0.0.0)" }, { type: 1, schemaName: "ext_thing", solution: "ExternalVendor (3.0.0.0)" }],
  }),
  "customizations.xml": customizationsXml({ entities: entity("sss_report", "Report", [["sss_name", "nvarchar"]]) }),
  "[Content_Types].xml": "<Types/>",
});

// cycle pair
const solD = await zip({
  "solution.xml": solutionXml({ name: "SolD", version: "1.0.0.0", managed: 1, roots: [{ type: 1, schemaName: "sss_d" }], missing: [{ type: 1, schemaName: "sss_e", solution: "SolE (1.0.0.0)" }] }),
  "customizations.xml": customizationsXml({ entities: entity("sss_d", "D", [["sss_name", "nvarchar"]]) }),
});
const solE = await zip({
  "solution.xml": solutionXml({ name: "SolE", version: "1.0.0.0", managed: 1, roots: [{ type: 1, schemaName: "sss_e" }], missing: [{ type: 1, schemaName: "sss_d", solution: "SolD (1.0.0.0)" }] }),
  "customizations.xml": customizationsXml({ entities: entity("sss_e", "E", [["sss_name", "nvarchar"]]) }),
});

// modern export layout: env vars as environmentvariabledefinitions/<name>/environmentvariabledefinition.xml (+ values json);
// foreign-prefix table (abc_thing) and system table (contact) both included with behavior 0
const envDefXml = (name, display, def = "") => `<?xml version="1.0" encoding="utf-8"?>
<environmentvariabledefinition schemaname="${name}">
  ${def ? `<defaultvalue>${def}</defaultvalue>` : ""}
  <displayname default="${display}"><label description="${display}" languagecode="1033" /></displayname>
  <introducedversion>1.0.0.0</introducedversion>
  <isrequired>0</isrequired>
  <type>100000000</type>
</environmentvariabledefinition>`;
const solFFiles = {
  "solution.xml": solutionXml({
    name: "SolF", version: "1.0.0.0", managed: 1,
    roots: [{ type: 1, schemaName: "abc_thing" }, { type: 1, schemaName: "contact" }, { type: 380, schemaName: "sss_FolderVar" }, { type: 380, schemaName: "sss_EmptyVar" }],
  }),
  // sss_FolderVar also declared in customizations.xml: must be deduped
  "customizations.xml": customizationsXml({ extra: `<environmentvariabledefinitions><environmentvariabledefinition schemaname="sss_FolderVar"><displayname>Folder Var</displayname><type>100000000</type></environmentvariabledefinition></environmentvariabledefinitions>` }),
  "environmentvariabledefinitions/sss_FolderVar/environmentvariabledefinition.xml": envDefXml("sss_FolderVar", "Folder Var"),
  "environmentvariabledefinitions/sss_FolderVar/environmentvariablevalues.json": JSON.stringify({ environmentvariablevalues: { environmentvariablevalue: { "@environmentvariablevalueid": "1", "@schemaname": "sss_FolderVar", value: "https://example.test" } } }),
  "environmentvariabledefinitions/sss_EmptyVar/environmentvariabledefinition.xml": envDefXml("sss_EmptyVar", "Empty Var"),
  "[Content_Types].xml": "<Types/>",
};
const solF = await zip(solFFiles);
// empty publisher prefix: only the prefix-less system table may be flagged
const solG = await zip({
  "solution.xml": solutionXml({ name: "SolG", version: "1.0.0.0", managed: 1, prefix: "", roots: [{ type: 1, schemaName: "new_widget" }, { type: 1, schemaName: "contact" }] }),
  "customizations.xml": customizationsXml({}),
});

const files = { "SolA_1_0_0_0.zip": solA1, "SolA_1_1_0_0_managed.zip": solA2, "SolB_2_0_0_0_managed.zip": solB, "SolC_1_0_0_0_managed.zip": solC, "SolD.zip": solD, "SolE.zip": solE, "SolF.zip": solF, "SolF_copy.zip": solF, "SolG.zip": solG };
for (const [n, b] of Object.entries(files)) writeFileSync(resolve(OUT, n), b);

const { page, assert, finish } = await launchPage(import.meta.url, { width: 1280, height: 900 });
await page.goto("file://" + TOOL + "/dist/index.html");

assert((await page.textContent("#host-mode")).includes("Standalone"), "standalone mode detected");

// load A1, A2, B, C
const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-add")]);
await chooser.setFiles(["SolA_1_0_0_0.zip", "SolA_1_1_0_0_managed.zip", "SolB_2_0_0_0_managed.zip", "SolC_1_0_0_0_managed.zip"].map((n) => resolve(OUT, n)));
await page.waitForFunction(() => document.querySelectorAll("#solution-list li:not(.empty)").length === 4);
assert(true, "4 solutions loaded");

// inventory
const inv = await page.textContent("#inv-body");
assert(inv.includes("SolA") && inv.includes("1.0.0.0") && inv.includes("Unmanaged"), "inventory summary");
assert(inv.includes("sss_project") && inv.includes("2 columns"), "inventory entity rows");
assert(inv.includes("Cloud flow") && inv.includes("sss_sharedoffice365"), "flow conn refs parsed");
assert(inv.includes("Plugin steps") && inv.includes("Missing dependencies"), "plugins + missing deps sections");
await page.screenshot({ path: resolve(OUT, "01-inventory-light.png") });

// compare A1 -> A2
await page.click('.tab[data-tab="compare"]');
assert((await page.$eval("#cmp-a", (e) => e.selectedIndex)) === 0 && (await page.$eval("#cmp-b", (e) => e.selectedIndex)) === 1, "compare defaults A=first, B=second");
await page.selectOption("#cmp-a", { index: 0 });
await page.selectOption("#cmp-b", { index: 1 });
const cmp = await page.textContent("#cmp-body");
assert(cmp.includes("upgrade"), "version upgrade detected");
assert(cmp.includes("sss_project.sss_budget") && cmp.includes("removed"), "removed column detected");
assert(cmp.includes("sss_task") && cmp.includes("added"), "added table detected");
await page.screenshot({ path: resolve(OUT, "02-compare.png") });

// risk A1 alone, then A2 with baseline A1
await page.click('.tab[data-tab="risk"]');
await page.selectOption("#risk-select", { index: 0 });
let risk = await page.textContent("#risk-body");
assert(/\d+ \/ 100/.test(risk), "risk score rendered");
assert(risk.includes("Unmanaged solution") && risk.includes("System tables included") && risk.includes("connection references not in this solution") && risk.includes("no default and no value"), "risk factors A1");
const scoreA1 = Number(risk.match(/(\d+) \/ 100/)[1]);
await page.selectOption("#risk-select", { index: 1 });
await page.selectOption("#risk-baseline", { index: 1 }); // index 0 = "none"
risk = await page.textContent("#risk-body");
assert(risk.includes("Columns removed since baseline") && risk.includes("sss_project.sss_budget"), "baseline removed-column factor");
assert(risk.includes("Managed / unmanaged mismatch"), "managed flip factor");
const scoreA2 = Number(risk.match(/(\d+) \/ 100/)[1]);
console.log("scores", { scoreA1, scoreA2 });
// downgrade: A1 over baseline A2
await page.selectOption("#risk-select", { index: 0 });
await page.selectOption("#risk-baseline", { index: 2 });
risk = await page.textContent("#risk-body");
assert(risk.includes("Version lower than baseline") && risk.includes("lower version than the one installed"), "downgrade version factor + advice");
await page.screenshot({ path: resolve(OUT, "03-risk.png") });

// order
await page.click('.tab[data-tab="order"]');
let order = await page.textContent("#order-body");
const names = await page.$$eval(".order-list .name", (els) => els.map((e) => e.textContent));
console.log("order", names);
assert(names.indexOf("SolA") < names.indexOf("SolB") && names.indexOf("SolB") < names.indexOf("SolC"), "topological order A<B<C");
assert(order.includes("ExternalVendor"), "external dependency listed");
assert(order.includes("Duplicate unique names") && order.includes("highest version kept"), "duplicate SolA flagged");
const solAItem = await page.$$eval(".order-list li", (els) => els.map((e) => e.textContent).find((t) => t.startsWith("SolA")));
assert(solAItem?.includes("1.1.0.0"), "install order uses highest SolA version: " + solAItem);
assert(order.includes("table sss_project created there"), "shell table edge to creating solution");
assert(!order.includes("table account"), "no edge for system table account");
await page.screenshot({ path: resolve(OUT, "04-order.png") });

// cycle
const [chooser2] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-add")]);
await chooser2.setFiles(["SolD.zip", "SolE.zip"].map((n) => resolve(OUT, n)));
await page.waitForFunction(() => document.querySelectorAll("#solution-list li:not(.empty)").length === 6);
order = await page.textContent("#order-body");
assert(order.includes("Dependency cycle") && order.includes("SolD") && order.includes("SolE"), "cycle detected");
await page.screenshot({ path: resolve(OUT, "05-order-cycle.png") });

// dark theme
await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
await page.click('.tab[data-tab="inventory"]');
await page.screenshot({ path: resolve(OUT, "06-inventory-dark.png") });

// export (browser fallback = download)
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#inv-export")]);
assert(dl.suggestedFilename().endsWith(".xray.json"), "export download " + dl.suggestedFilename());

// remove one + clear; selections are keyed by id so removing an earlier solution keeps them
await page.selectOption("#inv-select", { index: 5 });
await page.click('.tab[data-tab="compare"]');
await page.selectOption("#cmp-a", { index: 2 });
const selText = (id) => page.$eval(id, (e) => e.options[e.selectedIndex]?.textContent ?? "");
assert((await selText("#inv-select")).startsWith("SolE"), "inv-select on SolE before remove");
await page.click('#solution-list li button[aria-label="Remove SolD"]');
await page.waitForFunction(() => document.querySelectorAll("#solution-list li:not(.empty)").length === 5);
assert(true, "remove works");
assert((await selText("#inv-select")).startsWith("SolE"), "inv-select still SolE after removing SolD");
assert((await selText("#cmp-a")).startsWith("SolB"), "cmp-a still SolB after removing SolD");
await page.click("#btn-clear");
assert((await page.textContent("#solution-list")).includes("No solutions loaded"), "clear works");

// load zips one at a time: compare must default to two different solutions
const addOne = async (name, count) => {
  const [c] = await Promise.all([page.waitForEvent("filechooser"), page.click("#btn-add")]);
  await c.setFiles(resolve(OUT, name));
  await page.waitForFunction((n) => document.querySelectorAll("#solution-list li:not(.empty)").length === n, count);
};
await addOne("SolA_1_0_0_0.zip", 1);
await addOne("SolA_1_1_0_0_managed.zip", 2);
await page.click('.tab[data-tab="compare"]');
assert((await page.$eval("#cmp-a", (e) => e.value)) !== (await page.$eval("#cmp-b", (e) => e.value)), "one-at-a-time: A and B differ");
const cmp2 = await page.textContent("#cmp-body");
assert(cmp2.includes("upgrade") && cmp2.includes("sss_task") && !cmp2.includes("No differences"), "one-at-a-time: diff shown");

// drop on the dropzone loads the file once
await page.evaluate(async (b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], "SolF.zip", { type: "application/zip" }));
  document.querySelector("#dropzone").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
}, solF.toString("base64"));
await page.waitForFunction(() => document.querySelectorAll("#solution-list li:not(.empty)").length >= 3);
await page.waitForTimeout(500);
assert((await page.$$("#solution-list li:not(.empty)")).length === 3, "drop on dropzone loads exactly once");

// env vars from environmentvariabledefinitions/ folder layout, deduped with customizations.xml
await page.click('.tab[data-tab="inventory"]');
await page.selectOption("#inv-select", { index: 2 });
const envRows = await page.$$eval("#inv-body tr", (els) => els.map((e) => e.textContent));
const folderRows = envRows.filter((t) => t.includes("sss_FolderVar"));
assert(folderRows.length === 1 && folderRows[0].includes("value: yes"), "folder-layout env var parsed once with value: " + folderRows.join(" | "));
assert(envRows.some((t) => t.includes("sss_EmptyVar") && t.includes("default: no") && t.includes("value: no")), "folder-layout env var without value");

// risk: system-table factor only flags prefix-less tables; empty-prefix env vars
const factorText = async (title) => (await page.$$eval("#risk-body .factor", (els) => els.map((e) => e.textContent))).find((t) => t.startsWith(title)) ?? "";
await page.click('.tab[data-tab="risk"]');
await page.selectOption("#risk-select", { index: 2 });
await page.selectOption("#risk-baseline", { index: 0 });
let sys = await factorText("System tables included");
assert(sys.includes("contact") && !sys.includes("abc_thing"), "system tables: contact only, not foreign-prefix abc_thing");
const envF = await factorText("Environment variables with no default");
assert(envF.includes("sss_EmptyVar") && !envF.includes("sss_FolderVar"), "env-var risk uses folder-layout values");

// same version (SolF twice) is allowed: low-weight factor with corrected advice; empty prefix does not flag everything
await addOne("SolF_copy.zip", 4);
await addOne("SolG.zip", 5);
await page.selectOption("#risk-select", { index: 3 });
await page.selectOption("#risk-baseline", { index: 3 }); // SolF (drop) as baseline for SolF_copy
const verF = await factorText("Version not incremented");
assert(verF.includes("+3") && verF.includes("allowed"), "same version: allowed, low weight: " + verF);
await page.selectOption("#risk-select", { index: 4 });
await page.selectOption("#risk-baseline", { index: 0 });
sys = await factorText("System tables included");
assert(sys.includes("contact") && !sys.includes("new_widget"), "empty prefix: only prefix-less system table flagged");
assert(!(await page.textContent("#risk-body")).includes("different publisher prefix"), "empty prefix: no prefix-hygiene factor");

await finish();

// E2E smoke test for the dist build in browser-fallback mode.
// Generates synthetic Dataverse solution zips, opens dist/index.html in Chromium and drives the UI.
// Run: npm run build && node scripts/e2e.mjs   (needs playwright + chromium available)
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";
import { checkDebugLog } from "../../_shared/e2e-debug.mjs";

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

// bug-fix fixtures: SolH v1/v2
// - MissingDependency on solution "Active" (unmanaged in source env) must be a blocker, not built-in
// - org-specific component type codes (>= 10000) labelled from zip content; 371 = Connector
// - empty RibbonDiffXml is not a ribbon customization
// - same-named business rules on different tables must not collapse in compare
const RULE_A = "2b000000-0000-4000-8000-00000000000a";
const RULE_B = "2b000000-0000-4000-8000-00000000000b";
const ruleWf = (id, name, entityName) => `
    <Workflow WorkflowId="{${id}}" Name="${name}"><Type>1</Type><Category>2</Category><PrimaryEntity>${entityName}</PrimaryEntity></Workflow>`;
const emptyRibbon = `<RibbonDiffXml><CustomActions /><Templates><RibbonTemplates Id="Mscrm.Templates" /></Templates><CommandDefinitions /><RuleDefinitions><TabDisplayRules /><DisplayRules /><EnableRules /></RuleDefinitions><LocLabels /></RibbonDiffXml>`;
const realRibbon = `<RibbonDiffXml><CustomActions><CustomAction Id="sss.btn" Location="Mscrm.Form.sss_ribbonyes.MainTab.Save.Controls._children" /></CustomActions><Templates><RibbonTemplates Id="Mscrm.Templates" /></Templates><CommandDefinitions /><RuleDefinitions><TabDisplayRules /><DisplayRules /><EnableRules /></RuleDefinitions><LocLabels /></RibbonDiffXml>`;
const withRibbon = (xml, ribbon) => xml.replace("</Entity>", `  ${ribbon}\n    </Entity>`);
const solHFiles = (version, rules) => ({
  "solution.xml": solutionXml({
    name: "SolH", version, managed: 1,
    roots: [
      { type: 1, schemaName: "sss_ribbonno" }, { type: 1, schemaName: "sss_ribbonyes" },
      { type: 10050, schemaName: "abc_sharedsql" }, { type: 10051, schemaName: "sss_DoThing" }, { type: 10001, schemaName: "sss_mystery" },
      { type: 371, schemaName: "sss_myconnector" }, { type: 29, id: `{${RULE_A}}` }, ...(version === "1.0.0.0" ? [{ type: 29, id: `{${RULE_B}}` }] : [{ type: 61, schemaName: "sss_/new.js" }]),
    ],
    missing: [{ type: 61, schemaName: "sss_/unmanaged.js", solution: "Active" }],
  }),
  "customizations.xml": customizationsXml({
    entities: withRibbon(entity("sss_ribbonno", "Ribbon No", [["sss_name", "nvarchar"]]), emptyRibbon) + withRibbon(entity("sss_ribbonyes", "Ribbon Yes", [["sss_name", "nvarchar"]]), realRibbon),
    workflows: rules.map(([id, e]) => ruleWf(id, "Validate", e)).join(""),
    extra: `<connectionreferences><connectionreference connectionreferencelogicalname="abc_sharedsql"><connectionreferencedisplayname>SQL</connectionreferencedisplayname><connectorid>/providers/Microsoft.PowerApps/apis/shared_sql</connectorid></connectionreference></connectionreferences>`,
  }),
  "customapis/sss_DoThing/customapi.xml": `<customapi uniquename="sss_DoThing"><name>sss_DoThing</name></customapi>`,
  "[Content_Types].xml": "<Types/>",
});
const solH1 = await zip(solHFiles("1.0.0.0", [[RULE_A, "sss_ribbonno"], [RULE_B, "sss_ribbonyes"]]));
const solH2 = await zip(solHFiles("1.1.0.0", [[RULE_A, "sss_ribbonno"]]));

// only a root component's behavior differs: with "hide root rows" on, compare must not claim "No differences"
const solIFiles = (behavior) => ({
  "solution.xml": solutionXml({ name: "SolI", version: "1.0.0.0", managed: 1, roots: [{ type: 1, schemaName: "sss_only", behavior }] }),
  "customizations.xml": customizationsXml({ entities: entity("sss_only", "Only", [["sss_name", "nvarchar"]]) }),
});
const solI1 = await zip(solIFiles(0));
const solI2 = await zip(solIFiles(2));

// compare filters (X1): SolJ v2 changes one column type, removes a table and adds a 25-column table
// -> Column category 27 rows (starts closed), Table 2 rows (starts open), root rows hidden by default
const BIG_COLS = Array.from({ length: 24 }, (_, i) => [`sss_c${String(i).padStart(2, "0")}`, "nvarchar"]);
const solJ1 = await zip({
  "solution.xml": solutionXml({ name: "SolJ", version: "1.0.0.0", managed: 1, roots: [{ type: 1, schemaName: "sss_keep" }, { type: 1, schemaName: "sss_old" }] }),
  "customizations.xml": customizationsXml({ entities: entity("sss_keep", "Keep", [["sss_name", "nvarchar"], ["sss_note", "nvarchar"]]) + entity("sss_old", "Old", [["sss_name", "nvarchar"]]) }),
});
const solJ2 = await zip({
  "solution.xml": solutionXml({ name: "SolJ", version: "1.1.0.0", managed: 1, roots: [{ type: 1, schemaName: "sss_keep" }, { type: 1, schemaName: "sss_big" }] }),
  "customizations.xml": customizationsXml({ entities: entity("sss_keep", "Keep", [["sss_name", "nvarchar"], ["sss_note", "memo"]]) + entity("sss_big", "Big", [["sss_name", "nvarchar"], ...BIG_COLS]) }),
});

// risk evidence (X4): 11 environment variables without default or value -> 8 chips + "+3 more"
const EMPTY_VARS = Array.from({ length: 11 }, (_, i) => `sss_Var${String(i).padStart(2, "0")}`);
const solK = await zip({
  "solution.xml": solutionXml({ name: "SolK", version: "1.0.0.0", managed: 1, roots: EMPTY_VARS.map((n) => ({ type: 380, schemaName: n })) }),
  "customizations.xml": customizationsXml({
    extra: `<environmentvariabledefinitions>${EMPTY_VARS.map((n) => `<environmentvariabledefinition schemaname="${n}"><displayname>${n}</displayname><type>100000000</type></environmentvariabledefinition>`).join("")}</environmentvariabledefinitions>`,
  }),
});

const files = { "SolK.zip": solK, "SolA_1_0_0_0.zip": solA1, "SolA_1_1_0_0_managed.zip": solA2, "SolB_2_0_0_0_managed.zip": solB, "SolC_1_0_0_0_managed.zip": solC, "SolD.zip": solD, "SolE.zip": solE, "SolF.zip": solF, "SolF_copy.zip": solF, "SolG.zip": solG, "SolH_1_0.zip": solH1, "SolH_1_1.zip": solH2, "SolI_1.zip": solI1, "SolI_2.zip": solI2, "SolJ_1.zip": solJ1, "SolJ_2.zip": solJ2 };
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
assert((await page.getAttribute('.tab[data-tab="compare"]', "aria-selected")) === "true" && (await page.getAttribute('.tab[data-tab="inventory"]', "aria-selected")) === "false", "tabs: aria-selected follows the active tab");
assert((await page.getAttribute('.tab[data-tab="compare"]', "aria-controls")) === "tab-compare", "tabs: aria-controls points at the panel");
assert((await page.$eval("#cmp-a", (e) => e.selectedIndex)) === 0 && (await page.$eval("#cmp-b", (e) => e.selectedIndex)) === 1, "compare defaults A=first, B=second");
await page.selectOption("#cmp-a", { index: 0 });
await page.selectOption("#cmp-b", { index: 1 });
const cmp = await page.textContent("#cmp-body");
assert(cmp.includes("upgrade"), "version upgrade detected");
assert(cmp.includes("sss_project.sss_budget") && cmp.includes("removed"), "removed column detected");
assert(cmp.includes("sss_task") && cmp.includes("added"), "added table detected");
// X5: "changed" detail is a labelled per-field diff of the changed fields only, full before / after in the tooltip
const changedRows = await page.$$eval("#cmp-body tr.diff-changed", (els) => els.map((e) => ({ text: e.textContent, title: e.querySelector(".diff-fields")?.getAttribute("title") ?? "" })));
const envChange = changedRows.find((r) => r.text.includes("sss_apikey"));
assert(envChange && envChange.text.includes("Has default: no → yes") && !envChange.text.includes("Has value") && !envChange.text.includes("|"), "changed env var: labelled field diff, changed fields only: " + envChange?.text);
assert(/^Before: Type: .+ · Has default: no · Has value: no\nAfter: Type: .+ · Has default: yes · Has value: no$/.test(envChange?.title ?? ""), "changed env var: full before / after in title: " + JSON.stringify(envChange?.title));
const tableChange = changedRows.find((r) => r.text.startsWith("changedsss_project"));
assert(tableChange && tableChange.text.includes("Forms: 1 → 2") && !tableChange.text.includes("Views"), "changed table: only Forms listed: " + tableChange?.text);
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

// fold state survives re-render (tab switch, select change); expand / collapse all
const invFold = (title) => page.$eval(`#inv-body details.card:has(h3:text-is("${title}"))`, (d) => d.open).catch(() => null);
const invFolds = () => page.$$eval("#inv-body details.card", (els) => els.map((d) => d.open));
assert((await invFold("Tables")) === true && (await invFold("Plugin steps")) === false, "fold defaults: Tables open, Plugin steps closed");
await page.click('#inv-body details.card:has(h3:text-is("Tables")) > summary');
await page.click('#inv-body details.card:has(h3:text-is("Plugin steps")) > summary');
await page.click('.tab[data-tab="compare"]');
await page.click('.tab[data-tab="inventory"]');
assert((await invFold("Tables")) === false && (await invFold("Plugin steps")) === true, "fold state kept after tab switch re-render");
await page.selectOption("#inv-select", { index: 1 });
await page.selectOption("#inv-select", { index: 0 });
assert((await invFold("Tables")) === false && (await invFold("Plugin steps")) === true, "fold state kept after select change re-render");
await page.click('#tab-inventory .fold-all button:text-is("Expand all")');
assert((await invFolds()).every(Boolean), "inventory: Expand all opens every card");
await page.click('#tab-inventory .fold-all button:text-is("Collapse all")');
assert((await invFolds()).every((o) => !o), "inventory: Collapse all closes every card");
await page.click('.tab[data-tab="risk"]');
await page.click('.tab[data-tab="inventory"]');
assert((await invFolds()).every((o) => !o), "inventory: Collapse all remembered after re-render");
// back to defaults for the rest of the run
await page.click('#inv-body details.card:has(h3:text-is("Tables")) > summary');

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

// ---- bug-fix regressions (SolH) ----
await page.click("#btn-clear");
await addOne("SolH_1_0.zip", 1);
await addOne("SolH_1_1.zip", 2);

// component type labels
await page.click('.tab[data-tab="inventory"]');
await page.selectOption("#inv-select", { index: 0 });
const invH = await page.textContent("#inv-body");
assert(invH.includes("Connector (371)") && !invH.includes("Connection Reference (371)"), "type 371 labelled Connector");
assert(invH.includes("Connection Reference (10050)"), "org-specific type inferred as Connection Reference from zip content");
assert(invH.includes("Custom API (10051)"), "org-specific type inferred as Custom API from customapis/ folder");
assert(invH.includes("Custom component (type 10001)"), "unknown org-specific type shown as Custom component (type N)");

// ribbon flag
const tableRows = await page.$$eval("#inv-body tr", (els) => els.map((e) => e.textContent));
assert(tableRows.some((t) => t.startsWith("sss_ribbonyes") && t.includes("· ribbon")), "real ribbon customization flagged");
assert(tableRows.some((t) => t.startsWith("sss_ribbonno") && t.includes("Ribbon No") && !t.includes("· ribbon")), "empty RibbonDiffXml not flagged as ribbon");

// Active dependency = blocker; foreign-prefix connection reference detected by content
await page.click('.tab[data-tab="risk"]');
await page.selectOption("#risk-select", { index: 0 });
await page.selectOption("#risk-baseline", { index: 0 });
const activeF = await factorText("Missing dependencies on unmanaged components");
assert(activeF.includes("sss_/unmanaged.js") && activeF.includes("exists only as unmanaged customization in the source environment"), "Active dependency scored as blocker: " + activeF);
assert(!(await factorText("Missing dependencies on System")).includes("unmanaged.js"), "Active dependency not treated as built-in");
const prefH = await factorText("Custom components with a different publisher prefix");
assert(prefH.includes("abc_sharedsql"), "prefix hygiene flags foreign-prefix connection reference (org-specific type)");
await page.click('.tab[data-tab="order"]');
const orderH = await page.textContent("#order-body");
assert(orderH.includes("sss_/unmanaged.js") && orderH.includes("unmanaged in source environment"), "Active dependency listed as external in install order");

// same-named business rules on different tables
await page.click('.tab[data-tab="compare"]');
await page.selectOption("#cmp-a", { index: 0 });
await page.selectOption("#cmp-b", { index: 1 });
const procRows = await page.$$eval("#cmp-body tr", (els) => els.map((e) => e.textContent));
const cmpFolds = () => page.$$eval("#cmp-body details.card", (els) => els.map((d) => d.open));
await page.click('#tab-compare .fold-all button:text-is("Collapse all")');
assert((await cmpFolds()).length > 0 && (await cmpFolds()).every((o) => !o), "compare: Collapse all closes every category: " + (await cmpFolds()).length);
await page.click("#cmp-hide-root");
await page.click("#cmp-hide-root");
assert((await cmpFolds()).every((o) => !o), "compare: collapsed categories stay closed after hide-root re-render");
await page.click('#tab-compare .fold-all button:text-is("Expand all")');
assert((await cmpFolds()).every(Boolean), "compare: Expand all opens every category");
assert(procRows.some((t) => t.startsWith("removed") && t.includes("Validate") && t.includes("sss_ribbonyes")), "same-named business rule on another table reported as removed: " + procRows.filter((t) => t.includes("Validate")).join(" | "));

// compare export: filename carries both names; respects "hide root" filter
assert(await page.$eval("#cmp-hide-root", (e) => e.checked), "hide root checked by default");
const [dlc] = await Promise.all([page.waitForEvent("download"), page.click("#cmp-export")]);
assert(dlc.suggestedFilename() === "SolH-1.0.0.0_vs_SolH-1.1.0.0.diff.json", "compare export filename: " + dlc.suggestedFilename());
const diffJson = JSON.parse(readFileSync(await dlc.path(), "utf8"));
assert(diffJson.entries.length > 0 && !diffJson.entries.some((e) => e.category === "Root component"), "compare export respects hide-root filter");
await page.click("#cmp-hide-root");
const [dlc2] = await Promise.all([page.waitForEvent("download"), page.click("#cmp-export")]);
const diffJson2 = JSON.parse(readFileSync(await dlc2.path(), "utf8"));
assert(diffJson2.entries.some((e) => e.category === "Root component"), "compare export includes root rows when filter off");
const chipText = () => page.$$eval("#cmp-body .card .chips .badge", (els) => els.map((e) => e.textContent).join(" "));
const rootRows = diffJson2.entries.filter((e) => e.category === "Root component");
const all = (c) => diffJson2.entries.filter((e) => e.change === c).length;
assert((await chipText()) === `+${all("added")} ~${all("changed")} -${all("removed")}`, "compare header counts include root rows when shown: " + (await chipText()));
await page.click("#cmp-hide-root");
assert((await chipText()) === `+${diffJson.counts.added} ~${diffJson.counts.changed} -${diffJson.counts.removed}` && diffJson.counts.added + diffJson.counts.changed + diffJson.counts.removed === diffJson.entries.length, "compare header counts = filtered entries = export counts: " + (await chipText()));
assert((await page.textContent("#cmp-body .count-caption")) === `${rootRows.length} root-component rows hidden`, "compare caption names hidden root rows");

// hide-root setting persists across reopen; only-root differences are not "No differences"
await page.click("#cmp-hide-root");
await page.reload();
assert(!(await page.$eval("#cmp-hide-root", (e) => e.checked)), "hide-root unchecked state restored after reload");
await page.click('.tab[data-tab="compare"]');
await page.click("#cmp-hide-root");
await addOne("SolI_1.zip", 1);
await addOne("SolI_2.zip", 2);
await page.click('.tab[data-tab="compare"]');
let cmpI = await page.textContent("#cmp-body");
assert(!cmpI.includes("No differences") && cmpI.includes("Only root-component differences") && cmpI.includes("1 root-component difference is hidden"), "only root differences: filtered empty state, not 'No differences'");
assert((await chipText()) === "+0 ~0 -0" && (await page.textContent("#cmp-body .count-caption")) === "1 root-component row hidden", "only root differences: header counts filtered + caption");
await page.click('#cmp-body .empty-state button:text-is("Clear filters")');
assert(!(await page.$eval("#cmp-hide-root", (e) => e.checked)), "Clear filters unticks hide-root");
cmpI = await page.textContent("#cmp-body");
assert(cmpI.includes("Root component") && cmpI.includes("sss_only") && (await chipText()) === "+0 ~1 -0" && !(await page.$("#cmp-body .count-caption")), "Clear filters shows the root-component row");
await page.click("#cmp-hide-root"); // back to the default

// ---- compare filters: change types, name, category folds, export, clear, persistence ----
await page.reload(); // fresh fold memory
await addOne("SolJ_1.zip", 1);
await addOne("SolJ_2.zip", 2);
await page.click('.tab[data-tab="compare"]');
const cmpFold = (title) => page.$eval(`#cmp-body details.card:has(h3:text-is("${title}"))`, (d) => d.open).catch(() => null);
const cmpCats = () => page.$$eval("#cmp-body details.card h3", (els) => els.map((e) => e.textContent));
const cmpRows = (cls = "") => page.$$eval(`#cmp-body tbody tr${cls}`, (els) => els.length);
const shownCaption = () => page.$$eval("#cmp-body .count-caption", (els) => els.map((e) => e.textContent).find((t) => t.includes("changes")) ?? null);
assert((await cmpRows()) === 29 && (await chipText()) === "+26 ~1 -2" && (await shownCaption()) === null, "SolJ: 29 rows, counts, no shown-of caption by default");
assert((await cmpFold("Column")) === false && (await cmpFold("Table")) === true, "category with >20 rows starts closed, <=20 open");
await page.click("#cmp-added");
assert((await cmpRows(".diff-added")) === 0 && (await cmpRows()) === 3, "untick Added hides added rows");
assert((await chipText()) === "+0 ~1 -2" && (await shownCaption()) === "3 of 29 changes", "untick Added: header counts + shown-of caption: " + (await shownCaption()));
assert((await cmpFold("Column")) === true, "Column opens once it has <=20 visible rows");
await page.click("#cmp-added");
await page.fill("#cmp-q", "sss_c0");
assert(JSON.stringify(await cmpCats()) === '["Column"]' && (await cmpRows()) === 10 && (await shownCaption()) === "10 of 29 changes", "name filter narrows; empty categories not rendered: " + (await cmpCats()));
const [dlj] = await Promise.all([page.waitForEvent("download"), page.click("#cmp-export")]);
const diffJ = JSON.parse(readFileSync(await dlj.path(), "utf8"));
assert(diffJ.entries.length === 10 && diffJ.entries.every((e) => e.name.startsWith("sss_big.sss_c0")) && diffJ.counts.added === 10 && diffJ.filter.name === "sss_c0" && diffJ.filter.changes.length === 3, "export JSON reflects name filter");
await page.fill("#cmp-q", "memo");
assert((await cmpRows()) === 1 && (await page.textContent("#cmp-body tbody")).includes("sss_keep.sss_note"), "name filter matches detail text");
await page.fill("#cmp-q", "sss_c0");
await page.click("#cmp-added");
const cmpJ = await page.textContent("#cmp-body");
assert(cmpJ.includes("No changes match") && cmpJ.includes("29 changes are hidden"), "filters hiding everything: filteredEmpty");
await page.click('#cmp-body .empty-state button:text-is("Clear filters")');
assert((await page.$eval("#cmp-added", (e) => e.checked)) && (await page.inputValue("#cmp-q")) === "" && (await page.$eval("#cmp-hide-root", (e) => e.checked)), "Clear filters resets type + name, keeps hide-root");
assert((await cmpRows()) === 29 && (await shownCaption()) === null, "Clear filters shows every row again");
const [dlj2] = await Promise.all([page.waitForEvent("download"), page.click("#cmp-export")]);
const noteEntry = JSON.parse(readFileSync(await dlj2.path(), "utf8")).entries.find((e) => e.name === "sss_keep.sss_note");
assert(
  noteEntry?.change === "changed" && noteEntry.detail === "Type: nvarchar → memo" && JSON.stringify(noteEntry.fields) === '[{"field":"Type","before":"nvarchar","after":"memo"}]' && noteEntry.before === "Type: nvarchar" && noteEntry.after === "Type: memo",
  "export JSON: changed entry keeps detail and adds fields / before / after: " + JSON.stringify(noteEntry),
);
await page.click("#cmp-removed");
await page.fill("#cmp-q", "sss_keep");
await page.reload();
assert(!(await page.$eval("#cmp-removed", (e) => e.checked)) && (await page.$eval("#cmp-added", (e) => e.checked)) && (await page.inputValue("#cmp-q")) === "sss_keep", "compare filters restored after reload");
await addOne("SolJ_1.zip", 1);
await addOne("SolJ_2.zip", 2);
await page.click('.tab[data-tab="compare"]');
assert((await cmpRows()) === 1 && (await shownCaption()) === "1 of 29 changes", "restored filters applied after reload");
await page.click("#cmp-removed");
await page.fill("#cmp-q", "");

// ---- inventory: table column folds (X6), find component (X3) ----
await page.reload(); // fresh fold memory
await addOne("SolA_1_0_0_0.zip", 1);
await page.click('.tab[data-tab="inventory"]');
const invCard = (title) => `#inv-body details.card:has(h3:text-is("${title}"))`;
// fold key is inv:cols:<table>, plus ?find=<query> while a search matched one of its columns
const colsFold = (table) => `${invCard("Tables")} details.cols:is([data-fold-key="inv:cols:${table}"], [data-fold-key^="inv:cols:${table}?find="])`;
const colsOpen = (table) => page.$eval(colsFold(table), (d) => d.open).catch(() => null);
assert((await page.textContent(`${colsFold("sss_project")} > summary`)) === "2 columns" && (await colsOpen("sss_project")) === false, "table row: '2 columns' fold, closed by default");
await page.click(`${colsFold("sss_project")} > summary`);
const colItems = await page.$$eval(`${colsFold("sss_project")} li`, (els) => els.map((e) => e.textContent));
assert(JSON.stringify(colItems) === '["sss_namenvarchar","sss_budgetmoney"]', "table row: columns listed with name + type: " + colItems.join(" | "));
await page.click('.tab[data-tab="risk"]');
await page.click('.tab[data-tab="inventory"]');
assert((await colsOpen("sss_project")) === true && (await colsOpen("account")) === false, "table column fold kept per table across re-render");
await page.click(`${colsFold("sss_project")} > summary`);

const invCards = () => page.$$eval("#inv-body details.card", (els) => els.map((d) => ({ title: d.querySelector("h3").textContent, open: d.open, count: d.querySelector(".count .badge").textContent })));
const invCardOf = async (title) => (await invCards()).find((c) => c.title === title);
const allCards = (await invCards()).length;
assert((await invCardOf("Tables")).count === "2" && (await invCardOf("Plugin steps")).open === false, "find: no search, plain counts");
await page.click(`${invCard("Tables")} > summary`); // user closes Tables outside the search
await page.fill("#inv-q", "project");
let found = await invCards();
assert(JSON.stringify(found.map((c) => c.title)) === '["Tables","Plugin steps"]', "find: only groups with a match are shown: " + found.map((c) => c.title).join(", "));
assert(found.every((c) => c.open) && found[0].count === "1 of 2" && found[1].count === "1", "find: matching cards open, badge 'shown of total': " + JSON.stringify(found));
assert((await page.$$eval(`${invCard("Tables")} tbody > tr`, (els) => els.map((e) => e.querySelector("td").textContent))).join() === "sss_project", "find: rows filtered inside a group");
await page.fill("#inv-q", "budget");
assert((await invCardOf("Tables"))?.count === "1 of 2" && (await colsOpen("sss_project")) === true && (await page.textContent(`${colsFold("sss_project")} li.is-match`)).includes("sss_budget"), "find: column-name match opens the table's column list and marks the column");
await page.fill("#inv-q", "");
found = await invCards();
assert(found.length === allCards && (await invCardOf("Tables")).open === false && (await invCardOf("Plugin steps")).open === false && (await colsOpen("sss_project")) === false, "find: clearing the search restores the user's folds");
await page.fill("#inv-q", "zzz-nothing");
assert((await page.textContent("#inv-body .empty-state")).includes("No components match"), "find: nothing matches -> filteredEmpty");
await page.click('#inv-body .empty-state button:text-is("Clear search")');
assert((await page.inputValue("#inv-q")) === "" && (await invCards()).length === allCards, "find: Clear search empties the box and shows every group");
await page.fill("#inv-q", "budget");
await page.reload();
assert((await page.inputValue("#inv-q")) === "budget", "find: search restored after reload");
await addOne("SolA_1_0_0_0.zip", 1);
assert(JSON.stringify((await invCards()).map((c) => c.count)) === '["1 of 2"]', "find: restored search applied after reload");
await page.fill("#inv-q", "");

// ---- risk evidence (X4): first 8 + "+N more" inline, full list kept in the data ----
await addOne("SolK.zip", 2);
await page.click('.tab[data-tab="risk"]');
await page.selectOption("#risk-select", { index: 1 });
const envFactor = '#risk-body .factor:has(h3:text-is("Environment variables with no default and no value"))';
const evChips = () => page.$$eval(`${envFactor} .evidence .badge`, (els) => els.map((e) => e.textContent));
const evMore = () => page.textContent(`${envFactor} .evidence-more`).catch(() => null);
assert((await evChips()).length === 8 && (await evMore()) === "+3 more", "evidence: first 8 chips + '+3 more'");
await page.click(`${envFactor} .evidence-more`);
assert(JSON.stringify(await evChips()) === JSON.stringify(EMPTY_VARS) && (await evMore()) === "Show less", "evidence: '+3 more' expands inline to all 11");
assert(await page.$eval(`${envFactor} .evidence-more`, (b) => b === document.activeElement && b.getAttribute("aria-expanded") === "true"), "evidence: toggle keeps focus, aria-expanded");
await page.selectOption("#risk-baseline", { index: 1 });
await page.selectOption("#risk-baseline", { index: 0 });
assert((await evChips()).length === 11, "evidence: expanded state kept across re-render");
await page.click(`${envFactor} .evidence-more`);
assert((await evChips()).length === 8 && (await evMore()) === "+3 more", "evidence: 'Show less' folds back to 8");
const [dlr] = await Promise.all([page.waitForEvent("download"), page.click("#risk-export")]);
const riskK = JSON.parse(readFileSync(await dlr.path(), "utf8"));
assert(riskK.factors.find((f) => f.id === "env-vars")?.evidence.length === 11, "risk export keeps the full evidence list");

// ---- debug mode (standalone: no host, the log still records the switch and saves as a download) ----
await checkDebugLog(page, assert, {
  tool: "solution-xray",
  act: async () => {},
  readSaved: async (click) => {
    const [dl] = await Promise.all([page.waitForEvent("download"), click()]);
    assert(/^solution-xray-debug-\d{4}-\d\d-\d\dT[\d-]+\.txt$/.test(dl.suggestedFilename()), "solution-xray: debug log file name " + dl.suggestedFilename());
    return readFileSync(await dl.path(), "utf8");
  },
});

await finish();

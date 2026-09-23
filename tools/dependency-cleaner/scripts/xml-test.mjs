// Unit tests for src/deps/xml.ts (stripForm / stripView). DOMParser is browser-only, so xml.ts is bundled with
// esbuild (from vite's deps) to an IIFE and exercised inside headless Chromium via Playwright.
// Run from tools/dependency-cleaner: node scripts/xml-test.mjs
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

function loadEsbuild() {
  for (const base of [TOOL, resolve(TOOL, "../solution-xray")]) {
    if (!existsSync(resolve(base, "node_modules"))) continue;
    try {
      return createRequire(resolve(base, "package.json"))("esbuild");
    } catch {
      /* next */
    }
  }
  throw new Error("esbuild not found: run npm install in tools/dependency-cleaner (vite ships esbuild)");
}

const esbuild = loadEsbuild();
const bundle = esbuild.buildSync({
  entryPoints: [resolve(TOOL, "src/deps/xml.ts")],
  bundle: true,
  format: "iife",
  globalName: "XmlLib",
  target: "es2022",
  write: false,
}).outputFiles[0].text;

const { page, assert, finish } = await launchPage(import.meta.url);
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ content: bundle });

// ---------- fixtures ----------

const FORM = `<?xml version="1.0" encoding="utf-8"?>
<form showImage="true">
  <tabs>
    <tab name="general" id="{t1}" verticallayout="true">
      <labels><label description="General" languagecode="1033" /></labels>
      <columns>
        <column width="100%">
          <sections>
            <section name="summary" id="{s1}">
              <labels><label description="Summary" languagecode="1033" /></labels>
              <rows>
                <row>
                  <cell id="{c1}"><labels><label description="Account Name" languagecode="1033" /></labels><control id="name" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="name" /></cell>
                </row>
                <row>
                  <cell id="{c2}"><labels><label description="Work Order" languagecode="1033" /></labels><control id="msdyn_workorderid" classid="{270BD3DB-D9AF-4782-9025-509E298DEC0A}" datafieldname="msdyn_WorkOrderId" uniqueid="{u-wo}" /></cell>
                  <cell id="{c3}"><labels><label description="Phone" languagecode="1033" /></labels><control id="telephone1" classid="{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" datafieldname="telephone1" /></cell>
                </row>
                <row>
                  <cell id="{c4}"><control id="msdyn_billingaccount" classid="{270BD3DB-D9AF-4782-9025-509E298DEC0A}" datafieldname="msdyn_billingaccount" /></cell>
                </row>
              </rows>
            </section>
          </sections>
        </column>
      </columns>
    </tab>
    <tab name="fieldservice" id="{t2}">
      <labels><label description="Field Service" languagecode="1033" /></labels>
      <columns>
        <column width="100%">
          <sections>
            <section name="fs_section" id="{s2}">
              <labels><label description="Field Service" languagecode="1033" /></labels>
              <rows>
                <row>
                  <cell id="{c5}"><control id="msdyn_travelcharge" classid="{C3EFE0C3-0EC6-42be-8349-CBD9079DFD8E}" datafieldname="msdyn_travelcharge" /></cell>
                </row>
              </rows>
            </section>
            <section name="wo_grid" id="{s3}">
              <labels><label description="Work Orders" languagecode="1033" /></labels>
              <rows>
                <row>
                  <cell id="{c6}" rowspan="10"><control id="WorkOrders" classid="{E7A81278-8635-4d9e-8D4D-59480B391C5B}" indicationOfSubgrid="true"><parameters><TargetEntityType>msdyn_workorder</TargetEntityType><RelationshipName>msdyn_account_msdyn_workorder_ServiceAccount</RelationshipName><ViewId>{v1}</ViewId></parameters></control></cell>
                </row>
              </rows>
            </section>
          </sections>
        </column>
      </columns>
    </tab>
  </tabs>
  <header id="{h}">
    <rows>
      <row>
        <cell id="{hc1}"><control id="header_msdyn_workorderid" classid="{270BD3DB-D9AF-4782-9025-509E298DEC0A}" datafieldname="msdyn_workorderid" /></cell>
        <cell id="{hc2}"><control id="header_ownerid" classid="{270BD3DB-D9AF-4782-9025-509E298DEC0A}" datafieldname="ownerid" /></cell>
      </row>
    </rows>
  </header>
  <events>
    <event name="onchange" application="false" active="false" attribute="msdyn_workorderid">
      <Handlers><Handler functionName="onWorkOrderChange" libraryName="msdyn_/Account.js" handlerUniqueId="{hh}" enabled="true" /></Handlers>
    </event>
  </events>
  <formLibraries><Library name="msdyn_/Account.js" libraryUniqueId="{lib}" /><Library name="sss_/account.js" libraryUniqueId="{lib2}" /></formLibraries>
  <controlDescriptions>
    <controlDescription forControl="{u-wo}"><customControl formFactor="2" name="MscrmControls.FieldService.Lookup"><parameters><datafieldname>msdyn_workorderid</datafieldname></parameters></customControl></controlDescription>
    <controlDescription forControl="{u-other}"><customControl formFactor="2" name="Sss.Pcf.Rating"><parameters><value>telephone1</value></parameters></customControl></controlDescription>
  </controlDescriptions>
</form>`;

const FETCH = `<fetch version="1.0" output-format="xml-platform" mapping="logical" distinct="false">
  <entity name="account">
    <attribute name="name" />
    <attribute name="msdyn_workorderid" />
    <attribute name="telephone1" />
    <order attribute="msdyn_workorderid" descending="false" />
    <filter type="and">
      <condition attribute="statecode" operator="eq" value="0" />
      <filter type="or">
        <condition attribute="msdyn_billingaccount" operator="not-null" />
        <condition attribute="msdyn_travelcharge" operator="gt" value="0" />
      </filter>
    </filter>
    <link-entity name="msdyn_workorder" from="msdyn_workorderid" to="msdyn_workorderid" visible="false" link-type="outer" alias="a_wo">
      <attribute name="msdyn_name" />
      <filter type="and"><condition attribute="msdyn_systemstatus" operator="eq" value="690970000" /></filter>
    </link-entity>
    <link-entity name="contact" from="contactid" to="primarycontactid" visible="false" link-type="outer" alias="a_pc">
      <attribute name="emailaddress1" />
      <attribute name="msdyn_travelcharge" />
    </link-entity>
  </entity>
</fetch>`;

const LAYOUT = `<grid name="resultset" object="1" jump="name" select="1" icon="1" preview="1"><row name="result" id="accountid"><cell name="name" width="300" /><cell name="msdyn_workorderid" width="150" /><cell name="telephone1" width="100" /><cell name="a_wo.msdyn_name" width="150" /><cell name="a_pc.emailaddress1" width="150" /><cell name="a_pc.msdyn_travelcharge" width="100" /></row></grid>`;

// Run a function on the page with XmlLib + DOM available; returns JSON-able result.
const run = (fn, arg) => page.evaluate(`(${fn})(${JSON.stringify(arg)})`);

// ---------- form tests ----------

const form = await run(
  (a) => {
    const r = XmlLib.stripForm(a.xml, a.cols, a.prot, a.tables);
    const d = new DOMParser().parseFromString(r.xml, "application/xml");
    const q = (s) => d.querySelectorAll(s).length;
    return {
      r,
      parseOk: d.getElementsByTagName("parsererror").length === 0,
      fields: [...d.querySelectorAll("control[datafieldname]")].map((c) => c.getAttribute("datafieldname").toLowerCase()),
      subgrids: q("control[indicationOfSubgrid]"),
      tabs: q("tab"),
      sections: [...d.querySelectorAll("section")].map((s) => s.getAttribute("name")),
      summaryRows: d.querySelectorAll('section[name="summary"] row').length,
      headerCells: d.querySelectorAll("header cell").length,
      cds: [...d.querySelectorAll("controlDescription")].map((c) => c.getAttribute("forControl")),
      events: q("event"),
      libs: q("Library"),
      startsDecl: r.xml.startsWith('<?xml version="1.0" encoding="utf-8"?>'),
      c3: r.xml.includes('<cell id="{c3}"><labels><label description="Phone" languagecode="1033"/></labels>'),
    };
  },
  { xml: FORM, cols: ["msdyn_workorderid", "msdyn_billingaccount", "msdyn_travelcharge", "name"], prot: ["name"], tables: ["msdyn_workorder"] },
);
assert(form.parseOk, "form: output is well-formed XML");
assert(!form.fields.some((f) => f.startsWith("msdyn_")), "form: all msdyn_ field controls removed (body + header, case-insensitive)");
assert(form.fields.includes("name") && form.fields.includes("telephone1") && form.fields.includes("ownerid"), "form: unrelated + protected fields kept");
assert(form.r.kept.length === 1 && form.r.kept[0].name === "name" && /protected/.test(form.r.kept[0].reason), "form: protected primary name listed in kept with reason");
assert(form.subgrids === 0 && form.r.removed.some((x) => /subgrid WorkOrders \(msdyn_workorder\)/.test(x)), "form: subgrid targeting msdyn_workorder removed via tables param");
assert(["msdyn_workorderid", "msdyn_billingaccount", "msdyn_travelcharge"].every((c) => form.r.removed.includes(c)), "form: removed lists columns");
assert(form.summaryRows === 2, "form: row emptied by removal dropped, mixed row kept");
assert(form.headerCells === 1, "form: header cell removed, header row with remaining cell kept");
assert(form.tabs === 2, "form: tabs never dropped");
assert(form.sections.join(",") === "summary", "form: emptied sections dropped");
assert(form.r.warnings.some((w) => /Section "Field Service"/.test(w)) && form.r.warnings.some((w) => /Section "Work Orders"/.test(w)), "form: warns for each dropped section");
assert(form.r.warnings.some((w) => /Tab "Field Service" is now empty/.test(w)), "form: warns when tab becomes empty");
assert(form.cds.length === 1 && form.cds[0] === "{u-other}", "form: controlDescription of removed control dropped, other kept");
assert(form.events === 1 && form.libs === 2, "form: events and libraries not edited");
assert(form.r.warnings.some((w) => /Event "onchange" on removed column msdyn_workorderid/.test(w)), "form: warns about event handler on removed column");
assert(form.r.warnings.some((w) => /msdyn_\/Account\.js/.test(w)) && !form.r.warnings.some((w) => /sss_\/account\.js/.test(w)), "form: warns about msdyn_ library only");
assert(form.startsDecl, "form: XML declaration preserved");
assert(form.c3, "form: untouched content preserved");

const noDecl = await run((a) => XmlLib.stripForm(a.xml, ["msdyn_x"], [], []), { xml: FORM.replace(/^<\?xml[^>]*>\s*/, "") });
assert(noDecl.xml === FORM.replace(/^<\?xml[^>]*>\s*/, "") && noDecl.removed.length === 0, "form: no-op returns input unchanged, no declaration added");

const noDecl2 = await run((a) => XmlLib.stripForm(a.xml, ["telephone1"], [], []).xml, { xml: FORM.replace(/^<\?xml[^>]*>\s*/, "") });
assert(!noDecl2.startsWith("<?xml") && !noDecl2.includes('datafieldname="telephone1"'), "form: edit without declaration adds none");

const noTables = await run((a) => XmlLib.stripForm(a.xml, ["msdyn_workorderid"], [], []), { xml: FORM });
assert(noTables.xml.includes("indicationOfSubgrid") && !noTables.removed.some((x) => x.startsWith("subgrid")), "form: subgrid kept when tables param omitted");

const bad = await run((a) => {
  try {
    XmlLib.stripForm(a, ["x"], []);
    return "no throw";
  } catch (e) {
    return String(e.message);
  }
}, "<form><tabs>");
assert(/invalid XML/.test(bad), "form: invalid XML throws");

// ---------- view tests ----------

const view = await run(
  (a) => {
    const r = XmlLib.stripView(a.fetch, a.layout, a.cols, a.links);
    const f = new DOMParser().parseFromString(r.fetchxml, "application/xml");
    const l = new DOMParser().parseFromString(r.layoutxml, "application/xml");
    return {
      r,
      ok: !f.getElementsByTagName("parsererror").length && !l.getElementsByTagName("parsererror").length,
      attrs: [...f.querySelectorAll("attribute")].map((x) => x.getAttribute("name")),
      conds: [...f.querySelectorAll("condition")].map((x) => x.getAttribute("attribute")),
      filters: f.querySelectorAll("filter").length,
      orders: f.querySelectorAll("order").length,
      links: [...f.querySelectorAll("link-entity")].map((x) => x.getAttribute("name")),
      cells: [...l.querySelectorAll("cell")].map((x) => x.getAttribute("name")),
    };
  },
  { fetch: FETCH, layout: LAYOUT, cols: ["msdyn_workorderid", "msdyn_billingaccount", "msdyn_travelcharge"], links: ["msdyn_workorder"] },
);
assert(view.ok, "view: outputs well-formed");
assert(view.links.join(",") === "contact", "view: msdyn_workorder link-entity removed whole, contact kept");
assert(view.attrs.join(",") === "name,telephone1,emailaddress1", "view: msdyn attributes removed (root + kept link-entity)");
assert(view.conds.join(",") === "statecode", "view: msdyn conditions removed, other kept");
assert(view.filters === 1, "view: emptied nested filter dropped, outer kept");
assert(view.orders === 0, "view: order on msdyn column removed");
assert(view.cells.join(",") === "name,telephone1,a_pc.emailaddress1", "view: layout cells removed (plain, removed alias, kept alias + msdyn col)");
assert(view.r.warnings.some((w) => /condition\(s\) removed/.test(w)), "view: warns when conditions removed");
assert(view.r.warnings.some((w) => /only sort order/.test(w)), "view: warns when only order removed");
assert(view.r.removed.includes("link-entity msdyn_workorder (a_wo)") && view.r.removed.includes("cell a_wo.msdyn_name"), "view: removed lists link-entity and cells");

const view2 = await run((a) => XmlLib.stripView(a.fetch, a.layout, [], ["msdyn_workorder"]), { fetch: FETCH, layout: LAYOUT });
assert(
  view2.fetchxml.includes('attribute="msdyn_workorderid"') && !view2.fetchxml.includes("a_wo") && !view2.layoutxml.includes("a_wo.") && view2.layoutxml.includes('name="msdyn_workorderid"'),
  "view: link-entity only removal leaves root columns",
);
assert(!view2.warnings.some((w) => /sort order/.test(w)), "view: no order warning when order untouched");
assert(!view2.warnings.some((w) => /condition/.test(w)), "view: no condition warning when only link-entity (with its own filter) removed");

const view3 = await run((a) => XmlLib.stripView(a.fetch, a.layout, ["msdyn_workorderid"], []), { fetch: FETCH, layout: LAYOUT });
assert(view3.warnings.some((w) => /joins from="msdyn_workorderid"/.test(w)), "view: warns when kept link-entity joins on removed column");

const noop = await run((a) => XmlLib.stripView(a.fetch, a.layout, ["nothing"], []), { fetch: FETCH, layout: LAYOUT });
assert(noop.fetchxml === FETCH && noop.layoutxml === LAYOUT && noop.removed.length === 0, "view: no-op returns inputs byte-identical");

const empty = await run(() => XmlLib.stripView("", "", ["x"], []));
assert(empty.fetchxml === "" && empty.layoutxml === "", "view: empty inputs tolerated");

await finish();

// README screenshots of the real dist build against the mocked PPTB host shared with the e2e
// (scripts/mock-host.mjs: fictional SSS Dev org, Ana Silva, Bruno Corp...). Writes docs/img/{check,columns-dark}.png.
// docs/img/columns.png is a real capture inside Power Platform ToolBox: this script never touches it.
// Run: npm run build && npm run screenshots   (needs playwright + chromium available, see ../../_shared/e2e-loader.mjs)
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";
import { mockHost } from "./mock-host.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = resolve(TOOL, "docs/img");
mkdirSync(OUT, { recursive: true });
if (!existsSync(resolve(TOOL, "dist/index.html"))) {
  console.error("dist/index.html missing: run npm run build first");
  process.exit(1);
}

// A few more secured columns on account than the e2e fixture, so the Column security table has some rows.
const MOCK = mockHost({
  securedColumns: [
    ["sss_creditlimit", "Credit Limit"],
    ["sss_taxid", "Tax ID"],
    ["sss_discountcap", "Discount Cap"],
  ],
  fieldPermissions: [
    { attributelogicalname: "sss_creditlimit", canread: 4, canupdate: 4, cancreate: 4 },
    { attributelogicalname: "sss_discountcap", canread: 4, canupdate: 0, cancreate: 4 },
  ],
});

const { page, assert, finish } = await launchPage(import.meta.url, { width: 1400, height: 900, initScript: MOCK });
await page.goto("file://" + TOOL + "/dist/index.html");
await page.waitForFunction(() => document.querySelectorAll("#table option").length > 1);

const settle = async () => {
  await page.waitForFunction(() => !/Checking…|Loading/.test(document.body.innerText));
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
};
const shot = async (name) => {
  await settle();
  await page.screenshot({ path: resolve(OUT, name), fullPage: false });
  console.log("wrote docs/img/" + name);
};

// Ana Silva on Bruno Corp (Account): record check.
await page.fill("#user-q", "ana");
await page.waitForSelector("#user-results li button");
await page.click("#user-results li button");
await page.selectOption("#table", "account");
await page.fill("#record-q", "bruno");
await page.waitForSelector("#record-results li button");
await page.click("#record-results li button");
await page.click("#btn-check");
await page.waitForFunction(() => document.querySelector("#tab-check h2")?.textContent.includes("Bruno Corp"));
await page.waitForSelector("#card-roles table.roles");
await page.waitForFunction(() => document.querySelector("#tab-columns table.columns"));

// 1. check.png: record check with the denied Write row open (the default for a denied right) and the Roles
// card with "Hide roles with no privilege" and its "4 of 5 roles" count. At 1400x900 not everything fits: the shot
// starts at the top, so the verdict chips and the Why list (the point of the screen) show and Roles follows below.
const chip = async (r) => (await page.textContent(`#verdicts .verdict[data-right="${r}"]`)).replace(/\s+/g, " ").trim();
assert((await chip("Read")).includes("granted") && (await chip("Write")).includes("denied"), "check: verdict chips");
assert(await page.$eval("#why-Write", (d) => d.open), "check: denied Write row open by default");
// Only Write stays open (Create, Delete and Assign are denied too and open by default) so the Roles table fits.
await page.evaluate(() => document.querySelectorAll("#why details").forEach((d) => (d.open = d.id === "why-Write")));
assert(await page.$eval("#card-roles", (d) => d.open) && (await page.$eval("#hide-irrelevant-roles", (b) => b.checked)), "check: Roles card open, 'Hide roles with no privilege' on");
assert((await page.textContent("#roles-count")) === "4 of 5 roles", "check: roles count caption");
await page.evaluate(() => (document.querySelector(".main").scrollTop = 0));
await shot("check.png");

// 2. columns-dark.png: Column security tab, dark theme applied the way ToolBox does it (settings:updated).
await page.click(".tab[data-tab='columns']");
await page.waitForFunction(() => document.querySelectorAll("#tab-columns table.columns tbody tr").length === 4);
await page.evaluate(() => window.__emit({ event: "settings:updated", data: { theme: "dark" } }));
assert((await page.getAttribute("html", "data-theme")) === "dark", "columns-dark: dark theme applied");
await shot("columns-dark.png");

await finish();

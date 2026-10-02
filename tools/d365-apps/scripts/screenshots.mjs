// README screenshots of the real dist build against the e2e's mocked host (scripts/mock-host.mjs) plus a UAT environment,
// fictional SSS data. Writes docs/img/{matrix,matrix-dark,preview,run}.png.
// Run: npm run build && npm run screenshots   (needs playwright + chromium available, see ../../_shared/e2e-loader.mjs)
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";
import { MOCK } from "./mock-host.mjs";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const OUT = resolve(TOOL, "docs/img");
mkdirSync(OUT, { recursive: true });
if (!existsSync(resolve(TOOL, "dist/index.html"))) {
  console.error("dist/index.html missing: run npm run build first");
  process.exit(1);
}

// a third environment (UAT: two updates, one current) and the Dev / UAT / Prod columns preselected
const EXTRA = `
(() => {
  const M = window.__mock;
  const P = (uniqueName, version, state) => ({ uniqueName, localizedName: uniqueName.replace(/^msdyn_/, '').toUpperCase(), version, state, publisherName: 'Microsoft' });
  M.envs.splice(1, 0, { id: 'env-uat', displayName: 'SSS UAT', type: 'Sandbox', state: 'Ready', dataverseId: 'org-uat', url: 'https://sss-uat.crm4.dynamics.com', geo: 'europe' });
  M.installed['env-uat'] = [P('msdyn_sales', '1.0.0.0', 'Installed'), P('msdyn_portal', '5.0.0.0', 'Installed'), P('msdyn_teamsapp', '3.0.0.0', 'Installed')];
  M.available['env-uat'] = [P('msdyn_sales', '1.2.0.0', 'None'), P('msdyn_teamsapp', '3.1.0.0', 'None')];
  try { localStorage.setItem('sss-d365-apps:envs', JSON.stringify(['env-dev', 'env-uat', 'env-prod'])); } catch {}
})();
`;

const { page, assert, finish } = await launchPage(import.meta.url, { initScript: MOCK });
await page.addInitScript(EXTRA);
await page.goto("file://" + TOOL + "/dist/index.html?pollMs=30");
await page.waitForFunction(() => document.querySelectorAll("#grid th.col").length === 3);
const cell = (env, app) => `td[data-cell="${env}|${app}"]`;
const theme = (t) =>
  page.evaluate((t) => {
    window.__mock.listeners.forEach((cb) => cb({}, { event: "settings:updated", data: { theme: t } }));
  }, t);
const shot = async (name) => {
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: resolve(OUT, name) });
  console.log("wrote docs/img/" + name);
};

// 1. matrix, light: updates, a failed install, one in progress; a selection of update + retry + install
await page.check("#show-available");
await page.waitForSelector(cell("env-prod", "msdyn_extra"));
await page.click("#btn-select-updates");
await page.click("#btn-select-failed");
await page.check(`${cell("env-prod", "msdyn_extra")} input`);
assert((await page.textContent("#summary")).includes("failed"), "summary badges: updates / failed / in progress");
await shot("matrix.png");

// 2. same, dark (the host's settings:updated event)
await theme("dark");
await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark");
await shot("matrix-dark.png");
await theme("light");
await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "light");

// 3. install preview: one fold per environment, Production open, danger confirm
await page.click("#btn-preview");
await page.waitForSelector("#plan details.plan-env");
assert(await page.$eval('#plan details[data-env="env-prod"]', (d) => d.open), "preview: Production fold open");
await shot("preview.png");

// 4. run: installs polled to the end (fast poll), results per install, environments read again
await page.click("#dlg-ok");
await page.waitForSelector("#run-table");
await page.waitForFunction(() => /Last run/.test(document.querySelector("#run-title")?.textContent ?? ""), null, { timeout: 20000 });
await page.waitForFunction(() => !/→/.test(document.querySelector('td[data-cell="env-uat|msdyn_sales"]')?.textContent ?? "→"));
await page.waitForTimeout(300);
assert((await page.$$eval("#run-table tbody tr", (els) => els.length)) >= 4, "run: results listed");
await shot("run.png");

await finish();

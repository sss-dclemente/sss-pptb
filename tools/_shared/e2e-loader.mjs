// Shared Playwright bootstrap for tool e2e scripts. Playwright is not a dependency of the tools:
// resolve it from local node_modules, a global install, or PLAYWRIGHT_PATH; CHROMIUM_PATH overrides the binary.
import { createRequire } from "node:module";

export function loadPlaywright(fromFile) {
  const require = createRequire(fromFile);
  for (const c of [process.env.PLAYWRIGHT_PATH, "playwright", "/opt/node22/lib/node_modules/playwright", "/usr/lib/node_modules/playwright", "/usr/local/lib/node_modules/playwright"].filter(Boolean)) {
    try {
      return require(c);
    } catch {
      /* next */
    }
  }
  throw new Error("playwright not found: npm i -g playwright, or set PLAYWRIGHT_PATH");
}

export async function launchPage(fromFile, { width = 1400, height = 900, initScript } = {}) {
  const { chromium } = loadPlaywright(fromFile);
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
  if (initScript) await page.addInitScript(initScript);
  let failed = 0;
  const assert = (c, msg) => {
    if (!c) {
      failed++;
      console.error("FAIL:", msg);
    } else console.log("ok:", msg);
  };
  const finish = async () => {
    assert(errors.length === 0, "no page/console errors" + (errors.length ? ": " + errors.join(" | ") : ""));
    await browser.close();
    if (failed) process.exit(1);
  };
  return { browser, page, errors, assert, finish };
}

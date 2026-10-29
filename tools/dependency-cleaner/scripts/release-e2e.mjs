// E2E for the release build (`npm run build`, what npm ships): the apply and undo of Upgrade blockers, Failed import
// and Cycles are left out until verified on a live environment (src/confirm-write.ts). Standalone page, no host mock.
// Run: npm run build && node scripts/release-e2e.mjs
import { resolve } from "node:path";
import { launchPage } from "../../_shared/e2e-loader.mjs";

const TOOL = resolve(new URL("..", import.meta.url).pathname);
const { page, assert, finish } = await launchPage(import.meta.url);
await page.goto("file://" + TOOL + "/dist/index.html");

for (const [p, undo] of [["ub"], ["fi", "#fi-undo"], ["cy", "#cy-undo"]]) {
  const bar = `#${p}-fix-actions`;
  const r = await page.$eval(bar, (el, p) => {
    el.hidden = false; // as when a plan is shown
    const shown = (s) => !!document.querySelector(s) && getComputedStyle(document.querySelector(s)).display !== "none";
    return { off: el.classList.contains("writes-off"), note: shown(`#${p}-fix-actions .unverified-note`), confirm: shown(`#${p}-confirm`), backup: shown(`#${p}-backup`) };
  }, p);
  assert(r.off && r.note && !r.confirm && !r.backup, `${p}: apply bar shows only the note: ${JSON.stringify(r)}`);
  if (undo) assert(await page.$eval(undo, (b) => b.hidden), `${p}: undo hidden`);
}
assert(!(await page.$("#tab-slim .unverified-note")), "Slim (verified) keeps its apply");

await finish();

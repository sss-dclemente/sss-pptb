// Shared e2e check for debug mode (_shared/debug.ts, debug-ui.ts): switch on, run `act`, save the log, check it.
// `readSaved(click)` performs the click on Save log and returns the saved text (mock saveFile or a browser download).
export async function checkDebugLog(page, assert, { tool, act, readSaved, expect = [] }) {
  assert(!(await page.$eval("#debug-toggle", (e) => e.checked)), `${tool}: debug mode off by default`);
  assert(await page.$eval("#debug-save", (e) => e.hidden), `${tool}: Save log hidden while the log is empty`);
  await page.check("#debug-toggle");
  await act();
  await page.waitForFunction(() => {
    const b = document.querySelector("#debug-save");
    return b && !b.hidden && /Save log \(\d+\)/.test(b.textContent ?? "");
  });
  await page.waitForTimeout(200);
  const text = await readSaved(() => page.click("#debug-save"));
  assert(new RegExp(`^SSS ${tool} (\\d+\\.\\d+\\.\\d+|dev) debug log`).test(text), `${tool}: log header names the tool and version: ${text.split("\n")[0]}`);
  assert(/\[debug\] debug on/.test(text), `${tool}: log records the switch`);
  for (const [re, msg] of expect) assert(re.test(text), `${tool}: log ${msg}`);
  assert(!/fileSystem\.saveFile/.test(text), `${tool}: saving the log does not log its own content`);
  await page.uncheck("#debug-toggle");
  await page.click("#debug-clear");
  await page.waitForFunction(() => document.querySelector("#debug-save").hidden);
  assert(true, `${tool}: Clear empties the log`);
  return text;
}

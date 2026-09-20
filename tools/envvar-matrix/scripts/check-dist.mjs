// Post-build guard: what the PPTB default CSP would reject.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const dist = new URL("../dist/", import.meta.url).pathname;
const fail = (m) => { console.error("check-dist: " + m); process.exit(1); };

if (!existsSync(join(dist, "index.html"))) fail("dist/index.html missing");
if (!existsSync(join(dist, "icon.svg"))) fail("dist/icon.svg missing");
const html = readFileSync(join(dist, "index.html"), "utf8");
if (/type="module"/.test(html)) fail("index.html still has type=module");
if (/https?:\/\//.test(html.replace(/<a [^>]*href="https:\/\/simplesmoothsafe\.com"[^>]*>/g, ""))) fail("index.html references a remote URL");
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
if (scripts.length !== 1) fail(`expected 1 script tag, got ${scripts.length}`);
if (!scripts[0].startsWith("./assets/")) fail("script src must be relative ./assets/");

const assets = readdirSync(join(dist, "assets"));
for (const f of assets) {
  const src = readFileSync(join(dist, "assets", f), "utf8");
  if (f.endsWith(".js")) {
    if (/\beval\(/.test(src)) fail(`${f} contains eval(`);
    // setimmediate polyfill (JSZip dep) has `new Function(""+A)` on a branch only hit
    // when a non-function is passed; JSZip never does. Anything else is a CSP risk.
    if (/new Function\(/.test(src.replace(/new Function\(""\+/g, ""))) fail(`${f} contains new Function(`);
    if (/https?:\/\/(cdn|fonts|unpkg|jsdelivr)/.test(src)) fail(`${f} references a CDN`);
  }
  if (f.endsWith(".css") && /@import\s+url\(\s*["']?https?:/.test(src)) fail(`${f} imports remote CSS`);
}
console.log(`check-dist: ok (${assets.join(", ")})`);

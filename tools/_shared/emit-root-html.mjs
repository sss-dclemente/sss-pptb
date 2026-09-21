// Shared post-build step: emit a package-root index.html next to package.json.
//
// The manifest sets `main: "index.html"`. Load Local Tool serves the tool from
// dist/, so dist/index.html answers it there. Installing the published package
// from npm leaves the tarball layout untouched (package.json at the root, the
// build under dist/), and the tool then fails to launch. Every published PPTB
// tool that does launch from npm ships an index.html at the package root, so
// emit one here too.
//
// Those tools ship their Vite source template, which npm force-includes because
// it is the `main` file; it references /src/*.tsx and renders nothing once
// published. Emit a working page instead: the built HTML with its asset paths
// rewritten from ./assets/ to ./dist/assets/, so the tool runs whether the host
// serves the package root or dist/.
//
// Usage: import { emitRootHtml } from "../../_shared/emit-root-html.mjs";
//        emitRootHtml(new URL("../", import.meta.url).pathname);
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function emitRootHtml(pkgRoot) {
  const fail = (m) => {
    console.error("emit-root-html: " + m);
    process.exit(1);
  };
  const src = join(pkgRoot, "dist", "index.html");
  if (!existsSync(src)) fail("dist/index.html missing — run the build first");

  const html = readFileSync(src, "utf8");
  const out = html.replace(/(src|href)="\.\/assets\//g, '$1="./dist/assets/');

  const rewritten = (out.match(/"\.\/dist\/assets\//g) || []).length;
  const original = (html.match(/"\.\/assets\//g) || []).length;
  if (!original) fail("dist/index.html has no ./assets/ references to rewrite");
  if (rewritten !== original) fail(`rewrote ${rewritten} of ${original} asset references`);
  if (/"\.\/assets\//.test(out)) fail("a ./assets/ reference survived the rewrite");

  writeFileSync(join(pkgRoot, "index.html"), out);
  console.log(`emit-root-html: ok (${rewritten} asset ref${rewritten === 1 ? "" : "s"} repointed to ./dist/assets/)`);
}

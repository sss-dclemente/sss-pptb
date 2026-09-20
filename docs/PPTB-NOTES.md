# PPTB — research notes for the XRay port

Date: 2026-09-20. Facts only. Every fact has a source. Anything not verified from source is marked **UNVERIFIED**.

Sources pinned:

| Source | Commit / version | Link |
|---|---|---|
| sample-tools | `79b0a0e` (2026-09-10) | https://github.com/PowerPlatformToolBox/sample-tools |
| pptb-docs-web | `3abb573` (2026-09-13) | https://github.com/PowerPlatformToolBox/pptb-docs-web |
| generator-pptb | `dc428b5` = v1.0.6 (2026-05-21) | https://github.com/PowerPlatformToolBox/generator-pptb |
| tool-management | `4928413` (2026-09-06) | https://github.com/PowerPlatformToolBox/tool-management |
| `@pptb/types` | 1.2.5 latest, 1.2.6-beta.2 beta | https://www.npmjs.com/package/@pptb/types |
| `@pptb/validate` | 1.0.2 latest | https://www.npmjs.com/package/@pptb/validate |

Shorthand: `docs/` = `pptb-docs-web/blob/main/src/app/`, `sample/` = `sample-tools/blob/main/new/`, `gen/` = `generator-pptb/blob/dc428b56dccd3e5802ea9e51b4cb37dcd4d9786e/generators/app/templates/`, `tm/` = `tool-management/blob/main/`.

---

## 1. Manifest = `package.json` (no `pptb` section)

PPTB keys live top-level in `package.json`. No `pptb`/`toolbox` sub-object anywhere. [sample/html-sample/package.json](https://github.com/PowerPlatformToolBox/sample-tools/blob/main/new/html-sample/package.json), [docs/tool-development/manifest/page.mdx](https://github.com/PowerPlatformToolBox/pptb-docs-web/blob/main/src/app/tool-development/manifest/page.mdx)

Required (docs manifest page + validator 1.0.2):

| Field | Rule | Source |
|---|---|---|
| `name` | non-empty string; scoped recommended (`@org/tool`), not mandated | docs manifest L24-56; validate.js |
| `version` | non-empty string. No semver check at intake. ≥1.0.0 only for Verified badge | validate.js; docs maturity-model L74 |
| `displayName` | non-empty | validate.js |
| `description` | non-empty | validate.js |
| `main` | `"index.html"` relative to `dist/` root (docs). Validator does NOT check it | docs manifest; validate.js |
| `icon` | relative POSIX path to `.svg` under `dist/`, no `..`, no URL, no backslash. Absent = warning only. Use `fill="currentColor"` for theme | validate.js; docs manifest L38 |
| `license` | exact match in `MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, GPL-2.0, GPL-3.0, LGPL-3.0, ISC, AGPL-3.0-only` | validate.js `APPROVED_LICENSES` |
| `contributors` | non-empty array, each `{name, url?}` | validate.js |
| `configurations.repository` | valid URL, HEAD reachable (validator always does network check) | validate.js |
| `configurations.readmeUrl` | valid URL, reachable, host must NOT be `github.com` — use `raw.githubusercontent.com` | validate.js |
| `configurations.website` | optional; missing = warning | validate.js |
| `configurations.iconUrl` | forbidden (error) | validate.js |

Conflict: docs manifest page says `readmeUrl` optional; validator errors without it. **Trust validator** (it is "single source of truth for CLI and web intake" per validate.js header comment).

Optional:

```json
"features": {
  "multiConnection": "none",          // REQUIRED whenever features object present: none|optional|required
  "connectionRequirement": "optional", // required|optional, default required
  "minAPI": "1.2.0",                   // semver
  "enabledForPowerPlatformAPI": false
},
"cspExceptions": { "connect-src": [{ "domain": "…", "exceptionReason": "…", "optional": false }] }
```
[docs/tool-development/manifest/page.mdx L77-148](https://github.com/PowerPlatformToolBox/pptb-docs-web/blob/main/src/app/tool-development/manifest/page.mdx)

Connectionless tool (our case): `features: { multiConnection: "none", connectionRequirement: "optional" }`. `getActiveConnection()` returns `null` when none. [docs manifest L96-108]

No `keywords` requirement (no `pptb-tool` keyword anywhere in docs, samples, or tool-management). Samples use `["powerplatform","dataverse","toolbox","pptb"]`. [sample/html-sample/package.json; tm grep]

`files`: samples use `["dist", "npm-shrinkwrap.json"]` (+ `pptb.config.json` if present). `finalize-package` script = `npm shrinkwrap`. [gen/html/package.json; sample/html-sample/package.json]

`pptb.config.json` (separate, optional): inter-tool invocation + MCP agents. Not needed for v1. [docs/tool-development/inter-tool-invocation/page.mdx]

Reference manifest (sample, GPL-3.0 — ours will differ): [sample/html-sample/package.json](https://github.com/PowerPlatformToolBox/sample-tools/blob/main/new/html-sample/package.json).

---

## 2. Build + dist layout

Generator HTML template (`yo pptb`, type `html`): `tsc && vite build`, Vite IIFE single bundle. [gen/html/vite.config.ts](https://github.com/PowerPlatformToolBox/generator-pptb/blob/dc428b56dccd3e5802ea9e51b4cb37dcd4d9786e/generators/app/templates/html/vite.config.ts)

```ts
export default defineConfig((configEnv) => ({
  base: "./src", root: "./src",
  build: {
    outDir: "../dist", assetsDir: "assets", cssCodeSplit: false,
    sourcemap: configEnv.mode === "development",
    rollupOptions: { output: { format: "iife", inlineDynamicImports: true, manualChunks: undefined } },
  },
}));
```

React sample adds `fixHtmlForPPTB` plugin: strips `type="module"` + `crossorigin`, moves `<script>` to end of `<body>`. Reason stated: PPTB loads tools in iframe via `file://` URLs; ES modules fail there. HTML generator template LACKS this plugin (its index.html references `app.js` while source is `app.ts` — build **UNVERIFIED**). [sample/react-sample/vite.config.ts](https://github.com/PowerPlatformToolBox/sample-tools/blob/main/new/react-sample/vite.config.ts); [sample-tools README "Build Configuration for PPTB Compatibility"]

Generator html template `base: "./src"` looks wrong vs React `base: './'` — **UNVERIFIED** which produces correct relative asset URLs; plan uses `base: './'` + `fixHtmlForPPTB` (sample code over generator template).

tsconfig (generator html): ES2022, `module: ESNext`, `moduleResolution: bundler`, `types: ["@pptb/types"]`, `noEmit: true`, strict. [gen/html/tsconfig.json]

Published tarball at intake = `package.json` + `dist/` ONLY (README, LICENSE, src stripped). Icon must exist at `dist/<icon>`. [tm/.github/workflows/convert-tool.yml L145-187](https://github.com/PowerPlatformToolBox/tool-management/blob/main/.github/workflows/convert-tool.yml)

Fresh `yo pptb` scaffold FAILS `pptb-validate` (missing `contributors`, `configurations`); nothing emits icon or `pptb.config.json`. Verified by running it. [generator notes B.9]

Generator interactive prompt rejects scoped ids (`/[^a-z0-9\-]/`); `--toolId @scope/name` bypasses. Simpler: hand-write package.json. [gen/../prompts.js]

---

## 3. Runtime API access

Host-injected globals: `window.toolboxAPI`, `window.dataverseAPI`, `window.powerplatformAPI`, `window.TOOLBOX_CONTEXT`. `@pptb/types` = devDependency, ambient namespaces `ToolBoxAPI.*`, `DataverseAPI.*`; no runtime import. [sample/html-sample/src/app.ts; @pptb/types@1.2.5 toolboxAPI.d.ts]

```ts
/// <reference types="@pptb/types" />
const toolbox = window.toolboxAPI;
const conn = await toolbox.connections.getActiveConnection(); // Connection | null
```

Injection path: iframe ← `toolboxAPIBridge.js` ← postMessage ← renderer ← IPC ← main. No tokens exposed to tools. [docs/toolbox-development/desktop/architecture/page.mdx L404-450]

Outside PPTB (plain browser / `vite dev`) globals are undefined → tool must guard (`window.toolboxAPI?.…`). [sample-tools README "Development Mode"]

### toolboxAPI surface used by XRay v1

| Call | Signature | Min version | Source |
|---|---|---|---|
| `utils.getCurrentTheme()` | `Promise<"light"\|"dark">` | 1.0.17 | toolboxAPI.d.ts L5238 |
| `utils.showNotification(o)` | `{title, body, type: info\|success\|warning\|error, duration}` | 1.0.17 | docs toolbox-api |
| `fileSystem.selectPath(o)` | `{type:"file"\|"folder", title?, filters?: {name, extensions[]}[]}` → `Promise<string\|null>` absolute path | 1.0.20 | toolboxAPI.d.ts L5095 |
| `fileSystem.readBinary(path)` | `Promise<Buffer>` (Node Buffer serialized over IPC; `.buffer` for ArrayBuffer) | 1.0.20 | toolboxAPI.d.ts L5288 |
| `fileSystem.saveFile(name, content, filters?)` | `Promise<string\|null>` native save dialog | 1.0.20 | docs filesystem-api |
| `events.on(handler)` | `(event, payload: {event, data, timestamp}) => void`; no `off()` | 1.0.17 | docs events |
| `connections.getActiveConnection()` | `Promise<Connection\|null>` | 1.2.0 | docs toolbox-api |

`readBinary` docs example literally reads a solution zip: `await toolboxAPI.fileSystem.readBinary('/path/to/solution.zip')`. [dataverseAPI.d.ts L6485; docs dataverse-api L1590]

### Theme

- Pull: `utils.getCurrentTheme()`. Samples apply `document.body.setAttribute("data-theme", theme)`. [sample/html-sample/src/app.ts L933-940]
- Push: `settings:updated` event, `payload.data.theme`. No dedicated `theme:changed` event. [docs/tool-development/api-reference/events/page.mdx L29-37]
- No CSS variables/tokens injected into tool iframe documented. **UNVERIFIED** whether any `--pptb-*`/Fluent tokens reach the tool. Tool owns its palette.
- Verified badge requires light+dark support. [docs maturity-model L67-69]
- Sample CSS does NOT react to theme (hardcoded gradient). Samples are stated "outdated by the maintainers". [docs ai-agent-skills L109]

### File input

- Documented path: `fileSystem.selectPath({type:"file", filters})` → `readBinary(path)`.
- `<input type="file">` / browser File API: **not mentioned anywhere** in docs, samples, or types. Whether it works in the sandboxed `file://` iframe is **UNVERIFIED**. Drag-and-drop likewise UNVERIFIED.
- fileSystem API has no `HostSupport: desktop` badge; VS Code host behavior of native dialogs **UNVERIFIED**.

### dataverseAPI (for v1.1 backlog only)

- `getSolutions(selectColumns[], connectionTarget?)` → `{value[]}` (1.0.17).
- `execute({operationName:"ExportSolution", operationType:"action", parameters:{SolutionName, Managed}})` → `Record<string, unknown>` (1.0.17). ExportSolution specifically not shown in docs; generic `execute` is. **UNVERIFIED** response shape (`ExportSolutionFile` base64 per Dataverse Web API).
- `deploySolution(content, opts?)` → `{ImportJobId}`; `getImportJobStatus(id)` (1.0.17).
[docs/tool-development/api-reference/dataverse-api/page.mdx L782, L1512-1600]

---

## 4. CSP

Default policy applied to every tool (verbatim): [docs/tool-development/csp-configuration/page.mdx L268-278](https://github.com/PowerPlatformToolBox/pptb-docs-web/blob/main/src/app/tool-development/csp-configuration/page.mdx)

```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https:;
font-src 'self' data:;
connect-src 'self';
```

Consequences for XRay:

| Item | Verdict |
|---|---|
| JSZip from CDN (`cdnjs`) | BLOCKED → bundle |
| Inline `<script>` / `<style>` / `style=""` | allowed (`unsafe-inline`) |
| `eval` / `new Function` | blocked (no `unsafe-eval`, not an allowed exception directive) |
| Google Fonts | blocked (`font-src`, `style-src`) → system fonts or bundle |
| Remote images over HTTPS | allowed |
| `fetch` to anything external | blocked |
| `data:` URIs for download links | allowed (`img-src`/`font-src` only list `data:`; download via `<a href=data:>` **UNVERIFIED** — prefer `fileSystem.saveFile`) |
| Blob URLs (`URL.createObjectURL`) | **UNVERIFIED** (not in policy text; `'self'` doesn't cover `blob:`) |

Exceptions: declare in `cspExceptions`, user consents at launch; declining = tool won't load; new exception → re-consent + immediate loss of Verified badge; "unnecessary CSP exceptions flagged during review". Goal for XRay: **zero exceptions**. [docs csp-configuration L49-140; maturity-model L100]

Enforcement in `WebviewProtocolManager` when serving tool HTML. Same for locally loaded dev tools. [docs csp L386]

---

## 5. Dev loop

1. `npm run build` → `dist/`.
2. PPTB Settings → **Show Debug Menu** → Debug → **Load Local Tool** → select project ROOT (folder with `package.json`; files served from `dist/`).
3. No hot reload: rebuild, close tab, Load Tool again. `npm run dev-watch` = `vite build --mode development --watch`.
4. DevTools: Help → Toggle Tool DevTools.
5. No dev-server-URL mode. VS Code host has no local loader (published builds only).
6. pnpm required on machine for "Install from npm" debug path; one docs page also says for local load. [docs/tool-development/debugging/desktop/page.mdx; docs/tool-installation/page.mdx L88-128]

---

## 6. Validate

`pptb-validate` CLI. Two copies exist:

- `@pptb/types@1.2.5` depends on `@pptb/validate ^0.0.2` → its bin runs OLD 0.0.2 rules (no `connectionRequirement`). Verified by running.
- `@pptb/validate@1.0.2` direct devDependency → current rules.

**Action**: add `@pptb/validate` as explicit devDependency, script `"validate": "pptb-validate"`. Confirm `npx pptb-validate --version` prints 1.0.2.

CLI 1.0.2 behaviour: reads `<cwd>/package.json` only; ignores ALL args (`--json`, `--skip-url-checks`, path — documented in README but not implemented); always does HEAD requests to `repository`, `readmeUrl`, `website`. Exit 1 on errors. Does NOT inspect `dist/`, HTML, JS, CSP content. [@pptb/validate@1.0.2 dist/cli.js, dist/validate.js]

Consequence: `readmeUrl` must be live on `raw.githubusercontent.com` (main branch) before validate passes → README must be pushed first.

---

## 7. Publish + intake

Steps (docs publishing page, verbatim order): build → `pptb-validate` → `npm run finalize-package` (`npm shrinkwrap`) → `npm publish --access public` → test via Debug → Install from npm → submit at https://www.powerplatformtoolbox.com/submit-tool (login; npm name + up to 3 categories from: Comparisons, Data, Development, Diagrams, Documentation, Environments, Migration, Solutions, Troubleshooting, Users & Security) → automated checks → manual review **48-72h** → listed; registry auto-syncs new npm versions daily (00:00 UTC string-compare of `latest`). [docs/tool-development/publishing/page.mdx; tm/.github/workflows/check-updates.yml]

Intake backend (`tm/convert-tool.yml`): `npm pack <name>` (always `latest`, `version` input ignored), `npm install --production --ignore-scripts`, `npm run build --if-present` (failure tolerated), strip `.map`/`.ts`, archive `package.json` + `dist/`, sha256, upload Azure Blob, patch `registry.json`, upsert Supabase. No CSP scan, no license gate, no audit at intake. Who dispatches it (web form) **UNVERIFIED**. [tm/.github/workflows/convert-tool.yml](https://github.com/PowerPlatformToolBox/tool-management/blob/main/.github/workflows/convert-tool.yml)

Scoped packages OK: id = strip `@`, `/`→`-` (`@simplesmoothsafe/pptb-solution-xray` → `simplesmoothsafe-pptb-solution-xray`). [tm convert-tool.yml L124]

README: markdown only, no HTML; full URLs for images. Stored as URL only. [docs publishing L44-46]

Verified badge (separate, 1-2 weeks, My Tools → Get Verified): README with screenshot/GIF + install/run; every CSP exception justified; no high/critical `npm audit`; no deprecated APIs; light+dark; SVG icon under dist; version ≥1.0.0; bug-health (<5 open, reply ≤10 days); 2 of 3 usage metrics (MAU ≥10, downloads ≥50, ≥1 review ≥3) — waivable. Nightly governance revokes on new CVE / new CSP exception / bug-health breach. [docs/tool-development/maturity-model/page.mdx; tm/buildScripts/maturityGovernance.js]

---

## 8. License

- Validator allow-list: `MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, GPL-2.0, GPL-3.0, LGPL-3.0, ISC, AGPL-3.0-only`.
- tool-management stores license verbatim, no gate. PPTB repos + `@pptb/types` + samples are GPL-3.0; generator template package.json says MIT (its LICENSE file is GPL-3.0 — inconsistency).
- `@pptb/types` is devDependency only (types, no runtime code shipped) → GPL does not propagate to our bundle. JSZip = MIT/GPL dual.
- Decision pending (user): MIT recommended (max reach, matches JSZip, no copyleft).

---

## 9. Docs vs sample conflicts (sample wins per rules)

| Topic | Docs | Sample / code | Used |
|---|---|---|---|
| `readmeUrl` | optional | validator: required | required |
| `features.multiConnection` | examples omit it | validator: required when `features` present | always set |
| `main` | `index.html` (manifest) vs `dist/index.html` (CSP page) | samples: `index.html` | `index.html` |
| File dialogs location | README `utils.saveFile` | typings + samples: `fileSystem.*` | `fileSystem.*` |
| `pptb-validate` flags | `--json --skip-url-checks path` | CLI ignores all args | run from package root, no args |
| Vite `base` | — | generator html `./src`; react/vue `./` | `./` |
| html template `fixHtmlForPPTB` | — | missing in generator html, present in react/vue/svelte | include |
| `DataverseConnection` type | deprecated | templates still use it | `Connection` |
| Theme change event | `settings:updated` | samples: none subscribed | subscribe `settings:updated` |

---

## 10. UNVERIFIED (open)

1. `<input type="file">` / drag-drop inside tool iframe.
2. `blob:` / `data:` download links under default CSP.
3. Any CSS tokens injected by host.
4. `base: './src'` in generator html template (likely bug).
5. ExportSolution via `execute` response shape.
6. Desktop-app runtime behaviour of `file://` iframe re ES modules (reason given only in comments).
7. `finalize-package` beyond `npm shrinkwrap`.
8. Published docs hostname (not in repo).
9. Who dispatches intake workflow.
10. VS Code host: native file dialogs.

# PORT-PLAN — solution-xray.html → PPTB tool

Status: APPROVED 2026-09-20 (D1–D7 OK). `solution-xray.html` could not be located in any repo, artifact, session, mailbox or SharePoint search; owner decided to **rewrite from scratch** against the v3 feature list. Section 3 records what that means.

Facts referenced: `docs/PPTB-NOTES.md` (§ numbers below).

---

## 0. Decisions (need your OK)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | npm scope | `@simplesmoothsafe/pptb-solution-xray` | Matches brief. Scope must exist on npm (you own it? confirm). Tool id in registry becomes `simplesmoothsafe-pptb-solution-xray` (§7) |
| D2 | License | **MIT** | Allow-listed (§8). JSZip MIT. No copyleft leak. `@pptb/types` devDep-only → GPL irrelevant |
| D3 | File input | `toolboxAPI.fileSystem.selectPath` + `readBinary`, with `<input type=file>` fallback when `window.toolboxAPI` absent | Only documented path (§3). Fallback keeps tool testable in plain browser and covers UNVERIFIED case |
| D4 | Build | Vite 5+ IIFE single bundle, `tsc --noEmit` typecheck | Sample-proven (§2). No framework |
| D5 | `readmeUrl` | `https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/solution-xray/README.md` | Validator needs live URL on `main` (§6). Means: merge PR before `pptb-validate` passes, or point at branch temporarily |
| D6 | Repo layout | monorepo `tools/<name>/` | pptb-tool-ideas.md plans 5+ tools. Zero shared code now; each tool self-contained npm package |
| D7 | Icon | hand-drawn SVG, `fill="currentColor"`, `dist/icon.svg` | Validator + Verified rule (§1) |

---

## 1. Target structure

```
sss-pptb/
├── docs/                         PPTB-NOTES, PORT-PLAN, BACKLOG
├── pptb-tool-ideas.md
├── solution-xray.html            original, kept for reference (frozen)
└── tools/
    └── solution-xray/
        ├── package.json          manifest (§1 notes)
        ├── tsconfig.json
        ├── vite.config.ts
        ├── README.md
        ├── LICENSE
        ├── .gitignore            dist/, node_modules/
        ├── icon.svg              copied to dist/ by vite (publicDir)
        └── src/
            ├── index.html        markup from original, scripts/styles as relative refs
            ├── styles.css        CSS from original + light/dark via [data-theme]
            ├── main.ts           bootstrap: theme, file picker, wire UI
            ├── host.ts           PPTB adapter: pickZip(), saveText(), theme, notify — with browser fallbacks
            ├── xray/             original logic, moved not rewritten
            │   ├── parse.ts      zip → solution model (JSZip)
            │   ├── inventory.ts
            │   ├── diff.ts
            │   ├── risk.ts
            │   └── order.ts      Kahn topo sort + cycle detection
            └── vite-env.d.ts     /// <reference types="@pptb/types" />
```

Module split inside `src/xray/` follows whatever the original HTML already separates into functions. If original is one big script, split only at feature boundaries listed above; internal function bodies unchanged.

Published tarball: `package.json` + `dist/` (+ `npm-shrinkwrap.json`). `dist/` = `index.html`, `assets/index-*.js` (single IIFE), `assets/index-*.css`, `icon.svg`.

---

## 2. package.json (manifest)

```json
{
  "name": "@simplesmoothsafe/pptb-solution-xray",
  "version": "0.1.0",
  "displayName": "SSS Solution XRay",
  "description": "Offline Dataverse solution zip analysis: component inventory, diff, upgrade risk, install order.",
  "main": "index.html",
  "icon": "icon.svg",
  "license": "MIT",
  "keywords": ["powerplatform", "dataverse", "toolbox", "pptb", "solution", "alm"],
  "contributors": [{ "name": "Duarte Clemente", "url": "https://simplesmoothsafe.com" }],
  "configurations": {
    "repository": "https://github.com/sss-dclemente/sss-pptb",
    "website": "https://simplesmoothsafe.com",
    "readmeUrl": "https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/solution-xray/README.md"
  },
  "features": {
    "multiConnection": "none",
    "connectionRequirement": "optional",
    "minAPI": "1.0.20"
  },
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsc --noEmit && vite build",
    "dev-watch": "vite build --mode development --watch",
    "validate": "pptb-validate",
    "finalize-package": "npm shrinkwrap"
  },
  "dependencies": { "jszip": "^3.10.1" },
  "devDependencies": { "@pptb/types": "^1.2.5", "@pptb/validate": "^1.0.2", "typescript": "^5", "vite": "^5" },
  "files": ["dist", "npm-shrinkwrap.json"]
}
```

Notes:
- No `cspExceptions` → zero consent dialog, Verified-safe.
- `minAPI: 1.0.20` = `fileSystem.*` floor. Bump to `1.2.0` only if `getActiveConnection` used (v1.1).
- `@pptb/validate` explicit devDep → 1.0.2 rules, not the 0.0.2 nested under `@pptb/types` (§6).
- `jszip` moved to `devDependencies` in 0.1.1 — Vite bundles it into the IIFE, so nothing at runtime resolves it; only `scripts/e2e.mjs` needs it. Keeping it in `dependencies` made every consumer download it a second time. Bundle hash is unchanged by the move.
- `npm-shrinkwrap.json` dropped from `files` in 0.1.1, and the `finalize-package` script removed. The PPTB samples and publishing docs prescribe both (PPTB-NOTES §§1, 9), but npm honours a published shrinkwrap as the full tree including its `dev: true` entries, so `npm install` of a ~25 kB tool pulled ~50 MB of vite/esbuild/typescript/rollup. `npm shrinkwrap --omit=dev` does not help. The `dist/` bundles are self-contained with no runtime dependencies left to lock, so the file bought nothing. `@pptb/validate` does not check for it.
- No package-root `index.html`. 0.1.2 added one, generated at build time, on the theory that `main: "index.html"` was resolved against the package root; 0.1.3 removes it again. It was not the cause and it fixed nothing. Installing a tool from npm inside ToolBox failed to launch because of a bug in the host: `getToolBaseDirectory` in `src/main/managers/browserviewProtocolManager.ts` stripped the package name to an empty string, so `path.join(toolsDir, "node_modules", "")` collapsed to `node_modules` and the handler served `node_modules/dist/index.html`. It affected every tool, scoped or not, ours and other authors'. `main` does resolve inside `dist/`, so our layout was always right. Load Local Tool (`localPath`) and marketplace installs (`tool.id`) take the other two branches of that function and were never affected. See PPTB-NOTES §11.
- Version `0.1.1`; still <1.0.0 until Verified request (needs ≥1.0.0).

---

## 3. Rewrite instead of port

Original file unavailable (see docs/PPTB-NOTES.md investigation). Rewritten in TypeScript from the feature list in `pptb-tool-ideas.md`: inventory, compare/diff, upgrade risk score, multi-solution install order (Kahn + cycle detection). Same scope, no new features.

Consequences vs the port plan:

| Planned | Done |
|---|---|
| Move inline JS into `src/xray/*.ts` verbatim | Written new: `parse.ts` (JSZip + DOMParser over solution.xml / customizations.xml / Workflows/*.json), `inventory.ts`, `diff.ts`, `risk.ts`, `order.ts` |
| Keep original CSS | New CSS on SSS two-layer tokens with `[data-theme="dark"]` |
| `strict: false` for moved code | Whole tree `strict: true` |
| Risk score formula from original | Defined in `risk.ts`: capped additive factors, bands Low <25, Medium <50, High <75, Critical. Weights are a first cut; tune with real zips |

Everything else in this plan (structure, manifest, CSP, file input, build, validate) applies unchanged.

## 4. CSP-driven changes (summary)

Default CSP (§4): `script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:`.

- JSZip: bundled via Vite (`import JSZip from "jszip"`). One bundle, IIFE, `inlineDynamicImports`.
- No CDN, no Google Fonts, no remote CSS.
- No `eval`. JSZip itself is eval-free (verify with `grep -c "eval(" dist/assets/*.js` post-build).
- Downloads/exports: `fileSystem.saveFile` in PPTB; `<a download>` blob fallback in browser.
- No `cspExceptions` declared.

---

## 5. File input approach

`src/host.ts`:

```ts
export async function pickZip(): Promise<{ name: string; data: Uint8Array } | null> {
  const tb = window.toolboxAPI;
  if (tb?.fileSystem?.selectPath) {
    const path = await tb.fileSystem.selectPath({ type: "file", title: "Select solution zip",
      filters: [{ name: "Solution zip", extensions: ["zip"] }] });
    if (!path) return null;
    const buf = await tb.fileSystem.readBinary(path);      // Buffer over IPC
    return { name: path.split(/[\\/]/).pop()!, data: new Uint8Array(buf) };
  }
  return pickViaInputElement();                             // browser fallback: <input type=file>
}
```

- `readBinary` returns Node `Buffer` (§3). `new Uint8Array(buf)` works for Buffer and ArrayBuffer. JSZip `loadAsync` accepts Uint8Array.
- Multi-solution install order needs N zips: loop `pickZip()` (selectPath is single-file; no `multiSelections` option in typings §3). UX: "Add solution" button, repeat. Browser fallback keeps `multiple`.
- Compare/diff needs 2 zips: two pick buttons (A/B).

Theme:

```ts
const theme = await tb?.utils.getCurrentTheme?.() ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
document.documentElement.dataset.theme = theme;
tb?.events.on((_e, p) => { if (p.event === "settings:updated" && (p.data as any)?.theme) document.documentElement.dataset.theme = (p.data as any).theme; });
```

---

## 6. Build tool

Vite, config = React sample's (§2) minus react plugin:

```ts
export default defineConfig(({ mode }) => ({
  base: "./",
  publicDir: "../public",          // icon.svg
  root: "src",
  build: {
    outDir: "../dist", emptyOutDir: true, assetsDir: "assets", cssCodeSplit: false,
    sourcemap: mode === "development",
    rollupOptions: { output: { format: "iife", inlineDynamicImports: true, manualChunks: undefined } },
  },
  plugins: [fixHtmlForPPTB()],     // strip type=module/crossorigin, scripts → end of body (copied verbatim from sample)
}));
```

Post-build checks (script `check-dist`): `dist/index.html` exists; single `<script src="./assets/…">` without `type=module`; `grep -L "https://" dist/assets/*.js` (no remote URLs); `grep -c "eval("` = 0.

---

## 7. Validate + README

- README at `tools/solution-xray/README.md`: what it does, screenshot placeholders (`docs/img/*.png` full raw URLs), install (marketplace + local Debug loader), privacy (all local, zip never leaves machine, no network, no CSP exceptions), footer SSS.
- `pptb-validate` does HEAD on `readmeUrl`/`repository`/`website` (§6) → must run after README is on `main` (or temporarily point `readmeUrl` at branch, then fix before publish). Plan: run validate in PR with branch URL, switch to `main` URL in final commit.

---

## 8. Steps (Phase 2, after OK)

1. `chore: scaffold tools/solution-xray` — package.json, tsconfig, vite.config, empty src, icon. Build green.
2. `feat: move xray logic to src/xray` — verbatim moves, `strict:false` for that dir.
3. `feat: host adapter + PPTB file picker` — host.ts, main.ts wiring.
4. `feat: theme light/dark + SSS footer`.
5. `docs: README + LICENSE`.
6. `chore: pptb-validate passes` — fix findings.
7. Manual test: `vite build` → Load Local Tool in PPTB (you; I can't run desktop app). Browser fallback test: I open `dist/index.html` via Playwright with a synthetic zip.
8. `docs/BACKLOG.md` (Phase 3).

Not in scope: npm publish, submit-tool, Verified request — you trigger.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| `file://` iframe quirks (relative asset paths) | `base: './'` + IIFE, same as samples |
| `readBinary` Buffer → Uint8Array conversion edge | test both `Buffer` and `{type:"Buffer",data:[]}` JSON shape (IPC serialization UNVERIFIED) |
| `readmeUrl` HEAD check fails on branch | validate with branch URL, finalize on main |
| Original HTML uses `eval`/`Function`/remote font | fix at step 2; flagged in §3 table |
| Large zips (50MB+) over IPC | measure; if slow, note in README; no fix in v1 |

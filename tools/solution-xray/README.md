# SSS Solution XRay

Offline analysis of Dataverse solution zips inside [Power Platform ToolBox](https://www.powerplatformtoolbox.com). No connection required. The zip never leaves your machine.

Built by [Simple Smooth Safe](https://simplesmoothsafe.com).

## What it does

Load one or more exported solution zips (managed or unmanaged) and get:

- **Inventory** — solution header (unique name, version, managed flag, publisher), root components by type, tables with column/form/view counts, relationships, global choices, processes and cloud flows (with the connection references each flow uses), model-driven and canvas apps, web resources, security roles, column security profiles, connection references, environment variables (default/value present?), plugin assemblies and steps, PCF controls, and the export's own declared missing dependencies.
- **Compare** — diff two zips (two versions of the same solution, or two different ones): added / removed / changed components per category, down to individual columns. Flags upgrade vs downgrade vs same version.
- **Upgrade risk** — a 0–100 heuristic score built from capped factors with evidence and advice for each: missing dependencies, unmanaged import, system (non-prefixed) tables included with all subcomponents, plugins, cloud flows whose connection references are not shipped, environment variables without values, canvas apps, size, publisher-prefix hygiene. Pick a baseline zip (the previous version) to also score removed tables, removed columns, version regressions (a lower version is blocked for managed imports; the same version is allowed but flagged lightly) and managed/unmanaged flips.
- **Install order** — load every solution you plan to import; the tool builds the dependency graph from `MissingDependencies` and shared tables (a table belongs to the solution that creates it; system tables such as `account` never create edges), runs a topological sort (Kahn) and reports the order, the reason for each edge, dependencies on solutions you did not load, and any dependency cycle with a concrete path.

Every tab exports its result as JSON.

## Screenshots

Inventory (light) and upgrade risk captured inside Power Platform ToolBox with the sample zips. Dark theme and install order are still synthetic.

![Inventory, light theme](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/solution-xray/docs/img/inventory-light.png)

![Inventory, dark theme](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/solution-xray/docs/img/inventory-dark.png)

![Upgrade risk](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/solution-xray/docs/img/risk.png)

![Install order with a dependency cycle](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/solution-xray/docs/img/install-order.png)

## Install

**From the ToolBox marketplace** — search for "SSS Solution XRay" once listed.

**From npm (ToolBox Debug menu)** — Settings → enable *Show Debug Menu* → Debug → *Install from npm* → `@simplesmoothsafe/pptb-solution-xray`.

**From source**

```bash
cd tools/solution-xray
npm install
npm run build
```

Then in ToolBox: Debug → *Load Local Tool* → select the `tools/solution-xray` folder (the one with `package.json`; files are served from `dist/`).

The built `dist/index.html` also runs in a plain browser (file picker and downloads fall back to standard browser APIs), which is how the smoke test drives it.

## Usage

1. **Add solution zip** — native file dialog inside ToolBox (one file per pick; repeat to add more). In a browser, multi-select and drag-and-drop also work.
2. Pick a tab. *Inventory* and *Upgrade risk* work with one zip; *Compare* and *Install order* need two or more.
3. *Export JSON* saves the current analysis.

Notes:

- The tool reads `solution.xml`, `customizations.xml`, `Workflows/*.json` and `environmentvariabledefinitions/*/` (definition XML and `environmentvariablevalues.json`). Anything else in the zip is only counted.
- If the same unique name is loaded twice (two versions), *Install order* uses the highest version (the first loaded on a tie); remove the other to change that.
- The risk score is a checklist, not a verdict. Read the evidence.

## Privacy

All processing happens in the tool's page. There is no network access: no telemetry, no CDN, no fonts, no API calls, and no CSP exceptions are requested. The zip is read from disk through the ToolBox file API (or the browser file picker) and stays in memory for the session.

## Development

```bash
npm run build       # typecheck + Vite IIFE bundle + dist checks (no eval, no remote URLs, single script)
npm run dev-watch   # rebuild on change; reload the tool tab in ToolBox
npm run validate    # @pptb/validate manifest rules (does live HEAD checks on the README/repo URLs)
npm run e2e         # Playwright smoke test against dist/ (needs playwright + Chromium available)
```

Stack: TypeScript, Vite, [JSZip](https://stuk.github.io/jszip/). Types from `@pptb/types`. No framework.

## License

MIT. See [LICENSE](https://github.com/sss-dclemente/sss-pptb/blob/main/tools/solution-xray/LICENSE).

# SSS EnvVar & ConnRef Matrix

Environment variables and connection references across environments, as one matrix, inside [Power Platform ToolBox](https://www.powerplatformtoolbox.com). See what is missing, what differs, copy values between environments with a preview, and export `deploymentSettings.json`.

Built by [Simple Smooth Safe](https://simplesmoothsafe.com).

## What it does

- **Matrix** — rows are environment variables (or connection references), columns are environments. Each cell shows the effective value and where it comes from: `value` (a value row exists), `default` (definition default only), `missing` (neither), `absent` (definition not in that environment). Rows with differences or gaps are highlighted.
- **Columns** — the ToolBox primary and secondary connections are live columns. Any number of extra columns come from **snapshots**: export a column to JSON, load it later as a read-only column. Compare Dev, Test, UAT and Prod without ToolBox needing more than two connections.
- **Filters** — text, only differences, only missing / unbound, and scope to a solution (its environment variable definitions and connection references).
- **Copy values** — select rows, pick source and target columns, preview the plan (create / update / skip with a reason per row), confirm, see per-row results. Or set a single cell. Writes go to `environmentvariablevalue` in the target environment; definitions are never created and secrets are never written.
- **Connection references** — bound / unbound / absent per environment, with connector and connection id. Read-only in v1.
- **Export** — `deploymentSettings.json` for any column (the shape `pac solution import --settings-file` expects), matrix CSV, and snapshots.

## Screenshots

Synthetic sample data. Replace with real captures before publishing.

![Environment variables matrix](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/envvar-matrix/docs/img/envvars.png)

![Copy preview](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/envvar-matrix/docs/img/preview.png)

![Connection references](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/envvar-matrix/docs/img/connrefs.png)

![Snapshot column, dark theme](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/envvar-matrix/docs/img/snapshot-dark.png)

## Install

**From the ToolBox marketplace** — search for "SSS EnvVar & ConnRef Matrix" once listed.

**From npm (ToolBox Debug menu)** — Settings → enable *Show Debug Menu* → Debug → *Install from npm* → `@simplesmoothsafe/pptb-envvar-matrix`.

**From source**

```bash
cd tools/envvar-matrix
npm install
npm run build
```

Then in ToolBox: Debug → *Load Local Tool* → select the `tools/envvar-matrix` folder.

## Usage

1. Pick a primary connection in ToolBox (and a secondary one to compare two live environments). The tool needs at least one connection.
2. Rows load on open; **Refresh** reloads after changes in the environment.
3. Filter, then select rows and use the bottom bar to copy values from one column into a live column. Every write goes through a preview and a confirm step. A Production target is called out in the preview.
4. **Export → Snapshot** saves the selected column as JSON; **Load snapshot…** adds it as a column in any later session.

Notes:

- Secrets (type *Secret*) are shown masked, compared by presence only, never written, and stored as `<secret>` in snapshots.
- A copy skips rows whose definition does not exist in the target: this tool sets values, it does not move definitions. Ship definitions in a solution.
- Values written outside a solution land in the environment's unmanaged layer, which is how `deploymentSettings.json` behaves too.
- Queries are not paged; environments with more than 5 000 environment variables or connection references would be truncated.

## Privacy

All data stays between ToolBox and your Dataverse environments: the tool talks to Dataverse only through the ToolBox `dataverseAPI` bridge, requests no CSP exceptions, and sends nothing anywhere else. Snapshots and exports are written to files you choose.

## Development

```bash
npm run build       # typecheck + Vite IIFE bundle + dist checks
npm run dev-watch   # rebuild on change; reload the tool tab in ToolBox
npm run validate    # @pptb/validate manifest rules
npm run e2e         # Playwright smoke test against dist/ with a mocked ToolBox host (needs playwright + Chromium)
```

Stack: TypeScript, Vite, no framework, no runtime dependencies. Types from `@pptb/types`.

## License

MIT. See [LICENSE](https://github.com/sss-dclemente/sss-pptb/blob/main/tools/envvar-matrix/LICENSE).

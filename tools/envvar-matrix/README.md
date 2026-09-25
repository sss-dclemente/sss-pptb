# SSS EnvVar & ConnRef Matrix

Environment variables and connection references across environments, as one matrix, inside [Power Platform ToolBox](https://www.powerplatformtoolbox.com). See what is missing, what differs, copy values between environments with a preview, and export `deploymentSettings.json`.

Built by [Simple Smooth Safe](https://simplesmoothsafe.com).

## What it does

- **Matrix** — rows are environment variables (or connection references), columns are environments. Each cell shows the effective value and where it comes from: `value` (a value row exists), `default` (definition default only), `missing` (neither), `absent` (definition not in that environment). Rows with differences or gaps are highlighted.
- **Columns** — the ToolBox primary and secondary connections are live columns. Any number of extra columns come from **snapshots** or **deploymentSettings.json** files (Load snapshot… detects the format; an empty `Value` / `ConnectionId` counts as not set, and values copy into a live column through the normal preview): export a column to JSON, load it later as a read-only column. Compare Dev, Test, UAT and Prod without ToolBox needing more than two connections.
- **Filters** — text, only differences, only missing / unbound, and scope to a solution (its environment variable definitions and connection references).
- **Copy values** — select rows, pick source and target columns, preview the plan (create / update / skip with a reason per row), confirm, see per-row results. Or set a single cell. Writes go to `environmentvariablevalue` in the target environment; definitions are never created and secrets are never written. Values are checked against the variable type before anything is written (Boolean `yes`/`no`, Number numeric, JSON parseable); invalid rows are shown in the preview and not written, and an empty input is skipped rather than written as an empty string. A copy or set that would only pin what the target already resolves to (for example its own default) is skipped, and a value copied from a source default is labelled as such. The preview cautions when the target value row is managed (the write adds an unmanaged layer) or when a definition has more than one value row.
- **Connection references** — bound / unbound / absent per environment, with connector and connection id. A reference bound to a different connector in another environment counts as a difference.
- **Bind connection references** — select rows on the Connection references tab, pick a source column and a live target, **Preview bind…**. Writes `connectionreference.connectionid` in the target, typically from a loaded deploymentSettings.json. Connection ids belong to one environment: a live column or snapshot of another org is refused; a settings file carries no org and is taken as written. Rows whose connector differs are invalid, rows already bound to the same id are skipped, and a managed reference is flagged (the binding is an unmanaged change, as with `pac --settings-file`). **Restart flows that are on** (default) turns each active flow using a rebound reference off and on so it picks up the connection; a flow that cannot be turned back on is reported as left off.
- **Pick connections (experimental)** — same bar, **Pick connections…**: lists the target environment's connections through the Power Platform API (`connectivity/environments/{id}/connections`, environment id from `RetrieveCurrentOrganization`) and offers a dropdown per selected reference with only that connector's connections (display name, account, status). Picks go through the same bind preview; a connection reporting an error status is cautioned. Needs ToolBox 1.2.6+ and a connection with the Power Platform API enabled (custom Client ID with delegated `Connectivity.Connections.Read`); otherwise the dialog says why and points to the deploymentSettings.json path. The list is what the signed-in user can see: a connection the flow owner cannot use makes turning the flow on fail (reported, flow left off).
- **Consolidate connection references** — Connection references tab → **Consolidate…**. Reads every solution-aware cloud flow (`workflow`, category 5) and shows, per connector with more than one reference, each reference's binding and how many flows use it. Pick the one to keep (a suggestion is preselected: bound, then most used, then managed) and tick the ones to merge into it. The preview lists every flow that changes, key by key (`shared_office365_1: old → kept`, `key shared_office365_1 → shared_office365`), and cautions on managed flows (unmanaged layer) and on merging references bound to different connections (flows then run as the kept reference's connection). Apply saves a backup JSON first (mandatory), then per flow: turn off if on → rewrite `connectionReferenceLogicalName` in `clientdata` → turn back on. A flow that cannot be turned back on (for example the kept reference is unbound) is reported and left off. Optionally deletes the merged references afterwards, only when unmanaged, no longer used by any flow (re-read after the update) and with no other dependents (`RetrieveDependenciesForDelete`, which catches canvas apps). **Restore from backup…** recreates deleted references and puts each flow's original `clientdata` back.
- **Unused connection references** — same view: references no cloud flow uses. Select (managed ones are locked), preview: each one is checked with `RetrieveDependenciesForDelete` first, so a reference a canvas app uses is kept with the reason. Apply saves a backup, re-reads the flows, checks dependents again, then deletes. Restore from backup recreates them.
- **Flows that are off** — same view: solution cloud flows that are off, split into *ready* (every connection reference they use exists and is bound) and *blocked* (with the unbound or missing references, or unreadable clientdata). Select ready flows (or **Select all ready**), **Turn on…**: the preview warns that turned-on flows start running on their triggers; each flow is turned on separately and failures are reported per flow. Typical after an import: bind the references, then turn the flows on here.
- **Solution check** — pick a solution in the Solution filter while in Consolidate: lists connection references used by the solution's cloud flows that are not in the solution (an export would miss them) and flows naming a reference that does not exist. **Add to solution…** runs `AddSolutionComponent` for each (no required components). Managed solutions are reported only.
- **Export** — `deploymentSettings.json` for any column (the shape `pac solution import --settings-file` expects), matrix CSV, and snapshots. `deploymentSettings.json` follows the solution filter when one is selected. `Value` is the current value row only: variables with just a default, and all secrets, get an empty `Value`, as with `pac solution create-settings`. CSV cells that a spreadsheet would read as a formula (starting with `=`, `+`, `-`, `@`) are prefixed with `'`.

## Screenshots

Rendered from the tool against a mocked host with fictional sample data (Contoso Dev / UAT sandboxes). Regenerate with `npm run build && npm run screenshots`.

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
2. Rows load on open; **Refresh** reloads after changes in the environment. If one connection fails to load, the other column still loads and the failed column shows the error.
3. Filter, then select rows and use the bottom bar to copy values from one column into a live column. Every write goes through a preview and a confirm step. A Production target is called out in the preview.
4. **Export → Snapshot** saves the selected column as JSON; **Load snapshot…** adds it as a column in any later session.

Notes:

- Secrets (type *Secret*) are shown masked, compared by presence only, never written, stored as `<secret>` in snapshots, and exported with an empty `Value` in `deploymentSettings.json`.
- A copy skips rows whose definition does not exist in the target: this tool sets values, it does not move definitions. Ship definitions in a solution.
- Values written outside a solution land in the environment's unmanaged layer, which is how `deploymentSettings.json` behaves too.
- Consolidation repoints each flow key to the kept reference. With **Collapse duplicate keys in flows** (on by default), keys that then point to the same reference (same `api.name`, `runtimeSource` and `impersonation`) fold into one: `host.connectionName` and `$connections['key']` expressions in the definition are repointed, and a key is dropped only when no other use of it is left in the definition (otherwise it stays, with a caution in the preview). Flows outside solutions ("My flows") use connections, not references, and are not touched. Canvas apps are not rewritten: a reference a canvas app uses is kept (its dependency blocks the delete).
- Queries follow `@odata.nextLink`, so environments with more than 5 000 environment variables or connection references load completely.

## Privacy

All data stays between ToolBox and your Dataverse environments: the tool talks to Dataverse only through the ToolBox `dataverseAPI` bridge, requests no CSP exceptions, and sends nothing anywhere else. Snapshots and exports are written to files you choose.

## Development

```bash
npm run build       # typecheck + Vite IIFE bundle + dist checks
npm run dev-watch   # rebuild on change; reload the tool tab in ToolBox
npm run validate    # @pptb/validate manifest rules
npm test            # node:test unit tests for the pure logic (clientdata rewrite, key collapse, plans, parsers); no browser
npm run e2e         # Playwright smoke test against dist/ with a mocked ToolBox host (needs playwright + Chromium)
```

Stack: TypeScript, Vite, no framework, no runtime dependencies. Types from `@pptb/types`.

## License

MIT. See [LICENSE](https://github.com/sss-dclemente/sss-pptb/blob/main/tools/envvar-matrix/LICENSE).

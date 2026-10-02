# SSS D365 Apps Matrix

The Power Platform admin center's **Environment → Resources → Dynamics 365 apps** page, for many environments at once, inside [Power Platform ToolBox](https://www.powerplatformtoolbox.com). Rows are apps, columns are environments. Each cell shows the installed version, an available update, a failed install or an install in progress. Tick cells, preview, run: installs are queued one at a time per environment, environments run in parallel, and progress is followed live. No clicking through PPAC environment by environment.

Built by [Simple Smooth Safe](https://simplesmoothsafe.com).

## What it does

- **Environments**: lists every environment your account can see that has a Dataverse database. Pick the columns; the selection is remembered. The first time, the connection's own environment is used.
- **Matrix**: for each picked environment, the installed Dynamics 365 apps and the apps available to install.
  - `1.0 → 1.2` (amber): an update is available.
  - `failed` (red): the last install failed; the error is shown.
  - `Installing` and similar: an operation is in progress; the cell can't be selected.
  - With **Show not installed**: apps available but installed in no picked environment.
  - Filter by name; **Only updates / failed** hides the rest.
- **Select all failed**: ticks every failed install for a retry (rows hidden by the name filter are left out).
- **Select all updates**: ticks every update, except packages flagged **custom upgrade**. Those handle their own upgrade; tick them by hand after reading their release notes.
- **Preview → run**: the preview lists the installs per environment and warns about Production environments. The run does one install at a time per environment, with up to 3 environments in parallel. Each install is followed until it ends (an install can take an hour) and the result shows in the matrix and in the run table. **Stop waiting** stops following; installs already started keep running in the environment. Afterwards the environments are read again.
- **Exports**:
  - Matrix CSV.
  - Run results CSV.
  - **pac script**: a PowerShell script with the same installs as `pac application install` lines, for CI or for a machine without ToolBox.

## Screenshots

Synthetic sample data from the e2e harness (mocked ToolBox host). Replace with real captures.

![Matrix: updates, failed installs and installs in progress per environment](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/d365-apps/docs/img/matrix.png)

![Preview before running installs, with the Production warning](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/d365-apps/docs/img/preview.png)

![After a run: results per install](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/d365-apps/docs/img/run.png)

![Matrix, dark theme](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/d365-apps/docs/img/matrix-dark.png)

## Setup

The tool uses the [Power Platform API](https://learn.microsoft.com/rest/api/power-platform/) through ToolBox (version **1.2.6 or later**), not Dataverse.

1. In ToolBox, enable the Power Platform API on the connection. This needs a custom client id: your own Entra app registration (public client). ToolBox's *Configure & Add* helper walks through it.
2. Grant the app these delegated Power Platform API permissions, with admin consent:
   - `EnvironmentManagement.Environments.Read`
   - `AppManagement.ApplicationPackages.Read`
   - `AppManagement.ApplicationPackages.Install`
3. The signed-in account needs admin rights on each environment (Power Platform admin, or System Administrator in that environment).

One connection is enough: the token covers every environment the account can see. A refused call shows a banner with these steps.

## Usage

1. Open the tool on a connection set up as above.
2. **Environments…**: tick the environments to compare, then **Load**.
3. **Select all updates**, or tick cells one by one (update, retry, install).
4. **Preview…**, check the list, **Run**.
5. Keep the tool open while it runs.

## Limitations

- **Not yet verified against a live tenant** (built before the probe in [docs/D365-APPS-PLAN.md](https://github.com/sss-dclemente/sss-pptb/blob/main/docs/D365-APPS-PLAN.md) §5):
  - **"Update available" is derived.** The API has no such state: the tool compares the installed version with the newest version of the same app in the environment's not-installed list. If an update doesn't show where PPAC shows one, save a debug log (below) and open an issue.
  - Whether the install response carries an operation id. When it doesn't, the tool follows the app's state in the environment instead.
- Installs can't be cancelled from the API; Stop waiting only stops following them.
- Install order inside an environment is the matrix's row order. When one app depends on another, run the base app first.

## Debug log

For troubleshooting, tick **Debug log** in the footer, reproduce the problem, then **Save log**. You get a `d365-apps-debug-<timestamp>.txt` file with every ToolBox and Power Platform API call the tool made (the exact path, the response or error, timing), notifications, connection events and uncaught errors. The switch is remembered for this tool; `?debug=1` also turns it on. Off, nothing is recorded.

The file is written only where you save it. Secrets (keys named like password, secret, token, authorization) are redacted, and long strings, arrays and binary payloads are truncated. Responses still contain tenant data such as environment names and URLs: review the file before you share it.

## Privacy

All calls go from ToolBox to the Power Platform API (`api.powerplatform.com`) through the ToolBox `powerplatformAPI` bridge, with your own token. The tool requests no CSP exceptions and sends nothing anywhere else. Exports are written to files you choose; the environment selection is kept in the tool's local storage.

## Install

**From the ToolBox marketplace**: search for "SSS D365 Apps Matrix" once listed.

**From source**

```bash
cd tools/d365-apps
npm install
npm run build
```

Then in ToolBox: Debug → *Load Local Tool* → select the `tools/d365-apps` folder.

## Development

```bash
npm run build       # typecheck + Vite IIFE bundle + dist checks
npm run dev-watch   # rebuild on change; reload the tool tab in ToolBox
npm test            # unit tests: response parsing, version compare, matrix cells, plan, run queue, exports
npm run e2e         # Playwright test against dist/ with a mocked host (needs playwright + Chromium)
npm run validate    # @pptb/validate manifest rules
```

Stack: TypeScript, Vite, no framework. Types from `@pptb/types`.

## License

MIT. See [LICENSE](https://github.com/sss-dclemente/sss-pptb/blob/main/tools/d365-apps/LICENSE).

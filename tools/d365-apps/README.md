# D365 Apps Matrix

The Power Platform admin center's **Environment → Resources → Dynamics 365 apps** page, for many environments at once, inside [Power Platform ToolBox](https://www.powerplatformtoolbox.com). Rows are apps, columns are environments. Each cell shows the installed version, an available update, a failed install or an install in progress. Tick cells, preview, run: installs are queued one at a time per environment, environments run in parallel, and progress is followed live. No clicking through PPAC environment by environment.

## What it does

- **Environments**: lists every environment your account can see that has a Dataverse database. Pick the columns; the selection is remembered. The first time, the connection's own environment is used.
- **Matrix**: for each picked environment, the installed Dynamics 365 apps and the apps available to install.
  - `1.0 → 1.2` (amber): an update is available.
  - `failed` (red): the last install failed; the error is shown on one line (hover for the full text).
  - `Installing` and similar: an operation is in progress; the cell can't be selected.
  - With **Show not installed**: apps available but installed in no picked environment.
  - Filter by name. The counts above the matrix (**updates**, **failed**, **in progress**) are toggles: press one or more to show only the apps in that state (any of them). **Clear filters** resets the name filter and the toggles.
- **Select all failed**: ticks every failed install for a retry (rows hidden by the name filter are left out).
- **Select all updates**: ticks every update, except packages flagged **custom upgrade**. Those handle their own upgrade; tick them by hand after reading their release notes.
- **Preview → run**: the preview names every target environment with the number of apps to install or update in it, lists the installs per environment, says that installs and updates cannot be undone, and warns about Production environments. The run does one install at a time per environment, with up to 3 environments in parallel. Each install is followed until it ends (an install can take an hour) and the result shows in the matrix and in the run table. **Stop waiting** stops following; installs already started keep running in the environment. Afterwards the environments are read again. The run section folds away when every install succeeded; **Only problems** hides the installs that succeeded, and **Dismiss** clears the run list.
- **Unused apps…** (read-only): for the **connection's** environment, which installed apps look unused.
  - Each app is mapped to its solutions: the solutions its package imported (solution history) plus its anchor solution (same unique name as the package).
  - The verdict comes from row counts in the tables that only that app's solutions contain. Tables and solutions shared with another installed app are listed but not counted, because they can hold the other app's data.
  - Verdicts: **Probably unused** (every own table empty), **Seed data only?** (no own table has more than 10 rows), **In use**, **No signal** (no own tables to count), **Solutions not found**, **Platform** (auto-installed apps such as Power Apps checker or Flow approvals, which can't be removed).
  - Each row shows the tables with rows, the model-driven apps and how many security roles they're shared with, and the solutions behind the app.
  - Counts come from `RetrieveTotalRecordCount`, a snapshot under 24 hours old; every zero is re-checked live with a one-row read.
  - Filter by name, or press verdict counts (any of them) to show only those apps. **Expand all / Collapse all** for the solutions behind each app; **How verdicts work** explains the method.
  - **Hide** keeps the report: **Unused apps…** shows it again without reading anything. **Re-run** reads it again.
  - Report CSV.
- **Exports**:
  - Matrix CSV.
  - Run results CSV.
  - **pac script**: a PowerShell script with the same installs as `pac application install` lines, for CI or for a machine without ToolBox.

## What this tool changes

Installs and updates of Dynamics 365 apps are **irreversible**: there is no rollback to the previous version and this tool cannot uninstall an app. Everything else the tool does is read-only.

**Power Platform writes** (only after you confirm the preview):

- **Install, update or retry a Dynamics 365 app package** in an environment: `POST environments/{id}/applicationPackages/{uniqueName}/install` (Power Platform API, AppManagement, api-version 2024-10-01), one call per ticked cell. The same call installs an app that is not installed, updates an installed app to the newest version the environment offers, or retries a failed install. The app's package imports or upgrades its solutions and components in that environment.
  - **Scope**: exactly the ticked cells (single cells, **Select all updates**, **Select all failed**), including any ticked cell in a row or column hidden by the filters (the preview flags those). One install at a time per environment, up to 3 environments in parallel.
  - **Confirmation**: the **Preview…** dialog is the only way to start a run. It names each target environment (display name, type and URL) with its number of apps, lists every install with its from/to version, warns about Production environments and custom-upgrade packages, and states that installs and updates cannot be undone. The run button is the danger button when a Production environment is in the plan.
  - **Backup**: not offered by this tool and not possible through this API. Take a backup or copy of the environment in the Power Platform admin center before running if you may need to go back.
  - **Reversible**: no. The Power Platform API has no rollback and no uninstall, and an install that has started cannot be cancelled (**Stop waiting** only stops following it). To remove an app, delete its solutions in the environment by hand (the **Unused apps** report lists them).
- **Reads**: environments, installed and available app packages, install operation status (Power Platform API); for the **Unused apps** report, solutions, solution history, table metadata, `RetrieveTotalRecordCount` and one-row reads (Dataverse Web API, connection's environment only). The report changes nothing.

**Files saved to disk** (only where you choose, through the ToolBox save dialog): Matrix CSV, Run results CSV, Unused apps report CSV, the **pac script** (`.ps1`; running it yourself performs the same irreversible installs, and its header says so) and the debug log.

**Browser storage** (per viewer, this tool only): the environment selection, hidden environment columns, filters and toggles, and the debug log switch, in `localStorage`.

**Nothing else.** The tool never uninstalls apps, never deletes or edits records, solutions, components, security roles or environment settings, and never changes environment configuration.

## Screenshots

Captured in Power Platform ToolBox against a Dataverse Sandbox environment.

![Matrix filtered to updates and failed installs; the custom-upgrade package is flagged](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/d365-apps/docs/img/matrix.png)

![Preview before running: target environment, the update, and the no-undo warning](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/d365-apps/docs/img/preview.png)

![After a run: the update succeeded and left the updates list](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/d365-apps/docs/img/run.png)

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
4. **Preview…**, check the target environments, the app count per environment and the list (installs and updates cannot be undone), **Run**.
5. Keep the tool open while it runs.

## Limitations

- **Tested on 2026-10-06 against a Dataverse Sandbox environment** (one environment): reading installed and available apps, the update / failed / custom-upgrade cells, the preview for an update and for a retry, one update run end to end (Storage Advisor Components 1.0.0.2 → 1.0.0.3: the install response carried an operation id, the tool followed it to Succeeded, and the re-read showed 1.0.0.3 with the update gone), Results CSV, Matrix CSV, light and dark theme. A throttled read (HTTP 429) is retried four times and then shown on that environment's column only.
- **Not yet verified against a live environment:**
  - **"Update available" is derived.** The API has no such state: the tool compares the installed version with the newest version of the same app in the environment's not-installed list. It has not been compared with the PPAC list. If an update doesn't show where PPAC shows one, save a debug log (below) and open an issue.
  - A retry of a failed install, a first-time install, and runs across several environments in parallel (the two other environments tried were throttled by the API).
  - The **pac script** has been generated but not run.
  - **Unused apps**: on the tested environment it mapped very few packages to their solutions (most rows read "Solutions not found"), so its verdicts are not reliable yet.
  - A connection without the Power Platform API permissions, and an expired connection.
- Installs can't be cancelled from the API; Stop waiting only stops following them.
- **Unused apps is a lead, not a verdict.** There's no usage telemetry in these APIs: an app whose tables are empty may still be needed (for example, it holds configuration another app reads). It covers only the connection's environment: switch the ToolBox connection to report on another one. It needs read access to solutions, solution history and table metadata (System Administrator or System Customizer).
- **No uninstall.** The Power Platform API has no uninstall. Remove an app by deleting its solutions in the environment (Solutions page), anchor first; the report lists them.
- Install order inside an environment is the matrix's row order. When one app depends on another, run the base app first.

## Debug log

For troubleshooting, tick **Debug log** in the footer, reproduce the problem, then **Save log**. You get a `d365-apps-debug-<timestamp>.txt` file with every ToolBox, Dataverse and Power Platform API call the tool made (the exact path, the response or error, timing), notifications, connection events and uncaught errors. The switch is remembered for this tool; `?debug=1` also turns it on. Off, nothing is recorded.

The file is written only where you save it. Secrets (keys named like password, secret, token, authorization) are redacted, and long strings, arrays and binary payloads are truncated. Responses still contain tenant data such as environment names and URLs: review the file before you share it.

## Privacy

All calls go from ToolBox to the Power Platform API (`api.powerplatform.com`) through the ToolBox `powerplatformAPI` bridge, with your own token. The tool requests no CSP exceptions and sends nothing anywhere else. Exports are written to files you choose; the environment selection is kept in the tool's local storage.

## Install

**From the ToolBox marketplace**: search for "D365 Apps Matrix" once listed.

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
npm run screenshots # synthetic captures of the mocked host into docs/img-synthetic/ (gitignored; not for the README)
```

Stack: TypeScript, Vite, no framework. Types from `@pptb/types`.

## AI Assistance

Substantial parts of this tool's code and documentation were generated with Claude Code (Anthropic) and reviewed, tested and maintained by the contributors listed in `package.json`. Testing status against real Dataverse environments is stated per feature under Limitations.

## Credits

Built and maintained by Duarte Clemente ([Simple Smooth Safe](https://simplesmoothsafe.com)).

## License

MIT. See [LICENSE](https://github.com/sss-dclemente/sss-pptb/blob/main/tools/d365-apps/LICENSE).

# D365-APPS-PLAN — SSS D365 Apps Matrix

Status: BUILT as 0.1.0 (`tools/d365-apps`), published to npm 2026-10-02 before the §5 probe ran; fixes go in 0.1.1. Every unverified shape below is parsed defensively and has a fallback. Run the probe with Debug log on and adjust `src/apps/api.ts` if a shape differs.

One-liner: the Power Platform admin center's **Environment → Resources → Dynamics 365 apps** page, for many environments at once. Rows are apps, columns are environments, and each cell shows the installed version, an available update, or a failed install. Tick cells, preview, run. Installs are queued one at a time per environment, environments run in parallel, and status is polled live. No PPAC clicking.

Questioning the requirement: bulk-updating one environment saves about ten clicks, because PPAC already has a per-environment page. The pain is N environments × M apps, so the tool is a cross-environment matrix from day one.

---

## 0. Decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Home | New tool `@simplesmoothsafe/pptb-d365-apps`, display "SSS D365 Apps Matrix" | Different API (Power Platform API, not Dataverse), different audience (admins), and its own marketplace listing |
| D2 | API | Power Platform API through `window.powerplatformAPI` (ToolBox ≥ 1.2.6): `EnvironmentManagement` + `AppManagement`, api-version `2024-10-01` | The documented app-management API; `pac application` uses the same service. No Dataverse calls |
| D3 | Setup | The ToolBox connection needs the Power Platform API enabled (custom Entra client id), with delegated `EnvironmentManagement.Environments.Read`, `AppManagement.ApplicationPackages.Read` and `AppManagement.ApplicationPackages.Install`. Manifest: `enabledForPowerPlatformAPI: true`, `minAPI: 1.2.6` | Without the API the tool has nothing to do, so it states the requirement up front (unlike EnvVar Matrix, where it's an extra). One connection reaches every environment the user can see: the token is tenant-wide |
| D4 | Environments | List the environments the user can see; keep those with a Dataverse database. A picker selects the columns, defaulting to the connection's own environment, and the selection is remembered | A tenant can have hundreds of environments, and each costs two calls |
| D5 | "Update available" | **Not a state in the API.** Derived: the `Installed` list gives installed versions, the `NotInstalled` list gives what is available. The same `uniqueName` with a higher version in the second list means an update. UNVERIFIED (§5) | `InstancePackageState` has no UpdateAvailable value |
| D6 | Writes | `POST applicationPackages/{uniqueName}/install` for update, install and retry. Preview → confirm with a Production warning. One install at a time per environment, up to 3 environments in parallel | PPAC refuses concurrent operations on one environment. Parallel across environments is what saves the time |
| D7 | Progress | Poll `operations/{operationId}` every 15 s until `Succeeded` / `Failed` / `Canceled`. When the install response carries no operation id (202 without a body), poll the environment's package list for that app's state instead | The host returns the body only, not the `Operation-Location` header |
| D8 | Safety | `customHandleUpgrade` packages are flagged and not ticked by "Select all updates". Installs are never cancelled from the tool: "Stop waiting" stops polling, not the install | The API has no cancel; an abandoned install keeps running in PPAC |
| D9 | Export | Matrix CSV and a `pac application install` PowerShell script for the selection | The script is the same plan for CI or for a machine without ToolBox |

## 1. Calls

| Need | Call | Notes |
|---|---|---|
| Environments | `EnvironmentManagement.Get("environments?api-version=2024-10-01")`, paging on `@odata.nextLink` / `@odata.nextlink` | Fields: `id`, `displayName`, `type`, `state`, `dataverseId`, `url`, `geo` |
| Connection's environment | `dataverseAPI.execute(RetrieveCurrentOrganization)` → `Detail.EnvironmentId` | Default column only; optional |
| Installed | `AppManagement.Get("environments/{id}/applicationPackages?appInstallState=Installed&api-version=2024-10-01")` | `uniqueName`, `version`, `state`, `localizedName` / `applicationName`, `publisherName`, `customHandleUpgrade`, `lastError`, `instancePackageId` |
| Available | same with `appInstallState=NotInstalled` | Contains updates for installed apps (D5, unverified) |
| Install | `AppManagement.Post("environments/{id}/applicationPackages/{uniqueName}/install?api-version=2024-10-01", {})` | 200 `InstancePackage` with `lastOperation.operationId`, or 202 |
| Status | `AppManagement.Get("environments/{id}/operations/{operationId}?api-version=2024-10-01")` | `status`: NotStarted / Running / Succeeded / Failed / Canceled; `error.message` |

Errors: the host prefixes every failure with `Power Platform request failed:`. A 401/403, "No access token" or "not enabled" error shows the setup banner (D3) with the three permissions.

## 2. Cell model

| Cell | When | Selectable action |
|---|---|---|
| `1.2.3` | installed, no newer version available | — |
| `1.2.3 → 1.3.0` ⬆ | newer version available (D5) | Update |
| ✗ failed | `state` InstallFailed / UninstallFailed, `lastError.message` shown | Retry |
| ⏳ | Installing / InstallRequested / InstallScheduled / InstallRetrying / Uninstalling | — |
| ○ available | not installed, installable (shown with "Show not installed") | Install |
| — | not in that environment's catalog | — |

Rows: apps installed in at least one selected environment. "Show not installed" adds apps available but installed nowhere selected. Filter by name; "Only updates" hides rows with nothing to do.

## 3. Run

Per environment: a queue in table order, one install at a time: POST, then poll until it finishes, then the next. Up to 3 environments run at once. Each cell shows queued / running / succeeded / failed (with the error). When everything is done, the affected environments are read again. Results table, CSV export of the results.

## 4. Tests

e2e with a mocked host (`window.powerplatformAPI` with `EnvironmentManagement` and `AppManagement`):
- 3 environments, one Production, one without Dataverse (filtered out);
- apps with an update, up to date, failed, installing, available-only, and one `customHandleUpgrade`.

Checks:
- the matrix renders, and the update is derived (D5);
- "Select all updates" skips the `customHandleUpgrade` package;
- the preview orders operations per environment, and the Production confirm is shown;
- installs run one per environment at a time, environments in parallel;
- an operation id is polled to Succeeded; a 202 with no body falls back to package-state polling; a failure shows the error;
- environments are re-read after the run;
- the pac script and CSV are correct;
- the setup banner appears on a 403;
- the debug log check (shared helper) passes.

## 5. Probe (owner, 15 min, before trusting D5 and D7)

Use a connection with the Power Platform API enabled, Debug log on, and one environment where PPAC shows an app with **Update available**. Load that environment, Save log, and record:

- [ ] Does the `NotInstalled` list contain the same `uniqueName` with the newer version (D5)? If not, what in either response marks the update (`state`, `instancePackageId`, a second entry in `Installed`)?
- [ ] Does `version` hold the package version in both lists?
- [ ] Install response: 200 with `lastOperation.operationId`, or 202 with no body?
- [ ] `operations/{id}`: the `status` values seen through a full install.
- [ ] Is `@odata.nextLink` used on either list, and in which casing?

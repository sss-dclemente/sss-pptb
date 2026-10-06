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
- [x] Install response: 200 with `lastOperation.operationId`, or 202 with no body? 200 with `lastOperation.operationId` (2026-10-06, PSA-DEV Sandbox, Storage Advisor Components 1.0.0.2 → 1.0.0.3, Succeeded in about 2.5 min).
- [ ] `operations/{id}`: the `status` values seen through a full install.
- [ ] Is `@odata.nextLink` used on either list, and in which casing?

## 6. Probe results (real tenant, 2026-10-02, debug log of 0.1.0; 5 environments, 34 installs)

- **D5 confirmed**: the `NotInstalled` list carries the newer version of an installed package under the same `uniqueName`. Derived updates installed and succeeded.
- Install response: 200 with `lastOperation.operationId` (and `packageUniqueName`, `packageVersion`, `lastOperation.state` = `InstallRequested`). Operation status went `NotStarted` → `Running` → `Succeeded` in about 2 minutes.
- List entries carry errors in **`errorDetails`** (not `lastError`), e.g. `PDS retrying: Deployment was interrupted.` Fixed in 0.1.1.
- **Two of four environments refused every install with a bare `HTTP 400`** within about 200 ms; the same packages installed in the other two. The host does not pass the response body on, so the reason is not visible. 0.1.1 explains the usual causes on a bare 400 and stops an environment's queue after two refusals in a row instead of sending every remaining install.
- No paging on either list (a single page per environment).
- Debug log caps (12 000 chars per line, 25 array items) hid most packages of a list response; raised to 64 000 and 60 in the shared debug module.

## 7. Uninstall (owner question, 2026-10-02): analysis; report built as 0.2.0 (§8), uninstall not built

**There is no uninstall in the Power Platform API.** `AppManagement` has four operations: list tenant packages, list environment packages, install, and install status (`pac app-management` mirrors them). PPAC's own "Uninstall" exists only for a few apps (Customer Insights), through an API that isn't public.

**The documented route is per environment, in Dataverse:** delete the app's managed solutions, in order. For example, Microsoft's Business performance analytics uninstall lists 19 solutions to delete one by one, and Traceability lists 6 with "common" last. Two Dataverse messages make that safe to script:
- `RetrieveDependenciesForUninstall(SolutionUniqueName)`: what blocks deleting a solution;
- `UninstallSolutionAsync(SolutionUniqueName)`: deletes a managed solution in the background (returns an async operation to poll).

**Proposal: "Unused apps", read-only first.**
1. Map each installed package to its solutions:
   - the anchor solution (often the package's `uniqueName`, e.g. `msdyn_ContactCenterRTAAnchor`);
   - the managed solutions the anchor requires (`RetrieveRequiredComponents` on its components, or the solution's dependencies), from the same publisher.
2. "Unused" signals, per environment:
   - tables those solutions own have **no rows** (`RetrieveTotalRecordCount`, one call for many tables);
   - its model-driven apps are assigned to no security role.
   
   No usage telemetry is reachable through these APIs, so the result is "probably unused", never "unused".
3. Skip platform anchors that are installed automatically (Power Apps checker, Flow approvals, app deployment, Dataverse accelerator…). Removing them is refused ("Attempting to delete a restricted solution", seen in the real log) or they come back.
4. Uninstall, as a later phase:
   - dependency check per solution;
   - an order (anchor first, shared/common last);
   - preview with the tables and row counts that will be deleted;
   - typed confirmation;
   - `UninstallSolutionAsync` one solution at a time, polled.
   
   No backup is possible: the data in the app's tables is deleted.

Needs a Dataverse connection per environment (ToolBox connections). This doesn't come through the Power Platform API token, so it is a different setup from the rest of the tool.


## 8. Unused apps report (0.2.0, read-only)

Built from §7 steps 1–3, for the **connection's** environment only (Dataverse calls go through `dataverseAPI`, which has one connection). Code: `src/apps/unused.ts`, UI `src/unused-ui.ts`.

| Step | Call | Notes |
|---|---|---|
| Installed apps | `listPackages` (Power Platform API), or the matrix's read for that environment | Packages mid-install are left out |
| Solutions | `solutions?$filter=ismanaged eq true and isvisible eq true` | |
| Package → solutions | `msdyn_solutionhistories?$select=msdyn_name,msdyn_packagename,msdyn_operation,msdyn_result&$filter=msdyn_operation eq 0 and msdyn_packagename ne null`; on error the same without `$filter` (virtual table), then filtered in code; on error again, anchors only | **UNVERIFIED**: that `msdyn_packagename` equals the Power Platform API package `uniqueName`. Plus the anchor: solution `uniquename` = package `uniqueName` |
| Components | `solutioncomponents` types 1 and 80 by `_solutionid_value`, 20 per `or` | |
| Tables | `EntityDefinitions` (`IsCustomEntity` true, not intersect, not virtual) | `objectid` = `MetadataId` |
| Rows | `RetrieveTotalRecordCount(EntityNames=@p1)?@p1=<JSON, URI-encoded>` via `queryData`, 50 per call; a 0 or a missing table re-checked with `<set>?$select=<pk>&$top=1` | Snapshot < 24 h. A live row the snapshot missed = written recently = in use |
| Apps | `appmodules` with `$expand=appmoduleroles_association($select=roleid)`; without the expand on error | Info only, not in the verdict (first-party apps ship with roles) |

Ownership: a solution or table counts for a package only when no other installed package's solutions contain it. Shared ones are listed, never counted.

Verdict: platform list (§6 names) → `platform`; no solutions → `not-found`; no countable own table → `no-signal`; a live row the snapshot missed → `in-use`; all own tables 0 → `unused`; max ≤ 10 rows → `light` ("Seed data only?"); else `in-use`.

### Probe (owner, 10 min)

Debug log on, a connection to an environment with a few D365 apps, **Unused apps…**, Save log:
- [ ] Does `msdyn_solutionhistories` answer the filtered query, and does `msdyn_packagename` match the package unique names (e.g. `msdyn_SalesApp`)? If most apps show *Solutions not found* or *anchor* only, send the log.
- [ ] `RetrieveTotalRecordCount` response shape (`EntityRecordCountCollection.Keys/Values`).
- [ ] Any app marked *Probably unused* that you know is used: which tables did it count?

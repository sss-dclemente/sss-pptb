# SSS Solution XRay — backlog

Not built. Ordered by expected value. v1 = offline zip analysis only.

## v1.1 — Live mode (zip vs environment) — done, unreleased (ExportSolution result shape not yet verified against a live environment; Extras open)

Goal: pre-import check without leaving ToolBox. Pick a connection, pull the deployed solution, run the same pipeline, diff against the zip you are about to import.

Flow:
1. `toolboxAPI.connections.getActiveConnection()` → if null, tab stays disabled with a hint. Manifest changes: `features.connectionRequirement` stays `optional`, `multiConnection` → `optional` (secondary connection = compare two environments later), `minAPI` → `1.2.0`.
2. `dataverseAPI.getSolutions(["uniquename","friendlyname","version","ismanaged","publisherid"])` → picker (filter out System/Active/Default and `msdyn*`).
3. `dataverseAPI.execute({ operationName: "ExportSolution", operationType: "action", parameters: { SolutionName, Managed: <bool> } })` → response `ExportSolutionFile` (base64). Decode → `Uint8Array` → existing `parseSolutionZip`. **UNVERIFIED**: PPTB's `execute` result shape for this action; test against a sandbox first. Fallback: `queryData` cannot export; there is no other route without the host.
4. Result appears in the sidebar as a normal solution tagged `env: <connection name>`. All four tabs work unchanged.
5. Pre-import report = *Compare* (env → zip) + *Upgrade risk* with env as baseline. One button: "Check zip against environment".

Extras once live:
- ~~Resolve the zip's `MissingDependencies` against the environment~~ done (2026-11-27, unreleased): Inventory card *Check in <env>*, one read-only lookup per required component (`src/xray/deps-live.ts`). `RetrieveMissingDependencies` not used: it needs the solution already in the target.
- Use `dataverseAPI.getImportJobStatus` after a `deploySolution` triggered elsewhere (see post-import tab).

Risks: ExportSolution on large solutions takes minutes and returns tens of MB over IPC; add a spinner and size warning. Managed export of an unmanaged solution needs `Managed: true`.

## v1.1 — Post-import tab (importjob viewer) — done

- [x] Built: offline file / paste and live `importjobs` source, failures-first table, counts per type, top error codes, JSON/CSV export, links to the loaded zip's inventory. Live source not yet verified against a live environment.

Goal: replace reading `importjob.data` XML by hand.

Sources, in order of convenience:
1. Offline: user pastes or opens the `importjob` XML / `formattedresults` file saved from the environment. Zip-free; fits the tool's offline promise.
2. Live: `dataverseAPI.queryData("importjobs?$select=importjobid,solutionname,progress,completedon,data&$orderby=createdon desc&$top=20")` → pick a job → parse `data`.

Parsing: `<importexportxml><solutionManifests><solutionManifest result="success|failure" ...>` plus per-component nodes (`<entities><entity ... result= errorcode= errortext=>`, `<workflows>`, `<webresources>`, `<securityroles>`, `<connectionreferences>`, `<environmentvariables>` …). Output: one table — component, type, result, error code, error text — filtered to failures/warnings by default, with counts per type and the top error codes. Export JSON/CSV.

Merge with XRay: highlight importjob failures against the zip's inventory (same schema names) so a failed component is one click from its definition.

## Smaller items

- Deployment settings scaffold: export `deploymentSettings.json` skeleton (connection references + environment variables found in the zip) for `pac solution import --settings-file`.
- Compare: option to ignore version-only changes in forms/views (needs form XML hashing rather than counts).
- [x] Inventory: parse `Workflows/*.json` for flow triggers and connector list.
- Inventory: parse `PluginAssemblies` folder for DLL sizes.
- Inventory: itemise collections currently only counted (`Templates`, `EntityMaps`, `customapis`, `EntityDataProviders`).
- Install order: when the same unique name is loaded twice, prefer the highest version instead of first loaded.
- Persist last-used tab and diff options via `toolboxAPI.settings`.
- Real screenshots for README; request Verified badge after v1.0.0 and 10 MAU.
- Inter-tool invocation (`pptb.config.json`): accept a zip path as prefill so other SSS tools can hand over a solution.

## Removed tools (2026-11-18)

Access Checker, Dependency Cleaner, Offboarding Wizard and Audit Config Matrix were removed from this repo; their npm packages are deprecated and the last published versions remain installable. The Access Checker `RetrieveUserPrivileges` team-depth finding that lived here moved to [PPTB-NOTES.md](PPTB-NOTES.md) §14.

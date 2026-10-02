# SSS Solution XRay — backlog

Not built. Ordered by expected value. v1 = offline zip analysis only.

## v1.1 — Live mode (zip vs environment)

Goal: pre-import check without leaving ToolBox. Pick a connection, pull the deployed solution, run the same pipeline, diff against the zip you are about to import.

Flow:
1. `toolboxAPI.connections.getActiveConnection()` → if null, tab stays disabled with a hint. Manifest changes: `features.connectionRequirement` stays `optional`, `multiConnection` → `optional` (secondary connection = compare two environments later), `minAPI` → `1.2.0`.
2. `dataverseAPI.getSolutions(["uniquename","friendlyname","version","ismanaged","publisherid"])` → picker (filter out System/Active/Default and `msdyn*`).
3. `dataverseAPI.execute({ operationName: "ExportSolution", operationType: "action", parameters: { SolutionName, Managed: <bool> } })` → response `ExportSolutionFile` (base64). Decode → `Uint8Array` → existing `parseSolutionZip`. **UNVERIFIED**: PPTB's `execute` result shape for this action; test against a sandbox first. Fallback: `queryData` cannot export; there is no other route without the host.
4. Result appears in the sidebar as a normal solution tagged `env: <connection name>`. All four tabs work unchanged.
5. Pre-import report = *Compare* (env → zip) + *Upgrade risk* with env as baseline. One button: "Check zip against environment".

Extras once live:
- Resolve the zip's `MissingDependencies` against the environment: query `solutioncomponent` / `dependency` tables (or `RetrieveMissingDependencies` via `execute`) to turn "declared missing" into "actually missing here".
- Use `dataverseAPI.getImportJobStatus` after a `deploySolution` triggered elsewhere (see post-import tab).

Risks: ExportSolution on large solutions takes minutes and returns tens of MB over IPC; add a spinner and size warning. Managed export of an unmanaged solution needs `Managed: true`.

## v1.1 — Post-import tab (importjob viewer)

Goal: replace reading `importjob.data` XML by hand.

Sources, in order of convenience:
1. Offline: user pastes or opens the `importjob` XML / `formattedresults` file saved from the environment. Zip-free; fits the tool's offline promise.
2. Live: `dataverseAPI.queryData("importjobs?$select=importjobid,solutionname,progress,completedon,data&$orderby=createdon desc&$top=20")` → pick a job → parse `data`.

Parsing: `<importexportxml><solutionManifests><solutionManifest result="success|failure" ...>` plus per-component nodes (`<entities><entity ... result= errorcode= errortext=>`, `<workflows>`, `<webresources>`, `<securityroles>`, `<connectionreferences>`, `<environmentvariables>` …). Output: one table — component, type, result, error code, error text — filtered to failures/warnings by default, with counts per type and the top error codes. Export JSON/CSV.

Merge with XRay: highlight importjob failures against the zip's inventory (same schema names) so a failed component is one click from its definition.

## Smaller items

- Deployment settings scaffold: export `deploymentSettings.json` skeleton (connection references + environment variables found in the zip) for `pac solution import --settings-file`.
- Compare: option to ignore version-only changes in forms/views (needs form XML hashing rather than counts).
- Inventory: parse `Workflows/*.json` for flow triggers and connector list; parse `PluginAssemblies` folder for DLL sizes.
- Inventory: itemise collections currently only counted (`Templates`, `EntityMaps`, `customapis`, `EntityDataProviders`).
- Install order: when the same unique name is loaded twice, prefer the highest version instead of first loaded.
- Risk: user-editable weights (settings API `toolboxAPI.settings`) and a "why" popover per factor.
- Persist last-used tab and diff options via `toolboxAPI.settings`.
- Real screenshots for README; request Verified badge after v1.0.0 and 10 MAU.
- Inter-tool invocation (`pptb.config.json`): accept a zip path as prefill so other SSS tools can hand over a solution.

## RetrieveUserPrivileges understates team-inherited depth (fixed in 0.1.6)

`fetchUserPrivileges` backed the `platform` column in **table mode**, and table mode displays `platformDepth ?? bestDepth` as the answer. Per the Web API reference for [RetrieveUserPrivileges](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrieveuserprivileges):

> For privileges that the user inherits through their team membership, this function only returns the **Basic** (user-level) depth, regardless of the actual depth granted by the team's security roles.

So table mode reported Basic where the effective depth was Local, Deep or Global, for exactly the "user with a mix of direct role + team role" case `docs/RELEASE.md` asks to test. Record mode was never affected: it uses `RetrievePrincipalAccess`, computed per record.

Replaced with [RetrieveUserPrivilegeByPrivilegeName](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/retrieveuserprivilegebyprivilegename), which returns the real effective depth including team roles. It resolves one privilege per call, so the tool asks only for the eight rights of the table being checked rather than every privilege in the environment, and caches per user and privilege. A right with no privilege for the table, such as Assign or Share on an organization-owned table, has no definition to ask about and is skipped.

`RetrieveUserSetOfPrivilegesByNames` would do the same in a single call, but its parameter is a `Collection(Edm.String)` and the host serializes arrays as JSON without a collection branch. Given PPTB-NOTES §12, that serialization needs verifying against a live environment before it is worth the change; `PrivilegeName` is an `Edm.String`, which the host provably handles.

The e2e mock previously returned team-derived privileges at their real depth, so the existing "table-level Share Local via team" assertion passed while a real environment would have shown Basic. It now models `RetrieveUserPrivileges` faithfully, defect included, and asserts the tool never calls it. Against the old implementation the suite fails four assertions, two of them on the depth itself.

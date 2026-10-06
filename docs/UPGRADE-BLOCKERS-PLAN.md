# UPGRADE-BLOCKERS-PLAN — upgrade pre-flight for "cannot be deleted" (F2)

Status: BUILT in Dependency Cleaner 1.1.0 (tab **Upgrade blockers**, `src/deps/upgrade.ts`, `src/upgrade-ui.ts`, `scripts/upgrade-e2e.mjs`). Owner approved building on 2026-10-01 before the §4 probe ran: every UNVERIFIED call below is parsed defensively and has a fallback. Run the probe and adjust if the real shapes differ.

Built as planned, plus:
- D2: apps, canvas apps / custom pages and web resources are also matched by **unique name** between Dev and target, in case imported ids differ (the §4 question). Fixes look the app and the canvas app up in Dev by unique name.
- When `msdyn_componentlayers` fails or returns nothing, the dependent is placed by solution membership in the target and flagged (order and unmanaged layer unknown).
- D8: JS web resources and site maps only; `appaction` scanning is deferred.
- Restore re-adds app components removed by a fix (`AddAppComponents` + `PublishXml`).

One-liner: before you upgrade solution S in Test/Prod, list every component the upgrade will delete, every component that will block that delete, **where** the blocker lives (S in Dev, another managed solution, or the unmanaged layer in the target), and the fix. Canvas apps and custom pages come first.

Facts: `docs/PPTB-NOTES.md` (§12: an `Edm.Guid` function parameter must go through `queryData`). Reuses Dependency Cleaner (`tools/dependency-cleaner/src/deps/fetch.ts`: `queryAll`, `queryByIds`, `pool`, `fetchComponents`, `fetchOwningSolutions`, `retrieveRequired`, `resolveNames`, backup/restore).

---

## The problem

On upgrade (`DeleteAndPromote`), Dataverse deletes each component that S no longer contains **and** that no other managed solution holds. A delete fails when a **dependent** component outside the delete set still references it: "The component cannot be deleted because it is referenced by…". The platform only checks the topmost layer of each dependent ([Removing dependencies](https://learn.microsoft.com/power-platform/alm/removing-dependencies)), so you fix one blocker, retry, and hit the next. Each round costs a stage → fail → uninstall `_Upgrade` → re-export → re-import.

Canvas apps and custom pages (`canvasapp`, component type 300; `canvasapptype` 0 canvas, 1 component library, 2 custom page) make this worse:

| Removed (required) | Typical dependent that blocks | Where the dependent usually lives |
|---|---|---|
| Custom page | Model-driven app (`appmodule`, 80): page still in `appmodulecomponent`, even after "Remove from navigation" | App in another solution, or an unmanaged app layer in the target |
| Custom page | Site map (62) SubArea | Same app's site map, often in another solution |
| Component library | Canvas apps and custom pages that import it | Other solutions |
| Connection reference / env var / table / column | Canvas app or custom page that uses it as a data source | Another solution's app not yet re-released |

Goal: **one pre-flight run = the complete blocker list**, not one per failed import.

## 0. Decisions (to approve)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Home | New **"Upgrade blockers"** tab in SSS Dependency Cleaner (v2), not a new tool | Same domain (dependencies), same connections (primary = Dev, secondary = target), same fetch, name and backup code. Plan D1 there already defers "deletion blockers" to later |
| D2 | Input | **Two connections**: Dev (unmanaged S) + target (managed S). Removed set = target membership − Dev membership, matched by `objectid` | Imported solution-aware components keep their id, so there's no zip-to-metadata name mapping. Zip input (via the XRay parser) comes in v2 for targets you can't reach from Dev's machine |
| D3 | Delete set | A component counts as *deleted* only when no other managed solution in the target holds it. Others show as "survives, held by T" (info) | Matches the platform rule. Without this filter the list is mostly noise |
| D4 | Blocker check | `RetrieveDependenciesForDelete(ObjectId, ComponentType)` in the **target** for each deleted component, then drop dependents that are themselves in the delete set | This is the platform's own check, so we predict exactly what the import will say |
| D5 | Classification | Each blocker gets one fix location: **Dev / S** (S's own component still references it), **Release T first** (topmost layer is managed solution T), **Target unmanaged** (topmost layer is Active) | That's the three actions a person can take. The grouping *is* the plan |
| D6 | Writes v1 | Dev only: `RemoveAppComponents` (page or table out of a model-driven app), `RemoveSolutionComponent`, then `PublishXml` for touched app modules. Behind preview → backup → confirm, as in the existing tool | Dev fixes are reversible (re-add). Target writes are not |
| D7 | Writes v2 | Target: `RemoveActiveCustomizations` for an Active-layer blocker on a component with a managed base. Per-row confirm, Production banner | Can't be undone, and data on the layer is lost ([Solution layers](https://learn.microsoft.com/power-apps/maker/data-platform/solution-layers#remove-an-unmanaged-layer)) |
| D8 | Untracked references | Report-only "runtime break" list: JS web resources with `navigateTo({pageType:"custom", name})`, form XML with an embedded canvas control on the app name, `appaction` rows that name the page | These don't block the upgrade, but they break right after it. A cheap text scan of what's already loaded |

## 1. Data

| Need | Call | Notes |
|---|---|---|
| S in both envs | `fetchSolutions` on primary and target; S must be unmanaged in Dev and managed in target | Otherwise stop with a message |
| Membership | `fetchComponents(api, solutionId)` on both | Dev tables with `rootcomponentbehavior = 0` cover their subcomponents: treat every target row whose `rootsolutioncomponentid` points at such a table as kept |
| Removed set R | target rows − Dev rows, by `objectid` + `componenttype` | |
| Other holders | `fetchOwningSolutions(target, R ids)` → keep managed solutions ≠ S (and not `_Upgrade` of S) | Sets "survives, held by T" (D3) |
| Blockers | `queryData("RetrieveDependenciesForDelete(ObjectId=<guid>,ComponentType=<int>)")` on target, `pool` 4 | Guid → `queryData` (§12). Response `EntityCollection` of `dependency`: `dependentcomponentobjectid`, `dependentcomponenttype`, `dependentcomponentbasesolutionid`. Parse defensively like `retrieveRequired` |
| Topmost layer of a dependent | `msdyn_componentlayers?$filter=msdyn_componentid eq '<id>' and msdyn_solutioncomponentname eq '<name>'&$select=msdyn_solutionname,msdyn_order` | Max `msdyn_order` wins. `Active` = unmanaged. Needs the component name string per type (`CanvasApp`, `AppModule`, `SiteMap`…) |
| Does S's Dev copy still reference it? | `retrieveRequired(dev, dependentId, type)` and look for the removed id | Only when the dependent is also in Dev S. Yes → "Fix in Dev"; no → no blocker, the upgrade replaces it |
| Dynamic component types | `solutioncomponentdefinitions?$select=solutioncomponenttype,name,primaryentityname` | Connection references and other solution-aware tables have per-org type codes |
| Names | `resolveNames` + `canvasapps?$select=name,displayname,canvasapptype`, `appmodules?$select=uniquename,name`, `sitemaps?$select=sitemapnameunique` | |
| Runtime-break scan (D8) | `webresourceset?$select=name,content&$filter=webresourcetype eq 3` (base64 JS), `systemforms` formxml for tables in R's apps, `appactions` | Text match on the canvas app `name`. Report only |

## 2. Classification

For each deleted component `c` and each dependent `d` from D4:

```
if d in R                                  → ignore (deleted together)
layer = topmost(d)
if layer == "Active"                       → TARGET-UNMANAGED   fix: edit/remove unmanaged layer in target (v2 action)
else if layer == S:
    if d in Dev S and Dev d still requires c → FIX-IN-DEV        fix: RemoveAppComponents / edit / RemoveSolutionComponent
    else                                   → none (new version of d drops the reference)
else (layer == T, managed)                 → RELEASE-T-FIRST    fix: new T without the reference, upgrade T before S
```

Output, grouped by fix location, then by dependent:

- **Fix in Dev (S)**: actionable in this tab.
- **Release first**: solution T, its version in the target, the components to change in T's Dev. Order line: `T → S`.
- **Target unmanaged**: component, layer, a deep link to "See solution layers".
- **Survives** (D3) and **Runtime break** (D8): info.
- Export: Markdown + CSV (the release ticket).

## 3. Write path (v1, Dev only)

1. Tick FIX-IN-DEV rows → preview: `RemoveAppComponents(AppId, Components[])`, `RemoveSolutionComponent(type, id, S)`.
2. Backup JSON (app module component list, solution membership), as in the existing tool. Confirm stays disabled until it's downloaded.
3. Execute → `PublishXml` `<importexportxml><appmodules><appmodule>{id}</appmodule></appmodules></importexportxml>` for touched apps.
4. Re-run the check. Expect zero FIX-IN-DEV rows.

## 4. Probe before building (owner, 20 min, one Dev + one Test env)

Use a custom page P that's in a model-driven app M, both shipped managed to Test. In Dependency Cleaner devtools, with Test as a connection:

```js
const P = "<canvasappid of P>";
console.log(await dataverseAPI.queryData(`RetrieveDependenciesForDelete(ObjectId=${P},ComponentType=300)`, "secondary"));
console.log(await dataverseAPI.queryData(`msdyn_componentlayers?$filter=msdyn_componentid eq '<appmoduleid of M>' and msdyn_solutioncomponentname eq 'AppModule'&$select=msdyn_solutionname,msdyn_order`, "secondary"));
console.log(await dataverseAPI.queryData(`canvasapps?$select=canvasappid,name&$filter=name eq '<P unique name>'`, "primary"));
console.log(await dataverseAPI.queryData(`canvasapps?$select=canvasappid,name&$filter=name eq '<P unique name>'`, "secondary"));
```

Record:

- [ ] Does `RetrieveDependenciesForDelete` return M (type 80) for P? The exact response shape.
- [ ] Is the site map (62) also listed, or only the app module?
- [ ] Does `msdyn_componentlayers` work through `queryData`, and what does `msdyn_solutionname` show for an unmanaged layer (`Active`)?
- [ ] Is `canvasappid` the same in Dev and Test? (D2 depends on it.)
- [ ] For a canvas app that uses a connection reference: does `RetrieveDependenciesForDelete` on the connection reference list the app?

## 5. Effort

M–L, about 2 sessions:
- fetch + classify ~200 LOC
- tab UI ~250 LOC
- Dev write path reuses the existing preview/backup (~80 LOC new)
- mock + e2e ~200 LOC

## 6. Later

- v2: zip input (XRay parser) instead of Dev connection; target writes (D7); multi-solution release order across several S at once (simulator from the upgrade-planner discussion).
- ~~v2: import a failed `importjob` and turn its "cannot be deleted" errors into the same table, for when the upgrade already failed.~~ BUILT in 1.5.0 as the **Failed import** tab (`src/deps/failed.ts`, `src/failed-ui.ts`, `scripts/failed-e2e.mjs`): reads `msdyn_solutionhistories` (the Solution history page's source) or pasted error text instead of `importjob`, needs one connection only, and brings the D7 target write (`RemoveActiveCustomizations`) plus a re-point of unmanaged cloud flows to another connection reference of the same connector (undoable).
- Ownership linter (prevention): components in more than one unmanaged solution in Dev, with custom pages put next to their host app.

## 7. Probe results (real tenant, 2026-10-02, debug logs of 1.1.0 and 1.1.1; Dev sandbox → Prod)

- `fetchComponents` asked for `_rootsolutioncomponentid_value`, which does not exist: `rootsolutioncomponentid` is a Uniqueidentifier, not a lookup. Diagnose and Upgrade blockers both failed on their first query. Fixed in 1.1.1.
- `RetrieveDependenciesForDelete` through `queryData` works. The response is `{ value: [dependency] }` with `dependentcomponentobjectid`, `dependentcomponenttype`, `dependentcomponentparentid` (all zeros when there is no parent) and `dependentcomponentbasesolutionid`. The parser reads it as is. 48 of 138 calls returned dependents.
- `msdyn_componentlayers` works with `msdyn_componentid eq '<id>'` (quoted) and `msdyn_solutioncomponentname` = `Workflow`, `SystemForm`, `CanvasApp`, `AppModule`, `SiteMap`, `EntityRelationship`, `SdkMessageProcessingStep`, `AppElement`. It **ignores `$select`** and returns `msdyn_changes` / `msdyn_componentjson` (large). The unmanaged layer is named `Active`, as assumed. `msdyn_order` is ascending from the bottom layer.
- **Ids differ between environments** for model-driven apps and canvas apps / custom pages: the same app has another `appmoduleid` / `canvasappid` in Dev and Prod. Matching them by unique name (D2) was needed.
- The runtime-break scan read every JavaScript web resource with its content in one request; the host failed to parse the response (`Parse Error: JS Exception`). 1.1.2 reads ids and names first, then content five files at a time.


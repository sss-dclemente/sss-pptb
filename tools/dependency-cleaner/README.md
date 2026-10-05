# SSS Dependency Cleaner

Why does my solution depend on `msdyn_*`, and how do I get rid of it? Inside [Power Platform ToolBox](https://www.powerplatformtoolbox.com): pick an unmanaged solution in dev, see every dependency on a managed solution the target environment does not have (Field Service, Sales, Customer Service, Project Operations…), see which component in *your* solution causes it, and fix it in place. Then export again and the import works.

Built by [Simple Smooth Safe](https://simplesmoothsafe.com).

## What it does

- **Diagnose** — for each component of the solution, asks Dataverse for its required components (`RetrieveRequiredComponents`, 4 in parallel, with progress, cancel and a per-session cache), finds the managed solution that owns each one (see *How ownership is decided*), and groups the result by the component you can act on. A component that is itself owned by a managed solution (a Field Service column pulled in by "add all assets") counts too.
- **Filter** — publisher prefixes or solution names, default `msdyn, msdynce, mspp`. Editable, so it works for any ISV.
- **Target awareness** — with a secondary connection (the target environment), solutions already there are marked "present in target" and hidden by default; any managed solution missing in the target is a blocker. Without one, everything matching the filter is a blocker.
- **Fix** — per finding, pick a fix:
  - *Convert table to shell*: a table added with all assets is removed and added back with `DoNotIncludeSubcomponents`. Every subcomponent that would leave is listed and can be ticked back in or out. Ticked by default: columns with your publisher prefix, the forms/views you edit, and every form, view and chart not owned by a managed solution matching the filter (these are named by display name, so ownership decides, not the prefix). A table cannot be converted to a shell by one finding and removed by another: the preview refuses the conflict until you pick one.
  - *Remove from solution* for a column, form or view included directly.
  - *Edit form*: remove the cells/controls bound to the msdyn columns, hidden fields (`<hiddencontrols>`) bound to them, and subgrids / quick views on msdyn tables (quick views are read from the entity-escaped `<QuickForms>` text real formxml uses); never the primary name or a required column, which are reported instead; drop empty sections.
  - *Edit view*: strip the msdyn attributes, conditions, orders and link-entities from fetchxml and the matching cells from layoutxml.
  - Relationships, sitemap, apps, ribbon, charts, processes, web resources and plugin steps are report only, with a link to the solution in the maker portal.
- **Preview → backup → confirm** — the preview lists every operation with a before/after XML diff. Confirm stays disabled until the backup (`dependency-cleaner-backup-<solution>-<timestamp>.json`: original form/view XML and the full solution membership) is saved. Then: membership changes → form/view updates → one `PublishXml` for the touched tables → the diagnosis runs again and shows fixed / still present.
- **Restore** — load a backup, preview, apply: original XML written back, removed components re-added, tables put back to all assets, then published. A backup only restores into the environment it was taken in (its url is recorded in the file).
- **Slim** — what does not belong in an unmanaged solution: every component that is neither unmanaged (yours) nor a managed component with an unmanaged layer (customized by you) is removed from the solution. Managed tables added with all assets become shells with only your subcomponents re-added. Preview → backup → confirm; membership only, the environment keeps every component. See *Slim* below.
- **Cycles** — tick the unmanaged solutions you ship and the base solution that is always imported first: which solution needs which, the cycles that leave no import order, and the fixes: shared components into the base, a copy into the solution that needs them, or a move of the dependent. Required components no selected solution carries go to the base too. Preview simulates the result before anything is written; Undo reverses an apply. See *Cycles* below.
- **Upgrade blockers** — before you upgrade a managed solution in Test or Prod (secondary connection), see what the upgrade will delete and what will block each delete ("cannot be deleted, referenced by…"), all in one run instead of one failed import per blocker. See *Upgrade blockers* below.
- **Offline** — open an exported solution zip and read `solution.xml` `<MissingDependencies>` (the list the import checks), grouped and filtered the same way. No connection needed.
- **Name lookups that fail** (metadata, form or view names) are shown as a warning above the findings, and every finding that involves such a component is report only: an edit keyed on an unresolved name would change nothing. Reads by id run 4 at a time; a throttled read (HTTP 429) is retried once after its `Retry-After`.
- **Export** — findings as JSON or CSV (cells a spreadsheet would read as a formula are prefixed with `'`).

## How ownership is decided

A component belongs to the solution that **created** it, not to every managed solution that has a solution component row for it. In a D365 dev environment every msdyn app that extends account or contact (Sales, Field Service…) has a row for the table and often for its main form; those tables and forms are still System's. First match wins:

1. Dataverse names the base (creating) solution in a dependency row (`requiredcomponentbasesolutionid`), and it is managed: that solution.
2. Platform component: table `IsCustomEntity = false`, column `IsCustomAttribute = false`, or, for forms, views and other types, the System solution contains it. Owner System, never in the filter, always present in the target.
3. Exactly one other managed solution contains it: that one.
4. Several: the one whose publisher prefix is the component's schema-name prefix (`msdyn_x` → `msdyn`); else the first when all match the filter; else the first outside the filter. Ambiguous ownership is never read as msdyn-owned, so nothing is removed or dropped on a guess.

A dependency is present in the target when any managed solution that contains the component is installed there.

Safety: managed solutions are never offered and writes are refused if the solution turns out to be managed when re-checked right before writing; a Production-looking connection needs an explicit tick. Changing the connection clears the diagnosis, the preview and the backup tick; Confirm and Restore re-read the current connection and refuse when it is not the one the plan was made on. After a new diagnosis, a picked fix the finding no longer offers is dropped. Confirm runs once, however often it is clicked, and the re-diagnosis after a fix always covers the solution that was fixed, whatever the picker shows.

## Upgrade blockers

Pick the Dev solution you are about to ship; the target is the secondary connection, where the solution is installed managed.

1. **Removed** — components in the target's solution that Dev's solution no longer has. Matched by id; model-driven apps, canvas apps / custom pages and web resources also by unique name (their ids can differ between environments). A table Dev includes with all assets keeps every subcomponent that still exists in Dev.
2. **Deleted** — removed and held by no other managed solution in the target. The rest **survives** (listed with the solution that holds it).
3. **Blockers** — `RetrieveDependenciesForDelete` in the target for each deleted component, the same check the import runs. Dependents deleted by the same upgrade, or part of a table it deletes, are dropped.
4. **Where to fix** — from the dependent's top layer in the target (`msdyn_componentlayers`; when that is unavailable, from solution membership, flagged):
   - *Fix in Dev*: the top layer is your solution and Dev's copy still references the component (`RetrieveRequiredComponents` in Dev). For a model-driven app that still lists a custom page, table, form, view or chart: **Remove from the app** (`RemoveAppComponents` in Dev + `PublishXml` for the app), behind preview → backup → confirm. Other dependents can be removed from the solution too, so the upgrade deletes both.
   - *Release first*: another managed solution's layer references it. Ship a new version of that solution and upgrade it first; the tab shows the order.
   - *Target unmanaged*: an unmanaged (Active) layer in the target references it. Report only: remove the active customization or edit it there.
   - *Resolved*: your solution's new version no longer references it. No action.
5. **Runtime breaks** — deleted custom pages and canvas apps whose unique name appears in the target's JavaScript web resources (`navigateTo({ pageType: "custom", name })`) or site maps. Not tracked as dependencies: the upgrade succeeds and these fail afterwards.

Export the result as a Markdown checklist (release ticket) or CSV. The Restore tab re-adds app components removed by a fix.

## Slim

Pick an unmanaged solution in Dev and Analyze. Each `solutioncomponent` row is classified, first match wins:

1. **Keep: yours** — unmanaged **and** custom: `IsManaged = false` with `IsCustomEntity` / `IsCustomAttribute` / `IsCustomRelationship` / `IsCustomOptionSet`, or an unmanaged record (form, view, process, role…) that the `System` solution does not contain. Platform components (account, its system columns, System forms) are unmanaged too but not yours: they are judged like managed ones. The backing table of a record type comes from `solutioncomponentdefinitions.primaryentityname` when the tool does not know it (connection references).
2. **Keep: included by your table** — subcomponent of one of your tables added with all assets (an implicit member).
3. **Unknown: kept** — the origin or the layers could not be read; the error is listed. Nothing is removed on a guess.
4. **Keep: customized** — an `Active` (unmanaged) layer in `msdyn_componentlayers` that changes something real: its `msdyn_changes` names an attribute other than bookkeeping (`modifiedon`, `overwritetime`, `solutionid`, `statecode`…). In a copied or long-lived environment nearly every component carries an Active row with no change at all; those count as not customized and the summary says how many. Read once per managed or platform component (4 in flight, progress, cancel). The layer is environment-wide, so a component that other unmanaged solutions also contain is flagged *also in …*: tick it to remove anyway.
5. **Convert to shell** — managed or platform table added with all assets: removed and re-added with `DoNotIncludeSubcomponents`, then the subcomponents classified keep are added back. A table with nothing of yours in it is removed whole.
6. **Keep: parent** — a pristine managed table or environment variable definition whose subcomponent or value stays (option *Keep parents of kept components*, on by default).
7. **Remove** — managed or platform, no real customization; the owning managed solution (base layer) is shown.

Every row of Remove and Shell can be unticked, every kept row ticked. **Preview** lists the operations (shell conversions first, then subcomponents, then roots), **Download backup** saves the full membership in the Dependency Cleaner backup format, **Confirm and apply** runs them: a failure marks its row and the batch continues, except inside one shell conversion, where the rest of that table's group is skipped. The analysis then runs again. The **Restore** tab re-adds what left and puts shells back to all assets. Export the classification as Markdown (checklist) or CSV. Plan and probe: docs/SOLUTION-SLIMMER-PLAN.md.

## Cycles

Dependencies are environment-wide facts (a form needs a column); solutions only decide who carries them. When solution A contains a component that needs one only solution B contains, A must be imported after B. Two solutions needing each other have no import order: each managed import fails on a missing dependency. Tick two or more unmanaged solutions and pick the **base** solution (the one always imported first), then Analyze:

1. Every member of every selected solution → `RetrieveRequiredComponents` (cached for the session, shared with Diagnose). A required component in the same solution is internal; one whose base solution is managed is Diagnose's business and only counted; one the base solution contains is satisfied; one another selected solution contains is an **edge**; one nobody carries is an **orphan** (the export would report it as a missing dependency).
2. Edges form a graph; cycles are its strongly connected components; without cycles the **import order** is shown (base first).
3. Per edge and required component, pick a fix: **Add to base** (default inside a cycle; a table as a shell, a column brings its table shell along; tick *also remove* to move instead of copy, root rows only), **Copy into** the solution that needs it, **Move the dependents** to the solution that has it (root rows only), or nothing. Orphans are ticked into the base by default.
4. **Preview** lists the operations and simulates them: cycles, edges, orphans and import order *after* the fixes, so a move that only shifts the problem (or a removal that leaves a column behind) is visible before the write. **Download backup** saves the operations with their inverses; **Confirm and apply** runs them (a failure marks its row, the rest runs) and analyzes again. **Undo…** loads that backup and reverses it, in the same environment only. A table shell that came along with a column or form stays in the base after an undo: remove it with Slim or by hand.

Export the result as a Markdown checklist (import order, cycle rows, orphans) or CSV. Plan and probe: docs/CYCLES-PLAN.md.

## Screenshots

Synthetic sample data from the e2e harness (mocked ToolBox host). Replace with real captures.

![Diagnose: msdyn dependencies grouped by the component that causes them](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/dependency-cleaner/docs/img/diagnose.png)

![Upgrade blockers: what a managed upgrade deletes and what blocks each delete](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/dependency-cleaner/docs/img/upgrade-blockers.png)

![Cycles: Sales and Service need each other; fixes into the base solution, simulated import order](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/dependency-cleaner/docs/img/cycles.png)

![Slim: managed components without a customization, tables to convert to shells, kept rows folded](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/dependency-cleaner/docs/img/slim.png)

![Fix preview with before/after XML diff and backup](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/dependency-cleaner/docs/img/fix-preview.png)

![Offline zip analysis, dark theme](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/dependency-cleaner/docs/img/offline-dark.png)

## Install

**From the ToolBox marketplace** — search for "SSS Dependency Cleaner" once listed.

**From source**

```bash
cd tools/dependency-cleaner
npm install
npm run build
```

Then in ToolBox: Debug → *Load Local Tool* → select the `tools/dependency-cleaner` folder.

## Usage

1. Primary connection = the dev environment. Optionally a secondary connection = the target environment.
2. **Diagnose**: pick the solution, adjust the filter, run. Or **Slim**: pick the solution, Analyze, untick what must stay. Or **Cycles**: tick the solutions you ship, pick the base, Analyze. Or **Upgrade blockers**: pick the solution you are about to upgrade in the target, Analyze.
3. Pick a fix on the findings you want to act on, **Preview fixes…**, review, **Download backup**, **Confirm and apply**.
4. Export the solution again.

## Limitations

- **Upgrade blockers, UNVERIFIED against a live environment**: the response shape of `RetrieveDependenciesForDelete` through the host, the `msdyn_componentlayers` filter (`msdyn_componentid` as a quoted string, `msdyn_solutioncomponentname` = `CanvasApp`, `AppModule`, `SystemForm`…) and `"Active"` as the unmanaged layer's name, `AddAppComponents` / `RemoveAppComponents` with `@odata.type` component references (`entity` / `entityid` for a table), and whether imported components keep their ids (apps, canvas apps and web resources are also matched by unique name). Run the probe in docs/UPGRADE-BLOCKERS-PLAN.md §4 first.
- **Slim** (verified on a live environment, 1.3.0 → 1.3.1): the reads all answer (`primaryentityname`, `ismanaged` on every record-backed type, the layer component names). What the first run taught: platform components are `IsManaged = false` (hence the custom / System test) and Active layers are mostly phantom (hence the `msdyn_changes` test). One layer read per component that is not yours: a solution with 500 of them means 500 calls, 4 at a time, cancellable. The layer names of environment variables (`EnvironmentVariableDefinition`, `EnvironmentVariableValue`) are still UNVERIFIED: a type whose rows never come back lands in *Unknown: kept*.
- **Cycles, UNVERIFIED against a live environment** beyond the reads Diagnose and Slim verified: one `RetrieveRequiredComponents` per member of every selected solution (hundreds of calls for large solutions, 4 at a time, cached, cancellable). A required component that the base solution contains is taken as satisfied: that holds when the base is installed first, which the tool assumes and the import order shows.
- **`RemoveSolutionComponent` through `dataverseAPI.execute`** (verified failing with `ComponentId`, 1.3.0): the Web API action takes a `SolutionComponent` entity reference; 1.3.1 sends `{ SolutionComponent: { "@odata.type": "Microsoft.Dynamics.CRM.solutioncomponent", solutioncomponentid: <component id> }, ComponentType, SolutionUniqueName }` and, if that is refused, retries with the solutioncomponent row id. The `solutioncomponentid` value the server expects (component id, as the SDK's `ComponentId`, or the row id) is the one thing left to confirm on the next apply. `AddSolutionComponent` (`ComponentId`, `ComponentType`, `SolutionUniqueName`, `AddRequiredComponents`, `DoNotIncludeSubcomponents`) matches the documented action and is still UNVERIFIED through the host.
- `RetrieveRequiredComponents` is one call per component: a large solution means hundreds of calls. They run 4 at a time, can be cancelled, and are cached for the session. Its response shape through the host is also **UNVERIFIED**; the tool accepts `EntityCollection` as an array or as `{ Entities }`.
- Forms with msdyn PCF controls, libraries or event handlers get warnings, not edits. A view whose only filter or sort used msdyn columns gets a warning.
- Converting a table to a shell in a solution other developers use removes subcomponents they may rely on: read the list in the preview.
- Ownership (above) relies on the base solution Dataverse reports, table / column metadata and System membership. A custom form or view contained by several managed solutions of different publishers is treated as not msdyn-owned.

## Debug log

For troubleshooting, tick **Debug log** in the footer, reproduce the problem, then **Save log**: a `dependency-cleaner-debug-<timestamp>.txt` file with every ToolBox, Dataverse and Power Platform API call the tool made (the exact query or request, the response or error, timing), notifications, connection events and uncaught errors. The switch is remembered for this tool; `?debug=1` also turns it on. Off, nothing is recorded.

The file is written only where you save it. Secrets (keys named like password, secret, token, authorization) are redacted, and long strings, arrays and binary payloads are truncated, but responses still contain record data such as names and ids: review the file before you share it.

## Privacy

All data stays between ToolBox and your Dataverse environments: the tool talks to Dataverse only through the ToolBox `dataverseAPI` bridge, requests no CSP exceptions, and sends nothing anywhere else. Backups and exports are written to files you choose.

## Development

```bash
npm run build       # typecheck + Vite IIFE bundle + dist checks
npm run dev-watch   # rebuild on change; reload the tool tab in ToolBox
npm run validate    # @pptb/validate manifest rules
npm run xml-test    # form / view XML stripping
npm run e2e         # Playwright tests against dist/ with a mocked ToolBox host (needs playwright + Chromium): Diagnose/Fix/Restore, Upgrade blockers, Slim, Cycles
```

Stack: TypeScript, Vite, no framework, JSZip (offline tab). Types from `@pptb/types`.

## License

MIT. See [LICENSE](https://github.com/sss-dclemente/sss-pptb/blob/main/tools/dependency-cleaner/LICENSE).

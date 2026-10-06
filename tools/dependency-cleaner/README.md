# Dependency Cleaner

Why does my solution depend on `msdyn_*`, and how do I get rid of it? Inside [Power Platform ToolBox](https://www.powerplatformtoolbox.com): pick an unmanaged solution in dev, see every dependency on a managed solution the target environment does not have (Field Service, Sales, Customer Service, Project Operations…), see which component in *your* solution causes it, and fix it in place. Then export again and the import works.

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
- **Preview → backup → confirm** — the preview lists every operation with a before/after XML diff. Confirm stays disabled until the backup (`dependency-cleaner-backup-<solution>-<timestamp>.json`: original form/view XML and the full solution membership) is saved; a last confirmation names the environment (connection name and url), the number of operations and the way back. Then: membership changes → form/view updates → one `PublishXml` for the touched tables → the diagnosis runs again and shows fixed / still present.
- **Restore** — load a backup, preview, apply: original XML written back, removed components re-added, tables put back to all assets, then published. A backup only restores into the environment it was taken in (its url is recorded in the file).
- **Slim** — what does not belong in an unmanaged solution: every component that is neither unmanaged (yours) nor a managed component with an unmanaged layer (customized by you) is removed from the solution. Managed tables added with all assets become shells with only your subcomponents re-added. Preview → backup → confirm; membership only, the environment keeps every component. See *Slim* below.
- **Cycles** — tick the unmanaged solutions you ship and the base solution that is always imported first: which solution needs which, the cycles that leave no import order, and the fixes: shared components into the base, a copy into the solution that needs them, or a move of the dependent. Required components no selected solution carries go to the base too. Preview simulates the result before anything is written; Undo reverses an apply. See *Cycles* below.
- **Upgrade blockers** — before you upgrade a managed solution in Test or Prod (secondary connection), see what the upgrade will delete and what will block each delete ("cannot be deleted, referenced by…"), all in one run instead of one failed import per blocker. See *Upgrade blockers* below.
- **Failed import** — the upgrade already failed with "The connectionreference(…) component cannot be deleted because it is referenced by N other components": read the error from solution history (or paste it), see what still references the component in that environment, where each reference lives, and fix it there. See *Failed import* below.
- **Offline** — open an exported solution zip and read `solution.xml` `<MissingDependencies>` (the list the import checks), grouped and filtered the same way. No connection needed.
- **Name lookups that fail** (metadata, form or view names) are shown as a warning above the findings, and every finding that involves such a component is report only: an edit keyed on an unresolved name would change nothing. Reads by id run 4 at a time; a throttled read (HTTP 429) is retried once after its `Retry-After`.
- **Export** — findings as JSON or CSV (cells a spreadsheet would read as a formula are prefixed with `'`).

## What this tool changes

Diagnose, Offline and every analysis (Upgrade blockers, Slim, Cycles, Failed import before you apply) only read. Dataverse is written only by **Confirm and apply** on the Fix, Upgrade blockers, Slim, Cycles and Failed import tabs, by **Apply restore**, **Undo…** (Cycles) and **Undo flow changes…** (Failed import). Each of these runs only after a preview that lists every operation, and the apply buttons stay disabled until the backup is saved. A last confirmation dialog then names the environment (connection name and url), the number of operations and what they change, and the way back, or says plainly that there is none. A connection that looks like Production needs an extra tick. Writes are refused when the connection changed since the preview or when the solution turns out to be managed.

### Dataverse writes, by tab

**Diagnose → Fix** (primary connection, the unmanaged solution you diagnosed). The fixes run in this order: membership changes, then form and view updates, then one `PublishXml`. The first failure stops the rest. `PublishXml` still runs if a form or view was already updated.

| Fix | API | What changes | Way back |
|---|---|---|---|
| Convert table to shell | `RemoveSolutionComponent` (table), `AddSolutionComponent` with `DoNotIncludeSubcomponents = true`, then `AddSolutionComponent` for each subcomponent ticked to keep | Solution membership: the unticked subcomponents leave the solution. The table and its columns, forms and views stay in the environment. | Restore puts the table back with all assets |
| Remove from solution | `RemoveSolutionComponent` | One table, column, form or view leaves the solution. It stays in the environment. | Restore re-adds it |
| Edit form | `systemform` update of `formxml` | The form itself, in the environment (every solution that contains it sees the change): cells, controls, hidden fields, subgrids and quick views bound to the filtered columns or tables are removed, and sections left empty are dropped | The backup holds the original `formxml`. Restore writes it back |
| Edit view | `savedquery` update of `fetchxml` and `layoutxml` | The view itself, in the environment: filtered attributes, conditions, orders, link-entities and their layout cells are removed | The backup holds the original XML. Restore writes it back |
| (after edits) | `PublishXml` for the touched tables | Publishes customizations of those tables | None needed |

**Restore** (primary connection). Loads a backup saved by Fix, Upgrade blockers or Slim, compares it with the environment and previews the operations. Then it re-adds removed components (`AddSolutionComponent`), puts shell tables back to all assets (`RemoveSolutionComponent` + `AddSolutionComponent`), writes the backed-up `formxml` / `fetchxml` / `layoutxml` back, re-adds app components (`AddAppComponents`) and publishes (`PublishXml`). Limits:
- A backup restores only into the environment whose url it records, and only into an unmanaged solution.
- Restore takes no new backup. Form and view edits made after the backup are overwritten.
- A form or view deleted since the backup is not restored (listed as a note).
- A component that no longer exists in the environment cannot be re-added; its row fails.
- Restore cannot bring back an active customization removed in Failed import.

**Upgrade blockers** (writes only in Dev, the primary connection. The target, the secondary connection, is only read):

| Fix | API | What changes | Way back |
|---|---|---|---|
| Remove from the app | `RemoveAppComponents` on the Dev model-driven app, then `PublishXml` for the app | The app no longer lists the custom page, table, form, view or chart | The backup lists the removed app components. Restore re-adds them with `AddAppComponents` and publishes |
| Remove from the solution too | `RemoveSolutionComponent` in the Dev solution | Membership only: the dependent leaves the solution, so the upgrade deletes it as well | Restore re-adds it |

Layers in the target are never removed from this tab: *Target unmanaged* rows are report only.

**Slim** (primary connection, the selected unmanaged solution). Uses `RemoveSolutionComponent` for every row ticked for removal. Uses `RemoveSolutionComponent` + `AddSolutionComponent` (`DoNotIncludeSubcomponents = true`) + `AddSolutionComponent` for the kept subcomponents of each table converted to a shell. Membership only: nothing is deleted from the environment. A failure skips the rest of that table's steps; other operations still run. Way back: the backup holds the full membership. Restore re-adds what left and puts shells back to all assets.

**Cycles** (primary connection, the unmanaged solutions you ticked and the base solution). Uses `AddSolutionComponent` into the base solution or into the solution that needs the component (tables go in as shells with `DoNotIncludeSubcomponents`). Uses `RemoveSolutionComponent` from the solution that has it, for *also remove* and *Move the dependents*. Membership only. Way back: the backup lists the operations. **Undo…** runs the inverse operations, only in the environment the backup records. A table shell that came along with a column or form stays in the base after an undo.

**Failed import** (the environment the import failed in, often Test or Production. You pick it as the primary or the secondary connection):

| Fix | API | What changes | Way back |
|---|---|---|---|
| Remove active customizations | `RemoveActiveCustomizations(SolutionComponentName, ComponentId)` | Deletes the unmanaged (Active) layer of that component. The managed definition underneath takes over | **None. This is not reversible, by this tool or by the platform.** The backup keeps the layer's `msdyn_componentjson` as a record only, so you can re-create the customization by hand. Confirm needs an extra *cannot be undone* tick |
| Re-point flow to another connection reference | `workflow` update: `statecode` off (if the flow was on), `clientdata` with the new `connectionReferenceLogicalName`, `statecode` back on | The cloud flow's connection reference | The backup holds the previous `clientdata`. **Undo flow changes…** writes it back (off, update, on) |

The operations are independent: a failure marks its row and the rest runs.

### Files saved to disk

Files are saved only through the ToolBox save dialog, where you choose:
- **Backups.** `dependency-cleaner-backup-<solution>-<timestamp>.json` from Fix, Upgrade blockers and Slim. `dependency-cleaner-backup-cycles-<timestamp>.json` from Cycles. `dependency-cleaner-failed-import-<solution>-<timestamp>.json` from Failed import. They contain component ids and names, solution membership, form and view XML, flow `clientdata` and Active layer JSON.
- **Exports.** Findings JSON or CSV, and Markdown or CSV from Upgrade blockers, Slim, Cycles and Failed import.
- **Debug log.** Only when you save it.

### Browser storage

`localStorage` of the tool's page, per viewer:
- The view settings: find text, type filters, *Show present in target*, *Scan JS and site maps*, *Keep parents of kept components* and the Cycles base solution (`sss-view:dependency-cleaner`).
- The Debug log switch (`sss-debug:dependency-cleaner`).

### Nothing else

The tool never:
- deletes a component, record or solution from an environment. The only deletion is the Active layer removed by *Remove active customizations*.
- writes to a managed solution.
- imports, exports, upgrades or uninstalls solutions.
- changes business data records, security roles, users, teams, ownership or environment settings.
- writes to the target environment from Diagnose or Upgrade blockers.

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

## Failed import

For when the import already failed. One connection is enough: the environment the import failed in (the secondary connection with Dev as primary, or the primary alone).

1. **Find the error** — *Scan solution history* reads the last failed operations (`msdyn_solutionhistories`, `msdyn_result = false`; if the virtual table refuses the filter, the newest 100 rows are filtered here) and keeps those whose message names a component that "cannot be deleted because it is referenced by N other components". The newest one is checked at once. Or open *Paste an error instead*, paste the Failure details / Operation details text (the repeated fault XML counts once) and, optionally, the solution's unique name.
2. **Component** — the table name in the message gives the component type: `solutioncomponentdefinitions.primaryentityname` for per-org types (a connection reference's type is its table's ObjectTypeCode), a fixed map for the platform types. Shown with its name, or "no longer exists" / "nothing references it now" (import again).
3. **References** — `RetrieveDependenciesForDelete` in that environment, then each dependent's layers (`msdyn_componentlayers`, solution membership as fallback, flagged):
   - **Fix in this environment** — the top layer is unmanaged (`Active`).
     - Active layer on top of a managed solution (a flow edited or re-bound in Test/Prod): **Remove active customizations** (`RemoveActiveCustomizations`). The managed definition takes over. Cannot be undone: the backup keeps the layer's `msdyn_componentjson` as a record.
     - A cloud flow that names the connection reference in its `clientdata`: **Re-point flow to** another connection reference of the same connector in that environment. Off → `clientdata` → on, only `connectionReferenceLogicalName` changes. **Undo flow changes…** writes the old `clientdata` back from the backup.
     - Unmanaged only, anything else: report (edit or delete it there).
   - **Fix in Dev** — the failed solution's own layer still references it. With Dev as the primary connection, **Run Upgrade blockers** opens the pre-flight on that solution, which lists every such reference and offers the Dev fixes.
   - **Release first** — another managed solution references it: ship it without the reference and upgrade it first; the release order is shown.
4. **Preview → backup → confirm** — the preview lists the operations; Confirm needs the backup, a tick for *cannot be undone* when an active customization is removed, and a tick when the environment looks like Production. Operations are independent: a failure marks its row, the rest runs. Then the check runs again (`4 → 2 references`); at zero, import again.

Export the result as a Markdown checklist.

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

## Install

**From the ToolBox marketplace** — search for "Dependency Cleaner" once listed.

**From source**

```bash
cd tools/dependency-cleaner
npm install
npm run build
```

Then in ToolBox: Debug → *Load Local Tool* → select the `tools/dependency-cleaner` folder.

## Usage

1. Primary connection = the dev environment. Optionally a secondary connection = the target environment.
2. **Diagnose**: pick the solution, adjust the filter, run. Or **Failed import**: pick the environment the import failed in, Scan solution history (or paste the error). Or **Slim**: pick the solution, Analyze, untick what must stay. Or **Cycles**: tick the solutions you ship, pick the base, Analyze. Or **Upgrade blockers**: pick the solution you are about to upgrade in the target, Analyze.
3. Pick a fix on the findings you want to act on, **Preview fixes…**, review, **Download backup**, **Confirm and apply**, then check the environment, the operation count and the way back in the last confirmation before you click Apply.
4. Export the solution again.

## Limitations

- **Failed import, UNVERIFIED against a live environment**: `msdyn_solutionhistories` through the host (filter on `msdyn_result`, `$orderby`/`$top` on a virtual table; the unfiltered fallback reads the newest 100 rows), `RemoveActiveCustomizations(SolutionComponentName='Workflow',ComponentId=<guid>)` through `queryData` (Learn writes `ComponentId=(<guid>)`, tried second), and the classification of a flow whose Active layer comes from a re-bind in the target. Each failed import names the first component it cannot delete: after a fix, the next import may stop on another one; scan again.
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
npm run e2e         # Playwright tests against dist/ with a mocked ToolBox host (needs playwright + Chromium): Diagnose/Fix/Restore, Upgrade blockers, Slim, Cycles, Failed import
```

Stack: TypeScript, Vite, no framework, JSZip (offline tab). Types from `@pptb/types`.

## AI Assistance

Substantial parts of this tool's code and documentation were generated with Claude Code (Anthropic) and reviewed and maintained by the contributors listed in `package.json`. Testing status against real Dataverse environments is stated per feature under Limitations.

## Credits

Built and maintained by Duarte Clemente ([Simple Smooth Safe](https://simplesmoothsafe.com)).

## License

MIT. See [LICENSE](https://github.com/sss-dclemente/sss-pptb/blob/main/tools/dependency-cleaner/LICENSE).

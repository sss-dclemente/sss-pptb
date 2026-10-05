# SOLUTION-SLIMMER-PLAN — remove what does not belong in an unmanaged solution

Status: BUILT in Dependency Cleaner 1.3.0 (tab **Slim**, `src/deps/slim.ts`, `src/slim-ui.ts`, `scripts/slim-e2e.mjs`). The §4 probe has not run against a live environment: every UNVERIFIED call below is parsed defensively and a component whose state cannot be read is **kept and flagged**, never removed.

One-liner: pick an unmanaged solution in Dev; the tab lists every component that is neither yours (unmanaged) nor a managed component you customized (unmanaged "Active" layer on top), and removes those from the solution after preview → backup → confirm. The environment is never changed: `RemoveSolutionComponent` drops membership only.

Backlog ancestor: "Unmanaged Layer Sweeper" (`pptb-tool-ideas.md`, score 10). Reuses Dependency Cleaner: `fetchComponents`, `resolveNames`, `MetaCache`, `msdyn_componentlayers` reading, `removeRequest` / `addRequest`, the backup format and the Restore tab.

---

## The problem

An unmanaged solution collects components it should not export:

| How it got in | What it is | What the export carries |
|---|---|---|
| Add existing → table → *Include all components* on a managed table (account, msdyn_workorder) | `rootcomponentbehavior = 0`: every column, form, view, chart, key and relationship of the table, hundreds of rows | Managed metadata the target already has, plus a dependency on every managed solution that owns a piece of it |
| *Add required components* | Managed tables, choices, web resources the platform pulled in | Same |
| An old "add subcomponents" habit, a copy-paste from another solution | Managed forms, views, roles | Same |

Only two kinds of component belong: **unmanaged** components (created in this environment: `ismanaged = false`) and **managed components with an unmanaged layer** (a managed form you edited, a managed view you changed: the export carries the diff). Everything else is noise that slows export and import, lengthens the dependency list and hides what the solution really changes.

## 0. Decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Home | Tab **Slim** in SSS Dependency Cleaner, not a new package | Same connections, same membership / name / layer / backup code. A new tool would mean moving `deps/*` into `_shared` and a seventh marketplace submission for ~400 lines of new code |
| D2 | Keep rule | Keep when `ismanaged = false`, or when `msdyn_componentlayers` has an `Active` row for the component. Remove otherwise | That is the definition of "belongs". The Active layer is environment-wide, not per solution, so a customization made for another unmanaged solution also keeps the component: flagged with "also in N other unmanaged solutions", the person decides |
| D3 | Managed table with all assets | Convert to a shell (`remove` + `add` with `DoNotIncludeSubcomponents`) and re-add the subcomponents the keep rule keeps | Removing one pristine column under *all assets* is not possible; the shell is how the maker portal does it too ("segmented solutions") |
| D4 | Managed table, behaviour 1 / 2 | Its explicit subcomponent rows are judged one by one; the table row stays when it has an Active layer or a kept child, else it goes | A table row with no kept child and no customization carries nothing |
| D5 | Parents of kept children | Keep a pristine managed parent whose child stays: table of a kept column / form / view, environment variable definition of a kept value. Toggle, default on | Dataverse adds the parent back on export anyway; removing it only makes the next analysis list it again |
| D6 | Unmanaged table with all assets | Its subcomponents stay, whatever their flag | They are implicit members; a pristine managed column on your own table is rare and cannot leave without converting your table to a shell |
| D7 | Unknown state | A component whose `ismanaged` or layers could not be read is **kept** and listed under *Unknown* with the error | Never remove on a guess |
| D8 | Overrides | Every row of the Remove and Shell sections can be unticked (kept); every *customized* row can be ticked "remove anyway" | D2's environment-wide layer needs a human decision per case |
| D9 | Writes | Dev only, `RemoveSolutionComponent` / `AddSolutionComponent` as in the Fix tab. Preview → backup → confirm; a failed operation marks its row and the batch continues, except inside one shell conversion (remove → add shell → re-add kept children), where the rest of that group is skipped | A table removed and not re-added is the one failure mode that loses something; the backup restores it |
| D10 | Not in v1 | Secondary connection to check that the owning managed solution of a removed component is installed in the target; removing *unmanaged layers* (`RemoveActiveCustomizations`) | Both are a different tool (the first is Diagnose's job with a target connection; the second changes the environment) |

## 1. Data

| Need | Call | Notes |
|---|---|---|
| Membership | `fetchComponents(api, solutionId)` | rows with `rootcomponentbehavior`, `rootsolutioncomponentid` |
| Component types | `solutioncomponentdefinitions?$select=solutioncomponenttype,name,primaryentityname` | `name` is the layer component name (`Entity`, `SavedQuery`, `connectionreference`…); `primaryentityname` the table that backs record components. UNVERIFIED: `primaryentityname` as a column name |
| Managed flag, metadata | `getAllEntitiesMetadata([..., "IsManaged", "EntitySetName", "PrimaryIdAttribute"])`, `getEntityRelatedMetadata(table, "Attributes", [..., "IsManaged"])`, `RelationshipDefinitions(<id>)?$select=SchemaName,IsManaged`, `GlobalOptionSetDefinitions(<id>)?$select=Name,IsManaged` | Columns are read per parent table (the root row names it) |
| Managed flag, records | `<entityset>?$select=<id>,<name>,ismanaged&$filter=<id> eq … or …` (40 ids per call, 4 in flight) | Entity set from a static map for the common types, else from `primaryentityname` → entity metadata. A table without `ismanaged` fails the read → the names are retried without it and the flag is *unknown* |
| Active layer | `msdyn_componentlayers?$filter=msdyn_componentid eq '<id>' and msdyn_solutioncomponentname eq '<name>'` for every **managed** component, 4 in flight, progress + cancel | Verified shape (UPGRADE-BLOCKERS-PLAN §4 results): quoted guid, `$select` ignored, large `msdyn_componentjson` in every row, `msdyn_solutionname = 'Active'` is the unmanaged layer, `msdyn_order` ascending from the base. The base row names the owning managed solution. One call per component: a filter on `msdyn_solutionname eq 'Active'` per type would be one call per type but its semantics are UNVERIFIED (an empty answer could mean "unsupported", and that would remove on a guess) |
| Other unmanaged solutions | `fetchOwningSolutions(api, kept managed ids)` → solutions that are unmanaged, not this one, not Default / Active / Basic | One chunked query; sets D2's flag |
| Environment variable values | `environmentvariablevalues?$select=environmentvariablevalueid,_environmentvariabledefinitionid_value&$filter=…` for kept values | D5 for definitions |

## 2. Classification

Per `solutioncomponent` row, first match wins:

1. `ismanaged` unknown or layer read failed → **unknown** (kept, flagged with the error).
2. `ismanaged = false` → **keep: unmanaged**.
3. Subcomponent of an unmanaged table with behaviour 0 → **keep: included by its table**.
4. Active layer present → **keep: customized** (flag when other unmanaged solutions also contain it).
5. Table with behaviour 0 → **shell**: convert, re-add the children classified keep (1–4); the shell row itself stays only when the table has an Active layer or a kept child, else the whole table is removed (`remove` without re-add).
6. Parent (table behaviour 1 / 2, or environment variable definition) of a kept child, option D5 on → **keep: parent of a kept component**.
7. Otherwise → **remove**, with the owning managed solution from the base layer.

Counts in the summary: components, keep unmanaged, keep customized, keep parents, shells, remove, unknown.

## 3. Operations

```
for each shell table (D3):
  RemoveSolutionComponent  table
  AddSolutionComponent     table  DoNotIncludeSubcomponents=true      (skipped when the table itself is removed)
  AddSolutionComponent     each kept child                             (skipped when the table itself is removed)
for each remove, subcomponent rows first, then roots:
  RemoveSolutionComponent  component
```

Identical operations run once. A failure inside a shell group skips the rest of the group; every other operation still runs. After the run the analysis repeats and the summary shows *before → after* for the remove count.

Backup: the full membership before the run (`buildMembershipBackup`), in the Dependency Cleaner backup format, so the **Restore** tab re-adds removed components, puts shells back to all assets and re-adds removed subcomponents.

## 4. Probe (first real run, Debug log on)

Run Analyze on a solution with (a) a managed table added with all assets, (b) a managed form you edited, (c) a connection reference and an environment variable, (d) a security role. Save the log and check:

- [ ] `solutioncomponentdefinitions` returns `name` and `primaryentityname`; the dynamic connection reference type resolves to `connectionreferences`.
- [ ] `ismanaged` reads succeed for every type listed; any type that lands in *Unknown* names the entity set to fix in `recordSource` (`src/deps/slim.ts`).
- [ ] `msdyn_componentlayers` for `Entity`, `Attribute`, `Role`, `SavedQuery`, `SystemForm` returns rows; the edited form shows `Active`; a pristine column shows only the owning managed solution. A type whose rows are always empty needs its layer name checked against `solutioncomponentdefinitions.name`.
- [ ] Preview on the all-assets table: shell conversion + re-add of your columns and the edited form, nothing else.
- [ ] Apply: results all ok; the maker portal shows the table as "selected components"; export the solution and compare the zip size and `MissingDependencies` before / after.
- [ ] Restore from the backup puts the table back to all assets.

## 5. Later

- Type-level Active layer query (one call per type) once its semantics are verified: cuts a 500-component solution from 500 layer calls to ~15.
- Secondary connection: flag a removed component whose owning managed solution is not installed in the target (today: the Diagnose tab after slimming).
- "Why is it here" hints: `solutioncomponent.createdon` / `createdby` to show when and who added the noise.

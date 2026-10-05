# SOLUTION-SLIMMER-PLAN — remove what does not belong in an unmanaged solution

Status: BUILT in Dependency Cleaner 1.3.0, corrected in 1.3.1 after the first real run (§4 results, 2026-10-05, SL sandbox, solution PP365ControlFlows). Tab **Slim**, `src/deps/slim.ts`, `src/slim-ui.ts`, `scripts/slim-e2e.mjs`. A component whose state cannot be read is **kept and flagged**, never removed.

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
| D2 | Keep rule | Keep when the component is **yours** (unmanaged and custom), or when its `Active` layer **changes something real** (D11). Remove otherwise, managed and platform alike (D12) | That is the definition of "belongs". The Active layer is environment-wide, not per solution, so a customization made for another unmanaged solution also keeps the component: flagged with "also in N other unmanaged solutions", the person decides |
| D3 | Managed table with all assets | Convert to a shell (`remove` + `add` with `DoNotIncludeSubcomponents`) and re-add the subcomponents the keep rule keeps | Removing one pristine column under *all assets* is not possible; the shell is how the maker portal does it too ("segmented solutions") |
| D4 | Managed table, behaviour 1 / 2 | Its explicit subcomponent rows are judged one by one; the table row stays when it has an Active layer or a kept child, else it goes | A table row with no kept child and no customization carries nothing |
| D5 | Parents of kept children | Keep a pristine managed parent whose child stays: table of a kept column / form / view, environment variable definition of a kept value. Toggle, default on | Dataverse adds the parent back on export anyway; removing it only makes the next analysis list it again |
| D6 | Unmanaged table with all assets | Its subcomponents stay, whatever their flag | They are implicit members; a pristine managed column on your own table is rare and cannot leave without converting your table to a shell |
| D7 | Unknown state | A component whose `ismanaged` or layers could not be read is **kept** and listed under *Unknown* with the error | Never remove on a guess |
| D8 | Overrides | Every row of the Remove and Shell sections can be unticked (kept); every *customized* row can be ticked "remove anyway" | D2's environment-wide layer needs a human decision per case |
| D9 | Writes | Dev only, `RemoveSolutionComponent` / `AddSolutionComponent` as in the Fix tab. Preview → backup → confirm; a failed operation marks its row and the batch continues, except inside one shell conversion (remove → add shell → re-add kept children), where the rest of that group is skipped | A table removed and not re-added is the one failure mode that loses something; the backup restores it |
| D11 | Phantom Active layers | An `Active` row counts as a customization only when its `msdyn_changes.Attributes` names something beyond bookkeeping (`modifiedon`, `modifiedby`, `overwritetime`, `solutionid`, `supportingsolutionid`, `componentstate`, `publishedon`, `versionnumber`, `importsequencenumber`, `statecode`, `statuscode`, `workflowidunique`). The changed attributes are shown on the row | First real run: 141 of 142 components had an Active row, 119 of them with `Attributes: []` and most of the rest with `modifiedon` / `overwritetime` only. Without this rule nothing is ever removed. Unreadable `msdyn_changes` counts as a real change (keep) |
| D12 | Platform components | `ismanaged = false` is not "yours": platform components (account, its system columns, System forms and views) are unmanaged too. Yours = unmanaged **and** custom (`IsCustomEntity`, `IsCustomAttribute`, `IsCustomRelationship`, `IsCustomOptionSet`; for record types, not contained by the `System` solution). Platform is classified like managed: customized or removed | First real run: `owningteam`, `createdbyyominame` on a platform table came back `IsManaged: false, IsCustomAttribute: false` |
| D13 | RemoveSolutionComponent payload | Web API shape: `{ SolutionComponent: { "@odata.type": "Microsoft.Dynamics.CRM.solutioncomponent", solutioncomponentid: <component id> }, ComponentType, SolutionUniqueName }`. Should the server want the solutioncomponent row id, the row id is tried next | First real run: 123 of 123 removes failed with `0x80048d19 … 'ComponentId' … is not a valid parameter for the operation 'RemoveSolutionComponent'` (the SDK's parameter name, not the Web API's); nothing was changed. Also fixed the Fix and Restore tabs, which used the same request |
| D10 | Not in v1 | Secondary connection to check that the owning managed solution of a removed component is installed in the target; removing *unmanaged layers* (`RemoveActiveCustomizations`) | Both are a different tool (the first is Diagnose's job with a target connection; the second changes the environment) |

## 1. Data

| Need | Call | Notes |
|---|---|---|
| Membership | `fetchComponents(api, solutionId)` | rows with `rootcomponentbehavior`, `rootsolutioncomponentid` |
| Component types | `solutioncomponentdefinitions?$select=solutioncomponenttype,name,primaryentityname` | `name` is the layer component name (`Entity`, `SavedQuery`, `connectionreference`…); `primaryentityname` the table that backs record components. UNVERIFIED: `primaryentityname` as a column name |
| Origin, metadata | `getAllEntitiesMetadata([..., "IsManaged", "IsCustomEntity", "EntitySetName", "PrimaryIdAttribute"])`, `getEntityRelatedMetadata(table, "Attributes", [..., "IsManaged", "IsCustomAttribute"])`, `RelationshipDefinitions(<id>)?$select=SchemaName,IsManaged,IsCustomRelationship`, `GlobalOptionSetDefinitions(<id>)?$select=Name,IsManaged,IsCustomOptionSet` | managed → managed; unmanaged + custom → yours; unmanaged + not custom → platform (D12). Columns are read per parent table (the root row names it) |
| Origin, records | `<entityset>?$select=<id>,<name>,ismanaged&$filter=<id> eq … or …` (40 ids per call, 4 in flight); unmanaged ones: `fetchOwningSolutions` → contained by the `System` solution → platform, else yours | Entity set from a static map for the common types, else from `primaryentityname` → entity metadata (verified). A table without `ismanaged` fails the read → the names are retried without it and the origin is *unknown* |
| Active layer | `msdyn_componentlayers?$filter=msdyn_componentid eq '<id>' and msdyn_solutioncomponentname eq '<name>'` for every component that is not yours, 4 in flight, progress + cancel | Verified: quoted guid, `$select` ignored, `msdyn_changes` (JSON with `Attributes: [{Key, Value}]`) and `msdyn_componentjson` in every row, `msdyn_solutionname = 'Active'` is the unmanaged layer, `msdyn_order` ascending from the base, names `Entity`, `Attribute`, `Role`, `SavedQuery`, `SystemForm`, `Workflow`, `WebResource`, `OptionSet`, `AppModule`, `SiteMap` all answer. The base row names the owning managed solution. D11 reads `msdyn_changes`. One call per component: a filter on `msdyn_solutionname eq 'Active'` per type would be one call per type but its semantics are UNVERIFIED (an empty answer could mean "unsupported", and that would remove on a guess) |
| Other unmanaged solutions | `fetchOwningSolutions(api, kept managed ids)` → solutions that are unmanaged, not this one, not Default / Active / Basic | One chunked query; sets D2's flag |
| Environment variable values | `environmentvariablevalues?$select=environmentvariablevalueid,_environmentvariabledefinitionid_value&$filter=…` for kept values | D5 for definitions |

## 2. Classification

Per `solutioncomponent` row, first match wins:

1. Origin **yours** (unmanaged and custom, D12) → **keep: yours**.
2. Subcomponent of one of your tables with behaviour 0 → **keep: included by its table**.
3. Origin or layers unreadable → **unknown** (kept, flagged with the error).
4. Active layer that changes something real (D11) → **keep: customized** (flag when other unmanaged solutions also contain it).
5. Managed or platform table with behaviour 0 → **shell**: convert, re-add the children classified keep (1–4); the shell row itself stays only when the table is customized or has a kept child, else the whole table is removed (`remove` without re-add).
6. Parent (table behaviour 1 / 2, or environment variable definition) of a kept child, option D5 on → **keep: parent of a kept component**.
7. Otherwise → **remove**, with the owning managed solution from the base layer (`System` for platform components) and a note when a phantom Active layer was ignored.

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

## 4. Probe

First run 2026-10-05 (1.3.0, SL sandbox, PP365ControlFlows: 779 membership rows, 131 tables of which 123 with all assets, 2 003 reads, 2 min 50 s):

- [x] `solutioncomponentdefinitions` returns `name` and `primaryentityname`.
- [x] `ismanaged` / `IsManaged` reads succeed for tables, columns, relationships, choices, forms, views, processes, web resources, roles, charts, apps, canvas apps, site maps, connection references, environment variable definitions and values. **But** platform components report `IsManaged: false` → D12.
- [x] `msdyn_componentlayers` answers for `Entity`, `Attribute`, `OptionSet`, `Role`, `SavedQuery`, `SystemForm`, `Workflow`, `WebResource`, `AppModule`, `SiteMap`. **But** 141 of 142 components have an Active row, 119 of them empty → D11.
- [x] Preview: 123 shell conversions, each remove → add shell → re-add kept children.
- [ ] Apply: **all 123 removes failed**, `'ComponentId' … is not a valid parameter for the operation 'RemoveSolutionComponent'`; the adds were skipped (group rule, D9), nothing changed → D13. 1.3.1 sends the `SolutionComponent` reference.
- [ ] Restore from the backup puts the table back to all assets.

Second run (1.3.1), Debug log on, same solution:

- [ ] Counts: platform tables (account, contact…) show the *platform* badge; the *customized* section lists only components whose Layers line names a real change (formxml, xaml, a display name…), and the warning counts the phantom Active layers.
- [ ] Apply on a small selection first (untick everything but two or three rows): results ok; if the first remove fails and the retry with the row id succeeds, the log shows two `RemoveSolutionComponent` calls for that row: say so, and `removeRequest` switches to the row id for good.
- [ ] Analyzed again: the removed rows are gone; the maker portal shows the shell tables with "selected components".
- [ ] Restore from the backup re-adds them.

## 5. Later

- Type-level Active layer query (one call per type) once its semantics are verified: cuts a 500-component solution from 500 layer calls to ~15.
- Secondary connection: flag a removed component whose owning managed solution is not installed in the target (today: the Diagnose tab after slimming).
- "Why is it here" hints: `solutioncomponent.createdon` / `createdby` to show when and who added the noise.

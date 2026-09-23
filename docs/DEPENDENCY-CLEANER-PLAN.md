# DEPENDENCY-CLEANER-PLAN — SSS Dependency Cleaner

Status: APPROVED (D1–D8 confirmed by owner). Build starts after the bug-fix PR for the three existing tools is merged.

One-liner: "why does my solution depend on msdyn_*, and remove it". Pick an unmanaged solution in dev, see every dependency on a managed solution the target environment does not have (Field Service, Sales, Customer Service, Project Operations…), see the component in *your* solution that causes it, fix it in place: take the component out of the solution, or remove the msdyn column from the form or view. Then export again and the import works.

Facts: `docs/PPTB-NOTES.md` (§12: an `Edm.Guid` function parameter must go through `queryData`, not `execute`).

---

## 0. Decisions (approved)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Problem | **Import fails because of missing msdyn dependencies.** Deletion blockers and managed uninstall come later | This is the most common case: a system table added with "all assets", a form with a Field Service column, or a view with a link-entity to `msdyn_workorder` |
| D2 | Writes | (a) remove from solution: `RemoveSolutionComponent`, and re-add a table as a shell with `AddSolutionComponent` + `DoNotIncludeSubcomponents=true`; (b) edit form XML and view fetchxml/layoutxml, then `PublishXml`. Always behind preview → confirm, like Matrix | Owner chose "also edit forms/views". (a) is metadata-safe; (b) changes the UI in dev, so it needs a backup first (D5) |
| D3 | Filter | Default: dependencies whose required component belongs to a managed solution with publisher prefix `msdyn` / `msdynce` / `mspp` or unique name `msdyn*`. The filter can be edited (a list of prefixes or solutions) | The request is msdyn-focused, and the same engine covers any ISV |
| D4 | Target awareness | Optional second connection = the target environment. Solutions that exist there (`getSolutions`) are marked "present in target — safe" and hidden by default | Without it every msdyn dependency looks bad; with it only the real import blockers show |
| D5 | Backup | Before any form/view write, download `dependency-cleaner-backup-<solution>-<ts>.json` with the original `formxml` / `fetchxml` / `layoutxml` and solution membership. A Restore tab reapplies it | Form XML edits cannot be undone through the platform. The backup is the undo |
| D6 | Out of scope v1 (report only) | Sitemap, app module components, ribbon/command bar, charts, BPF, classic workflows, cloud flows, plugin steps, web resources that reference msdyn. These get a deep link to the maker portal | Each is a different XML dialect; editing them automatically is high risk for little gain |
| D7 | Managed / Production | Refuse writes when the solution is managed. Show a confirm banner when the connection label looks like Production | Dependencies are fixed in dev, never downstream |
| D8 | Package | `@simplesmoothsafe/pptb-dependency-cleaner`, display "SSS Dependency Cleaner", MIT. `multiConnection: optional` (secondary = target), `connectionRequirement: required`, `minAPI: 1.2.0` | Same as Matrix |

---

## 1. Data

| Need | Call | Notes |
|---|---|---|
| Solutions | `getSolutions(["solutionid","uniquename","friendlyname","version","ismanaged","_publisherid_value"])` primary and target | Unmanaged only in the picker |
| Solution components | `queryData("solutioncomponents?$select=objectid,componenttype,rootcomponentbehavior,rootsolutioncomponentid&$filter=_solutionid_value eq <id>")` + `@odata.nextLink` | |
| Required components per component | `queryData("RetrieveRequiredComponents(ObjectId=<guid>,ComponentType=<int>)")` → `EntityCollection` of `dependency` rows | Guid → `queryData` (§12). N calls; throttle 4 in parallel, show progress |
| Alternative, one call | `queryData("dependencies?$filter=…")` | **UNVERIFIED** whether `dependency` can be read through the Web API; test first, and fall back to the per-component calls |
| Owning solution of the required component | `queryData("solutioncomponents?$select=_solutionid_value&$filter=objectid eq <guid>")` → managed solution + publisher | Batch by `or` chunks (≤ 50 ids) |
| Names for display | `getAllEntitiesMetadata`, `getEntityRelatedMetadata(table,"Attributes")`, `systemforms`, `savedqueries` | Cached |
| Missing in target | `execute({operationName:"RetrieveMissingDependencies", operationType:"function", parameters:{SolutionUniqueName}})` on the **target**: only for solutions already imported there, otherwise use D4 | String param, so `execute` is fine |
| Offline input (bonus) | Load an exported zip and read `solution.xml` `<MissingDependencies>` with the XRay parser | This is the exact list that `pac solution import` checks. No connection needed to diagnose |

## 2. Diagnosis model

Each finding is `{ required: {type, name, solution, publisher}, dependent: {type, name, id, table?}, cause, fix[] }`, grouped by dependent component (what the user can act on), not by the required one.

The cause classifier maps a dependent type to the likely reason and the available fixes:

| Dependent (type) | Typical cause | Fix offered |
|---|---|---|
| Entity (1) with `rootcomponentbehavior = 0` on a system/msdyn table | Added "with all assets", so all msdyn columns, forms and views come along | **Convert to shell**: remove + add again with `DoNotIncludeSubcomponents`, then add only the subcomponents that are yours (your prefix) |
| Attribute (2) `msdyn_*` | msdyn column included directly | Remove from solution |
| Relationship (10) to an msdyn table | Your lookup targets `msdyn_*` | Report only: this is a real dependency, so the target needs the app, or the column has to be deleted by hand |
| Form (60) | Control, tab or section bound to an msdyn column, or a form library | **Edit form**: remove the `<cell>` / `<control>` for those columns, drop empty sections; or remove the form from the solution |
| View (26) | `<attribute>`, `<condition>` or `<link-entity>` on msdyn | **Edit view**: strip them from fetchxml and the matching `<cell>` from layoutxml; or remove the view |
| Chart (59), Sitemap (62), App module (80), Ribbon, Workflow (29), Web resource (61), Plugin step (92) | Various | Report + deep link (D6) |

A finding is a **real blocker** when the required solution is not present in the target (D4), or when there is no target, it matches the D3 filter.

## 3. Write path

1. The user ticks findings and gets a preview listing each operation: `RemoveSolutionComponent(type, id, solution)`, `AddSolutionComponent(…, DoNotIncludeSubcomponents=true)`, `update systemform.formxml` (diff shown), `update savedquery.fetchxml/layoutxml` (diff shown).
2. Download the backup (D5). This is mandatory, and Confirm stays disabled until it is done.
3. Execute in order: membership changes → form/view updates → `PublishXml` with `<importexportxml><entities><entity>…</entity></entities></importexportxml>` for the touched tables.
4. Re-run the diagnosis and show "fixed / still present" per finding.

`RemoveSolutionComponent` / `AddSolutionComponent` are actions (JSON body), so a Guid inside the body is fine through `execute`. **UNVERIFIED** in the PPTB host; test in a sandbox before shipping.

Form XML editing is a pure function `stripColumns(formxml, columns[]) → {xml, removed[]}` using DOMParser, with unit coverage in e2e. It never removes the primary name field or required fields (`requiredlevel` ApplicationRequired), and any such case is reported instead. Views: `stripColumns(fetchxml, layoutxml, columns[], linkEntities[])`, and a view whose sort or filter only used msdyn columns gets a warning.

## 4. UI

Tabs: **Diagnose** (solution picker, target picker, filter, run, findings grouped by dependent with required-solution chips) · **Fix** (selected findings → preview → backup → confirm → result) · **Restore** (load a backup JSON → preview → apply) · **Offline** (drop a zip → MissingDependencies list, grouped the same way). Exports: findings JSON/CSV.

## 5. Tests

Same e2e pattern as the other tools, with a mocked host. The dev env has a solution containing `account` (behavior 0), a form with `msdyn_workorder` controls and a view with a link-entity to `msdyn_workorder`. The target env has no Field Service. Assertions: findings count and grouping; the shell conversion issues remove + add with the flag; form and view XML are stripped correctly and required fields are kept; a backup is required before confirm; PublishXml is called with the touched tables; re-diagnosis is clean; Restore puts the XML back.

## 6. Risks / open

- `RetrieveRequiredComponents` over a large solution means hundreds of calls. It needs progress, a cancel button and a cache per session. Check whether reading `dependencies` directly works (§1).
- Converting a table to a shell in a solution that other devs use removes subcomponents they may rely on. The preview lists every subcomponent that will leave.
- Forms with msdyn PCF controls or libraries (`<Library>` / `<event>` handlers) are report only in v1.
- `PublishXml` on big tables is slow; publish once, at the end.

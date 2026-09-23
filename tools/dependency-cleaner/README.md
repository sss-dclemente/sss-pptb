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
2. **Diagnose**: pick the solution, adjust the filter, run.
3. Pick a fix on the findings you want to act on, **Preview fixes…**, review, **Download backup**, **Confirm and apply**.
4. Export the solution again.

## Limitations

- **UNVERIFIED in the PPTB host**: `AddSolutionComponent` / `RemoveSolutionComponent` through `dataverseAPI.execute` (action, JSON body), and restoring a shell table to "all assets" with remove + add. The request shapes follow the Dataverse Web API; try them in a sandbox before relying on them.
- `RetrieveRequiredComponents` is one call per component: a large solution means hundreds of calls. They run 4 at a time, can be cancelled, and are cached for the session. Its response shape through the host is also **UNVERIFIED**; the tool accepts `EntityCollection` as an array or as `{ Entities }`.
- Forms with msdyn PCF controls, libraries or event handlers get warnings, not edits. A view whose only filter or sort used msdyn columns gets a warning.
- Converting a table to a shell in a solution other developers use removes subcomponents they may rely on: read the list in the preview.
- Ownership (above) relies on the base solution Dataverse reports, table / column metadata and System membership. A custom form or view contained by several managed solutions of different publishers is treated as not msdyn-owned.

## Privacy

All data stays between ToolBox and your Dataverse environments: the tool talks to Dataverse only through the ToolBox `dataverseAPI` bridge, requests no CSP exceptions, and sends nothing anywhere else. Backups and exports are written to files you choose.

## Development

```bash
npm run build       # typecheck + Vite IIFE bundle + dist checks
npm run dev-watch   # rebuild on change; reload the tool tab in ToolBox
npm run validate    # @pptb/validate manifest rules
npm run xml-test    # form / view XML stripping
npm run e2e         # Playwright test against dist/ with a mocked ToolBox host (needs playwright + Chromium)
```

Stack: TypeScript, Vite, no framework, JSZip (offline tab). Types from `@pptb/types`.

## License

MIT. See [LICENSE](https://github.com/sss-dclemente/sss-pptb/blob/main/tools/dependency-cleaner/LICENSE).

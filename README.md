# sss-pptb

Power Platform ToolBox tools by [Simple Smooth Safe](https://simplesmoothsafe.com).

| Tool | npm | Status |
|---|---|---|
| [Solution XRay](tools/solution-xray/README.md) — offline Dataverse solution zip analysis | `@simplesmoothsafe/pptb-solution-xray` | v1.2.2 |
| [EnvVar & ConnRef Matrix](tools/envvar-matrix/README.md) — env vars and connection references across environments, copy values, merge duplicate and delete unused connection references across all flows, bind connection references (settings file or Power Platform API picker), solution fit check, turn on flows after import, deploymentSettings.json import/export | `@simplesmoothsafe/pptb-envvar-matrix` | v1.6.2 |
| [Access Checker](tools/access-checker/README.md) — why can / can't a user do X on a record: roles, teams, BU, ownership, shares, hierarchy, column security | `@simplesmoothsafe/pptb-access-checker` | v1.2.3 |
| [Dependency Cleaner](tools/dependency-cleaner/README.md) — why does my solution depend on msdyn_*: find the component, convert tables to shells, strip msdyn columns from forms and views, with backup and restore; upgrade blockers: what a managed upgrade deletes, what blocks each delete (custom pages, canvas apps, model-driven apps) and where to fix it; slim: remove every managed component you did not customize from an unmanaged solution, all-assets tables to shells; cycles: circular dependencies between unmanaged solutions, import order, fixes through a base solution; failed import: "component cannot be deleted because it is referenced by" from solution history, what references it, remove active customizations or re-point the flow to another connection reference (Upgrade blockers, Cycles and Failed import read-only in release builds until their writes are verified live) | `@simplesmoothsafe/pptb-dependency-cleaner` | v1.6.0 |
| [D365 Apps Matrix](tools/d365-apps/README.md) — Dynamics 365 apps across environments: installed version, update available, failed install per app and environment; bulk update / retry / install with live progress; pac script export (Power Platform API); read-only Unused apps report | `@simplesmoothsafe/pptb-d365-apps` | v0.3.4 |
| [Offboarding Wizard](tools/offboarding-wizard/README.md) — user leaves: inventory of what they own and hold, then one reviewed run of reassignments | `@simplesmoothsafe/pptb-offboarding-wizard` | v0.2.2 |
| [Audit Config Matrix](tools/audit-matrix/README.md) — org / table / column audit flags, cross-environment diff, bulk set | `@simplesmoothsafe/pptb-audit-matrix` | v0.2.3 |

## Install without the marketplace

Every tool is on npm, listed in the ToolBox marketplace or not. Needs ToolBox 1.2.7 or later and the Debug menu (Settings → *Show Debug Menu*).

- **Install from npm**: Debug → *Install from npm* → the package name from the table above (e.g. `@simplesmoothsafe/pptb-dependency-cleaner`). ToolBox installs it with pnpm, so pnpm must be on the machine; pnpm can hold back a version published in the last few hours.
- **From the package file** (no npm access on the machine, or to pin a version): download the tarball, `https://registry.npmjs.org/@simplesmoothsafe/pptb-<tool>/-/pptb-<tool>-<version>.tgz` (or `npm pack @simplesmoothsafe/pptb-<tool>`), extract it (`tar -xzf <file>.tgz`, also on Windows 10 and later), then Debug → *Load Local Tool* → the extracted `package` folder.

To update, install the new version the same way.

Docs: [PPTB research notes](docs/PPTB-NOTES.md) · [port plan](docs/PORT-PLAN.md) · [backlog](docs/BACKLOG.md) · [matrix plan](docs/ENVVAR-MATRIX-PLAN.md) · [PP API spike](docs/PP-API-SPIKE.md) · [access checker plan](docs/ACCESS-CHECKER-PLAN.md) · [dependency cleaner plan](docs/DEPENDENCY-CLEANER-PLAN.md) · [solution slimmer plan](docs/SOLUTION-SLIMMER-PLAN.md) · [cycles plan](docs/CYCLES-PLAN.md) · [D365 apps plan](docs/D365-APPS-PLAN.md) · [offboarding plan](docs/OFFBOARDING-PLAN.md) · [audit matrix plan](docs/AUDIT-MATRIX-PLAN.md) · [usability audit](docs/USABILITY-AUDIT.md) · [release checklist](docs/RELEASE.md) · [screenshot shot list](docs/SCREENSHOTS.md) · [tool ideas](pptb-tool-ideas.md)

Each tool is a self-contained npm package under `tools/`; `tools/_shared/` holds the host adapter, debug log, DOM helpers and design tokens they import by relative path (bundled by Vite, so published packages stay self-contained). Build with `npm install && npm run build` inside the tool folder; load in ToolBox via Debug → Load Local Tool.

Every tool has a **Debug log** switch in its footer: it records each ToolBox / Dataverse / Power Platform API call with its request, response or error, and saves it as a `.txt` file to attach to a bug report or a probe (secrets redacted; record data truncated but included).

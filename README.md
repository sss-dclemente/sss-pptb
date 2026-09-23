# sss-pptb

Power Platform ToolBox tools by [Simple Smooth Safe](https://simplesmoothsafe.com).

| Tool | npm | Status |
|---|---|---|
| [SSS Solution XRay](tools/solution-xray/README.md) — offline Dataverse solution zip analysis | `@simplesmoothsafe/pptb-solution-xray` | v1.0.0 |
| [SSS EnvVar & ConnRef Matrix](tools/envvar-matrix/README.md) — env vars and connection references across environments, copy values, deploymentSettings.json | `@simplesmoothsafe/pptb-envvar-matrix` | v1.0.0 |
| [SSS Access Checker](tools/access-checker/README.md) — why can / can't a user do X on a record: roles, teams, BU, ownership, shares, hierarchy, column security | `@simplesmoothsafe/pptb-access-checker` | v1.0.0 |
| [SSS Dependency Cleaner](tools/dependency-cleaner/README.md) — why does my solution depend on msdyn_*: find the component, convert tables to shells, strip msdyn columns from forms and views, with backup and restore | `@simplesmoothsafe/pptb-dependency-cleaner` | v1.0.1 |

Docs: [PPTB research notes](docs/PPTB-NOTES.md) · [port plan](docs/PORT-PLAN.md) · [backlog](docs/BACKLOG.md) · [matrix plan](docs/ENVVAR-MATRIX-PLAN.md) · [access checker plan](docs/ACCESS-CHECKER-PLAN.md) · [dependency cleaner plan](docs/DEPENDENCY-CLEANER-PLAN.md) · [release checklist](docs/RELEASE.md) · [screenshot shot list](docs/SCREENSHOTS.md) · [tool ideas](pptb-tool-ideas.md)

Each tool is a self-contained npm package under `tools/`; `tools/_shared/` holds the host adapter, DOM helpers and design tokens they import by relative path (bundled by Vite, so published packages stay self-contained). Build with `npm install && npm run build` inside the tool folder; load in ToolBox via Debug → Load Local Tool.

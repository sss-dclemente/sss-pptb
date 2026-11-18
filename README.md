# sss-pptb

Power Platform ToolBox tools by [Simple Smooth Safe](https://simplesmoothsafe.com).

| Tool | npm | Status |
|---|---|---|
| [Solution XRay](tools/solution-xray/README.md) — offline Dataverse solution zip analysis | `@simplesmoothsafe/pptb-solution-xray` | v1.2.2 |
| [EnvVar & ConnRef Matrix](tools/envvar-matrix/README.md) — env vars and connection references across environments, copy values, merge duplicate and delete unused connection references across all flows, bind connection references (settings file or Power Platform API picker), solution fit check, turn on flows after import, deploymentSettings.json import/export | `@simplesmoothsafe/pptb-envvar-matrix` | v1.6.2 |
| [D365 Apps Matrix](tools/d365-apps/README.md) — Dynamics 365 apps across environments: installed version, update available, failed install per app and environment; bulk update / retry / install with live progress; pac script export (Power Platform API); read-only Unused apps report | `@simplesmoothsafe/pptb-d365-apps` | v0.3.4 |
| Access Checker, Dependency Cleaner, Offboarding Wizard, Audit Config Matrix — **removed 2026-11-18** (source deleted from this repo; npm packages deprecated, last published versions remain installable) | `@simplesmoothsafe/pptb-access-checker` · `-dependency-cleaner` · `-offboarding-wizard` · `-audit-matrix` | removed (last: v1.2.3 · v1.6.0 · v0.2.2 · v0.2.3) |

## Install without the marketplace

Every tool is on npm, listed in the ToolBox marketplace or not. Needs ToolBox 1.2.7 or later and the Debug menu (Settings → *Show Debug Menu*).

- **Install from npm**: Debug → *Install from npm* → the package name from the table above (e.g. `@simplesmoothsafe/pptb-solution-xray`). ToolBox installs it with pnpm, so pnpm must be on the machine; pnpm can hold back a version published in the last few hours.
- **From the package file** (no npm access on the machine, or to pin a version): download the tarball, `https://registry.npmjs.org/@simplesmoothsafe/pptb-<tool>/-/pptb-<tool>-<version>.tgz` (or `npm pack @simplesmoothsafe/pptb-<tool>`), extract it (`tar -xzf <file>.tgz`, also on Windows 10 and later), then Debug → *Load Local Tool* → the extracted `package` folder.

To update, install the new version the same way.

Docs: [PPTB research notes](docs/PPTB-NOTES.md) · [port plan](docs/PORT-PLAN.md) · [backlog](docs/BACKLOG.md) · [matrix plan](docs/ENVVAR-MATRIX-PLAN.md) · [PP API spike](docs/PP-API-SPIKE.md) · [D365 apps plan](docs/D365-APPS-PLAN.md) · [usability audit](docs/USABILITY-AUDIT.md) · [release checklist](docs/RELEASE.md) · [screenshot shot list](docs/SCREENSHOTS.md) · [tool ideas](pptb-tool-ideas.md)

Each tool is a self-contained npm package under `tools/`; `tools/_shared/` holds the host adapter, debug log, DOM helpers and design tokens they import by relative path (bundled by Vite, so published packages stay self-contained). Build with `npm install && npm run build` inside the tool folder; load in ToolBox via Debug → Load Local Tool.

Every tool has a **Debug log** switch in its footer: it records each ToolBox / Dataverse / Power Platform API call with its request, response or error, and saves it as a `.txt` file to attach to a bug report or a probe (secrets redacted; record data truncated but included).

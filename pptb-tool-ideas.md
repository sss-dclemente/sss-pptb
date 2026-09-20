# PPTB Tool Ideas — SSS

Date: 2026-09-20 · Owner: Duarte Clemente (Simple Smooth Safe)
Source: https://github.com/PowerPlatformToolBox · https://www.powerplatformtoolbox.com

## Decisions

- Goal: SSS brand / reputation
- First ship: weekend — port SSS XRay (`solution-xray.html`) to PPTB
- Focus areas: ALM / solutions, Security / audit
- Scoring: `Score = Pain + 2×Vis − Cx` (1–5 each; Cx 5 = hard). Ratings = judgment, not data. Validate via PPTB Discord requests + XrmToolBox download counts.

## PPTB catalog snapshot (npm, 2026-09-20, ~55 tools)

Already covered — skip: FetchXML Studio, Plugin Registration, Command Bar Studio (Ribbon), Bulk Data Studio, Early Bound Generator, Metadata Browser, Web Resource Manager, Trace Analyzer, Forge SQL, Solution Layer Manager, User Settings, Easy Translator / translation tools, Data Migrator, Data Importer, View Layout Copier, Security Role Comparator (same env), ERD Generator, Solution Dependency Analyzer, Fast Record Counter, Table Icons, Custom API + Events Manager, Document Template Deployment Manager, Solution Component Comparison (env-to-env), Table Logic Map, Flow Finder, Flow Documentation Generator, Environment Manager (org settings), Managed Identity wizard, Theme Studio, Side Pane Studio, PCF Builder, Polymorphic Lookup, NameBuilder, Universal Search, Ownership Mover, User Security tools, Solution Blueprint (docs).

Platform notes: PPTB v1.2.5 — private marketplace sources, CSP consent review, headless MCP execution, Power Platform API connections.

## XrmToolBox gaps (not migrated)

- Attribute Manager (change column type / rename / delete with data carry-over)
- Audit Center + audit history extract / restore
- Power Pages Records Mover / Portal Code Editor
- Environment Variable + Connection Reference manager
- Access Checker
- Auto Number Manager, Alternate Key Manager
- Assembly Recovery
- Personal views / charts / dashboards reassign
- Bulk Workflow / on-demand flow execution over FetchXML set
- TypeScript typings generator + late-bound constants
- Chart XML editor
- System Jobs / Bulk Delete / storage capacity analyzer
- Import Job / Solution History viewer
- Notes / file column attachment extractor

## Net-new ideas (no XTB ancestor)

- Flow run history: failed runs across env, bulk resubmit
- Key Vault / secret env var auditor
- Unmanaged layer bulk remover
- Agent-callable tools via PPTB headless MCP
- DocGen funnel: Word template content-control inventory / placeholder mapper (parked — goal is brand, not funnel)

## Scored list (Vis ×2)

| # | Tool | Pain | Vis | Cx | Score |
|---|---|---|---|---|---|
| 1 | Access Checker | 5 | 5 | 3 | 12 |
| 2 | EnvVar + ConnRef Matrix | 5 | 4 | 2 | 11 |
| 3 | Offboarding Wizard | 4 | 5 | 3 | 11 |
| 4 | XRay port | 3 | 4 | 1 | 10 |
| 5 | Unmanaged Layer Sweeper | 5 | 4 | 3 | 10 |
| 6 | Flow ALM Fixer | 5 | 4 | 3 | 10 |
| 7 | Attribute Manager | 5 | 5 | 5 | 10 |
| 8 | Audit Center (full) | 4 | 5 | 4 | 10 |
| 9 | SPN / Admin Inventory | 3 | 4 | 2 | 9 |
| 10 | Role Minimizer | 4 | 5 | 5 | 9 |
| 11 | Audit Config Matrix | 3 | 3 | 1 | 8 |
| 12 | Deployment Settings Builder | 4 | 3 | 2 | 8 |
| 13 | Import Job Viewer | 4 | 3 | 2 | 8 |
| 14 | Priv Escalation Paths | 2 | 4 | 2 | 8 |
| 15 | Solution Drift Monitor | 4 | 4 | 4 | 8 |
| 16 | Share Explorer (POA) | 3 | 3 | 2 | 7 |
| 17 | Column Security Matrix | 3 | 3 | 2 | 7 |
| 18 | Role Diff Cross-Env | 3 | 3 | 2 | 7 |
| 19 | DLP Impact Checker | 3 | 4 | 4 | 7 |
| 20 | Env Compare (non-solution config) | 4 | 3 | 4 | 6 |
| 21 | Publisher / Prefix Auditor | 2 | 2 | 1 | 5 |
| 22 | Orphan Finder | 3 | 2 | 2 | 5 |
| 23 | Managed Props Bulk Editor | 2 | 2 | 2 | 4 |
| 24 | Patch / Upgrade Planner | 2 | 2 | 3 | 3 |

## One-liners

- **Access Checker** — "why can / can't user X do Y on record Z". `RetrievePrincipalAccess` + role / team / BU / share / hierarchy breakdown.
- **EnvVar + ConnRef Matrix** — rows = env vars / conn refs, columns = environments. Missing values, diff, bulk set, export `deploymentSettings.json`.
- **Offboarding Wizard** — user leaves → reassign records, flows, personal views, connections, queues in one run.
- **XRay port** — solution zip analysis: inventory, diff, upgrade risk score, install order. v1.1: live mode (`ExportSolution`) → zip-vs-env pre-import check.
- **Unmanaged Layer Sweeper** — managed components with active layer → bulk remove. Dry-run + export first.
- **Flow ALM Fixer** — post-import: flows off, conn ref unbound, owner = deploy SPN → bulk fix.
- **Attribute Manager** — column type change / rename with data carry-over. High prestige, data-loss risk.
- **Audit Center** — audit config + history extract + restore old values.
- **SPN / Admin Inventory** — app users, roles, last use. Audit-ready export.
- **Role Minimizer** — privileges vs actual usage → least-privilege role.
- **Audit Config Matrix** — org / table / column audit flags, cross-env diff, bulk set. Seed for Audit Center.
- **Import Job Viewer** — `importjob` XML → readable failure reason, per-component result.
- **Priv Escalation Paths** — roles with `prvAssignRole`, `prvWriteRole`, act-on-behalf → risk flags.
- **Solution Drift Monitor** — component hash snapshots → diff over time.
- **Share Explorer** — POA: who shared what, bulk revoke.
- **Column Security Matrix** — FLS profiles × columns × users / teams.
- **DLP Impact Checker** — policy vs connectors in use → what breaks. Needs PP admin API.

## Build order

1. **XRay port** — Cx 1, learn PPTB API
2. **EnvVar + ConnRef Matrix** — absorbs Deployment Settings Builder (export button)
3. **Access Checker** — absorbs Share Explorer + Column Security Matrix (tabs)
4. **Offboarding Wizard** — reuses Access Checker security queries
5. **Audit Config Matrix** → grows into Audit Center

Merge: Import Job Viewer → XRay "post-import" tab.
Parked: Attribute Manager, Role Minimizer (after audience exists).
Cut: #20–24 (low Vis).

## Brand mechanics

- Consistent `SSS` prefix on tool names, sss-design look across all tools
- SSS link in tool footer, README, npm scope
- Each release → LinkedIn post + short video
- Request PPTB "verified" review early
- Suite framing: XRay + Import Job Viewer + Layer Sweeper = "SSS ALM suite"

## Open checks before XRay port

- PPTB CSP rules: JSZip bundled, no CDN
- File picker: PPTB file API vs `<input type=file>`
- Manifest / package.json fields (`@pptb/types`, `@pptb/validate`)
- npm scope choice
- License (PPTB repos GPL-3.0 — check tool requirements)

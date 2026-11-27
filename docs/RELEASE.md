# RELEASE — owner-side steps per tool

> **2026-11-18 — four tools removed.** Access Checker, Dependency Cleaner, Offboarding Wizard and Audit Config Matrix were removed from this repo (marketplace cap of 3 tools for a new publisher, catalog overlap, write paths never verified live, one maintainer). Their npm packages are deprecated, not unpublished: the last published versions remain installable. Their per-tool sections below are deleted; mentions in the 2026-10 history are kept as history. Reusable host / Web API findings: [PPTB-NOTES.md](PPTB-NOTES.md) §14. Kept: Solution XRay, EnvVar & ConnRef Matrix, D365 Apps Matrix.

## Marketplace review round (2026-10) — owner steps

Reviews of Access Checker, Dependency Cleaner, D365 Apps Matrix and Audit Config Matrix came back "changes requested" against the [marketplace](https://docs.powerplatformtoolbox.com/policies/marketplace) and [AI-assisted development](https://docs.powerplatformtoolbox.com/policies/ai-assisted-development) policies. Fixed in the repo for all seven tools (patch versions):
- `displayName` without the publisher prefix; attribution only in `contributors` and the README `## Credits` section (in-app "Simple Smooth Safe" header and footer link removed).
- `## What this tool changes` section in every README, right after What it does.
- Write confirmations name the target environment and the scope, and either save a backup first or say plainly that the change cannot be undone from the tool (D365 Apps: every install / update / retry; Audit Matrix: publish names its environment, apply saves a backup snapshot and states the revert path).
- `## AI Assistance` disclosure in every README.
- Synthetic screenshots removed (see [SCREENSHOTS.md](SCREENSHOTS.md)).

Not fixable in the repo — owner, per tool, before replying to the review:
- [ ] **Real-environment test** (policy: "Tested by a person, against a real environment": light and dark theme, realistic data volumes, error paths — missing permissions, expired connection, empty results). Use the per-tool checklists below, plus the new confirmations. Then, and only then, remove or rewrite the matching "UNVERIFIED" / "not yet verified against a live tenant" README lines (Dependency Cleaner Limitations, D365 Apps Limitations, Audit Matrix backup/revert note). The reviewers flagged those lines on Dependency Cleaner and D365 Apps: the fix is the test, not deleting the line.
- [ ] Once tested, the `## AI Assistance` line may say "reviewed, tested and maintained"; until then it says "reviewed and maintained".
- [ ] Real ToolBox screenshots, added back to each README.
- [x] **Published to npm 2026-10-06, before the real-environment check** (from `main` b672f0c, each after `npm run build && npm run validate`): Solution XRay 1.2.1, EnvVar & ConnRef Matrix 1.6.1, Access Checker 1.2.1, Dependency Cleaner 1.5.1, D365 Apps Matrix 0.3.1, Offboarding Wizard 0.2.1, Audit Config Matrix 0.2.1. These npm builds do **not** contain the live-test fixes and screenshots committed afterwards on `claude/pensive-ride-08x8zw` (audit-matrix, d365-apps, access-checker, dependency-cleaner commits labelled 0.2.1 / 0.3.1 / 1.2.1 / 1.5.1): those versions are taken on npm, so they were bumped to 0.2.2 / 0.3.2 / 1.2.2 / 1.5.2 and **published to npm 2026-10-06** from this branch with the live-test fixes and real screenshots. Any later fix for Solution XRay / EnvVar Matrix / Offboarding Wizard goes in 1.2.2 / 1.6.2 / 0.2.2. Do not unpublish. README-only changes need no new version: the listing reads `readmeUrl` from `main`.
- [x] **Published to npm 2026-11-18** (from `main`, each after `npm run build && npm run validate && npm run e2e`): EnvVar & ConnRef Matrix 1.6.2 and D365 Apps Matrix 1.0.0 (`main` 707ef7a), Solution XRay 1.3.0 (same build, staged earlier the same day) then 1.3.1 (description mentions live mode; `main` 2c4083c). All three carry the `features.connections` migration. The live mode / Post-import (XRay 1.3.x) and D365 Apps lines still marked not verified in the READMEs stay until the real-environment test.
- [ ] Reply to the review / resubmit once the items above are done.

What to put in each screenshot is spelled out per shot in [SCREENSHOTS.md](SCREENSHOTS.md).

Everything below runs on the owner's machine: needs ToolBox desktop, a Dataverse connection and an npm login. Order per tool: real-env test → real screenshots → publish → submit. Repo state: `main` builds and e2e green for all five; `pptb-validate` passes for all of them. Offboarding Wizard and Audit Config Matrix (0.1.0 on npm since 2026-10-02) have been loaded against a real environment read-only; their write paths are untested.

**Show/hide usability release: published to npm 2026-10-02 before the real-environment check** (fixes go in patch versions): Solution XRay 1.2.0, EnvVar Matrix 1.6.0, Access Checker 1.2.0, Dependency Cleaner 1.2.0, D365 Apps 0.3.0, Offboarding Wizard 0.2.0, Audit Config Matrix 0.2.0. What changed per tool: [USABILITY-AUDIT.md](USABILITY-AUDIT.md) §5. Synthetic README screenshots were refreshed from the e2e harness (`npm run screenshots` in envvar-matrix, d365-apps and access-checker; `E2E_SHOTS=1` for offboarding-wizard e2e and dependency-cleaner upgrade-e2e); real ToolBox captures were kept. Still to do per tool:
- [ ] Load it in ToolBox, light and dark: the fold chevrons, Expand all / Collapse all, the new filters with their "N of M" counts and Clear filters.
- [ ] Reopen the tool: filters and toggles come back as left (saved per viewer in localStorage).
- [ ] Run one write path end to end against a throwaway environment (the preview and plan dialogs were regrouped).
- [ ] Replace the remaining synthetic screenshots with real captures.

Common prep (once):

```bash
git clone https://github.com/sss-dclemente/sss-pptb.git && cd sss-pptb
npm login            # npm account with publish rights on the @simplesmoothsafe scope
```

Per tool, from `tools/<tool>`:

```bash
npm install && npm run build      # dist/ + CSP guard
npm run e2e                        # needs playwright + chromium (npm i -g playwright && npx playwright install chromium)
npm run validate                   # @pptb/validate 1.0.2, live HEAD on readmeUrl
npm test                           # envvar-matrix only: unit tests, no browser
```

ToolBox: Settings → *Show Debug Menu* → Debug → *Load Local Tool* → pick `tools/<tool>`. Light and dark (Settings → theme) both.

## 1. Solution XRay — `tools/solution-xray`

Real-env test (no connection needed):
- [ ] Add 2+ real solution zips (one managed, one unmanaged, ideally two versions of the same solution).
- [ ] Inventory: tables, columns, flows, connection references, env vars, dependencies counts match the maker portal.
- [ ] Compare: v1 → v2 shows added / removed / changed components.
- [ ] Risk: score + factors read sensibly on a real managed solution.
- [ ] Install order: multi-solution set sorts by dependencies; missing dependency listed.
- [ ] Export JSON writes via ToolBox save dialog.
- [ ] Debug log (1.1.0; published to npm 2026-10-02 before this check, fixes go in 1.1.1): tick Debug log in the footer, add a zip, Save log: the .txt names the tool and 1.1.0 and records the switch and the file pick. Untick: nothing more is recorded.
- [ ] Live mode (1.3.0; npm 1.2.1 → 1.3.0, 1.2.2 never published on its own): connected to a Dev env with an unmanaged solution, *Check zip against environment* exports it and fills Compare (A = env, B = zip) and Upgrade risk. If it fails, the debug log records the `ExportSolution` result shape: fix `src/xray/live.ts`. Managed solutions listed but not pickable.
- [ ] Missing deps live (unreleased, UNVERIFIED): Inventory → zip with MissingDependencies on tables/columns/web resources → *Check in <env>*: rows marked *present* / *missing here* match the env. Any *failed* row: hover for the error, fix the query in `src/xray/deps-live.ts`.
- [ ] Post-import (1.3.0): *Load recent import jobs* lists the env's last 20 jobs; pick a failed import: failures first, error codes and texts match the maker portal's import history. Open a downloaded `importjob.data` XML offline: same result. Any component type shown as a raw XML element name → add it to `TYPE_LABELS` in `src/xray/importjob.ts`.

Screenshots (replace `docs/img/*.png`, keep file names): `inventory-light.png`, `inventory-dark.png`, `risk.png`, `install-order.png`. Then delete the line "Synthetic sample data. Replace with real captures before publishing." from `README.md`.

Publish:
```bash
cd tools/solution-xray && npm run build && npm run validate && npm publish --access public
```
Submit at https://www.powerplatformtoolbox.com/submit-tool: npm name `@simplesmoothsafe/pptb-solution-xray`, categories **Solutions, Troubleshooting, Migration** (as listed in the catalog, checked 2026-11-18).

## 2. EnvVar & ConnRef Matrix — `tools/envvar-matrix`

Real-env test (primary + secondary connection, Dev + Test):
- [ ] Both live columns load; counts match `environmentvariabledefinitions` / `connectionreferences` in the maker portal.
- [ ] Filters: text, only differences, only missing, solution scope (pick a solution with env vars).
- [ ] Copy Dev → Test on 2 non-secret rows: preview shows create/update/skip, confirm, results ok, Refresh shows new values. Verify in Test maker portal.
- [ ] Set single cell on a boolean and a JSON variable.
- [ ] Secret rows masked, never written, skipped in preview.
- [ ] Export deploymentSettings.json for Test; feed it to `pac solution import --settings-file` on a throwaway solution.

Note: 1.2.0 was published to npm on 2026-09-24, before the checks below had run on a real environment. Fix failures in 1.2.1; do not unpublish.

- [ ] Consolidate (1.2.0), throwaway Dev env: two solution flows on two different Office 365 references (same connection), one flow On. Merge one into the other: backup saved, preview key-by-key, flow turned off/on and still runs, designer shows the kept reference, merged reference deleted. Repeat with the kept reference unbound: flow reported "left off". Reference used by a canvas app: delete skipped with dependency reason. Restore from backup puts both back.
- [ ] Unused cleanup (1.2.0): one unused unmanaged reference + one used only by a canvas app. Preview: first "delete", second "keep" with dependency reason. Apply deletes the first only.
- [ ] Solution check (1.2.0): solution with a flow whose reference lives outside it. Filter to the solution in Consolidate: listed; Add to solution; export the solution, the reference is in it.
- [ ] Load a real `pac solution create-settings` file via Load snapshot…: values show as a column; copy one value into Dev through the preview.
- [ ] Bind from that settings file: one unbound reference used by an active flow. Preview → Bind: connection set in maker portal, flow restarted and runs. Snapshot from another env as source: refused.
- [ ] Pick connections (1.3.0, experimental; published to npm 2026-09-24 before the probe, fixes go in 1.3.1): first run the probe in `docs/PP-API-SPIKE.md` §6. Connection with Power Platform API enabled: Pick connections… lists the env's connections, each dropdown only that connector's; bind one, flow restarted and runs. Connection without it: "Connections unavailable" with the reason. If the probe shows other field names, fix `normalizeConnection` in `src/matrix/ppconnections.ts`.
- [ ] Turn on flows (1.4.0; published to npm 2026-09-25 before this check, fixes go in 1.4.1): after importing a solution with flows, bind their references, open Consolidate: flows listed as ready / blocked with reasons; turn on one ready flow, it runs on its trigger; a flow whose reference is unbound cannot be selected.
- [ ] Bind backup + run log (1.4.1; published to npm 2026-09-25 before this check, fixes go in 1.4.2): bind one reference; a `connref-bind-backup-*.json` is saved first; Consolidate → Restore from backup… with it puts the old binding back (also for a reference that was unbound). Run log lists the bind and the restore; Export CSV opens cleanly in Excel. Reload the tool: the log is still there.
- [ ] Unit test fixture (1.4.0): export a real solution flow's `clientdata` with two keys on one connector (e.g. `shared_office365`, `shared_office365_1`) and add it next to `scripts/fixtures/flow-clientdata.json` (synthetic, modelled on the export shape); `npm test` must stay green.
- [ ] Snapshot export from Dev, reload as third column, matrix compares.
- [ ] Connection references tab: bound / unbound / absent correct.

Screenshots: `envvars.png`, `preview.png`, `connrefs.png`, `snapshot-dark.png`. Remove the synthetic-data line from `README.md`.

Publish:
```bash
cd tools/envvar-matrix && npm run build && npm test && npm run validate && npm publish --access public
```
Submit: `@simplesmoothsafe/pptb-envvar-matrix`, categories **Environments, Migration, Comparisons**.

- [ ] Debug log (1.5.0; published to npm 2026-10-02 before this check, fixes go in 1.5.1): tick Debug log, Refresh, Save log: every `queryData` with its query text and result, no connection secret in the file. The switch is still on after reopening the tool.

## 3–6. Access Checker, Dependency Cleaner, Offboarding Wizard, Audit Config Matrix

Removed 2026-11-18 (see note at top). Do not publish new versions. Owner steps: `npm deprecate` each package and withdraw the pending marketplace submissions (Access Checker, Dependency Cleaner, Audit Config Matrix; Offboarding Wizard was never submitted).

## 7. D365 Apps Matrix — `tools/d365-apps`

Submit (or set in the reply to the review): `@simplesmoothsafe/pptb-d365-apps`, categories **Environments, Comparisons, Solutions**. Environments: an admin task done per environment, the same place as Environment Manager. Comparisons: the matrix compares app versions across environments. Solutions: each install or update imports the app's solutions, and Unused apps maps apps to solutions.

## After publish

- [ ] ToolBox → Debug → *Install from npm* → each package name; smoke test once more from the published build (README, LICENSE, src are stripped at intake, only `package.json` + `dist/` ship).
- [x] Root `README.md`: change "unpublished" to the published version per tool.
- [ ] Commit real screenshots + README edits; `readmeUrl` points at `main`, so the marketplace picks them up on the next daily sync.
- [x] Version: all four tools at `1.0.0` (Verified badge needs ≥1.0.0). Bumped by owner decision before the real-env checklist ran; registry syncs `latest` daily at 00:00 UTC.
- [ ] Do NOT add a package-root `index.html` either. 0.1.2 generated one; 0.1.3 removed it. `main` resolves inside `dist/`, so it was never needed — the npm-install launch failure was a host bug (PPTB-NOTES §11), not a packaging problem.
- [ ] Do NOT reintroduce `npm-shrinkwrap.json`. The PPTB samples and publishing docs prescribe it plus a `finalize-package` script, and both were dropped in 0.1.1: npm honours a published shrinkwrap as the full tree including its `dev: true` entries, so `npm install` of a ~25 kB tool pulled ~50 MB of vite/esbuild/typescript/rollup (measured: 50 MB → under 200 KB after the fix). `npm shrinkwrap --omit=dev` does not help. The `dist/` bundles are self-contained, so there is nothing left to lock, and `@pptb/validate` does not check for it. See docs/PORT-PLAN.md.

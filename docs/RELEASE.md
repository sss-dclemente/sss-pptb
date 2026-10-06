# RELEASE — owner-side steps per tool

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

## 1. SSS Solution XRay — `tools/solution-xray`

Real-env test (no connection needed):
- [ ] Add 2+ real solution zips (one managed, one unmanaged, ideally two versions of the same solution).
- [ ] Inventory: tables, columns, flows, connection references, env vars, dependencies counts match the maker portal.
- [ ] Compare: v1 → v2 shows added / removed / changed components.
- [ ] Risk: score + factors read sensibly on a real managed solution.
- [ ] Install order: multi-solution set sorts by dependencies; missing dependency listed.
- [ ] Export JSON writes via ToolBox save dialog.
- [ ] Debug log (1.1.0; published to npm 2026-10-02 before this check, fixes go in 1.1.1): tick Debug log in the footer, add a zip, Save log: the .txt names the tool and 1.1.0 and records the switch and the file pick. Untick: nothing more is recorded.

Screenshots (replace `docs/img/*.png`, keep file names): `inventory-light.png`, `inventory-dark.png`, `risk.png`, `install-order.png`. Then delete the line "Synthetic sample data. Replace with real captures before publishing." from `README.md`.

Publish:
```bash
cd tools/solution-xray && npm run build && npm run validate && npm publish --access public
```
Submit at https://www.powerplatformtoolbox.com/submit-tool: npm name `@simplesmoothsafe/pptb-solution-xray`, categories **Solutions, Troubleshooting, Comparisons**.

## 2. SSS EnvVar & ConnRef Matrix — `tools/envvar-matrix`

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

## 3. SSS Access Checker — `tools/access-checker`

Real-env test (one connection, a user with a mix of direct role + team role):
- [ ] User typeahead finds by name / domain / email; disabled badge on a disabled user.
- [ ] Table list excludes intersect/private tables; org-owned table shows Assign / Share as n/a.
- [ ] Table-level check: every chip's depth equals the effective depth in Security roles UI (`agrees` on all eight).
- [ ] Record check: pick a record owned by another user in a child BU and one in a sibling BU; verdict chips match what the user actually sees (log in as them or use "Check access" in the model-driven app). Any `platform says otherwise` → note the case in `docs/BACKLOG.md`.
- [ ] Record shared with a team the user belongs to: Shares tab lists it with `via team`; Check tab shows the share as the winning path.
- [ ] Column security on a table with a secured column: Read / Update / Create match the field security profile UI.
- [ ] Hierarchy: with hierarchy security on and the user as the owner's manager, the Hierarchy card appears. If the card says "state unknown", the organization row could not be read: check `fetchHierarchySettings` in `src/access/fetch.ts` (`ishierarchicalsecuritymodelenabled`, `maxdepthforhierarchicalsecuritymodel`, both documented on the organization table). A manager further above the owner than the organization's hierarchy depth gets no card.
- [ ] Table-level check on an activity table (Task) and on Note: chips agree (names come from entity metadata: `prv*Activity`, `prv*Note`).
- [ ] Team role with *Member's privilege inheritance* = *Team privileges only* at Basic: a record the user owns is not reached through it; a record owned by that team is.
- [ ] Record shared with the user for a right they hold no privilege for: the chip is denied and the "why" line says the share has no effect.
- [ ] Exports: JSON, shares CSV, columns CSV.
- [ ] Debug log (1.1.0; published to npm 2026-10-02 before this check, fixes go in 1.1.1): tick Debug log, run a record check, Save log: user, privilege and share queries with results; a failed call shows its error.

Screenshots: `check.png`, `columns-dark.png` (+ optionally `shares.png`, add to README). Remove the synthetic-data line from `README.md`.

Publish:
```bash
cd tools/access-checker && npm run build && npm run validate && npm publish --access public
```
Submit: `@simplesmoothsafe/pptb-access-checker`, categories **Users & Security, Troubleshooting**.

## 4. SSS Dependency Cleaner — `tools/dependency-cleaner`

Real-env test, Upgrade blockers (1.1.0; published to npm 2026-10-02 before this check, fixes go in 1.1.1). Sandbox only: primary = Dev with the unmanaged solution, secondary = Test with it installed managed, a custom page still listed by a model-driven app.
- [ ] Tick Debug log, Upgrade blockers → Analyze, Save log. The log answers the probe in docs/UPGRADE-BLOCKERS-PLAN.md §4: `RetrieveDependenciesForDelete` response shape, `msdyn_componentlayers` rows (and the unmanaged layer's name), `canvasappid` / `appmoduleid` equal or not between Dev and Test. Send the .txt; adjust `src/deps/upgrade.ts` if a shape differs.
- [ ] Counts (removed / deleted / survive / blockers) match what a real stage-and-upgrade of the same solution reports in the target.
- [ ] Remove from app on the page blocker: backup saved, `RemoveAppComponents` succeeds, the app no longer lists the page after publish, re-analysis drops the blocker. Restore puts the page back.
- [ ] Runtime breaks: a JS web resource calling `navigateTo` with the page name is listed.
- [ ] Exports: Markdown checklist and CSV.
Slim (1.3.0 probed 2026-10-05 on SL sandbox, PP365ControlFlows; 1.3.1 not yet published): results and the second-run checklist in docs/SOLUTION-SLIMMER-PLAN.md §4.
- [x] Reads: `primaryentityname`, every `ismanaged`, layer names for tables / columns / roles / views / forms / processes / web resources / choices / apps / site maps.
- [x] Apply failed on `RemoveSolutionComponent` (`ComponentId` is not a Web API parameter); nothing changed. 1.3.1 sends the `SolutionComponent` reference (also used by Fix and Restore).
- [ ] 1.3.1, Debug log on: platform badges on account / contact; *customized* only where Layers names a real change; apply two or three rows, then the whole plan; Analyzed again shows them gone; Restore re-adds.

Cycles (1.4.0; not yet published): probe in docs/CYCLES-PLAN.md §4 with two sandbox solutions that need each other and an empty base solution.
- [ ] Analyze: the cycle and its two rows; orphans plausible. Preview with the defaults: 0 cycles after, order base first. Apply, Analyzed again: 0 cycles; the base holds the column (with its table shell) and the table shell. Undo removes them. Export both managed, import in the shown order: no missing dependencies.
Failed import (1.5.0; not yet published). Sandbox only: a managed solution whose new version drops a connection reference that an unmanaged flow (or an Active layer of a managed flow) in Test still uses; import the new version, let it fail.
- [ ] Debug log on, Failed import → Scan solution history: the failed run is listed (`msdyn_solutionhistories` filter accepted or the unfiltered fallback), the connection reference is named, its references are placed by layer.
- [ ] Re-point the unmanaged flow: backup saved, the flow is off → updated → on, Checked again drops it; Undo flow changes puts it back.
- [ ] Remove active customizations on the managed flow's Active layer: `RemoveActiveCustomizations` through `queryData` succeeds (or note which `ComponentId` form works), the layer is gone in See solution layers, Checked again drops it. Import again: the upgrade passes.
- [ ] Paste the raw Failure details text: one component, same result.
- [x] 1.1.1 (published to npm 2026-10-02): Diagnose and Upgrade blockers failed on their first query with `0x80060888: Could not find a property named '_rootsolutioncomponentid_value'` (first real-environment debug log). `rootsolutioncomponentid` is a Uniqueidentifier column, not a lookup; the e2e mocks now reject the wrong name like Dataverse does.

Publish:
```bash
cd tools/dependency-cleaner && npm run build && npm run validate && npm publish --access public
```

## 5. SSS Offboarding Wizard — `tools/offboarding-wizard`

Real-env test (one connection, a sandbox user who owns a bit of everything, plus a second user as successor). **Do the first run against a sandbox**: this tool writes ownership and membership.

> **Status, 2026-09-21.** Loaded in ToolBox against a real environment and exercised read-only: it connects, reads and renders. No plan was applied, so every write path below is still untested and none of the boxes are ticked on the strength of that session.
>
> **0.1.0 published to npm 2026-10-02, before the write-path checks below.** Fixes go in 0.1.1; do not unpublish.
- [ ] Leaver typeahead finds by name / domain / email; BU, manager, state, access mode and direct-report count are right. If access mode shows `—`, the attribute name is wrong: fix it in `src/offboard/fetch.ts`.
- [ ] Record scan: the request count in the confirmation is plausible, the progress bar moves, Cancel stops it, and any table listed as *not scanned* is one that genuinely rejects the owner filter. Counts for two or three tables match an advanced find on the same owner.
- [ ] Every other category is correct against the maker portal / admin centre: flows (an active modern flow is flagged), personal views and charts, queues owned, queue memberships, teams (owner vs Entra group), security roles, field security profiles, connection references, direct reports. Any category that errors → note the entity set or relationship name in `docs/OFFBOARDING-PLAN.md` §UNVERIFIED and fix `src/offboard/fetch.ts`.
- [ ] Preview writes nothing: open it, read the verbatim calls, cancel, then confirm in the platform that nothing moved.
- [ ] Apply a small plan (one table, a few records, one role, one team): each operation gets its own row, the records moved, the role and membership changed. Then a plan that includes something the connection user lacks the privilege for: it fails as one red row and the rest of the run continues.
- [ ] Confirm the tool never touched the leaver's user record: still enabled, same access mode, same licence.
- [ ] Exports: inventory JSON + CSV, apply report JSON + CSV, and the manual-steps list.

Screenshots: `inventory.png`, `plan.png`, `report-dark.png`. Remove the synthetic-data line from `README.md`.

Publish:
```bash
cd tools/offboarding-wizard && npm run build && npm run validate && npm publish --access public
```
Submit: `@simplesmoothsafe/pptb-offboarding-wizard`, categories **Users & Security, Data**.

## 6. SSS Audit Config Matrix — `tools/audit-matrix`

Real-env test (two connections to sandboxes whose audit configuration differs, or one connection plus a snapshot). **Metadata writes are real and need a publish**: sandbox first.

> **Status, 2026-09-21.** Loaded in ToolBox against a real environment and exercised read-only: it connects, reads and renders. No plan was applied, so every write path below is still untested and none of the boxes are ticked on the strength of that session.
>
> **0.1.0 published to npm 2026-10-02, before the write-path checks below.** Fixes go in 0.1.1; do not unpublish.
- [ ] Matrix loads; table count and the audited count match Settings → Auditing → Entity and Field Audit Settings.
- [ ] A table from a managed solution that forbids the change shows as `locked` and cannot be ticked.
- [ ] Secondary connection populates the comparison column; `≠` appears exactly where the two environments really differ. Then export a snapshot from one, load it into the other, and check the same diff appears.
- [ ] Expand a table: its auditable columns load, the column counts name their scope, and a column you know is audited reads `on`.
- [ ] Org tab: the four switches match the admin centre for both environments. Any field showing `unknown` names an attribute to fix in `src/audit/fetch.ts` — `isreadauditenabled` and `auditretentionperiodv2` are the two unverified ones.
- [ ] **Plan: match other env** builds a plan that never contains a locked row. Preview, cancel, and confirm nothing changed.
- [ ] Apply a small plan (one table flag, one column flag): rows report ok, then accept the scoped publish, then reload the matrix and see the new values. Check the table in the maker portal.
- [ ] A write that the environment rejects stays in the plan as a failed row and does not stop the batch.
- [ ] Exports: matrix CSV, JSON snapshot, plan CSV and plan PowerShell script (run the script against a sandbox once to confirm it is actually runnable).

Screenshots: `matrix.png`, `columns.png`, `differences.png`, `preview.png`, `org-dark.png`. Remove the synthetic-data line from `README.md`.

Publish:
```bash
cd tools/audit-matrix && npm run build && npm run validate && npm publish --access public
```
Submit: `@simplesmoothsafe/pptb-audit-matrix`, categories **Users & Security, Comparisons, Solutions**.

## After publish

- [ ] ToolBox → Debug → *Install from npm* → each package name; smoke test once more from the published build (README, LICENSE, src are stripped at intake, only `package.json` + `dist/` ship).
- [x] Root `README.md`: change "unpublished" to the published version per tool.
- [ ] Commit real screenshots + README edits; `readmeUrl` points at `main`, so the marketplace picks them up on the next daily sync.
- [x] Version: all four tools at `1.0.0` (Verified badge needs ≥1.0.0). Bumped by owner decision before the real-env checklist ran; registry syncs `latest` daily at 00:00 UTC.
- [ ] Do NOT add a package-root `index.html` either. 0.1.2 generated one; 0.1.3 removed it. `main` resolves inside `dist/`, so it was never needed — the npm-install launch failure was a host bug (PPTB-NOTES §11), not a packaging problem.
- [ ] Do NOT reintroduce `npm-shrinkwrap.json`. The PPTB samples and publishing docs prescribe it plus a `finalize-package` script, and both were dropped in 0.1.1: npm honours a published shrinkwrap as the full tree including its `dev: true` entries, so `npm install` of a ~25 kB tool pulled ~50 MB of vite/esbuild/typescript/rollup (measured: 50 MB → under 200 KB after the fix). `npm shrinkwrap --omit=dev` does not help. The `dist/` bundles are self-contained, so there is nothing left to lock, and `@pptb/validate` does not check for it. See docs/PORT-PLAN.md.

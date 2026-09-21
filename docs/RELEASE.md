# RELEASE — owner-side steps per tool

What to put in each screenshot is spelled out per shot in [SCREENSHOTS.md](SCREENSHOTS.md).

Everything below runs on the owner's machine: needs ToolBox desktop, a Dataverse connection and an npm login. Order per tool: real-env test → real screenshots → publish → submit. Repo state: `main` builds and e2e green for all five; `pptb-validate` passes for the three published tools and runs for the other two once their READMEs are on `main`.

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
- [ ] Snapshot export from Dev, reload as third column, matrix compares.
- [ ] Connection references tab: bound / unbound / absent correct.

Screenshots: `envvars.png`, `preview.png`, `connrefs.png`, `snapshot-dark.png`. Remove the synthetic-data line from `README.md`.

Publish:
```bash
cd tools/envvar-matrix && npm run build && npm run validate && npm publish --access public
```
Submit: `@simplesmoothsafe/pptb-envvar-matrix`, categories **Environments, Migration, Comparisons**.

## 3. SSS Access Checker — `tools/access-checker`

Real-env test (one connection, a user with a mix of direct role + team role):
- [ ] User typeahead finds by name / domain / email; disabled badge on a disabled user.
- [ ] Table list excludes intersect/private tables; org-owned table shows Assign / Share as n/a.
- [ ] Table-level check: every chip's depth equals the effective depth in Security roles UI (`agrees` on all eight).
- [ ] Record check: pick a record owned by another user in a child BU and one in a sibling BU; verdict chips match what the user actually sees (log in as them or use "Check access" in the model-driven app). Any `platform says otherwise` → note the case in `docs/BACKLOG.md`.
- [ ] Record shared with a team the user belongs to: Shares tab lists it with `via team`; Check tab shows the share as the winning path.
- [ ] Column security on a table with a secured column: Read / Update / Create match the field security profile UI.
- [ ] Hierarchy: with hierarchy security on and the user as the owner's manager, the Hierarchy card appears. If the card says "state unknown", the attribute `ishierarchicalsecuritymodelenabled` is wrong: fix `fetchHierarchyEnabled` in `src/access/fetch.ts`.
- [ ] Exports: JSON, shares CSV, columns CSV.

Screenshots: `check.png`, `columns-dark.png` (+ optionally `shares.png`, add to README). Remove the synthetic-data line from `README.md`.

Publish:
```bash
cd tools/access-checker && npm run build && npm run validate && npm publish --access public
```
Submit: `@simplesmoothsafe/pptb-access-checker`, categories **Users & Security, Troubleshooting**.

## 4. SSS Offboarding Wizard — `tools/offboarding-wizard`

Real-env test (one connection, a sandbox user who owns a bit of everything, plus a second user as successor). **Do the first run against a sandbox**: this tool writes ownership and membership.
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
Submit: `@simplesmoothsafe/pptb-offboarding-wizard`, categories **Users & Security, Data Management**.

## 5. SSS Audit Config Matrix — `tools/audit-matrix`

Real-env test (two connections to sandboxes whose audit configuration differs, or one connection plus a snapshot). **Metadata writes are real and need a publish**: sandbox first.
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
- [ ] Version: `0.1.3` is published and fine for listing. Bump to `1.0.0` (Verified badge needs ≥1.0.0) once the real-env checklist passes; registry syncs `latest` daily at 00:00 UTC.
- [ ] Do NOT add a package-root `index.html` either. 0.1.2 generated one; 0.1.3 removed it. `main` resolves inside `dist/`, so it was never needed — the npm-install launch failure was a host bug (PPTB-NOTES §11), not a packaging problem.
- [ ] Do NOT reintroduce `npm-shrinkwrap.json`. The PPTB samples and publishing docs prescribe it plus a `finalize-package` script, and both were dropped in 0.1.1: npm honours a published shrinkwrap as the full tree including its `dev: true` entries, so `npm install` of a ~25 kB tool pulled ~50 MB of vite/esbuild/typescript/rollup (measured: 50 MB → under 200 KB after the fix). `npm shrinkwrap --omit=dev` does not help. The `dist/` bundles are self-contained, so there is nothing left to lock, and `@pptb/validate` does not check for it. See docs/PORT-PLAN.md.

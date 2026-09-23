# RELEASE — owner-side steps per tool

What to put in each screenshot is spelled out per shot in [SCREENSHOTS.md](SCREENSHOTS.md).

Everything below runs on the owner's machine: needs ToolBox desktop, a Dataverse connection and an npm login. Order per tool: real-env test → real screenshots → publish → submit. Repo state: `main` builds, e2e green, `pptb-validate` passes for all three.

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
- [ ] Hierarchy: with hierarchy security on and the user as the owner's manager, the Hierarchy card appears. If the card says "state unknown", the organization row could not be read: check `fetchHierarchySettings` in `src/access/fetch.ts` (`ishierarchicalsecuritymodelenabled`, `maxdepthforhierarchicalsecuritymodel`, both documented on the organization table). A manager further above the owner than the organization's hierarchy depth gets no card.
- [ ] Table-level check on an activity table (Task) and on Note: chips agree (names come from entity metadata: `prv*Activity`, `prv*Note`).
- [ ] Team role with *Member's privilege inheritance* = *Team privileges only* at Basic: a record the user owns is not reached through it; a record owned by that team is.
- [ ] Record shared with the user for a right they hold no privilege for: the chip is denied and the "why" line says the share has no effect.
- [ ] Exports: JSON, shares CSV, columns CSV.

Screenshots: `check.png`, `columns-dark.png` (+ optionally `shares.png`, add to README). Remove the synthetic-data line from `README.md`.

Publish:
```bash
cd tools/access-checker && npm run build && npm run validate && npm publish --access public
```
Submit: `@simplesmoothsafe/pptb-access-checker`, categories **Users & Security, Troubleshooting**.

## After publish

- [ ] ToolBox → Debug → *Install from npm* → each package name; smoke test once more from the published build (README, LICENSE, src are stripped at intake, only `package.json` + `dist/` ship).
- [x] Root `README.md`: change "unpublished" to the published version per tool.
- [ ] Commit real screenshots + README edits; `readmeUrl` points at `main`, so the marketplace picks them up on the next daily sync.
- [x] Version: all four tools at `1.0.0` (Verified badge needs ≥1.0.0). Bumped by owner decision before the real-env checklist ran; registry syncs `latest` daily at 00:00 UTC.
- [ ] Do NOT add a package-root `index.html` either. 0.1.2 generated one; 0.1.3 removed it. `main` resolves inside `dist/`, so it was never needed — the npm-install launch failure was a host bug (PPTB-NOTES §11), not a packaging problem.
- [ ] Do NOT reintroduce `npm-shrinkwrap.json`. The PPTB samples and publishing docs prescribe it plus a `finalize-package` script, and both were dropped in 0.1.1: npm honours a published shrinkwrap as the full tree including its `dev: true` entries, so `npm install` of a ~25 kB tool pulled ~50 MB of vite/esbuild/typescript/rollup (measured: 50 MB → under 200 KB after the fix). `npm shrinkwrap --omit=dev` does not help. The `dist/` bundles are self-contained, so there is nothing left to lock, and `@pptb/validate` does not check for it. See docs/PORT-PLAN.md.

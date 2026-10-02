# SCREENSHOTS — what to capture, per tool

The eighteen images under `tools/*/docs/img/` are synthetic placeholders. `configurations.readmeUrl` points at `main`, so whatever is committed there is what the marketplace listing renders. Replacing them is the last blocking step before submission (`docs/RELEASE.md`).

Work through one tool at a time. Each shot below names the file to overwrite, the state to build, and what has to be visible for the image to earn its place.

## Before you start

**Use a sandbox or trial environment, not a client one.** These images go into a public repo and a public marketplace listing. A real Dataverse environment puts table names, user names, security roles and record data in front of everyone who browses the catalogue. A developer or trial environment with data you own gives an equally real capture with none of that exposure. If you do use a live environment, check every shot for client-identifying values before committing — the Access Checker ones in particular put user names and role names on screen by design.

**Keep the window the same size for all eighteen.** The e2e suites render at 1400×900 and the layouts are tuned for it. A consistent size makes the shots in a README look like one set.

**Theme** is Settings → theme in ToolBox. Five files want dark (`inventory-dark`, `snapshot-dark`, `columns-dark`, `report-dark`, `org-dark`); the rest are light.

**Load the tools with Debug → Load Local Tool.** Install-from-npm is broken in the host (PPTB-NOTES §11), so it is not an option until they ship the fix.

**Keep the file names exactly as they are.** The READMEs reference them by name; renaming breaks the listing images.

---

## 1. SSS Solution XRay — `tools/solution-xray/docs/img/`

Needs two or more real exported solution zips. Ideally two versions of the same solution, one of them managed, so Compare and the baseline scoring have something to say. No connection required.

### `inventory-light.png` — light
Inventory tab, one real solution loaded.
- Solution header visible: unique name, version, managed flag, publisher
- The tables section expanded far enough to show column/form/view counts
- Enough rows that the component-type breakdown reads as a real solution, not a toy

This is the first image on the listing. If only one shot gets care, make it this one.

### `inventory-dark.png` — dark
The same solution, same scroll position, theme switched. The pair exists to show the tool is themed, so keeping everything else identical is the point.

### `risk.png` — light
Upgrade risk tab, with a **baseline selected** (the previous version of the same solution).
- Score and band visible
- Several factors listed with their evidence, not an empty or near-zero result
- At least one baseline-only factor if your zips produce it — removed table, removed column, version regression, managed/unmanaged flip

A score of 0 with no factors makes the feature look pointless. Pick the pair of zips that produces real findings.

### `install-order.png` — light
Install order tab, with **three or more solutions loaded**.
- The computed order visible with the reason on each edge
- Ideally a dependency on a solution you did not load, listed as external

The README caption says "with a dependency cycle". If your real solutions do not form one, either change the caption to match what the image shows, or use `SolD.zip` + `SolE.zip` from the sample set for this one shot — they are built to cycle. Do not leave the caption describing something the image does not contain.

---

## 2. SSS EnvVar & ConnRef Matrix — `tools/envvar-matrix/docs/img/`

Needs two connected environments (primary and secondary) with environment variables that genuinely differ. The value of this tool is the difference, so an all-green matrix is the wrong picture.

### `envvars.png` — light
Environment variables tab, both environment columns showing.
- A variable with a value in one environment and **missing in the other**
- A variable whose values differ between environments
- At least one secret row, **masked** — this shows the tool handles secrets safely and is worth having on screen
- The filter row visible so the only-differences and only-missing options are discoverable

### `preview.png` — light
The copy preview dialog, open, after choosing a source and target environment and pressing copy.
- The preview listing **update, create and skip** rows together if you can arrange it — the three outcomes side by side is what makes the dialog legible
- Skipped secrets visible as skipped

Capture the preview, not the result. The preview is the safety feature.

### `connrefs.png` — light
Connection references tab.
- A mix of **bound and unbound** references
- The connector name and the connection each one resolves to

### `snapshot-dark.png` — dark
Environment variables tab with a **snapshot loaded as a third column**, theme switched.
- Three columns side by side, so the snapshot feature is obvious
- The snapshot column visibly labelled as such

---

## 3. SSS Access Checker — `tools/access-checker/docs/img/`

Needs one connection and a user with a mix of direct role and team role. The most persuasive shot is one where the verdict is **not** all-green — a denial with its reason explained is the whole point of the tool.

### `check.png` — light
Check tab, a user and a record selected, verdicts rendered.
- The per-right chips visible across the eight access rights
- **At least one denial** alongside the grants
- The chain that produced a verdict visible — role, team, business unit, ownership or share
- The business-unit relation line and, if your environment has hierarchy security on, the hierarchy card

If a `platform says otherwise` warning appears, do not screenshot it — note the case in `docs/BACKLOG.md` and fix it first. Shipping a listing image that shows the tool disagreeing with the platform would be a poor first impression.

### `columns-dark.png` — dark
Columns tab on a table with a **real field security profile**, theme switched.
- Secured columns listed with Read / Update / Create per column
- Mixed results, not all-allowed

### `shares.png` — light, optional
Shares tab, a record shared with a team the user belongs to.
- The share listed with the `via team` badge
- The `affects` badge showing it is the winning path

If you capture it, add it to `tools/access-checker/README.md` under the existing screenshots with a caption like "Shares, with the path that grants access". If you skip it, nothing else changes.

---

## 4. SSS Offboarding Wizard — `tools/offboarding-wizard/docs/img/`

Needs one connection and a sandbox user who owns a realistic mix — records in several tables, at least one active modern flow, a couple of personal views, a team, two roles. The tool's argument is *how much a leaving user silently holds*, so a thin inventory undersells it. Use a sandbox: these shots put a person's name, their teams and their roles on screen.

### `inventory.png` — light
Inventory tab, the leaver selected and the record scan finished.
- The leaver header with business unit, manager and state
- Several category cards with non-zero counts, at least one expanded to its detail table
- The records-per-table card showing more than one table, and the active-modern-flow flag if the user has one

This is the first image on the listing. Do not capture it mid-scan with a half-empty progress bar.

### `plan.png` — light
The preview dialog open, over the Plan & apply tab.
- The successor selected and the per-category options visible behind the dialog
- Operation counts per category in the dialog, with at least one warning or skip line (an owner team or an Entra group team does this nicely)
- Some of the verbatim calls visible — they are what tells a reviewer the tool shows its work before writing

### `report-dark.png` — dark
The results after a small applied plan, theme switched.
- One row per operation with its ok status
- Ideally one failed row alongside the successes: an honest failure row is more convincing than a clean sheet
- The manual-steps list visible if it fits

## 5. SSS Audit Config Matrix — `tools/audit-matrix/docs/img/`

Needs two connections to environments whose audit configuration genuinely differs (dev vs test is the natural pair), or one connection plus a snapshot exported from the other. A matrix with no `≠` in it demonstrates nothing.

### `matrix.png` — light
Matrix tab, both environments loaded, nothing filtered.
- Both environment columns with their connection names in the header
- The counts row: tables audited, differences
- Enough rows that the on/off mix is visible, with at least two `≠` markers on screen
- A `locked` row if your environment has one

### `columns.png` — light
The same matrix with one table expanded to its columns.
- The parent table row and its columns indented below it
- At least one column differing between the environments
- The column counts naming their scope

### `differences.png` — light
The "only differences" filter active.
- Only differing rows left, and the count making clear how many
- This is the shot that sells the tool to someone doing an environment comparison, so pick a table set where the differences are real and explicable

### `preview.png` — light
The preview dialog from **Plan: match other env**.
- Each operation with its current value, planned value and reason
- The count of operations, and the confirm/cancel buttons
- No locked row anywhere in the list (if one appears, that is a bug, not a screenshot)

### `org-dark.png` — dark
Org settings tab, both environments side by side, theme switched.
- The four switches per environment, with a real difference between them if you have one
- If a field reads `unknown`, fix the attribute name before capturing — a listing image should not advertise a gap

---

## After the captures

Per tool:

1. Overwrite the files in `tools/<tool>/docs/img/`, same names.
2. Delete the line `Synthetic sample data. Replace with real captures before publishing.` from `tools/<tool>/README.md`.
3. Check each image once more for anything you would not want on a public listing.
4. If you added `shares.png`, add its markdown to the access-checker README.

Then commit and **push to `main`**. `readmeUrl` resolves against `main`, so the listing only picks the images up once they are there — not from a branch.

Only after that does that tool's submission step in `docs/RELEASE.md` make sense to run.

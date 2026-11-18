# SCREENSHOTS — what to capture, per tool

Marketplace review (2026-10) rejected synthetic screenshots: the policy is "Screenshots are real. Screenshots and GIFs must show the actual tool, not mock-ups." All synthetic images were removed from `tools/*/docs/img/` and from the READMEs; the e2e / `npm run screenshots` output now goes to the gitignored `docs/img-synthetic/`. Real ToolBox captures kept: Solution XRay `inventory-light.png` and `risk.png`. `configurations.readmeUrl` points at `main`, so whatever is committed there is what the marketplace listing renders.

Per shot below: capture it inside ToolBox, save it under `tools/<tool>/docs/img/` with the file name given, and add it back to the tool README under a `## Screenshots` section (after `## What this tool changes`), with the raw.githubusercontent.com `main` URL. Never commit an image from `docs/img-synthetic/`.

Work through one tool at a time. Each shot below names the file to overwrite, the state to build, and what has to be visible for the image to earn its place.

## Before you start

**Use a sandbox or trial environment, not a client one.** These images go into a public repo and a public marketplace listing. A real Dataverse environment puts table names, user names, security roles and record data in front of everyone who browses the catalogue. A developer or trial environment with data you own gives an equally real capture with none of that exposure. If you do use a live environment, check every shot for client-identifying values before committing.

**Keep the window the same size for every shot.** The e2e suites render at 1400×900 and the layouts are tuned for it. A consistent size makes the shots in a README look like one set.

**Theme** is Settings → theme in ToolBox. Two files want dark (`inventory-dark`, `snapshot-dark`); the rest are light.

**Load the tools with Debug → Load Local Tool.** Install-from-npm is broken in the host (PPTB-NOTES §11), so it is not an option until they ship the fix.

**Keep the file names exactly as they are.** The READMEs reference them by name; renaming breaks the listing images.

---

## 1. Solution XRay — `tools/solution-xray/docs/img/`

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

## 2. EnvVar & ConnRef Matrix — `tools/envvar-matrix/docs/img/`

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

## 3–5. Access Checker, Offboarding Wizard, Audit Config Matrix

Removed 2026-11-18 together with Dependency Cleaner: tools deleted from this repo, npm packages deprecated (last published versions remain installable). No captures needed.

---

## After the captures

Per tool:

1. Overwrite the files in `tools/<tool>/docs/img/`, same names.
2. Delete the line `Synthetic sample data. Replace with real captures before publishing.` from `tools/<tool>/README.md`.
3. Check each image once more for anything you would not want on a public listing.

Then commit and **push to `main`**. `readmeUrl` resolves against `main`, so the listing only picks the images up once they are there — not from a branch.

Only after that does that tool's submission step in `docs/RELEASE.md` make sense to run.

# Usability audit — show / hide what matters

> **2026-11-18:** Access Checker, Dependency Cleaner, Offboarding Wizard and Audit Config Matrix were removed from this repo (npm packages deprecated; last published versions remain installable). Their per-tool sections and rows are deleted below; cross-cutting S-items stay as history.

Scope: all 7 tools at the time (3 kept). Question: can the user hide the noise and reveal the part of the content they need?
Method: read each tool's UI code, built it, ran its mocked e2e, reviewed screenshots. Fix status in §5.
Checked per screen: collapse/expand (+ visible affordance, expand/collapse all), filters + "N of M" counts, column visibility, noise hidden by default, detail on demand, empty states + "Clear filters", persistence of toggles, ARIA.

Severity: **H** = user misses or misreads content / acts on rows they cannot see · **M** = slow to reach content · **L** = polish.

## 1. Cross-cutting (fix once in `tools/_shared`)

| # | Sev | Where | Finding | Fix |
|---|---|---|---|---|
| S1 | H | `_shared/tokens.css:181-182` | `details.card > summary` hides the native marker, nothing replaces it → closed fold cards look like plain headings (XRay, Dep Cleaner upgrade, Offboarding inventory). Access Checker `.why summary` (`display:flex`) loses its marker too. | `summary .card-head::before` chevron, `rotate(90deg)` on `[open]`; same rule for `.why summary`. |
| S2 | M | `_shared/dom.ts:57` | No expand all / collapse all anywhere. | `foldAllButtons(container)` helper → two ghost buttons in card-list headers. |
| S3 | M | all tools | Open/closed state lost on every re-render (filter change, tab switch, refresh, post-apply). | `foldCard(..., key)` + module-level `Map<key, open>` updated on `toggle`. |
| S4 | M | all tools | No filter/toggle persisted; only debug switch uses localStorage. | `viewState(toolId)` helper — localStorage in try/catch (pattern from `debug.ts:36`). |
| S5 | M | all tools | No "N of M shown" and no "Clear filters" action in filtered empty states. | `filteredEmptyState(onClear)` + count caption convention. |
| S6 | L | `_shared/dom.ts:111-119` | Tabs: no `aria-selected` / `aria-controls` / `tabpanel`, no arrow keys. `#status` / progress lines lack `aria-live`. | Set in `wireTabs`; add `aria-live="polite"` to status. |
| S7 | L | `_shared/tokens.css:167` | `.toolbar .btn { margin-left:auto }` scatters adjacent toolbar buttons (D365 "Select all updates" vs "Select all failed"). | Apply auto-margin only to first button of a trailing group. |
| S8 | H | EnvVar `styles.css:30-33`, D365 `styles.css:28-31` | Matrix first column not sticky → horizontal scroll loses which row you are on. | `position:sticky; left:0` + background on name column (and select column). |

## 2. Bugs found in passing (not just disclosure)

| Tool | Where | Bug |
|---|---|---|
| D365 Apps | `main.ts:438-441` | "Select all updates" ignores the name filter ("Select all failed" respects it) → silently ticks hidden rows. |
| Solution XRay | `main.ts:183` vs `:168` | Compare header counts include root rows the list hides; when only root rows differ → false "No differences". |

## 3. Per tool

### Solution XRay
Has: tabs; Inventory fold cards (only Tables open; 0-count groups dropped); Compare "Hide root-component rows" (on).
| # | Sev | Where | Gap → fix |
|---|---|---|---|
| X1 | H | `main.ts:205`, `index.html:53` | Compare can't narrow by change type or name; all categories open. → Added/Changed/Removed chips + name filter; open category only if ≤20 rows; "12 of 340". |
| X2 | H | `main.ts:183,188` | Counts/empty-state bug (§2). → Count from filtered `entries`; "N root differences hidden · Show". |
| X3 | M | `index.html:43` | No Inventory search. → "Find component" filters all groups, opens matches, "3 of 41" per badge. |
| X4 | M | `risk.ts:62,71,82,115,137,183,206,214` / `:105,128,148,158` | Risk evidence silently cut by `slice()` or unbounded. → First 8 + "+N more" inline. |
| X5 | M | `diff.ts:34-36,84` | "Changed" detail is raw fingerprint `a\|b\|c → …`. → Labelled per-field diff, changed fields only; full value in `title`. |
| X6 | M | `inventory.ts:38` | Tables show "N columns" only. → Row `<details>` with column name + type. |
| X7 | L | `main.ts:126` | System tables mixed with custom; `other:*` groups each a card. → "Hide system tables" toggle; merge `other:*` into one closed card. |
| X8 | L | `main.ts:313` | Install-order reasons capped at 5, "(+N)" not clickable. → Toggle to reveal. |

### EnvVar & ConnRef Matrix
Has: text filter, Only differences, Only missing/unbound, Solution filter (survive tab switch, lost on reload); snapshot column remove.
| # | Sev | Where | Gap → fix |
|---|---|---|---|
| E1 | H | `styles.css:30-33` | Name column scrolls away (S8). |
| E2 | H | `main.ts:259,303` | Live env columns can't be hidden (must disconnect). → "Columns ▾" menu, per-column checkbox, persisted; hidden columns excluded from `differs`. |
| E3 | H | `main.ts:348-354` | No "4 of 10" or tab totals. → Caption + tab counts. |
| E4 | M | `styles.css:47-48` | Long values (JSON, Key Vault refs) wrap fully. → Clamp 3 lines, full in `title`, per-cell expand. |
| E5 | M | `main.ts:444-478` | Toolbar filters/exports stay active but ignored in Consolidate view. → Hide/disable there. |
| E6 | M | `main.ts:539,585,645` | Consolidate cards always open (15 connector groups = long scroll). → `foldCard`; open groups with selection/unbound + Unused + Flows-off; expand/collapse all in `.cons-head`. |
| E7 | M | `matrix.ts:79` | "Only missing / unbound" also matches `absent`. → Split "Missing value" vs "Not deployed"; optional per-column. |
| E8 | M | `styles.css:51` | ✎ edit button opacity 0 on keyboard focus. → `:focus-visible { opacity:1 }`. |
| E9 | L | `styles.css:41-42`, `main.ts:287` | Only row border marks difference; badges untooltipped; "value/managed" badge on every cell. → Per-cell diff tint, badge tooltips, "Compact" (non-ok badges only, default on). |
| E10 | L | `main.ts:1099-1120,1338`, `:118`, `:604-646`, `:256` | Preview mixes skipped rows; run log unfilterable; Flows-off mixes blocked/ready + ignores solution scope; no select-all. → "Hide skipped (n)", "Only failures", "Only ready", header checkbox. |

### D365 Apps Matrix
Has: name filter, "Only updates / failed", "Show not installed" (off); env picker dialog (persisted); Unused "Show all" + per-app `<details>`.
| # | Sev | Where | Gap → fix |
|---|---|---|---|
| P1 | H | `styles.css:28-31` | App column not sticky (S8). |
| P2 | H | `main.ts:303-311` | Env columns only removable via picker + API reload; empty envs show column of "—". → "Hide empty environments" (on, persisted) + ✕ per column header, local only. |
| P3 | H | `main.ts:438-441`, `:326` | Select-all-updates bug (§2). → Same `shown` predicate; "N selected (M hidden)". |
| P4 | M | `main.ts:290-298,321` | Counts ignore filter; badges static; no "in progress" filter. → "3 of 12 apps × 8 envs", Clear; badges as `aria-pressed` toggles. |
| P5 | M | `index.html:56-64`, `styles.css:46` | Run section can't collapse/dismiss (40% height). → `<details open>`, auto-collapse on clean finish, "Only problems", Dismiss. |
| P6 | M | `main.ts:233,267-268` | Cell errors stack unbounded. → One line ellipsis + `title`/`<details>`; drop run note after reload. |
| P7 | M | `unused-ui.ts:49,83-116` | Closing Unused discards report; no filters; long notes always shown. → Hide/Show with cache + Re-run; verdict badges as filters; name filter; "How verdicts work" fold. |
| P8 | L | `main.ts:210,343-349`, `:257`, `styles.css:34` | Env dialog no ticked count/type filter; preview groups unfoldable; checkbox label uses GUID; long names nowrap. → "N of M ticked" + type select; per-env `<details>`; env name in label; ellipsis + `title`. |

## 4. Recommended order

1. **Shared pass** (one PR, every tool benefits): S1 chevron, S2 expand/collapse all, S3 fold-state memory, S4 `viewState` persistence, S5 count + Clear filters, S6 ARIA, S8 sticky columns.
2. **Bugs** from §2 (7 items, each small and independently testable in the existing e2e mocks).
3. **High per-tool items** that make the user miss content: X1, E2, P2 (A/D/O/M items: tools removed).
4. Medium/low as each tool's next minor version.

## 5. Status

Done (shared pass + §2 bugs), each covered by new e2e assertions:

- **Shared:** S1 chevron (`details.card`, `summary.chev`), S2 `foldAllButtons`, S3 `foldCard` / `keepFold` keys (only user folds are remembered), S4 `view-state.ts` (`persistControls`, `loadView` / `saveView`), S5 `shownOf` + `filteredEmpty`, S6 tab ARIA + arrow keys and `aria-live` status, S7 toolbar button grouping, S8 `.sticky-col`.
- **Bugs (§2):** all 7 fixed.
- **Wired per tool:**
  - Solution XRay: X2, fold keys, expand/collapse all, saved "Hide root-component rows".
  - EnvVar Matrix: E1, E3, E8, Clear filters, saved filters + Solution + tab.
  - D365 Apps: P1, P3, count + Clear filters, saved filters.

Done (per-tool High items, second round):

- Solution XRay: X1 change-type + name filters, big categories start closed.
- EnvVar Matrix: E2 Columns menu (hidden columns excluded from differences).
- D365 Apps: P2 hide empty environments + ✕ per column (hidden ticks flagged in Preview).

Done (Medium items, third round):

- Solution XRay: X3 Inventory search, X4 full risk evidence with +N more, X5 labelled field diffs, X6 per-table column lists.
- EnvVar Matrix: E4 value clamp with more/less, E5 matrix-only controls hidden in Consolidate, E6 foldable consolidate cards, E7 Missing vs Not deployed filters.
- D365 Apps: P4 status badges as filters, P5 foldable run section with Only problems / Dismiss, P6 one-line cell notes, P7 Unused report kept, filterable, notes folded.

Done (Low items, fourth round):

- Solution XRay: X7 Hide system tables (no publisher prefix, same rule as Risk) + one Other collections card; X8 install-order reasons expand.
- EnvVar Matrix: E9 per-cell diff tint, badge tooltips, Compact badges; E10 Hide skipped in previews, run log filters, Only ready + solution scope on Flows that are off, select-all-shown.
- D365 Apps: P8 Environments dialog ticked count + type filter, preview folds per environment, readable checkbox labels, long names cut.

All audit items are done. Fixed in passing: EnvVar endless retry on a failed solution flow read.

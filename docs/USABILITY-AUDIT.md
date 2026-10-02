# Usability audit — show / hide what matters

Scope: all 7 tools. Question: can the user hide the noise and reveal the part of the content they need?
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
| Audit Matrix | `audit/matrix.ts:102` | Text search only matches table fields, so `visibleColumns` column-name branch never runs: searching `telephone1` → "No tables match". |
| Audit Matrix | `audit/write.ts:64`, `main.ts:263`, `main.ts:527` | Selected rows hidden by a filter still get planned; "Plan: match other env" ignores filters. |
| D365 Apps | `main.ts:438-441` | "Select all updates" ignores the name filter ("Select all failed" respects it) → silently ticks hidden rows. |
| Offboarding | `offboard/fetch.ts:378`, `plan.ts:91` | `isdefault` not selected → BU default team listed; with `teamRemove` default on, plan includes a removal Dataverse always refuses. |
| Offboarding | `main.ts:280`, `index.html:125-130` | "Hide tables with no records" actually hides tables that could not be scanned (scan never returns 0-record tables). |
| Offboarding | `main.ts:606` | Scan filter after scan doesn't filter the records card and collapses every open card. |
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

### Access Checker
Has: Why list `<details>` per right (all closed).
| # | Sev | Where | Gap → fix |
|---|---|---|---|
| A1 | H | `styles.css:49` | Why rows have no expand cue (S1). |
| A2 | H | `main.ts:291` | Denied / "platform disagrees" rows start closed. → `open` when `platform==="no" \|\| agrees===false`. |
| A3 | H | `main.ts:308-322` | Roles table lists every role even with no privilege on this table. → "Hide roles with no privilege on this table" (on) + "2 of 15". |
| A4 | M | `main.ts:276` | 10-column Roles table not narrowable to the right in question. → Verdict chips as buttons: open Why row + highlight that column. |
| A5 | M | `main.ts:374-381` | Shares tab: 60 principals, affecting ones not first or counted. → Search, "Only shares affecting {user}", sort affecting first, count in title. |
| A6 | M | `main.ts:416-418` | Column security unfilterable. → Name search, "Only columns with a denied right", "n of N". |
| A7 | M | `main.ts:346-349` | Roles/Ownership/Shares/Hierarchy cards not foldable. → `foldCard` (Hierarchy closed) + expand/collapse all for Why. |
| A8 | L | `main.ts:274`, `:334`, `:344` | "granted\*", depth names unexplained; teams one long line; notes banner always full. → `title` legends; teams "+N"; notes first line + `<details>`. |

### Dependency Cleaner
Has: Diagnose "Show present in target" (off); upgrade Resolved/Survives/Deleted fold cards (closed).
| # | Sev | Where | Gap → fix |
|---|---|---|---|
| D1 | H | `main.ts:271-299,529`, `styles.css:172` | Fix/Restore diff blocks always open → Confirm bar screens away. → `<details>` "formxml diff (−N/+M)" closed + expand/collapse all. |
| D2 | H | `main.ts:333-357` | Shell "leaving" list flat (200+ checkboxes). → Per-card search, type filter, "Only leaving" (on >30), Keep/Drop all shown, "38 of 212". |
| D3 | M | `main.ts:263,582` | No in-results search/type filter in Diagnose/Offline (Filter box needs re-run). → Client-side find + type select, "12 of 80", Clear. |
| D4 | M | `main.ts:582-592` | Offline ignores present-in-target toggle. → Apply `#show-safe`. |
| D5 | M | `upgrade-ui.ts:172,221` | Dev/Release/Target sections + Runtime breaks not foldable. → `foldCard(open)`; Runtime breaks closed when >10. |
| D6 | M | `main.ts:262`, `upgrade-ui.ts:212` | Errors cut to 3. → "Show all N" `<details>`. |
| D7 | M | `main.ts:76,198` | Owning-solution lists hover-only. → Chip as `<button aria-expanded>` inline reveal. |
| D8 | L | `upgrade-ui.ts:130-143,159`, `index.html:18-19` | Layers caption always shown; report-only blockers lack label; Findings export shown disabled on all tabs. → Layers disclosure (open for membership warning); "Fix by hand in Dev" badge; hide exports off Diagnose. |

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

### Offboarding Wizard
Has: 12 inventory fold cards (records open if found, rest closed); scan filter + "hide tables with no records".
| # | Sev | Where | Gap → fix |
|---|---|---|---|
| O1 | H | `main.ts:255`, `fetch.ts:325` | Flags ("active flow breaks when owner disabled") hidden inside closed cards. → Open flagged cards by default + "n flagged" warn badge. |
| O2 | H | `main.ts:237,606-607` | Filter/re-render collapses cards; records card ignores filter (§2). → `openCats` set; "Filter tables" inside records card. |
| O3 | H | `main.ts:548-553` | Results list every op in plan order; 1 failure in 2,000 buried. → "Failed (n) / All (n)" (Failed default), failures first, summary link. |
| O4 | M | `main.ts:550`, `tokens.css:200-203` | Full error in nowrap badge → table overflows sideways. → `badge("failed")` + wrapping `<details>` error cell. |
| O5 | M | `main.ts:280` | Mislabelled checkbox (§2). → "Show N tables that could not be scanned" (off), in records card. |
| O6 | M | `main.ts:254` | Empty categories rendered as full "0" cards. → Hidden by default + one caption "Nothing held in: …". |
| O7 | M | `fetch.ts:378`, `plan.ts:91` | BU default team (§2). → Select `isdefault`, filter + "show system teams", skip in plan. |
| O8 | M | `main.ts:52,438-440` | Preview capped at 25 ops; skipped list unlabeled. → Per-category `<details>`, "Skipped (n)" closed, "Show all N". |
| O9 | L | `fetch.ts:431,447,492-494`, `main.ts:319-324` | Same long note per row; raw relationship names in headers; options shown for empty categories; no per-card search >20 items. → Note once in caption; names to `title`; hide irrelevant options; per-card filter. |

### Audit Config Matrix
Has: text search, Audit on/off/all, Only differences, Layer custom/managed, Has audited/secured columns; ▸/▾ expander (`aria-expanded`).
| # | Sev | Where | Gap → fix |
|---|---|---|---|
| M1 | H | `audit/matrix.ts:102` | Column-name search bug (§2). → Keep table if any loaded column matches; caption "column names match expanded tables only". |
| M2 | H | `audit/matrix.ts:105,108` | "Has audited columns" and column-level "Only differences" silently drop unexpanded tables. → Label "(expanded tables)" + "Load columns for N visible tables" (concurrency 3, Cancel). |
| M3 | H | `audit/fetch.ts:46,59` | Hundreds of OOB tables; "custom" = unmanaged, not publisher. → Fetch `IsCustomEntity`; Origin all/custom/Microsoft, default custom when >100 tables. |
| M4 | H | `main.ts:96,234` | Counts ignore filters. → "42 of 913 tables shown" + Clear filters (also in empty state). |
| M5 | M | `audit/write.ts:64`, `main.ts:248,263,527` | Hidden selections still planned (§2). → "12 selected (3 hidden)", select-all-visible header, "Plan: match (visible N)". |
| M6 | M | — | No "Only changeable" (locked rows stay in diff view). → Toggle, off by default. |
| M7 | M | `main.ts:403,455` | Expanded rows / loaded columns lost on Refresh and after Apply. → Keep `expanded`, reload their columns. |
| M8 | M | `main.ts:149,167,483` | Expander tiny; rebuild drops keyboard focus. → "expand to load" cell as button; restore focus by logical name. |
| M9 | M | `main.ts:324,378,409` | Plan, preview, results are flat lists (300-row dialog). → Summary first, per-table `foldCard`s closed, × per item; results failures first + "Only failures". |
| M10 | L | `main.ts:136,160,185,252` | Locked reason hidden; empty comparison/Diff columns shown with no comparison. → Badge `title` with managed property; hide columns when `!matrix.other`. |

## 4. Recommended order

1. **Shared pass** (one PR, every tool benefits): S1 chevron, S2 expand/collapse all, S3 fold-state memory, S4 `viewState` persistence, S5 count + Clear filters, S6 ARIA, S8 sticky columns.
2. **Bugs** from §2 (7 items, each small and independently testable in the existing e2e mocks).
3. **High per-tool items** that make the user miss content: X1, E2, A2/A3, D1/D2, P2, O1/O3, M2/M3.
4. Medium/low as each tool's next minor version.

## 5. Status

Done (shared pass + §2 bugs), each covered by new e2e assertions:

- **Shared:** S1 chevron (`details.card`, `summary.chev`), S2 `foldAllButtons`, S3 `foldCard` / `keepFold` keys (only user folds are remembered), S4 `view-state.ts` (`persistControls`, `loadView` / `saveView`), S5 `shownOf` + `filteredEmpty`, S6 tab ARIA + arrow keys and `aria-live` status, S7 toolbar button grouping, S8 `.sticky-col`.
- **Bugs (§2):** all 7 fixed.
- **Wired per tool:**
  - Solution XRay: X2, fold keys, expand/collapse all, saved "Hide root-component rows".
  - EnvVar Matrix: E1, E3, E8, Clear filters, saved filters + Solution + tab.
  - Access Checker: A1, A2, expand/collapse all on Why.
  - Dependency Cleaner: upgrade fold keys + expand/collapse all, saved toggles, Diagnose empty-state action.
  - D365 Apps: P1, P3, count + Clear filters, saved filters.
  - Offboarding Wizard: O1, O2, O5, O7, expand/collapse all.
  - Audit Matrix: M1, M4, M5, saved filters.

Open: every other per-tool High / Med / Low item in §3.

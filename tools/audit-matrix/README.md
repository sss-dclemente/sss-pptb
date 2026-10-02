# SSS Audit Config Matrix

Dataverse auditing is three switches at three levels — organization, table, column — and no screen shows all three at once, let alone two environments side by side. This tool does, inside [Power Platform ToolBox](https://www.powerplatformtoolbox.com): the whole audit configuration on one page, diffed against a second environment, and fixed in bulk behind a preview.

Built by [Simple Smooth Safe](https://simplesmoothsafe.com).

## What it does

- **Matrix** — rows are tables, and a row expands to its auditable columns. Each cell is that environment's audit flag: `on`, `off`, `—` (not present) or `locked` when the managing solution forbids the change. A `≠` marks anything the two environments disagree about.
- **Two environments** — the ToolBox primary connection, compared with the secondary connection or with a **snapshot** loaded from file. Snapshots let you diff against an environment you are not connected to, and double as audit evidence.
- **Counts** — tables audited, table differences, and columns audited / differing in the tables you expanded. Column flags are read per table on expand, so the column counts name their scope instead of guessing an environment-wide total.
- **Filters** — text, audit on / off, only differences, custom / managed layer, and "has audited or secured columns".
- **Auditing is an AND across three levels** — organization, table, column. A column captures nothing unless all three are on, so a green column under a table with auditing off is a false reassurance: it is marked `inert` and counted separately as "audited columns capturing nothing". If the organization switch itself is off, the matrix says so at the top — a screen full of green flags in an environment that records nothing is exactly what you opened this tool to find out — and the apply preview repeats it, because the writes will set the flags and still capture nothing.
- **Org settings** — `isauditenabled`, `isuseraccessauditenabled`, `isreadauditenabled` and the retention, for both environments, side by side. Retention is read from `auditretentionperiodv2` *and* the legacy `auditretentionperiod`, because plenty of environments carry the value only in the old column with v2 null; the card names which one it came from. A field an environment does not return is shown as `unknown`, never as a crash. Read-only in v1: org-level auditing is environment-wide — off stops all capture, on starts billing audit storage — so that decision stays in the admin centre.
- **Apply** — select tables and columns and plan "audit on" / "audit off", or build the whole plan in one click with **Plan: match other env**. Every plan goes through a preview listing each operation with its current value, planned value and reason, then a confirm, then per-row ok / fail. Successful rows leave the plan; failed ones stay in it.
- **Publish** — metadata changes only take effect once published, so after a successful batch the tool offers a publish scoped to the tables it actually wrote, behind its own confirm.
- **Export** — matrix CSV (level, table, column, both flags, differs, locked, managed), a JSON snapshot of the primary environment, and the pending plan as CSV or as a PowerShell script that performs the same Web API calls.

### About the writes

Writes ship **enabled**, for table and column flags, on the primary connection only. They follow the retrieve-modify-PUT pattern the ToolBox metadata API documents, with guardrails:

- every write re-reads the **full, fresh** definition first — the matrix projection is never sent back;
- only `IsAuditEnabled.Value` is changed, rebuilt from the flag just read, with `MSCRM.MergeLabels` on so other languages' labels survive;
- response-only annotations are stripped and `@odata.type` normalised;
- a locked flag (`CanBeChanged: false`) is never planned and is re-checked at write time;
- at most 3 tables are written in parallel, items of one table in order, with progress and a Cancel button;
- nothing is written without an explicit preview and confirm.

Org-level switches are read-only (see above). If your environment does not allow metadata writes from a tool at all, export the plan instead: the CSV and the PowerShell script describe exactly the same change.

## Screenshots

Synthetic sample data. Replace with real captures before publishing.

![Audit matrix across two environments](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/audit-matrix/docs/img/matrix.png)

![A table expanded to its columns](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/audit-matrix/docs/img/columns.png)

![Filtered to the differences](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/audit-matrix/docs/img/differences.png)

![Preview before applying](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/audit-matrix/docs/img/preview.png)

![Org settings, dark theme](https://raw.githubusercontent.com/sss-dclemente/sss-pptb/main/tools/audit-matrix/docs/img/org-dark.png)

## Install

**From the ToolBox marketplace** — search for "SSS Audit Config Matrix" once listed.

**From npm (ToolBox Debug menu)** — Settings → enable *Show Debug Menu* → Debug → *Install from npm* → `@simplesmoothsafe/pptb-audit-matrix`.

**From source**

```bash
cd tools/audit-matrix
npm install
npm run build
```

Then in ToolBox: Debug → *Load Local Tool* → select the `tools/audit-matrix` folder.

## Usage

1. Pick a primary connection in ToolBox, and a secondary one to compare two live environments. The tool needs at least the primary.
2. Tables and org settings load on open. Pick the comparison environment in **Compare with**, or **Load snapshot…** to compare against a file.
3. Expand a table to read its column flags. Columns are fetched per table, for both environments, and cached for the session.
4. Filter to the differences, select what should change, and plan it — or press **Plan: match other env** to build the whole plan from the diff.
5. On the **Apply** tab, preview, confirm, and publish when asked. A Production target is called out in the preview.
6. **Snapshot** saves the primary environment (including the columns you expanded) as JSON for later comparison.

Notes:

- Auditing only captures anything when the org-level switch is on, then the table's, then the column's. The Org settings tab is there so that precondition is visible before you turn on 200 tables.
- Intersect, private and logical tables are filtered out, as are attributes that cannot be audited.
- Metadata reads and writes are slow. Expect a few seconds per table on a large plan, and use the progress and Cancel in the status bar.
- Metadata collections are not paged; environments with extremely large metadata could be truncated.

## Privacy

All data stays between ToolBox and your Dataverse environments: the tool talks to Dataverse only through the ToolBox `dataverseAPI` bridge, requests no CSP exceptions, and sends nothing anywhere else. Snapshots and exports are written to files you choose.

## Development

```bash
npm run build       # typecheck + Vite IIFE bundle + dist checks
npm run dev-watch   # rebuild on change; reload the tool tab in ToolBox
npm run validate    # @pptb/validate manifest rules
npm run e2e         # Playwright smoke test against dist/ with a mocked ToolBox host (needs playwright + Chromium)
```

Stack: TypeScript, Vite, no framework, no runtime dependencies. Types from `@pptb/types`. Design notes and the decision table: [`docs/AUDIT-MATRIX-PLAN.md`](https://github.com/sss-dclemente/sss-pptb/blob/main/docs/AUDIT-MATRIX-PLAN.md).

## License

MIT. See [LICENSE](https://github.com/sss-dclemente/sss-pptb/blob/main/tools/audit-matrix/LICENSE).

# AUDIT-MATRIX-PLAN — SSS Audit Config Matrix

Status: implemented in `tools/audit-matrix` (v0.1.0). Build order #5 in `pptb-tool-ideas.md`; the seed for "Audit Center".

One-liner: org / table / column audit flags on one screen, cross-environment diff, bulk set with a reviewed plan.

Why it exists: auditing in Dataverse is three switches at three levels — organization, table, column — and every surface shows one of them at a time. Nobody can see the whole picture, let alone compare two environments, so audit configuration drifts silently between Dev and Prod and is only discovered when someone asks for a history that was never captured. This tool shows all three levels at once, diffs them against a second environment, and fixes the gap in bulk behind a preview.

Facts: `docs/PPTB-NOTES.md` (manifest, CSP, build, host API). Shape, tone and scaffold mirror `docs/ENVVAR-MATRIX-PLAN.md` / `tools/envvar-matrix`; shared code from `tools/_shared`.

---

## 0. Decisions

| # | Decision | Recommendation | Why |
|---|---|---|---|
| AU1 | Comparison columns | Primary connection + **one** comparison column: the secondary connection or a loaded snapshot, picked in a "Compare with" select | Audit config is a two-sided question ("what does Prod have that Dev does not"). Two columns keep the row legible when a row also expands to columns. Snapshots give N environments without more live connections, as in the EnvVar Matrix |
| AU2 | Column-level data | Lazy: `Attributes` fetched per table **on row expand**, per connection, cached for the session | An environment has 400–1 000 tables; fetching every table's attributes up front is minutes of metadata calls. Header counts for columns are therefore explicitly scoped to "expanded tables" rather than silently wrong |
| AU3 | Table / column writes | **Shipped enabled**, with: fresh full definition re-read immediately before every write, only `IsAuditEnabled.Value` touched, locked flags never planned, preview + confirm, bounded concurrency 3, per-item ok/fail, scoped publish behind a second confirm | The vendor-documented retrieve-modify-PUT pattern in `@pptb/types` is exactly what this needs, and the risk is contained: the payload is whatever Dataverse just returned, with one boolean changed. See §3 |
| AU4 | Org-level writes | **Read-only in v1**, both environments side by side | `isauditenabled` is environment-wide: off stops all capture, on starts billing audit storage. That is an admin-centre decision with a cost attached, not a matrix click. The plan export covers the scripted path |
| AU5 | Locked flags | A table or column whose `IsAuditEnabled.CanBeChanged` is `false` renders as a locked row: shown, diffed, counted, but its checkbox is disabled and no plan builder can include it | Managed solutions can forbid the change. Failing at write time would be a worse experience than never offering it |
| AU6 | Plan export | Every plan exports as CSV and as a PowerShell script performing the same retrieve-modify-PUT against the Web API | An honest read+diff is useful even where tool-driven metadata writes are not allowed; the script is the reviewed path into a pipeline |
| AU7 | Package | `@simplesmoothsafe/pptb-audit-matrix`, display "SSS Audit Config Matrix", MIT, v0.1.0 | Consistent with XRay / EnvVar Matrix / Access Checker |

Manifest: `features: { multiConnection: "optional", connectionRequirement: "required", minAPI: "1.2.0" }`. No `cspExceptions`.

---

## 1. Data

All reads take the `connectionTarget` argument (`"primary" | "secondary"`), so the same code fills both columns.

| Need | Exact call |
|---|---|
| Tables + table audit flag | `getAllEntitiesMetadata(["LogicalName","SchemaName","DisplayName","IsAuditEnabled","IsManaged","IsCustomizable","IsIntersect","IsPrivate","IsLogicalEntity","OwnershipType"], target)`, filtered to `!IsIntersect && !IsPrivate && !IsLogicalEntity` |
| Columns of one table (lazy) | `getEntityRelatedMetadata(table, "Attributes", ["LogicalName","DisplayName","IsAuditEnabled","IsValidForRead","IsSecured","AttributeType","IsManaged"], target)`, dropping `IsValidForRead === false`, attributes with no `IsAuditEnabled`, and types `Virtual`, `EntityName`, `CalendarRules`, `PartyList`, `ManagedProperty` |
| Org switches | `queryData("organizations?$select=organizationid,name,isauditenabled,isuseraccessauditenabled,isreadauditenabled,auditretentionperiodv2&$top=1", target)` with a **narrowing fallback chain** (see below) |
| Second environment | `toolboxAPI.connections.getSecondaryConnection()` through `_shared/host.getConnections()` |
| Full definition before a write | `getEntityMetadata(table, true, undefined, target)` / `getEntityRelatedMetadata(table, "Attributes(LogicalName='x')", undefined, target)` |

`IsAuditEnabled` at both levels is a **managed property**, not a boolean: `{ Value, CanBeChanged, ManagedPropertyLogicalName }` (`canmodifyauditsettings`). `fetch.toFlag()` accepts the object, a bare boolean, and a missing value, and never throws.

Org fallback chain — the widest `$select` first, then narrower ones, so an environment that does not expose a field degrades to "unknown" instead of failing the read:

```
organizationid,name,isauditenabled,isuseraccessauditenabled,isreadauditenabled,auditretentionperiodv2
organizationid,name,isauditenabled,isuseraccessauditenabled,auditretentionperiodv2
organizationid,name,isauditenabled,isuseraccessauditenabled
organizationid,name,isauditenabled
```

Whatever did not come back is listed under the card as "Not returned by this environment: …".

Snapshot file (AU1): `{ "kind": "sss-audit-matrix-snapshot", "version": 1, "environment": {name,url,environment,takenAt}, "org": {…}, "tables": [{ logicalName, schemaName, displayName, ownership, isManaged, audit: {value,canBeChanged,managedPropertyLogicalName}, columns?: [{ logicalName, displayName, attributeType, isManaged, isSecured, audit }] }] }`. `columns` is present only for tables that had been expanded when the snapshot was taken, so a snapshot is as deep as the session that produced it. A snapshot whose `version` is newer than the tool's is rejected with a message, not parsed optimistically.

---

## 2. Matrix and diff semantics

Rows are tables (the union of both environments, sorted by display name); a row expands to its auditable columns. Cells are the audit flag in each environment.

| Cell | Meaning |
|---|---|
| `on` / `off` | `IsAuditEnabled.Value` in that environment |
| `—` (absent) | The table or column does not exist in that environment, or there is no comparison column |
| `locked` badge | `CanBeChanged: false` — shown, never planned |
| `≠` | The two environments disagree |

- A table row is "differing" if its own flag differs **or** any loaded column of it differs; the "only differences" filter keeps such a row and narrows its column sub-rows to the differing ones.
- Counts in the header: `tables audited / total`, `table differences`, `columns audited in N expanded tables`, `column differences`. The column counts name their own scope because of AU2 — they are not an environment-wide total and do not pretend to be.
- Filters: text (logical / schema / display name), audit on / off, only differences, layer custom / managed, "has audited or secured columns" (loaded tables only).
- Secured columns (`IsSecured`) are surfaced next to audit because "who saw this" and "who can see this" are asked together; column security itself belongs to the Access Checker.

---

## 3. Write path and its risks

Table flag → `updateEntityDefinition(logicalName, definition, { mergeLabels: true }, target)`.
Column flag → `updateAttribute(logicalName, attributeLogicalName, definition, { mergeLabels: true }, target)`.

Both are PUT: they replace the whole definition. The rules the implementation follows, in order:

1. **Never PUT a projection.** The matrix holds a ten-property projection of each table. Writing that back would blank everything else. Each write therefore issues a fresh `getEntityMetadata` / single-attribute read first and sends *that* object back.
2. **Change one property.** Only `IsAuditEnabled` is replaced, and it is rebuilt from the freshly read flag: `{ Value: planned, CanBeChanged: <as read>, ManagedPropertyLogicalName: <as read> ?? "canmodifyauditsettings" }`.
3. **Strip response-only annotations.** `@odata.context`, `@odata.etag` and instance annotations (`@OData.Community.*`, `@Microsoft.Dynamics.CRM.*`) are removed; `@odata.type` is kept but its leading `#` is stripped, because the response form (`#Microsoft.Dynamics.CRM.StringAttributeMetadata`) is a read annotation and the request form is unprefixed. An attribute write without an `@odata.type` is refused rather than sent.
4. **Drop `Attributes` from an entity PUT** if the read ever returns it: attributes are updated through `updateAttribute`, never inside the entity body.
5. **`mergeLabels: true`** (`MSCRM.MergeLabels`) on every write, so other languages' labels are preserved — the standard hazard of a metadata PUT.
6. **Locked is locked.** `CanBeChanged: false` is checked twice: when planning, and again against the fresh read at write time.
7. **Bounded concurrency 3, per table.** Items of one table run in order; at most three tables are written in parallel. Progress is reported per item and a Cancel button stops the run after the item in flight; unstarted items come back as `cancelled`, nothing is left ambiguous.
8. **Publish is separate.** Metadata changes do not take effect until published. After a batch, the tool offers `publishCustomizations(table, target)` scoped to the tables it actually wrote successfully, behind its own confirm. Failed tables are not published.
9. **Nothing writes without preview + confirm.** The preview lists every operation with current value, planned value and why; results show per-row ok/fail; successful rows leave the plan, failed rows stay in it.

Risks accepted, and what bounds them:

| Risk | Bound |
|---|---|
| PUT replaces the whole definition | Payload is the environment's own fresh response with one boolean changed; annotations stripped; `mergeLabels` on |
| A managed table's flag looks changeable but the platform refuses | Failure surfaces as a failed row with the platform message; other rows are unaffected |
| Turning table audit on where org audit is off captures nothing | The Org settings tab shows the org switch beside the table matrix, so the precondition is visible |
| Metadata writes are slow and can be rate limited | Concurrency 3, progress, cancel, and a plan that survives a partial run |
| A user is not allowed to write metadata at all | The whole plan exports as CSV and as a PowerShell script performing the same calls (AU6) |

### UNVERIFIED

1. `isreadauditenabled` on `organizations` — name not confirmed against a live environment; handled by the fallback chain and shown as "unknown" when absent.
2. `auditretentionperiodv2` — believed to be the current retention field (days, `-1` = forever), with `auditretentionperiod` as the older one. Only v2 is requested; absence degrades to "unknown".
3. Whether `updateEntityDefinition` in `@pptb/types` 1.2.5 forwards `MSCRM.MergeLabels` for an entity PUT as it documents (the option is passed; the header is not observable from the tool).
4. Whether a scoped `publishCustomizations(table)` is sufficient for a column-level audit change, or whether a publish-all is needed in some versions. The tool publishes scoped; a publish-all is one click away in ToolBox.
5. Dataverse-side paging: `getAllEntitiesMetadata` and `Attributes` are assumed to return complete collections (no `@odata.nextLink` handling), as in the sibling tools.
6. Exact `@odata.type` round-trip for every attribute kind; only the `#`-stripping normalisation is asserted, and an attribute with no type is refused.

---

## 4. Screens

Single page, three tabs.

1. **Matrix** — the core. Header: environment chips, "Compare with" select, Refresh, Load snapshot. Toolbar: filters and exports plus "Plan: match other env". Counts bar. Table of tables; a row expands to its columns. Bottom bar when rows are selected: "Plan: audit on", "Plan: audit off", "Clear selection".
2. **Org settings** — one card per environment (primary and the comparison one): `isauditenabled`, `isuseraccessauditenabled`, `isreadauditenabled`, `auditretentionperiodv2`, each as on / off / value / **unknown**, with the list of fields the environment did not return, and the read-only statement (AU4).
3. **Apply** — the pending plan, the target environment named, and Preview & apply / Plan CSV / Plan script / Clear plan. The tab label carries the pending count.

Outside ToolBox the page renders with "Not running inside ToolBox" in the footer and an empty state in every tab; nothing throws.

---

## 5. Structure

```
tools/audit-matrix/
├── package.json, tsconfig.json, vite.config.ts, .gitignore, LICENSE, README.md, public/icon.svg
├── docs/img/*.png              screenshots, produced by the e2e run
├── scripts/check-dist.mjs      → ../../_shared/check-dist.mjs
├── scripts/e2e.mjs             → ../../_shared/e2e-loader.mjs
└── src/
    ├── index.html, styles.css (imports ../../_shared/tokens.css), main.ts
    └── audit/
        ├── types.ts      ManagedFlag, TableAudit, ColumnAudit, OrgAudit, EnvData, Matrix rows, Filters
        ├── fetch.ts      tables / columns / org reads, managed-property parsing, full-definition reads
        ├── matrix.ts     merge two environments → rows + column sub-rows, diff flags, counts, filters
        ├── write.ts      plan builders, retrieve-modify-PUT, concurrency, publish
        ├── snapshot.ts   serialize / parse + version guard
        └── export.ts     matrix CSV, plan CSV, plan PowerShell
```

E2E (`npm run e2e`): dist run in Chromium with a mocked `window.toolboxAPI` / `window.dataverseAPI`, two environments differing in table flags, a column audited only in Test, a locked table and a locked column, a table whose write fails, and org switches that differ (plus one org field the mock refuses, to exercise the fallback). Drives load → counts and diff markers → filter to differences → expand to columns → exports → snapshot as the comparison column → "match other environment" plan → preview → confirm → apply → asserted metadata write shapes → scoped publish → failed row → plan exports. A separate run with no host asserts the standalone state.

---

## 6. Not in v1 — the path to an Audit Center

| Deferred | Note |
|---|---|
| Audit **history** extract | `RetrieveRecordChangeHistory` / `RetrieveAttributeChangeHistory` per record, paged, exported. The natural v1.1 tab |
| **Restore** old values | Write back a previous value from the history, with the same preview/confirm. Needs the history tab first |
| Retention + storage | `auditretentionperiodv2` write, audit-partition / storage view, bulk delete of audit data (`BulkDeleteRequest` jobs) |
| Org-level writes | Behind an explicit "I understand this is environment-wide" gate, once AU4 is revisited |
| Solution scope filter | Restrict the matrix to one solution's tables, as the EnvVar Matrix does for its rows |
| Environment-wide column counts | Needs either a metadata bulk read or a background crawl; AU2 is the honest interim |
| Paging | `@odata.nextLink` on metadata collections, shared with the sibling tools |
| N live environments | Same ceiling as the EnvVar Matrix: two connections, snapshots beyond that |

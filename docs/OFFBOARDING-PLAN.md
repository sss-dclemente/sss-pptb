# OFFBOARDING-PLAN — SSS Offboarding Wizard

Status: implemented in `tools/offboarding-wizard/`. Build order #4 in `pptb-tool-ideas.md`; reuses the Access Checker's security data model (users, roles, teams, BUs) and the EnvVar Matrix's plan → preview → confirm → apply → per-row result pattern.

One-liner: "user leaves → reassign records, flows, personal views, connections, queues in one run." Pick the leaver, get a complete and honest inventory of what they hold, pick a successor, review a preview of the exact operations, apply them with progress, export a report an auditor can read.

Facts: `docs/PPTB-NOTES.md`. `@pptb/types` 1.2.5 gives `queryData`, `update`, `associate`, `disassociate`, `getAllEntitiesMetadata` — which is the whole surface this tool needs. It uses **no** `execute` call at all.

---

## 0. Decisions (my recommendations)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| O1 | Writes in v1 | **Yes, but only the reassignments**: records, flows/processes, personal views, personal charts, owned queues, connection references, team membership, security roles, field security profiles, manager of direct reports. Never disable the leaver, never touch licences | The pain is that disabling a user silently breaks things. The reassignments are the part that is safe to automate and tedious to do by hand; disabling is one click a human should own, and licences live outside Dataverse |
| O2 | Ownership mechanism | **`update(entity, id, { "ownerid@odata.bind": "/systemusers(id)" })`**, not the SDK `Assign` message via `execute` | `update` and `@odata.bind` are documented in `@pptb/types`; `Assign` as an OData action bound to an arbitrary table is not, and a wrong action name fails per record at apply time. Setting `ownerid` is the Web API way to reassign. Safer of the two |
| O3 | Bulk mechanism | **One `update` per record with bounded concurrency (4)**, not `updateMultiple` | `updateMultiple` returns `void`: a partial failure gives no per-record result, and the whole point of the report is per-record ok/fail. README points at the ToolBox "Ownership Mover" for very large volumes |
| O4 | Roles / profiles / teams | **`associate` / `disassociate`** on `systemuserroles_association`, `systemuserprofiles_association`, `teammembership_association`, not `AddMembersTeam` / `RemoveMembersTeam` | `@pptb/types` documents `associate`/`disassociate` with exactly these relationship names as its examples. The `*MembersTeam` actions take a collection of `EntityReference`, whose serialization over the bridge is unverified |
| O5 | Record inventory | **Metadata-driven scan**: user/team-owned, non-intersect, non-private, non-logical tables → one count request per table, concurrency 6, progress bar, cancel button, per-table failures listed as "not scanned". A text filter narrows the scan; a toggle hides empty tables | Dataverse has no cross-table "what does this user own". Hundreds of requests is the honest cost and the UI says so before it starts. A per-table failure must never break the run |
| O6 | Roles: copy or remove? | **Both offered, opt-in, independent**; default copy-to-successor on, remove-from-leaver off | Copying keeps the successor working; removing is the security-hygiene half and belongs to whoever runs the offboarding, not to a default |
| O7 | Team target | Records (and only records) may be reassigned to a **team** instead of the successor. Flows, views, charts, queues and connection references always go to the successor user | Only records are commonly team-owned. Offering a team target everywhere would produce operations the platform rejects |
| O8 | Package | `@simplesmoothsafe/pptb-offboarding-wizard`, display "SSS Offboarding Wizard", MIT, `0.1.0`. Manifest `multiConnection: none`, `connectionRequirement: required`, `minAPI: 1.2.0` | Consistent with the siblings |

---

## 1. Data (all via `dataverseAPI`, primary connection)

| Need | Call | Verified? |
|---|---|---|
| Leaver / successor search | `queryData("systemusers?$select=systemuserid,fullname,domainname,internalemailaddress,_businessunitid_value,_parentsystemuserid_value,isdisabled,accessmode&$filter=(contains(fullname,'x') or contains(domainname,'x') or contains(internalemailaddress,'x')) and applicationid eq null&$orderby=fullname&$top=20")` | yes; `accessmode` confirmed, labels corrected (§5) |
| Business unit name | `queryData("businessunits?$select=businessunitid,name&$filter=businessunitid eq <id>")` | yes (Access Checker) |
| Manager | same `systemusers` read on `_parentsystemuserid_value` | yes |
| Owned tables | `getAllEntitiesMetadata(["LogicalName","SchemaName","DisplayName","EntitySetName","PrimaryNameAttribute","PrimaryIdAttribute","OwnershipType","IsIntersect","IsPrivate","IsLogicalEntity"])`, kept where `OwnershipType` is `UserOwned`/`TeamOwned` | yes (Access Checker) |
| Records owned, per table | `queryData("<entityset>?$filter=_ownerid_value eq <id>&$count=true&$top=0")` → `@odata.count`; on a missing annotation, `"<entityset>?$select=<primaryid>&$filter=_ownerid_value eq <id>&$top=<cap+1>"` and count the page | annotation confirmed, saturates at 5 000 (§5); the bridge is the open part, hence the fallback |
| Record ids to reassign | `queryData("<entityset>?$select=<primaryid>,<primaryname>&$filter=_ownerid_value eq <id>&$top=<cap>")` | same set/filter as above |
| Flows & classic processes | `queryData("workflows?$select=workflowid,name,category,statecode,type&$filter=_ownerid_value eq <id>&$orderby=name")`, `type eq 2` rows (activation copies) dropped, `category` labelled 0 workflow / 1 dialog / 2 business rule / 3 action / 4 BPF / 5 modern flow, `category 5 + statecode 1` flagged high-risk | confirmed; `type eq 1` filter corrected (§5) |
| Personal views | `queryData("userqueries?$select=userqueryid,name,returnedtypecode&$filter=_ownerid_value eq <id>")` | confirmed (§5) |
| Personal charts | `queryData("userqueryvisualizations?$select=userqueryvisualizationid,name,primaryentitytypecode&$filter=_ownerid_value eq <id>")` | confirmed (§5) |
| Queues owned | `queryData("queues?$select=queueid,name,queuetypecode&$filter=_ownerid_value eq <id>")` | confirmed (§5) |
| Queue memberships | `queryData("systemusers?$select=systemuserid&$filter=systemuserid eq <id>&$expand=queuemembership_association($select=queueid,name)")` | confirmed (§5) |
| Team memberships | `queryData("systemusers?…&$expand=teammembership_association($select=teamid,name,teamtype,_businessunitid_value)")` | yes (Access Checker + `@pptb/types` example) |
| Security roles | `queryData("systemusers?…&$expand=systemuserroles_association($select=roleid,name,_businessunitid_value)")` | yes |
| Field security profiles | `queryData("systemusers?…&$expand=systemuserprofiles_association($select=fieldsecurityprofileid,name)")` | yes for the read |
| Connection references | `queryData("connectionreferences?$select=connectionreferenceid,connectionreferencedisplayname,connectionreferencelogicalname,connectorid&$filter=_ownerid_value eq <id>")` | confirmed (§5) |
| Connections | `queryData("connections?$select=connectionid,name,statuscode&$filter=_ownerid_value eq <id>&$orderby=name&$top=5000")` | confirmed (§5) |
| Direct reports | `queryData("systemusers?$select=systemuserid,fullname,domainname,isdisabled&$filter=_parentsystemuserid_value eq <id>")` | yes |

Every category is read independently and its failure is captured: the card shows `Could not read this category: <message>` and the run continues. A table that rejects the owner filter is listed under "not scanned" with the platform's message.

## 1b. Writes

| Category | Call | Verified? |
|---|---|---|
| Records | `update("<logicalname>", id, { "ownerid@odata.bind": "/systemusers(<successor>)" })` — or `"/teams(<team>)"` when a team target is chosen | confirmed as the documented path, not a workaround (§5); only the bridge wrapper is untested |
| Flows, personal views, personal charts, queues, connection references, connections | same `update` on `workflow` / `userquery` / `userqueryvisualization` / `queue` / `connectionreference` / `connection`. `workflow.ownerid` targets `systemuser` only, so assets never take a team bind | same |
| Security roles | `associate("systemuser", <successor>, "systemuserroles_association", "role", <roleid>)` / `disassociate("systemuser", <leaver>, "systemuserroles_association", <roleid>)` | **yes** — the literal example in `@pptb/types` |
| Field security profiles | same shape with `systemuserprofiles_association` / `fieldsecurityprofile` | confirmed: `systemuserprofiles` is the intersect, so the associate is valid (§5) |
| Team membership | `associate("team", <teamid>, "teammembership_association", "systemuser", <successor>)` / `disassociate("team", <teamid>, "teammembership_association", <leaver>)` | **yes** — the literal example in `@pptb/types` |
| Direct reports | `update("systemuser", <reportid>, { "parentsystemuserid@odata.bind": "/systemusers(<successor>)" })` | confirmed; `SetParentSystemUserRequest` is the deprecated path (§5) |
| Queue memberships | *none in v1* — inventory only, reported as a manual step | — |
| Leaver's own user row | *never written* — no disable, no access-mode change, no licence | by design (O1) |

Owner teams are kept in the plan but flagged: records owned by the team do not move with the person. Entra security/office group teams (`teamtype` 2 and 3) are **skipped** with a reason, because that membership comes from Entra ID.

---

## 2. Engine

`src/offboard/plan.ts` is pure: `(inventory, recordIdsPerTable, options) → Plan`. A `Plan` is a list of `PlannedOp`, each carrying a human label, a detail line and the exact `Call` it will make:

```ts
type Call =
  | { op: "update"; entity: string; id: string; record: Record<string, unknown> }
  | { op: "associate"; entity: string; id: string; relationship: string; relatedEntity: string; relatedId: string }
  | { op: "disassociate"; entity: string; id: string; relationship: string; relatedId: string };
```

The preview dialog renders `CALL_TEXT(call)` verbatim, so what is confirmed is what runs. The plan also carries `warnings` (truncated tables, tables that could not be counted, a cancelled scan, the connection-reference caveat) and `skipped` (Entra teams, queue memberships, categories where neither copy nor remove was chosen).

`src/offboard/apply.ts` executes the confirmed ops through the same bounded pool the scan uses (default 4 concurrent writes), one `OpResult` per op, no retries. A failure is recorded and the run continues. Hard cap 5 000 operations; above 1 000 the preview shows a danger banner and points at the ToolBox "Ownership Mover".

---

## 3. Screens

1. **Leaver** — user typeahead over `systemusers` (name / domain / email `contains`, `$top=20`, disabled badge). On pick: business unit, manager, state, access mode, direct-report count, and the note that the tool never disables the user.
2. **Inventory** — one foldable card per category: include checkbox, label, count, detail table on expand, per-item flags (active modern flow, owner team, Entra team, connection-reference caveat). The records card holds the scan: filter, request-count confirmation, progress with cancel, per-table counts with their own checkboxes, and the "not scanned" list.
3. **Plan & apply** — successor typeahead, record target (successor user or a team), per-category options (copy/remove roles, copy/remove profiles, remove/add team membership, records-per-table cap), live operation count, `Preview plan` → dialog with counts, warnings, skips and the first 25 calls → `Apply N` (danger styling) → progress → results.
4. **Report** — inventory JSON/CSV, apply-results JSON/CSV, the per-operation result table and the list of remaining manual steps.

Theme comes from `initTheme` (`utils.getCurrentTheme` + `settings:updated`); both themes are exercised by the e2e. With no host injected the tool renders its empty states and says it is not running inside ToolBox.

---

## 4. Structure

```
tools/offboarding-wizard/
├── package.json, tsconfig.json, vite.config.ts, .gitignore, LICENSE, README.md
├── public/icon.svg                person + exit arrow, same stroke language as the Access Checker shield
├── docs/img/*.png                 screenshots generated by the e2e (E2E_SHOTS=1)
├── scripts/check-dist.mjs         imports ../../_shared/check-dist.mjs
├── scripts/e2e.mjs                mocked host, whole flow, asserts the recorded writes
└── src/
    ├── index.html, styles.css (imports ../../_shared/tokens.css), main.ts
    └── offboard/
        ├── types.ts    domain types, code→label maps, Call
        ├── fetch.ts    every read + the bounded-concurrency pool + the record scan
        ├── plan.ts     inventory + choices → operations (pure)
        ├── apply.ts    runs a confirmed plan, one result per op
        └── export.ts   inventory / results JSON + CSV
```

E2E fixture: leaver Ana Silva (Sales BU, manager Zoe) with 3 accounts, 2 contacts, a table that rejects the owner filter, 1 active modern flow + 1 classic workflow, 1 personal view, 1 personal chart, 1 owned queue, 1 queue membership, 1 owner team, 1 Entra team, 2 roles, 1 field security profile, 1 connection reference, 1 direct report; successor Bruno Costa; one account whose update always fails. Asserts the flags, the scan summary including the failed table, that nothing is written before confirm and after cancel, every recorded write (entity, id, relationship, bind payload), that the Entra team and the leaver's own user row are never touched, the failed row, both exports and the dark theme.

---

## 5. Verified, and what is still open

Verified after v0.1.0 against the Microsoft Learn table reference and a live environment's metadata (`describe` / `read_query`). What changed in the code as a result is in §7.

| Claim | Verdict |
|---|---|
| Entity sets `workflows`, `userqueries`, `userqueryvisualizations`, `queues`, `connectionreferences`, `connections`, `roles` | **Confirmed**, each against its table reference's `EntitySetName` and the live collection name |
| All of those tables are `UserOwned` and expose `_ownerid_value` | **Confirmed**. `connectionreference` in particular is a standard owned table, not organization-owned |
| `queuemembership_association`, `systemuserprofiles_association`, `systemuserroles_association`, `teammembership_association` | **Confirmed** as N:N schema and navigation property names; `systemuserprofiles` is the intersect, so the associate write is valid |
| `systemuser.accessmode` | **Confirmed**, and the labels were wrong: 3 is Support User, 4 Non-interactive, 5 Delegated Admin |
| `ownerid@odata.bind` on an update instead of `Assign` | **Confirmed as the correct path, not a workaround.** Each of the five tables documents its `Assign` message as "PATCH … [Update] the `ownerid` property", and `AssignRequest` is deprecated in favour of `UpdateRequest` |
| `parentsystemuserid@odata.bind` on `systemuser` | **Confirmed**. `SetParentSystemUserRequest` is likewise a deprecated specialized update |
| `@odata.count` for `$count=true` | **Confirmed** as a top-level sibling of `value` — but it saturates at 5 000 without saying so, and the `Prefer` header that would reveal the overflow cannot be sent through `queryData` |
| `workflow.type` | **Corrected**: 1 Definition, 2 Activation, 3 Template. The old client-side `type !== 2` kept Templates, and on a real environment the activation copies outnumber the definitions, so the filter moved into OData as `type eq 1` |
| `ReassignObjectsSystemUser` | **Considered and rejected.** It reassigns everything a user owns in one bound call, but returns no per-record result and cannot be previewed — which is this tool's entire value |

Still open, each degrading instead of throwing:

1. Whether the ToolBox bridge forwards the `@odata.count` annotation (`queryData` is typed `Promise<{ value }>`). Mitigated by the capped id-page fallback.
2. Whether `getAllEntitiesMetadata` yields `OwnershipType` as the Web API's string or the client metadata API's flags integer. Both are accepted; getting it wrong would have scanned zero tables in silence.
3. Whether `ownerid@odata.bind` and `parentsystemuserid@odata.bind` survive the host's `update` wrapper unchanged (the Web API contract is confirmed; the bridge is not).
4. Whether the bridge surfaces the Dataverse error body on a failed write: the result row shows whatever `Error.message` carries.
5. Paging. No collection read follows `@odata.nextLink`; every one asks for at most 5 000 rows, which is the per-request ceiling, and `$skip` is not supported by Dataverse.

## 6. Environment behaviour the tool now has to state

Found during verification. None of it is a bug in the tool, all of it changes what an offboarding actually achieves, so each is surfaced in the UI rather than left for the operator to discover:

| Finding | Where it shows |
|---|---|
| `Organization.ShareToPreviousOwnerOnAssign`: when on, every reassigned record is shared back to the previous owner **with full rights**, so the leaver keeps access to everything the plan moved | Read from `organizations`; a plan warning, raised only when the setting is really on |
| Assigning a record deactivates any workflow or business rule currently active on it; the new owner must reactivate them | Standing warning on any plan that moves records |
| Cloud flows: only **solution-aware** flows can change owner this way, the previous owner remains a **co-owner**, and the change can take up to 7 days to affect licensing and run limits | Flag on each modern flow, plus a plan warning |
| A connection reference cannot be transferred from the Power Apps portal at all — the API path this tool uses is the only supported one. The connection behind it does not move, and if the leaver's account is disabled the connection becomes invalid **for everyone sharing it** | Flag on each connection reference |
| The connections themselves are owned records too | New **Connections** category, so the thing the tool used to only warn about is now listed and reassignable |
| `owner_workflows` cascades `Delete: Restrict` | Noted for the deferred "delete the leaver" step: it will fail while they own any process row |
| `TeamOwned` is documented "for internal use only" | The scan still accepts it; `TableInfo.ownership` is effectively always `user` |

## 7. Deferred to v1.1

- Disable the leaver and report the licence state (needs an explicit second confirmation and, for licences, the Power Platform admin API).
- Queue membership writes. The relationship name is confirmed; what is missing is the decision on whether removing a leaver from a queue should also reassign the queue items they hold.
- Share (POA) cleanup: revoke the leaver's shares / re-share to the successor — pairs with the Access Checker's Shares tab.
- Solution-aware reassignment: group flows and connection references by solution.
- "Who else is affected": flows whose connection references the leaver owns, and views other people use.
- Re-run / resume: keep the plan between sessions and retry only the failed rows.
- Cross-environment offboarding: the same leaver in several environments in one pass.

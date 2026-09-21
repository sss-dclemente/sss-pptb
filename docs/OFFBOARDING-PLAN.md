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
| Leaver / successor search | `queryData("systemusers?$select=systemuserid,fullname,domainname,internalemailaddress,_businessunitid_value,_parentsystemuserid_value,isdisabled,accessmode&$filter=(contains(fullname,'x') or contains(domainname,'x') or contains(internalemailaddress,'x')) and applicationid eq null&$orderby=fullname&$top=20")` | set + filter shipped in Access Checker; **`accessmode` UNVERIFIED** (renders `—` when absent) |
| Business unit name | `queryData("businessunits?$select=businessunitid,name&$filter=businessunitid eq <id>")` | yes (Access Checker) |
| Manager | same `systemusers` read on `_parentsystemuserid_value` | yes |
| Owned tables | `getAllEntitiesMetadata(["LogicalName","SchemaName","DisplayName","EntitySetName","PrimaryNameAttribute","PrimaryIdAttribute","OwnershipType","IsIntersect","IsPrivate","IsLogicalEntity"])`, kept where `OwnershipType` is `UserOwned`/`TeamOwned` | yes (Access Checker) |
| Records owned, per table | `queryData("<entityset>?$filter=_ownerid_value eq <id>&$count=true&$top=0")` → `@odata.count`; on a missing annotation, `"<entityset>?$select=<primaryid>&$filter=_ownerid_value eq <id>&$top=<cap+1>"` and count the page | **`@odata.count` UNVERIFIED** over the host bridge (`queryData` is typed `{ value }` only) — hence the fallback |
| Record ids to reassign | `queryData("<entityset>?$select=<primaryid>,<primaryname>&$filter=_ownerid_value eq <id>&$top=<cap>")` | same set/filter as above |
| Flows & classic processes | `queryData("workflows?$select=workflowid,name,category,statecode,type&$filter=_ownerid_value eq <id>&$orderby=name")`, `type eq 2` rows (activation copies) dropped, `category` labelled 0 workflow / 1 dialog / 2 business rule / 3 action / 4 BPF / 5 modern flow, `category 5 + statecode 1` flagged high-risk | **UNVERIFIED** (no source in `docs/PPTB-NOTES.md`) |
| Personal views | `queryData("userqueries?$select=userqueryid,name,returnedtypecode&$filter=_ownerid_value eq <id>")` | **UNVERIFIED** |
| Personal charts | `queryData("userqueryvisualizations?$select=userqueryvisualizationid,name,primaryentitytypecode&$filter=_ownerid_value eq <id>")` | **UNVERIFIED** |
| Queues owned | `queryData("queues?$select=queueid,name,queuetypecode&$filter=_ownerid_value eq <id>")` | **UNVERIFIED** |
| Queue memberships | `queryData("systemusers?$select=systemuserid&$filter=systemuserid eq <id>&$expand=queuemembership_association($select=queueid,name)")` | **UNVERIFIED** |
| Team memberships | `queryData("systemusers?…&$expand=teammembership_association($select=teamid,name,teamtype,_businessunitid_value)")` | yes (Access Checker + `@pptb/types` example) |
| Security roles | `queryData("systemusers?…&$expand=systemuserroles_association($select=roleid,name,_businessunitid_value)")` | yes |
| Field security profiles | `queryData("systemusers?…&$expand=systemuserprofiles_association($select=fieldsecurityprofileid,name)")` | yes for the read |
| Connection references | `queryData("connectionreferences?$select=connectionreferenceid,connectionreferencedisplayname,connectionreferencelogicalname,connectorid&$filter=_ownerid_value eq <id>")` | **UNVERIFIED** |
| Direct reports | `queryData("systemusers?$select=systemuserid,fullname,domainname,isdisabled&$filter=_parentsystemuserid_value eq <id>")` | yes |

Every category is read independently and its failure is captured: the card shows `Could not read this category: <message>` and the run continues. A table that rejects the owner filter is listed under "not scanned" with the platform's message.

## 1b. Writes

| Category | Call | Verified? |
|---|---|---|
| Records | `update("<logicalname>", id, { "ownerid@odata.bind": "/systemusers(<successor>)" })` — or `"/teams(<team>)"` when a team target is chosen | `update` yes; **`ownerid@odata.bind` payload UNVERIFIED** through the bridge (standard Web API) |
| Flows, personal views, personal charts, queues, connection references | same `update` on `workflow` / `userquery` / `userqueryvisualization` / `queue` / `connectionreference` | same |
| Security roles | `associate("systemuser", <successor>, "systemuserroles_association", "role", <roleid>)` / `disassociate("systemuser", <leaver>, "systemuserroles_association", <roleid>)` | **yes** — the literal example in `@pptb/types` |
| Field security profiles | same shape with `systemuserprofiles_association` / `fieldsecurityprofile` | relationship name verified for the read; **the associate use is UNVERIFIED** |
| Team membership | `associate("team", <teamid>, "teammembership_association", "systemuser", <successor>)` / `disassociate("team", <teamid>, "teammembership_association", <leaver>)` | **yes** — the literal example in `@pptb/types` |
| Direct reports | `update("systemuser", <reportid>, { "parentsystemuserid@odata.bind": "/systemusers(<successor>)" })` | `update` yes; **bind payload UNVERIFIED** |
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

## 5. UNVERIFIED

1. `@odata.count` surviving the host bridge — `queryData` is typed `Promise<{ value }>`. Mitigated by the capped id-page fallback.
2. Entity sets `workflows`, `userqueries`, `userqueryvisualizations`, `queues`, `connectionreferences` and the relationship `queuemembership_association`: standard Dataverse names, but nothing in `@pptb/types` or `docs/PPTB-NOTES.md` proves them. Each is its own category, so a wrong name costs one error row.
3. `systemuser.accessmode` — shown as `—` when absent.
4. `ownerid@odata.bind` / `parentsystemuserid@odata.bind` accepted by the host's `update`.
5. `systemuserprofiles_association` as an associable N:N (the read is proven, the write is not).
6. `Assign`, `AddMembersTeam`, `RemoveMembersTeam` via `execute` — deliberately **not used**; see O2 and O4.
7. Whether the ToolBox bridge surfaces the Dataverse error body on a failed `update`: the result row shows whatever `Error.message` carries.

## 6. Deferred to v1.1

- Disable the leaver and report the licence state (needs an explicit second confirmation and, for licences, the Power Platform admin API).
- Queue membership writes, once `queuemembership_association` is verified.
- Share (POA) cleanup: revoke the leaver's shares / re-share to the successor — pairs with the Access Checker's Shares tab.
- Solution-aware reassignment: group flows and connection references by solution.
- "Who else is affected": flows whose connection references the leaver owns, and views other people use.
- Re-run / resume: keep the plan between sessions and retry only the failed rows.
- Cross-environment offboarding: the same leaver in several environments in one pass.

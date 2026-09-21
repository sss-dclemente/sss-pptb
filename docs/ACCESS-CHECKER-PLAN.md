# ACCESS-CHECKER-PLAN — SSS Access Checker

Status: APPROVED (A1–A6 confirmed by owner), implemented in `tools/access-checker/`. Build order #3 in `pptb-tool-ideas.md`; absorbs "Share Explorer (POA)" and "Column Security Matrix" as tabs.

One-liner: "why can / can't user X do Y on record Z". Pick a user, a table and optionally a record; get the verdict per access right and the chain that produced it: roles (direct and via teams) with privilege depth, business-unit position, ownership, shares, hierarchy, column security.

Facts: `docs/PPTB-NOTES.md`. `@pptb/types` 1.2.5 `execute` supports bound functions on `systemuser` / any record with `EntityReference` parameters (`{ entityLogicalName, id }`), which is all this tool needs.

---

## 0. Decisions (need your OK)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| A1 | Writes | **v1 read-only.** No revoke, no role assignment | Access changes are exactly what an auditor wants to see done deliberately, not from a matrix. Revoke share → v1.1 with the same preview/confirm pattern |
| A2 | Verdict source | Platform truth first: `RetrievePrincipalAccess` (record) and `RetrieveUserPrivileges` (table level, effective depth per privilege). The explanation is computed by the tool and shown as "how we got here", never overriding the platform verdict | Dataverse security has edge cases (hierarchy, access teams, inherited privileges). Never claim more than the platform returns |
| A3 | Scope of explanation | Roles direct + owner teams + AAD group teams (whatever `teammembership_association` returns); privilege depth per entity per role; BU chain; ownership (user / team the user belongs to); explicit shares (POA) incl. shares to teams the user is in; manager/position hierarchy flagged as "possible" when user is above owner and the org has hierarchy security on | Covers 95% of real "why" questions. Access teams appear through team membership |
| A4 | Inputs | User: search box over `systemusers` (fullname / domainname / internalemailaddress `contains`). Table: dropdown from `getAllEntitiesMetadata` (user-facing tables only). Record: GUID paste or search by primary name attribute. Record optional → table-level check only | Same three inputs every time; a GUID paste beats a lookup dialog |
| A5 | Tabs | 1 **Check** (verdict + why) · 2 **Shares** (POA on the chosen record: who, what rights, via user or team) · 3 **Column security** (secured columns of the table × user effective read / update / create, via user and team profiles) | Three questions people actually ask about one record |
| A6 | Package | `@simplesmoothsafe/pptb-access-checker`, display "SSS Access Checker", MIT. Manifest `multiConnection: none`, `connectionRequirement: required`, `minAPI: 1.2.0` | Consistent |

Also in this PR: **shared scaffold** `tools/_shared/` (host adapter, DOM helpers, tokens CSS, dist check, e2e loader) imported by relative path and bundled by Vite. No workspace package: PPTB intake runs `npm install --production` inside the packed tarball, and a workspace dependency would not resolve there. XRay and Matrix migrated to the shared code in a separate commit, each re-verified by its e2e.

---

## 1. Data (all via `dataverseAPI`, primary connection)

| Need | Call |
|---|---|
| User search | `queryData("systemusers?$select=systemuserid,fullname,domainname,internalemailaddress,_businessunitid_value,_parentsystemuserid_value,isdisabled&$filter=contains(fullname,'x') or contains(domainname,'x')&$top=20")` |
| User roles | `queryData("systemusers(id)?$select=systemuserid&$expand=systemuserroles_association($select=roleid,name,_businessunitid_value)")` |
| User teams + team roles | `queryData("systemusers(id)?$expand=teammembership_association($select=teamid,name,teamtype,_businessunitid_value)")` then per team `teams(id)?$expand=teamroles_association($select=roleid,name)` |
| Role privileges | `execute({ entityName:"role", entityId, operationName:"RetrieveRolePrivilegesRole", operationType:"function" })` → `RolePrivileges[{PrivilegeId, Depth, BusinessUnitId}]` |
| Privilege names | `queryData("privileges?$select=privilegeid,name,accessright")` once, cached (≈1 500 rows); name pattern `prv{Create|Read|Write|Delete|Append|AppendTo|Assign|Share}{EntitySchemaName}` |
| Tables | `getAllEntitiesMetadata(["LogicalName","SchemaName","DisplayName","EntitySetName","PrimaryNameAttribute","PrimaryIdAttribute","OwnershipType","IsCustomizable","IsIntersect","IsPrivate"])` filtered to user/team/org-owned, non-intersect, non-private |
| Record | `queryData("<entityset>(id)?$select=<primaryid>,<primaryname>,_ownerid_value,_owningbusinessunit_value,_owningteam_value,_owninguser_value")` (org-owned tables: no owner fields) |
| Record search | `queryData("<entityset>?$select=<primaryid>,<primaryname>&$filter=contains(<primaryname>,'x')&$top=20")` |
| Verdict on record | `execute({ entityName:"systemuser", entityId:userId, operationName:"RetrievePrincipalAccess", operationType:"function", parameters:{ Target:{ entityLogicalName, id } } })` → `AccessRights` string `"ReadAccess, WriteAccess, …"` |
| Shares | `execute({ entityName:<table>, entityId:recordId, operationName:"RetrieveSharedPrincipalsAndAccess", operationType:"function" })` → `PrincipalAccesses[{ Principal{@odata.type, systemuserid|teamid}, AccessMask }]` |
| BU chain | `queryData("businessunits?$select=businessunitid,name,_parentbusinessunitid_value")` cached |
| Hierarchy on? | `queryData("organizations?$select=ishierarchicalsecuritymodelenabled")` (attribute name **UNVERIFIED**; if missing, hierarchy hint is skipped) |
| Column security | secured columns: `getEntityRelatedMetadata(table,"Attributes",["LogicalName","DisplayName","IsSecured"])`; profiles: `systemusers(id)?$expand=systemuserprofiles_association($select=fieldsecurityprofileid,name)` and per team `teams(id)?$expand=teamprofiles_association(...)`; permissions: `fieldpermissions?$select=attributelogicalname,canread,canupdate,cancreate,_fieldsecurityprofileid_value&$filter=entityname eq '<table>' and (_fieldsecurityprofileid_value eq … or …)` |

Depth codes from `RetrieveRolePrivilegesRole`: 0 Basic (user), 1 Local (BU), 2 Deep (parent-child BU), 3 Global (org). Access rights from `RetrievePrincipalAccess`: None, ReadAccess, WriteAccess, AppendAccess, AppendToAccess, CreateAccess, DeleteAccess, ShareAccess, AssignAccess.

---

## 2. Explanation engine (`src/access/explain.ts`)

Pure function: `(user, roles[], teams[], rolePrivileges{}, privilegeIndex, table, record?, shares?, buChain, hierarchyOn) → Explanation`.

For each right (Create, Read, Write, Delete, Append, AppendTo, Assign, Share):

1. **Privilege paths** — for every role the user holds (direct or via team), the depth of `prv{Right}{Table}`. Highest depth wins. Source label: `role R (direct)` / `role R via team T`.
2. **Reach** — given record owner BU vs user BU vs BU chain: Basic reaches if user owns (or owning team contains user); Local reaches if same BU; Deep reaches if record BU is user's BU or a descendant; Global always. Result: `granted by privilege` with the winning path, or `privilege depth D does not reach record in BU X`.
3. **Shares** — if any POA entry for the user or one of the user's teams carries the right, `granted by share from …` (shares beat depth).
4. **Hierarchy** — if hierarchy security is on and user is a manager (parent chain of the owner contains the user), flag `possible via manager hierarchy (read on all, write on direct reports)`; not asserted.
5. **Platform verdict** — the `RetrievePrincipalAccess` bit for the right. Shown as the truth; the engine's own conclusion is shown beside it with `agrees` / `platform says otherwise — see notes` (e.g. access teams, inherited privileges, disabled user).

Table-level (no record): steps 1 and 5 only, with 5 replaced by the effective privilege depth summary.

---

## 3. Screens

Header: connection chip, **User** search (typeahead, shows name · domain · BU · disabled badge), **Table** select, **Record** search/GUID, `Check` button. State persists for the session.

- **Check**: verdict row (8 chips: green granted / red denied / grey n/a for org-owned) → "Why" list per right, expandable → sections *Roles* (table: role, how held, depth for this table for each right), *Ownership & BU* (owner, owning BU, user BU, relation), *Shares affecting this user*, *Hierarchy* note. Export JSON.
- **Shares**: table of POA entries on the record: principal (user/team, name), rights chips, `affects checked user` badge when principal is the user or one of their teams. Export CSV. Read-only (A1).
- **Column security**: rows = secured columns of the table; columns = Read / Update / Create effective for the user, with the profile that grants each (user or team profile). Empty state when the table has no secured columns.

---

## 4. Structure

```
tools/_shared/
├── host.ts        connections, theme, notify, saveText/openText (from envvar-matrix host.ts)
├── dom.ts         $, h, badge, emptyState, table, card, foldCard, showDialog (from the two tools)
├── tokens.css     SSS two-layer tokens + base elements (from styles.css, without tool-specific rules)
├── check-dist.mjs
└── e2e-loader.mjs loadPlaywright + browser launch helper
tools/access-checker/
├── package.json, tsconfig.json (include ../_shared), vite.config.ts, LICENSE, README.md, public/icon.svg
├── scripts/check-dist.mjs (imports ../../_shared), scripts/e2e.mjs
└── src/
    ├── index.html, styles.css (imports ../_shared/tokens.css + tool rules), main.ts
    └── access/
        ├── types.ts
        ├── fetch.ts      all queries above, with a small cache (privileges, BUs, tables)
        ├── privileges.ts privilege name parsing, depth labels, rights mask parsing
        ├── explain.ts    engine (pure, unit-testable)
        ├── columns.ts    column security effective matrix
        └── export.ts     JSON / CSV
```

E2E: mocked host with one environment: 2 BUs (Root, Sales), user Ana (Sales BU, role "Sales Person" direct with Read Deep / Write Basic on account, team "Sales EU" with role "Sharer" granting Share Local), account owned by Bruno (Sales BU), account owned by Carla (Root BU), a share of Write to team "Sales EU" on Carla's account, one secured column on account, one profile via team. Asserts: verdict chips, why-paths, share affecting user, column security rows, table-level mode, exports, dark theme.

---

## 5. Steps

1. `tools/_shared` extracted; XRay + Matrix import it; both e2e green (one commit per tool).
2. Access Checker scaffold + fetch + privileges.
3. explain engine + e2e cases.
4. UI (Check / Shares / Column security).
5. README, validate (branch URL → main URL after merge), PR.

Not in v1: revoke/grant share, role assignment, access-team template inspection, cross-environment compare, N users at once (bulk "who can read X" → v1.1 as "Access Matrix").

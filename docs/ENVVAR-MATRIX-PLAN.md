# ENVVAR-MATRIX-PLAN — SSS EnvVar & ConnRef Matrix

Status: APPROVED 2026-09-20 (E1–E5 OK), implemented in `tools/envvar-matrix`. Build order #2 in `pptb-tool-ideas.md`; absorbs "Deployment Settings Builder".

One-liner: rows = environment variables and connection references, columns = environments. Shows missing values, differences, lets you copy values across environments, exports `deploymentSettings.json`.

Facts: `docs/PPTB-NOTES.md` (§ refs). Scaffold, build, CSP, theme, host adapter: same as `tools/solution-xray` (copied, not shared — refactor to a shared package at tool #3).

---

## 0. Decisions (need your OK)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| E1 | Columns = environments, but PPTB exposes at most 2 live connections (primary + secondary, §3) | Live columns = primary + secondary. Extra columns = **snapshots**: export a column to JSON, load snapshots as read-only columns | Only way to get N environments without leaving the PPTB API. Snapshots double as audit evidence |
| E2 | Writes | v1 writes **environment variable values only** (create/update `environmentvariablevalue`). Connection reference binding is read-only in v1 | Binding a conn ref needs a connection id from the Power Apps API (`enabledForPowerPlatformAPI` + Entra app), not Dataverse. Keep v1 Dataverse-only. Bulk bind → v1.1 |
| E3 | Write safety | Every write = dry-run preview table → explicit Confirm → per-row result. Secrets (type 100000005) read-only. Target environment shown by name + colour badge (Connection.environmentColor) | Prod is one click away. Preview is the guard |
| E4 | Solution scope | Default: all env vars / conn refs in the environment. Optional filter: by solution (query `solutioncomponents` for a picked solution) and by prefix text | Matrix across envs must not depend on solution membership, which drifts |
| E5 | Package | `@simplesmoothsafe/pptb-envvar-matrix`, display "SSS EnvVar & ConnRef Matrix", MIT | Naming consistent with XRay |

Manifest: `features: { multiConnection: "optional", connectionRequirement: "required", minAPI: "1.2.0" }` (secondary connection + `Connection` colour fields need 1.2.0, §10). No `cspExceptions`.

---

## 1. Data

Environment variables (per connection, `dataverseAPI.queryData(..., "primary"|"secondary")`):

```
environmentvariabledefinitions?$select=environmentvariabledefinitionid,schemaname,displayname,type,defaultvalue,description,ismanaged
  &$expand=environmentvariabledefinition_environmentvariablevalue($select=environmentvariablevalueid,value)
```

Types: 100000000 String, 100000001 Number, 100000002 Boolean, 100000003 JSON, 100000004 Data source, 100000005 Secret.
Effective value = current value if a value row exists, else default, else **missing**.

Connection references:

```
connectionreferences?$select=connectionreferenceid,connectionreferencelogicalname,connectionreferencedisplayname,connectorid,connectionid,ismanaged,statecode
```

Bound = `connectionid` non-empty. Connector = last segment of `connectorid`.

Solution filter (E4, optional): `solutioncomponents?$select=objectid,componenttype&$filter=_solutionid_value eq <id> and (componenttype eq 380 or componenttype eq 371)` then intersect on ids. Solution list from `dataverseAPI.getSolutions(["solutionid","uniquename","friendlyname","version","ismanaged"])`.

Snapshot file (E1): `{ "kind": "sss-envvar-matrix-snapshot", "version": 1, "environment": { name, url, environment, takenAt }, "environmentVariables": [{ schemaName, displayName, type, defaultValue, value, isManaged }], "connectionReferences": [{ logicalName, displayName, connectorId, connectionId, isManaged }] }`.

---

## 2. Screens

Single page, two tabs: **Environment variables** · **Connection references**. Shared header: column chips (primary, secondary, each loaded snapshot; remove snapshot), Refresh, filter text, toggles "only differences" / "only missing", solution filter (E4), Export.

Matrix table: row = schema/logical name (+ display name, type badge, managed badge); one cell per column.
- Env var cell: effective value, source badge (`value` / `default` / `missing`), secret → `••••` read-only.
- Conn ref cell: `bound` (connector, connection id short) / `unbound` / `absent`.
- Row highlight when values differ across columns or any column missing.

Row actions (env vars only, E2): "Copy → target": preview dialog listing rows, source value, target current value, then Confirm → `create` (`environmentvariablevalue` with `EnvironmentVariableDefinitionId@odata.bind`) or `update`; results column. Multi-select rows via checkboxes for bulk.

Export: `deploymentSettings.json` for a chosen column (`{ EnvironmentVariables: [{SchemaName, Value}], ConnectionReferences: [{LogicalName, ConnectionId, ConnectorId}] }`, the `pac solution import --settings-file` shape), and matrix CSV. Snapshot export per column.

Without a connection: page shows the same UI with only snapshot columns; live columns disabled. (`connectionRequirement: required` means PPTB will not open it connectionless anyway; kept for symmetry with the offline snapshot flow.)

---

## 3. Structure

```
tools/envvar-matrix/
├── package.json, tsconfig.json, vite.config.ts, LICENSE, README.md, public/icon.svg
├── scripts/check-dist.mjs, scripts/e2e.mjs
└── src/
    ├── index.html, styles.css (copied from solution-xray, same tokens)
    ├── host.ts            connections (primary/secondary + connection:* events), theme, saveFile/selectPath+readText, notify
    ├── main.ts            UI
    └── matrix/
        ├── types.ts       EnvVarRow, ConnRefRow, Column (live | snapshot), Matrix
        ├── fetch.ts       queryData wrappers → Column data
        ├── matrix.ts      merge columns → rows, diff/missing flags, filters
        ├── write.ts       plan + apply env var value writes (dry-run object → results)
        ├── export.ts      deploymentSettings.json, CSV, snapshot
        └── snapshot.ts    parse/validate snapshot JSON
```

E2E: dist run in Chromium with a **mock `window.toolboxAPI` / `window.dataverseAPI`** injected by Playwright (two fake environments), plus snapshot load. Covers matrix merge, diff flags, copy preview + apply against the mock, exports.

---

## 4. Steps

1. Scaffold (copy from XRay, rename, manifest).
2. `matrix/*` logic + unit-ish checks via e2e mock.
3. UI + host adapter with connection events (`connection:updated` → refetch).
4. Writes with preview/confirm.
5. Exports + snapshots.
6. README, validate (branch URL → main URL after merge), PR.

Not in v1: connection reference binding, Power Platform API, secrets write, bulk delete, N live environments.

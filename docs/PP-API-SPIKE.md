# Spike — Power Platform API for connection binding

> **Status (2026-09-24):** built as an experimental feature in envvar-matrix 1.3.0 (`src/matrix/ppconnections.ts`, **Pick connections…**) on the assumptions below, **before** the §6 probe ran. The parser reads the connector from `id` or several `properties` fields, and the account and status from several candidates. Run the probe and adjust `normalizeConnection` if the real shape differs.

Question: can the EnvVar & ConnRef Matrix list the connections in an environment, so a user can bind connection references by picking a connection instead of loading a deploymentSettings.json file?

Answer: **yes, conditionally**. ToolBox (≥ 1.2.6) exposes `window.powerplatformAPI`, and Microsoft documents a list-connections endpoint. It only works for connections the user has set up for the Power Platform API, which needs their own Entra app registration. Build it as an optional path; keep the settings file as the default.

Sources: PPTB `desktop-app@861c0b0`, `sample-tools@79b0a0e`, `pptb-docs-web@3abb573`, Microsoft Learn (links below). Nothing below was called live.

## 1. Endpoint (Microsoft)

```
GET https://api.powerplatform.com/connectivity/environments/{environmentId}/connections?api-version=2024-10-01
```

- [List Connections](https://learn.microsoft.com/rest/api/power-platform/connectivity/connections/list-connections). Response `{ value: Connection[] }`, where each `Connection` has `id`, `name`, `type`, `properties`.
- Permission: delegated `Connectivity.Connections.Read` ([permission reference](https://learn.microsoft.com/power-platform/admin/programmability-permission-reference)). The API supports delegated permissions only. Service principals need an RBAC role ([authentication](https://learn.microsoft.com/power-platform/admin/programmability-authentication-v2)).
- The documented `properties` schema looks like a connector's (`iconUri`, `tier`, `runtimeUrls`…), not a connection's. **Unverified:** where the connector id, status (error / expired) and owner live in the real response. Assumption: `name` = connection id (what `connectionreference.connectionid` holds), and the connector is either the path segment of `id` (`/providers/Microsoft.PowerApps/apis/<connector>/connections/<name>`) or `properties.apiId`.
- **Unverified:** which connections a delegated call returns: all connections in the environment, or only those the signed-in user owns or has been shared. This matters (see §4).

## 2. How ToolBox does it

| Topic | Finding | Source |
|---|---|---|
| Exposure | `window.powerplatformAPI.<Category>.Get/Post/Put/Patch/Delete(path, target?, headers?)` is given to **every** tool, whatever its manifest says | desktop-app `src/main/toolPreloadBridge.ts#L602`, `#L135-164` |
| URL | `https://api.powerplatform.com/<category lowercase>/` + path. The host substitutes nothing: the tool builds `environments/{id}/…` and adds `api-version` itself | `src/main/managers/powerplatformManager.ts#L80-93` |
| Transport | Runs in the main process (Node `https`), so the tool needs **no CSP exception** | `powerplatformManager.ts#L234-308` |
| Token | MSAL, scope fixed to `https://api.powerplatform.com/.default`. Works for interactive, username/password and client secret connections; device code has no path | `powerplatformManager.ts#L104-222`, `authManager.ts#L796-854` |
| Setup | Enabling the Power Platform API on a connection requires a **custom Client ID**: the user's own public-client Entra app with delegated Power Platform API permissions. The baseline set includes `Connectivity.Connections.Read`. ToolBox has a "Configure & Add" helper for this | `src/renderer/modules/connectionManagement.ts#L1509-1570`, docs `authentication/entra-app-registration` |
| `connection.enabledForPowerPlatformAPI` | UI and validation flag only; the request path never checks it | `powerplatformManager.ts` |
| `connection.scopesForPowerPlatformAPI` | The scopes granted on the last token, for information. A tool can check it for `Connectivity.Connections.Read` | `connectionsManager.ts#L218` |
| Manifest `features.enabledForPowerPlatformAPI` | Not enforced. It only adds a "this tool uses Power Platform API…" warning and a badge to the connection picker | `src/renderer/modules/toolManagement.ts#L145`, `modals/selectConnection` |
| Version | First release with the API: **v1.2.6** (`#575`, 2026-06-23). The sample tool declares `minAPI: "1.2.6"` | git history, sample-tools `new/html-sample/package.json` |
| Environment id | Not on the connection object. Options: Dataverse `RetrieveCurrentOrganization` → `Detail.EnvironmentId` (**already used** in `tools/dependency-cleaner/src/deps/fetch.ts#L418-425`), or match the connection's `url` against `EnvironmentManagement.Get("environments?api-version=2024-10-01")` | toolPreloadBridge `ToolSafeConnection` |
| Errors | Every error is prefixed `Power Platform request failed: …`. There is no specific "not enabled" error: an interactive connection without consent may open a browser consent prompt; otherwise expect `Authentication expired…`, `No access token found…`, or `HTTP 403: …` | `powerplatformManager.ts#L66-295` |
| Prior art | No PPTB tool calls Connectivity. The sample calls PowerApps, PowerAutomate, EnvironmentManagement, Governance and Authorization | sample-tools `new/html-sample/src/app.ts` |

## 3. Dataverse alternative checked: `connectioninstance`

Dataverse has a [Connection Instance](https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/connectioninstance) table (`connectioninstances`). Its columns: `connectioninternalid` (API Hub connection id), `connectorinternalid`, `connectionstatus`, `accountname`, owner, and a **required** `connectionreferenceid` lookup.

Because every row hangs off a connection reference, the table most likely holds only connections created through the newer "connections in Dataverse" path. It is not a full list of the environment's connections. It could still be a cheap Dataverse-only source for **status and account** of connections already bound. Worth one probe query (§6); don't design around it.

## 4. Risks

- **Setup barrier.** Most ToolBox users run interactive connections with the default client id. They would need an app registration and admin consent before the picker works. The deploymentSettings path has no such barrier.
- **Connection visibility vs usability.** If the call returns every connection in the environment, the picker can offer connections the flow owner cannot use, and activating the flow then fails. Mitigation: show the owner, prefer the user's own and shared connections, and keep the existing restart step that reports "left off".
- **Response shape unverified** (§1). Parse defensively and read the connector from `id` if `properties` lacks it.
- **Host version.** Raising `minAPI` from 1.2.0 to 1.2.6 would lock out older ToolBox builds for the whole tool. Feature-detect `window.powerplatformAPI` instead and keep `minAPI` as it is.
- **Manifest flag.** Setting `features.enabledForPowerPlatformAPI: true` would show the picker warning to every user, including those who never bind. Leave it off and explain setup inside the bind UI.

## 5. Proposed design (if the probe passes)

1. On opening **Preview bind…** with a live target and no source column, or through a "Pick connections…" action: if `window.powerplatformAPI` exists, read `Detail.EnvironmentId` (cached per connection url), then `Connectivity.Get(\`environments/${envId}/connections?api-version=2024-10-01\`, target)`.
2. Show a per-row dropdown with only the connections of that row's connector, labelled with display name, account/owner and status. Rows that already have a binding preselect it.
3. The plan goes through `planBind` / `applyBind` unchanged: build a synthetic source column from the picks. Same preview, connector check, managed caution and flow restart.
4. On failure, one inline message with the reason (`403` / consent / not enabled), a link to the ToolBox Entra app setup docs, and the fallback: "or load a deploymentSettings.json".

Effort: **M**, about one session: env id + connections fetch + parse ~80 LOC, dropdown UI ~120 LOC, mock + e2e ~150 LOC. No new write path.

## 6. Probe before building (owner, 15 minutes, one Dev env)

Needs a ToolBox connection with the Power Platform API enabled (custom client id, `Connectivity.Connections.Read` consented). With the Matrix tool open, run in its devtools console (Debug → toggle tool devtools):

```js
const org = await dataverseAPI.execute({ operationName: "RetrieveCurrentOrganization", operationType: "function", parameters: { AccessType: "Microsoft.Dynamics.CRM.EndpointAccessType'Default'" } });
const envId = org.Detail?.EnvironmentId; console.log("env", envId);
const r = await powerplatformAPI.Connectivity.Get(`environments/${envId}/connections?api-version=2024-10-01`);
console.log(r.value?.length, JSON.stringify(r.value?.[0], null, 2));
console.log(await dataverseAPI.queryData("connectioninstances?$select=connectioninternalid,connectorinternalid,connectionstatus,accountname&$top=5"));
```

Record:

- [ ] Does the call succeed? If not, the exact error text.
- [ ] Does `value[0].name` equal a `connectionreference.connectionid` in that environment?
- [ ] Where are the connector id, status and owner in the object?
- [ ] Count compared with the maker portal Connections page: all of the environment's connections, or only the user's own and shared ones?
- [ ] Does `connectioninstances` return rows, and for which connections?

Paste the output (redact ids if needed). With it, §5 can be built without guessing.

## Recommendation

**Go, gated on the probe.** The settings-file bind already covers the ALM case, which is the common one. The Power Platform API picker is a convenience for ad-hoc fixes in Dev, behind a setup most users don't have. Build it only once the probe confirms the response shape and which connections the call returns.

// Unit tests for the pure logic in src/matrix: flow clientdata parsing and rewriting, merge planning, off-flow
// classification, bind planning, settings import and Power Platform API connection parsing.
// The modules are bundled with esbuild (shipped with vite) into one ESM string and imported from a data URL,
// so no test framework or TS loader is needed. Run from tools/envvar-matrix: node scripts/unit-test.mjs
// scripts/fixtures/flow-clientdata.json is synthetic, modelled on the shape of an exported solution flow's clientdata
// (nested If / else / Scope, invoker vs embedded, keys _1 and _10). Add real exports next to it when available.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const esbuild = createRequire(resolve(TOOL, "package.json"))("esbuild");
const out = esbuild.buildSync({
  stdin: {
    contents: ["consolidate", "bind", "settings", "ppconnections"].map((m) => `export * from "./src/matrix/${m}";`).join("\n"),
    resolveDir: TOOL,
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  write: false,
});
const M = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

const FIXTURE = readFileSync(resolve(TOOL, "scripts/fixtures/flow-clientdata.json"), "utf8");
const parsed = (json) => JSON.parse(json);
const refsOf = (json) => Object.fromEntries(Object.entries(parsed(json).properties.connectionReferences).map(([k, v]) => [k, v.connection.connectionReferenceLogicalName]));
const hostNames = (json) => {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) k === "connectionName" ? out.push(x) : walk(x);
  };
  walk(parsed(json).properties.definition);
  return out.sort();
};
const rename = (pairs) => new Map(Object.entries(pairs));

// ---------- parse ----------

test("parseFlowRefs reads every key with its logical name and api", () => {
  const refs = M.parseFlowRefs(FIXTURE);
  assert.equal(refs.length, 5);
  assert.deepEqual(refs.find((r) => r.key === "shared_office365_10"), { key: "shared_office365_10", logicalName: "sss_o365_c", apiName: "shared_office365" });
});

test("parseFlowRefs: no connectionReferences → empty; invalid JSON throws", () => {
  assert.deepEqual(M.parseFlowRefs(JSON.stringify({ properties: { definition: {} } })), []);
  assert.deepEqual(M.parseFlowRefs("{}"), []);
  assert.throws(() => M.parseFlowRefs("{not json"));
});

// ---------- rewrite without collapse ----------

test("rewrite without collapse: logical name only, keys and definition untouched", () => {
  const r = M.rewriteClientdata(FIXTURE, rename({ sss_dataverse_b: "sss_dataverse_a" }), false);
  assert.deepEqual(r.changes, [{ key: "shared_commondataserviceforapps_1", from: "sss_dataverse_b", to: "sss_dataverse_a" }]);
  assert.equal(refsOf(r.json).shared_commondataserviceforapps_1, "sss_dataverse_a");
  assert.deepEqual(parsed(r.json).properties.definition, parsed(FIXTURE).properties.definition);
  assert.deepEqual(r.collapsed, []);
});

test("rewrite with nothing to rename returns the input string unchanged", () => {
  const r = M.rewriteClientdata(FIXTURE, rename({ sss_other: "sss_x" }), true);
  assert.equal(r.json, FIXTURE);
  assert.deepEqual(r.changes, []);
});

test("rename lookup is case-insensitive on the source logical name", () => {
  const r = M.rewriteClientdata(FIXTURE, rename({ sss_dataverse_b: "sss_dataverse_a" }), false);
  const upper = FIXTURE.replace('"sss_dataverse_b"', '"SSS_Dataverse_B"');
  const r2 = M.rewriteClientdata(upper, rename({ sss_dataverse_b: "sss_dataverse_a" }), false);
  assert.equal(r2.changes.length, 1);
  assert.equal(refsOf(r2.json).shared_commondataserviceforapps_1, refsOf(r.json).shared_commondataserviceforapps_1);
});

// ---------- collapse ----------

test("collapse: renamed key folds into the key that was not renamed; nested action repointed", () => {
  const r = M.rewriteClientdata(FIXTURE, rename({ sss_dataverse_b: "sss_dataverse_a" }), true);
  assert.deepEqual(r.collapsed, [{ drop: "shared_commondataserviceforapps_1", into: "shared_commondataserviceforapps", uses: 1 }]);
  const refs = refsOf(r.json);
  assert.ok(!("shared_commondataserviceforapps_1" in refs));
  assert.equal(refs.shared_commondataserviceforapps, "sss_dataverse_a");
  const d = parsed(r.json).properties.definition;
  assert.equal(d.actions.Get_a_row_by_ID.inputs.host.connectionName, "shared_commondataserviceforapps");
  assert.equal(d.triggers.When_a_row_is_added.inputs.host.connectionName, "shared_commondataserviceforapps");
});

test("collapse: runtimeSource differs (invoker vs embedded) → both keys kept, with reason", () => {
  const r = M.rewriteClientdata(FIXTURE, rename({ sss_o365_b: "sss_o365_a" }), true);
  assert.deepEqual(r.collapsed, []);
  assert.equal(r.kept.length, 1);
  assert.match(r.kept[0], /shared_office365_1: runtimeSource \/ impersonation differs from shared_office365/);
  const refs = refsOf(r.json);
  assert.equal(refs.shared_office365, "sss_o365_a");
  assert.equal(refs.shared_office365_1, "sss_o365_a");
});

test("collapse: _1 into _10 rewrites host + expression, never mangles the longer key", () => {
  const r = M.rewriteClientdata(FIXTURE, rename({ sss_o365_b: "sss_o365_c" }), true);
  assert.deepEqual(r.collapsed, [{ drop: "shared_office365_1", into: "shared_office365_10", uses: 2 }]);
  const d = parsed(r.json).properties.definition;
  assert.equal(d.actions.Condition.actions["Send_an_email_(V2)"].inputs.host.connectionName, "shared_office365_10");
  assert.equal(d.actions.Condition.else.actions.Scope.actions["Send_an_email_(V2)_2"].inputs.host.connectionName, "shared_office365_10");
  assert.equal(d.actions.Compose_connection_ids.inputs.one, "@parameters('$connections')['shared_office365_10']['connectionId']");
  assert.equal(d.actions.Compose_connection_ids.inputs.ten, "@parameters('$connections')['shared_office365_10']['connectionId']");
  assert.ok(!JSON.stringify(d).includes("shared_office365_1'") && !JSON.stringify(d).includes('"shared_office365_1"'));
  assert.equal(d.actions.Condition.else.actions.Scope.actions.Send_as_invoker.inputs.host.connectionName, "shared_office365", "invoker key untouched");
});

test("collapse: _10 into _1 keeps shared_office365_1 and does not touch a key that merely starts the same", () => {
  // rename c → b: _10 is the renamed key, _1 kept
  const r = M.rewriteClientdata(FIXTURE, rename({ sss_o365_c: "sss_o365_b" }), true);
  assert.deepEqual(r.collapsed, [{ drop: "shared_office365_10", into: "shared_office365_1", uses: 2 }]);
  assert.deepEqual(hostNames(r.json), ["shared_commondataserviceforapps", "shared_commondataserviceforapps_1", "shared_office365", "shared_office365_1", "shared_office365_1"]);
});

test("collapse: bracket form ['$connections']['key'] is repointed too", () => {
  const o = parsed(FIXTURE);
  o.properties.definition.actions.Compose_connection_ids.inputs.one = "@{body('x')['$connections']['shared_office365_1']}";
  const r = M.rewriteClientdata(JSON.stringify(o), rename({ sss_o365_b: "sss_o365_c" }), true);
  assert.equal(r.collapsed.length, 1);
  assert.equal(parsed(r.json).properties.definition.actions.Compose_connection_ids.inputs.one, "@{body('x')['$connections']['shared_office365_10']}");
});

test("collapse: a use the rewriter does not recognise blocks the drop", () => {
  const o = parsed(FIXTURE);
  o.properties.definition.actions.Compose_connection_ids.inputs.weird = { key: "shared_office365_1" };
  const r = M.rewriteClientdata(JSON.stringify(o), rename({ sss_o365_b: "sss_o365_c" }), true);
  assert.deepEqual(r.collapsed, []);
  assert.match(r.kept[0], /shared_office365_1: used in a form this tool does not rewrite/);
  const out = parsed(r.json);
  assert.equal(out.properties.connectionReferences.shared_office365_1.connection.connectionReferenceLogicalName, "sss_o365_c", "reference still repointed");
  assert.equal(out.properties.definition.actions.Condition.actions["Send_an_email_(V2)"].inputs.host.connectionName, "shared_office365_1", "definition left as it was");
});

test("collapse ignores pre-existing duplicates the merge did not touch", () => {
  const o = parsed(FIXTURE);
  o.properties.connectionReferences.shared_office365_10.connection.connectionReferenceLogicalName = "sss_o365_b"; // _1 and _10 already share b
  const r = M.rewriteClientdata(JSON.stringify(o), rename({ sss_dataverse_b: "sss_dataverse_a" }), true);
  assert.deepEqual(r.collapsed.map((c) => c.drop), ["shared_commondataserviceforapps_1"]);
  assert.ok("shared_office365_10" in refsOf(r.json));
});

test("renameConnectionKey counts only real uses", () => {
  const d = parsed(FIXTURE).properties.definition;
  const r = M.renameConnectionKey(d, "shared_office365_10", "shared_office365_1");
  assert.equal(r.uses, 2);
  assert.equal(M.renameConnectionKey(d, "shared_nothing", "x").uses, 0);
});

// ---------- planning ----------

const cr = (logicalName, connector, connectionId, isManaged = false) => ({
  id: "id-" + logicalName,
  logicalName,
  displayName: logicalName,
  connectorId: "/providers/Microsoft.PowerApps/apis/" + connector,
  connector,
  connectionId,
  isManaged,
});
const flow = (id, name, refs, statecode = 0, extra = {}) => ({
  id,
  name,
  statecode,
  statuscode: statecode === 1 ? 2 : 1,
  isManaged: false,
  clientdata: JSON.stringify({ properties: { connectionReferences: Object.fromEntries(refs.map(([k, n, api]) => [k, { connection: { connectionReferenceLogicalName: n }, api: { name: api } }])) } }),
  refs: refs.map(([key, logicalName, apiName]) => ({ key, logicalName, apiName })),
  ...extra,
});
const TARGET = { key: "primary", kind: "live", target: "primary", name: "Dev", url: "https://dev.crm4.dynamics.com", environment: "Dev", takenAt: "" };

test("planMerge: blocking errors for cross-connector, source = target, source also a target, double selection", () => {
  const refs = [cr("a", "shared_office365", "c1"), cr("b", "shared_office365", "c1"), cr("s", "shared_sql", "c9"), cr("c", "shared_office365", null)];
  const e = (specs) => M.planMerge(TARGET, refs, [], specs, { deleteSources: false }).errors.join(" | ");
  assert.match(e([{ target: "a", sources: ["s"] }]), /different connectors/);
  assert.match(e([{ target: "a", sources: ["a"] }]), /both source and target/);
  assert.match(e([{ target: "a", sources: ["b"] }, { target: "b", sources: ["c"] }]), /target of another merge/);
  assert.match(e([{ target: "a", sources: ["c"] }, { target: "b", sources: ["c"] }]), /more than one merge/);
  assert.match(e([{ target: "zzz", sources: ["a"] }]), /does not exist/);
  assert.equal(e([{ target: "a", sources: ["b", "c"] }]), "");
});

test("planMerge: identity-change and unbound-target warnings; managed refs kept on delete", () => {
  const refs = [cr("a", "shared_office365", null), cr("b", "shared_office365", "c2"), cr("m", "shared_office365", "c3", true)];
  const flows = [flow("f1", "F1", [["shared_office365", "b", "shared_office365"]], 1)];
  const p = M.planMerge(TARGET, refs, flows, [{ target: "a", sources: ["b", "m"] }], { deleteSources: true });
  assert.match(p.warnings.join(" "), /a is not bound/);
  assert.equal(p.flows.length, 1);
  assert.equal(p.flows[0].action, "update");
  assert.deepEqual(p.deletes.map((d) => `${d.logicalName}:${d.action}`), ["b:delete", "m:keep"]);
  const refs2 = [cr("a", "shared_office365", "c1"), cr("b", "shared_office365", "c2")];
  assert.match(M.planMerge(TARGET, refs2, [], [{ target: "a", sources: ["b"] }], { deleteSources: false }).warnings.join(" "), /different connection/);
});

test("planMerge: a flow with unreadable clientdata is skipped and keeps its source from being deleted", () => {
  const refs = [cr("a", "shared_office365", "c1"), cr("b", "shared_office365", "c1")];
  const broken = flow("f9", "Broken", [["shared_office365", "b", "shared_office365"]], 0, { parseError: "clientdata does not parse" });
  const p = M.planMerge(TARGET, refs, [broken], [{ target: "a", sources: ["b"] }], { deleteSources: true });
  assert.equal(p.flows[0].action, "skip");
  assert.equal(p.deletes[0].action, "keep");
});

test("connectorGroups: suggestion = bound, then most used, then managed", () => {
  const refs = [cr("x_unbound", "shared_office365", null), cr("y_bound", "shared_office365", "c1"), cr("z_bound_used", "shared_office365", "c1"), cr("solo", "shared_sql", "c9")];
  const usage = M.usageByConnRef([flow("f1", "F1", [["k", "z_bound_used", "shared_office365"]])]);
  const g = M.connectorGroups(refs, usage);
  assert.equal(g.length, 1, "singletons are not groups");
  assert.equal(g[0].suggested, "z_bound_used");
  assert.equal(g[0].refs[0].logicalName, "z_bound_used");
});

test("offFlows: ready only when every reference exists and is bound", () => {
  const refs = [cr("a", "shared_office365", "c1"), cr("u", "shared_sql", null)];
  const flows = [
    flow("f1", "Ready", [["k", "a", "shared_office365"]]),
    flow("f2", "Unbound", [["k", "a", "shared_office365"], ["s", "u", "shared_sql"]]),
    flow("f3", "Missing", [["k", "ghost", "shared_teams"]]),
    flow("f4", "On", [["k", "a", "shared_office365"]], 1),
    flow("f5", "Broken", [], 0, { parseError: "clientdata does not parse" }),
    flow("f6", "No refs", []),
  ];
  const o = M.offFlows(flows, refs);
  assert.deepEqual(o.map((f) => `${f.name}:${f.ready}`), ["No refs:true", "Ready:true", "Broken:false", "Missing:false", "Unbound:false"]);
  assert.match(o.find((f) => f.name === "Unbound").reason, /unbound: u/);
  assert.match(o.find((f) => f.name === "Missing").reason, /missing reference: ghost/);
});

test("planBind: other-org source refused, connector mismatch invalid, same id skipped", () => {
  const rec = (connector, connectionId) => cr("r", connector, connectionId);
  const row = (src, dst) => ({ key: "r", logicalName: "r", displayName: "r", connector: "shared_office365", differs: false, anyUnbound: false, anyAbsent: false, cells: { src, primary: dst } });
  const cell = (r) => ({ state: r.connectionId ? "bound" : "unbound", connector: r.connector, connectionId: r.connectionId, record: r });
  const settings = { key: "src", kind: "snapshot", name: "file", url: "", environment: "Settings file", takenAt: "" };
  const other = { ...settings, url: "https://test.crm4.dynamics.com" };
  assert.equal(M.planBind([row(cell(rec("shared_office365", "new")), cell(rec("shared_office365", null)))], settings, TARGET).items[0].action, "update");
  assert.equal(M.planBind([row(cell(rec("shared_office365", "new")), cell(rec("shared_office365", null)))], other, TARGET).items[0].action, "invalid");
  assert.match(M.planBind([row(cell(rec("shared_sql", "new")), cell(rec("shared_office365", null)))], settings, TARGET).items[0].reason, /connector differs/);
  assert.equal(M.planBind([row(cell(rec("shared_office365", "same")), cell(rec("shared_office365", "SAME")))], settings, TARGET).items[0].action, "skip");
});

// ---------- settings + Power Platform API ----------

test("parseDeploymentSettings: empty Value / ConnectionId mean not set", () => {
  const c = M.parseDeploymentSettings(JSON.stringify({ EnvironmentVariables: [{ SchemaName: "a", Value: "" }, { SchemaName: "b", Value: "x" }], ConnectionReferences: [{ LogicalName: "r", ConnectionId: "", ConnectorId: "/providers/Microsoft.PowerApps/apis/shared_sql" }] }), "s.json");
  assert.deepEqual(c.envVars.map((e) => e.value), [null, "x"]);
  assert.equal(c.connRefs[0].connectionId, null);
  assert.equal(c.connRefs[0].connector, "shared_sql");
  assert.equal(M.isDeploymentSettings({ kind: "sss-envvar-matrix-snapshot" }), false);
  assert.throws(() => M.parseDeploymentSettings("{}", "x.json"), /not a deploymentSettings file/);
});

test("normalizeConnection: connector from id path, properties.apiId or api.name; status and account", () => {
  const a = M.normalizeConnection({ name: "c1", id: "/providers/Microsoft.PowerApps/apis/shared_office365/connections/c1", properties: { displayName: "Mail", accountName: "a@x.com", statuses: [{ status: "Connected" }] } });
  assert.deepEqual(a, { id: "c1", connector: "shared_office365", displayName: "Mail", account: "a@x.com", status: "Connected", broken: false });
  assert.equal(M.normalizeConnection({ name: "c2", properties: { apiId: "/providers/Microsoft.PowerApps/apis/Shared_SQL" } }).connector, "shared_sql");
  assert.equal(M.normalizeConnection({ name: "c3", properties: { api: { name: "shared_teams" } } }).connector, "shared_teams");
  const b = M.normalizeConnection({ name: "c4", properties: { statuses: [{ status: "Error" }], createdBy: { email: "b@x.com" } } });
  assert.equal(b.connector, null);
  assert.equal(b.broken, true);
  assert.equal(b.account, "b@x.com");
  assert.equal(M.normalizeConnection({ id: "/providers/Microsoft.PowerApps/apis/shared_sql/connections/fromid" }).id, "fromid");
  assert.equal(M.normalizeConnection({ properties: {} }), null);
});

test("Power Platform helpers: next link, connector filter, error hints", () => {
  assert.equal(M.relativePpLink("https://api.powerplatform.com/connectivity/environments/e/connections?api-version=2024-10-01&$skiptoken=x"), "environments/e/connections?api-version=2024-10-01&$skiptoken=x");
  const conns = [{ id: "1", connector: "shared_sql" }, { id: "2", connector: null }];
  assert.deepEqual(M.connectionsFor(conns, "shared_sql").map((c) => c.id), ["1"]);
  assert.deepEqual(M.connectionsFor(conns, null), []);
  assert.match(M.explainPpError(new Error("HTTP 403: Forbidden")), /Connectivity\.Connections\.Read/);
  assert.match(M.explainPpError(new Error("Authentication expired for connection 'Dev'")), /custom Client ID/);
});

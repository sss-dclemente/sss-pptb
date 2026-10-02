// Unit tests for the pure logic in src/apps: response normalizing, version compare, matrix cells, plan, run queue, exports.
// Bundled with esbuild (shipped with vite) into one ESM string and imported from a data URL, like envvar-matrix.
// Run from tools/d365-apps: node scripts/unit-test.mjs
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const TOOL = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const esbuild = createRequire(resolve(TOOL, "package.json"))("esbuild");
const out = esbuild.buildSync({
  stdin: { contents: ["api", "matrix", "run", "export", "unused"].map((m) => `export * from "./src/apps/${m}";`).join("\n"), resolveDir: TOOL, loader: "ts" },
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  write: false,
});
const M = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

const env = (id, type = "Sandbox") => ({ id, name: id.toUpperCase(), type, state: "Ready", url: `https://${id}.crm4.dynamics.com`, geo: "europe", hasDataverse: true });
const pkg = (uniqueName, version, state = "Installed", extra = {}) => ({ uniqueName, name: uniqueName, version, state, publisher: "Microsoft", customHandleUpgrade: false, error: null, learnMoreUrl: null, ...extra });

test("compareVersions: numeric per part, missing parts are 0", () => {
  assert.equal(M.compareVersions("9.1.10.2", "9.1.9.9"), 1);
  assert.equal(M.compareVersions("1.2", "1.2.0.0"), 0);
  assert.equal(M.compareVersions("1.2.0.1", "1.2"), 1);
  assert.equal(M.compareVersions(null, "1.0"), -1);
});

test("normalizeEnvironment: Power Platform API and BAP shapes", () => {
  const a = M.normalizeEnvironment({ id: "e1", displayName: "Dev", type: "Sandbox", state: "Ready", dataverseId: "org1", url: "https://dev.crm.dynamics.com", geo: "europe" });
  assert.deepEqual([a.id, a.name, a.type, a.hasDataverse], ["e1", "Dev", "Sandbox", true]);
  const b = M.normalizeEnvironment({ name: "e2", id: "/providers/Microsoft.BusinessAppPlatform/environments/e2", properties: { displayName: "Teams", environmentSku: "Teams", linkedEnvironmentMetadata: {} } });
  assert.deepEqual([b.id, b.name, b.type, b.hasDataverse], ["e2", "Teams", "Teams", false]);
});

test("normalizePackage: names, version and errors from either shape", () => {
  const p = M.normalizePackage({ uniqueName: "msdyn_Sales", localizedName: "Sales", version: "9.0.1", state: "InstallFailed", lastError: { message: "boom" }, customHandleUpgrade: true });
  assert.deepEqual([p.name, p.version, p.state, p.error, p.customHandleUpgrade], ["Sales", "9.0.1", "InstallFailed", "boom", true]);
  const q = M.normalizePackage({ packageUniqueName: "X", packageVersion: "1.0", lastOperation: { state: "Installing", errorDetails: { message: "e" } } });
  assert.deepEqual([q.uniqueName, q.version, q.state, q.error], ["X", "1.0", "Installing", "e"]);
  assert.equal(M.normalizePackage({ version: "1" }), null);
});

test("relativePath strips the category base of a nextLink", () => {
  assert.equal(M.relativePath("https://api.powerplatform.com/appmanagement/environments/e1/applicationPackages?x=1&$skiptoken=2", "appmanagement"), "environments/e1/applicationPackages?x=1&$skiptoken=2");
  assert.equal(M.relativePath("environments?api-version=1", "environmentmanagement"), "environments?api-version=1");
});

test("isSetupError recognizes auth and permission failures only", () => {
  assert.ok(M.isSetupError(new Error("Power Platform request failed: HTTP 403: Forbidden")));
  assert.ok(M.isSetupError(new Error("No access token found for connection")));
  assert.ok(!M.isSetupError(new Error("HTTP 500: Internal Server Error")));
});

test("cellFor: current, update (derived), failed, busy, available, absent", () => {
  assert.equal(M.cellFor(pkg("a", "1.0"), pkg("a", "1.0", "None")).kind, "current");
  const u = M.cellFor(pkg("a", "1.0"), pkg("a", "1.2", "None"));
  assert.deepEqual([u.kind, u.action, u.target.version], ["update", "update", "1.2"]);
  const f = M.cellFor(pkg("a", "1.0", "InstallFailed", { error: "x" }), undefined);
  assert.deepEqual([f.kind, f.action, f.note], ["failed", "retry", "x"]);
  assert.equal(M.cellFor(pkg("a", "1.0", "Installing"), pkg("a", "2.0", "None")).kind, "busy");
  assert.deepEqual([M.cellFor(undefined, pkg("a", "1.0", "None")).kind, M.cellFor(undefined, pkg("a", "1.0", "None")).action], ["available", "install"]);
  assert.equal(M.cellFor(undefined, undefined).kind, "absent");
  assert.equal(M.cellFor(pkg("a", "1.0", "Uninstalled"), pkg("a", "1.0", "None")).kind, "available");
});

const results = () => [
  { env: env("dev"), installed: [pkg("sales", "1.0"), pkg("fs", "2.0", "InstallFailed", { error: "dep missing" }), pkg("custom", "1.0", "Installed", { customHandleUpgrade: true })], available: [pkg("sales", "1.1", "None"), pkg("sales", "1.2", "None"), pkg("custom", "1.5", "None", { customHandleUpgrade: true }), pkg("extra", "3.0", "None")], error: null, setupError: false },
  { env: env("prod", "Production"), installed: [pkg("sales", "1.2")], available: [pkg("sales", "1.2", "None")], error: null, setupError: false },
];

test("buildMatrix: rows from installed apps, newest catalog version wins, not-installed toggle", () => {
  const m = M.buildMatrix(results(), { showNotInstalled: false });
  assert.deepEqual(m.rows.map((r) => r.uniqueName), ["custom", "fs", "sales"]);
  const sales = m.rows.find((r) => r.uniqueName === "sales");
  assert.deepEqual([sales.cells.get("dev").kind, sales.cells.get("dev").target.version, sales.cells.get("prod").kind], ["update", "1.2", "current"]);
  assert.equal(m.rows.find((r) => r.uniqueName === "fs").cells.get("prod").kind, "absent");
  assert.ok(m.rows.find((r) => r.uniqueName === "custom").customHandleUpgrade);
  const all = M.buildMatrix(results(), { showNotInstalled: true });
  assert.ok(all.rows.some((r) => r.uniqueName === "extra" && r.cells.get("dev").kind === "available"));
  assert.deepEqual(M.counts(m), { updates: 2, failed: 1, busy: 0 });
});

test("state badges: counts per shown column, rowHasState combines states as OR in shown columns", () => {
  const m = M.buildMatrix(results(), { showNotInstalled: false });
  assert.deepEqual(M.counts(m, new Set(["prod"])), { updates: 0, failed: 0, busy: 0 }, "only the given columns");
  assert.deepEqual(M.counts(m, new Set(["dev", "prod"])), M.counts(m));
  const row = (u) => m.rows.find((r) => r.uniqueName === u);
  const both = new Set(["dev", "prod"]);
  assert.equal(M.rowHasState(row("fs"), new Set(["failed"]), both), true);
  assert.equal(M.rowHasState(row("fs"), new Set(["update", "busy"]), both), false);
  assert.equal(M.rowHasState(row("sales"), new Set(["failed", "update"]), both), true, "any of the states");
  assert.equal(M.rowHasState(row("sales"), new Set(["update"]), new Set(["prod"])), false, "hidden columns do not count");
  assert.deepEqual([...M.STATE_KINDS], ["update", "failed", "busy"]);
});

test("updateKeys skips custom-upgrade packages; planInstalls orders by environment then app", () => {
  const m = M.buildMatrix(results(), { showNotInstalled: true });
  assert.deepEqual(M.updateKeys(m), [M.cellKey("dev", "sales")]);
  assert.deepEqual(M.updateKeys(m, (u) => u !== "sales"), [], "rows hidden by the filter are left out");
  const sel = new Set([M.cellKey("prod", "sales"), M.cellKey("dev", "sales"), M.cellKey("dev", "fs"), M.cellKey("dev", "extra")]);
  const plan = M.planInstalls(m, sel);
  assert.deepEqual(plan.map((p) => `${p.env.id}:${p.uniqueName}:${p.action}`), ["dev:extra:install", "dev:fs:retry", "dev:sales:update"]);
  assert.deepEqual([plan[2].from, plan[2].to], ["1.0", "1.2"]);
});

test("runInstalls: one at a time per environment, parallel across, operation id and package-state fallback", async () => {
  const log = [];
  let active = new Map();
  let maxPerEnv = 0;
  let maxEnvs = 0;
  const ops = new Map();
  const pp = {
    EnvironmentManagement: { Get: async () => ({}), Post: async () => ({}) },
    AppManagement: {
      Post: async (path) => {
        const [, envId, name] = path.match(/environments\/([^/]+)\/applicationPackages\/([^/]+)\/install/);
        active.set(envId, (active.get(envId) ?? 0) + 1);
        maxPerEnv = Math.max(maxPerEnv, ...active.values());
        maxEnvs = Math.max(maxEnvs, [...active.values()].filter((n) => n > 0).length);
        log.push(`start ${envId}:${name}`);
        if (name === "nobody") return {};
        if (name === "bad") throw new Error("Power Platform request failed: HTTP 400: package not entitled");
        const id = `op-${envId}-${name}`;
        ops.set(id, { envId, polls: 0, fail: name === "willfail" });
        return { lastOperation: { operationId: id } };
      },
      Get: async (path) => {
        const op = path.match(/operations\/([^?]+)/);
        if (op) {
          const o = ops.get(decodeURIComponent(op[1]));
          if (++o.polls < 2) return { status: "Running" };
          active.set(o.envId, active.get(o.envId) - 1);
          return o.fail ? { status: "Failed", error: { message: "solution import failed" } } : { status: "Succeeded" };
        }
        // package-state fallback for "nobody"
        const envId = path.match(/environments\/([^/]+)\//)[1];
        if (path.includes("NotInstalled")) return { value: [] };
        active.set(envId, Math.max(0, (active.get(envId) ?? 1) - 1));
        return { value: [{ uniqueName: "nobody", version: "2.0", state: "Installed" }] };
      },
    },
  };
  const items = M.toRunItems([
    { env: env("a"), uniqueName: "x1", name: "x1", action: "update", from: "1", to: "2", customHandleUpgrade: false },
    { env: env("a"), uniqueName: "willfail", name: "willfail", action: "update", from: "1", to: "2", customHandleUpgrade: false },
    { env: env("b"), uniqueName: "nobody", name: "nobody", action: "install", from: null, to: "2", customHandleUpgrade: false },
    { env: env("b"), uniqueName: "bad", name: "bad", action: "install", from: null, to: "2", customHandleUpgrade: false },
    { env: env("c"), uniqueName: "y", name: "y", action: "retry", from: "1", to: "1", customHandleUpgrade: false },
  ]);
  await M.runInstalls({ pp, items, pollMs: 0, sleep: async () => {}, onChange: () => {}, stopped: () => false });
  assert.deepEqual(items.map((i) => i.status), ["succeeded", "failed", "succeeded", "failed", "succeeded"]);
  assert.equal(items[1].message, "solution import failed");
  assert.match(items[3].message, /package not entitled/);
  assert.equal(items[2].operationId, null);
  assert.equal(maxPerEnv, 1, "never two installs at once in one environment");
  assert.ok(maxEnvs >= 2, "environments run in parallel");
  assert.ok(log.indexOf("start a:willfail") > log.indexOf("start a:x1"), "per-environment order kept");
});

test("runInstalls: Stop waiting leaves queued items unstarted", async () => {
  let stop = false;
  const pp = { EnvironmentManagement: {}, AppManagement: { Post: async () => ({ operationId: "op" }), Get: async () => { stop = true; return { status: "Running" }; } } };
  const items = M.toRunItems([1, 2].map((n) => ({ env: env("a"), uniqueName: `p${n}`, name: `p${n}`, action: "update", from: "1", to: "2", customHandleUpgrade: false })));
  await M.runInstalls({ pp, items, pollMs: 0, sleep: async () => {}, onChange: () => {}, stopped: () => stop });
  assert.deepEqual(items.map((i) => [i.status, i.message]), [["stopped", "stopped waiting; the install continues in the environment"], ["stopped", "not started"]]);
});

test("exports: matrix CSV, pac script per environment, results CSV", () => {
  const m = M.buildMatrix(results(), { showNotInstalled: false });
  const csv = M.matrixCsv(m);
  assert.match(csv.split("\n")[0], /^app,unique name,publisher,DEV \(Sandbox\),PROD \(Production\)$/);
  assert.ok(csv.includes("sales,sales,Microsoft,1.0 -> 1.2,1.2"));
  const plan = M.planInstalls(m, new Set([M.cellKey("dev", "sales"), M.cellKey("dev", "fs")]));
  const ps = M.pacScript(plan, new Date("2026-10-02T00:00:00Z"));
  assert.ok(ps.includes("# DEV (Sandbox)"));
  assert.ok(ps.includes("pac application install --environment 'dev' --application-name 'sales'  # sales: update 1.0 -> 1.2"));
  assert.ok(ps.includes("--application-name 'fs'  # fs: retry failed install"));
  const items = M.toRunItems(plan);
  items[0].status = "failed";
  items[0].message = "=cmd";
  assert.ok(M.resultsCsv(items).includes(",'=cmd,"), "formula cells neutralised");
});

// ---- shapes and messages seen on a real tenant (debug log 2026-10-02) ----
const REAL_400 = new Error("Error invoking remote method 'powerplatform.request': Error: Power Platform request failed: HTTP 400");

test("real host error: wrapper stripped; bare 400 gets the usual causes", () => {
  assert.equal(M.errText(REAL_400), "HTTP 400");
  assert.match(M.refusalMessage(REAL_400), /^HTTP 400: the environment refused the install\. Usual causes: another install/);
  assert.equal(M.refusalMessage(new Error("Power Platform request failed: HTTP 409: conflict")), "HTTP 409: conflict");
});

test("real list entry: errorDetails carries the failure message", () => {
  const p = M.normalizePackage({ uniqueName: "msdyn_PowerAppsCheckerAnchor", version: "2.2.3321.1", state: "InstallFailed", errorDetails: { errorName: "InternalServerError", message: "PDS retrying: Deployment was interrupted." }, customHandleUpgrade: false });
  assert.deepEqual([p.state, p.error], ["InstallFailed", "PDS retrying: Deployment was interrupted."]);
});

test("real install response: operationId in lastOperation", async () => {
  const pp = { AppManagement: { Post: async () => ({ id: "c0b1", packageUniqueName: "msdyn_ContactCenterRTAAnchor", packageVersion: "1.1.26085.1002", lastOperation: { state: "InstallRequested", operationId: "27655005-af5b-4dbd-8f75-18683e0893ab" } }) } };
  assert.equal(await M.startInstall(pp, "env", "msdyn_ContactCenterRTAAnchor"), "27655005-af5b-4dbd-8f75-18683e0893ab");
});

test("runInstalls: an environment that refuses two installs in a row is not asked again", async () => {
  const posts = [];
  const pp = { AppManagement: { Post: async (path) => { posts.push(path); if (path.includes("env-bad")) throw REAL_400; return { lastOperation: { operationId: "op" } }; }, Get: async () => ({ status: "Succeeded" }) } };
  const mk = (envId, n) => ({ env: env(envId), uniqueName: `p${n}`, name: `p${n}`, action: "update", from: "1", to: "2", customHandleUpgrade: false });
  const items = M.toRunItems([mk("env-bad", 1), mk("env-bad", 2), mk("env-bad", 3), mk("env-bad", 4), mk("env-ok", 5)]);
  await M.runInstalls({ pp, items, pollMs: 0, sleep: async () => {}, onChange: () => {}, stopped: () => false });
  assert.deepEqual(items.map((i) => i.status), ["failed", "failed", "stopped", "stopped", "succeeded"]);
  assert.equal(posts.filter((p) => p.includes("env-bad")).length, 2, "only two POSTs to the refusing environment");
  assert.match(items[2].message, /refused the previous 2 installs/);
  assert.match(items[0].message, /Usual causes/);
});

test("failedKeys ticks every failed install; a visibility filter narrows it", () => {
  const m = M.buildMatrix(results(), { showNotInstalled: false });
  assert.deepEqual(M.failedKeys(m), [M.cellKey("dev", "fs")]);
  assert.deepEqual(M.failedKeys(m, (u) => u !== "fs"), []);
  const plan = M.planInstalls(m, new Set(M.failedKeys(m)));
  assert.deepEqual(plan.map((p) => `${p.env.id}:${p.uniqueName}:${p.action}`), ["dev:fs:retry"]);
});

test("emptyEnvIds / visibleEnvs: nothing installed (available only) is empty, unreadable never; ✕ and hideEmpty combine; select-all skips hidden columns", () => {
  const rs = [
    ...results(),
    { env: env("fresh"), installed: [], available: [pkg("sales", "1.2", "None"), pkg("extra", "3.0", "None")], error: null, setupError: false },
    { env: env("busy"), installed: [pkg("portal", "5.0", "Installing")], available: [], error: null, setupError: false },
    { env: env("broken"), installed: [], available: [], error: "HTTP 500", setupError: false },
  ];
  const m = M.buildMatrix(rs, { showNotInstalled: true });
  assert.deepEqual([...M.emptyEnvIds(m)], ["fresh"], "available cells do not count, in-progress does, errors never empty");
  const ids = (list) => list.map((e) => e.id).join(",");
  assert.equal(ids(M.visibleEnvs(m, new Set(), true)), "dev,prod,busy,broken");
  assert.equal(ids(M.visibleEnvs(m, new Set(), false)), "dev,prod,fresh,busy,broken");
  assert.equal(ids(M.visibleEnvs(m, new Set(["dev", "broken"]), true)), "prod,busy", "✕ hides any column, unreadable ones too");
  assert.deepEqual(M.updateKeys(m, (_u, envId) => envId !== "dev"), [], "hidden column left out of Select all updates");
  assert.deepEqual(M.failedKeys(m, (_u, envId) => envId === "dev"), [M.cellKey("dev", "fs")]);
});

// ---------- unused apps ----------

const G = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
/** A fake Dataverse: solutions, history, components, metadata, counts, live rows, apps. */
function fakeDv(o = {}) {
  const calls = [];
  const sols = [
    { solutionid: G(1), uniquename: "msdyn_Sales", friendlyname: "Sales", version: "9.0" },
    { solutionid: G(2), uniquename: "msdyn_SalesCore", friendlyname: "Sales core", version: "9.0" },
    { solutionid: G(3), uniquename: "msdyn_Common", friendlyname: "Common", version: "1.0" },
    { solutionid: G(4), uniquename: "msdyn_Gami", friendlyname: "Gamification", version: "1.0" },
    { solutionid: G(5), uniquename: "msdyn_FlowApprovals", friendlyname: "Approvals", version: "2.0" },
    { solutionid: G(6), uniquename: "msdyn_Seed", friendlyname: "Seed", version: "1.0" },
  ];
  const hist = [
    { msdyn_name: "msdyn_SalesCore", msdyn_packagename: "msdyn_Sales", msdyn_operation: 0, msdyn_result: true },
    { msdyn_name: "msdyn_Common", msdyn_packagename: "msdyn_Sales", msdyn_operation: 0, msdyn_result: true },
    { msdyn_name: "msdyn_Common", msdyn_packagename: "Gamification", msdyn_operation: 0, msdyn_result: true },
    { msdyn_name: "msdyn_Gami", msdyn_packagename: "Gamification", msdyn_operation: 0, msdyn_result: true },
    { msdyn_name: "msdyn_Gone", msdyn_packagename: "Gamification", msdyn_operation: 0, msdyn_result: true },
    { msdyn_name: "msdyn_Seed", msdyn_packagename: "SeedPkg", msdyn_operation: 1, msdyn_result: true },
    { msdyn_name: "msdyn_Seed", msdyn_packagename: "SeedPkg", msdyn_operation: 0, msdyn_result: true },
  ];
  const comps = [
    { objectid: G(101), componenttype: 1, _solutionid_value: G(2) }, // msdyn_opp: Sales only
    { objectid: G(102), componenttype: 1, _solutionid_value: G(3) }, // msdyn_shared: common
    { objectid: G(103), componenttype: 1, _solutionid_value: G(4) }, // msdyn_badge: Gamification only
    { objectid: G(104), componenttype: 1, _solutionid_value: G(4) }, // account: not custom
    { objectid: G(105), componenttype: 1, _solutionid_value: G(6) }, // msdyn_seedcfg
    { objectid: G(106), componenttype: 1, _solutionid_value: G(2) }, // msdyn_fresh: snapshot 0, live row
    { objectid: G(201), componenttype: 80, _solutionid_value: G(4) }, // Gamification app
  ];
  const defs = [
    { MetadataId: G(101), LogicalName: "msdyn_opp", EntitySetName: "msdyn_opps", PrimaryIdAttribute: "msdyn_oppid", IsCustomEntity: true, IsIntersect: false, TableType: "Standard" },
    { MetadataId: G(102), LogicalName: "msdyn_shared", EntitySetName: "msdyn_shareds", PrimaryIdAttribute: "msdyn_sharedid", IsCustomEntity: true, IsIntersect: false, TableType: "Standard" },
    { MetadataId: G(103), LogicalName: "msdyn_badge", EntitySetName: "msdyn_badges", PrimaryIdAttribute: "msdyn_badgeid", IsCustomEntity: true, IsIntersect: false, TableType: "Standard" },
    { MetadataId: G(104), LogicalName: "account", EntitySetName: "accounts", PrimaryIdAttribute: "accountid", IsCustomEntity: false, IsIntersect: false, TableType: "Standard" },
    { MetadataId: G(105), LogicalName: "msdyn_seedcfg", EntitySetName: "msdyn_seedcfgs", PrimaryIdAttribute: "msdyn_seedcfgid", IsCustomEntity: true, IsIntersect: false, TableType: "Standard" },
    { MetadataId: G(106), LogicalName: "msdyn_fresh", EntitySetName: "msdyn_freshes", PrimaryIdAttribute: "msdyn_freshid", IsCustomEntity: true, IsIntersect: false, TableType: "Standard" },
  ];
  const snapshot = { msdyn_opp: 5000, msdyn_shared: 70, msdyn_badge: 0, msdyn_seedcfg: 3, msdyn_fresh: 0 };
  const live = { msdyn_badges: 0, msdyn_freshes: 1 };
  const page = (value) => ({ value });
  return {
    calls,
    queryData: async (q) => {
      calls.push(q);
      if (q.startsWith("solutions?")) return page(sols);
      if (q.startsWith("msdyn_solutionhistories?")) {
        if (o.historyFails) throw new Error("history down");
        if (o.historyNoFilter && q.includes("$filter")) throw new Error("filter not supported");
        return page(hist);
      }
      if (q.startsWith("solutioncomponents?")) return page(comps.filter((c) => q.includes(c._solutionid_value)));
      if (q.startsWith("EntityDefinitions?")) return page(defs);
      if (q.startsWith("RetrieveTotalRecordCount(")) {
        const names = JSON.parse(decodeURIComponent(q.split("@p1=")[1]));
        const keys = names.filter((n) => n in snapshot);
        return { EntityRecordCountCollection: { Count: keys.length, Keys: keys, Values: keys.map((k) => snapshot[k]) } };
      }
      if (q.startsWith("appmodules?")) return page([{ appmoduleid: G(201), name: "Gamification", uniquename: "msdyn_gamification", appmoduleroles_association: [] }]);
      const set = q.split("?")[0];
      if (set in live) return page(live[set] ? [{ id: 1 }] : []);
      throw new Error("unexpected " + q);
    },
  };
}
const installedPkgs = [pkg("msdyn_Sales", "9.0"), pkg("Gamification", "1.0"), pkg("msdyn_FlowApprovals", "2.0"), pkg("SeedPkg", "1.0"), pkg("Ghost", "1.0"), pkg("Busy", "1.0", "Installing")];

test("historyMap: Import rows only, failed imports skipped, keyed lower-case", () => {
  const m = M.historyMap([
    { msdyn_name: "A", msdyn_packagename: "P", msdyn_operation: 0, msdyn_result: true },
    { msdyn_name: "B", msdyn_packagename: "P", msdyn_operation: 1, msdyn_result: true },
    { msdyn_name: "C", msdyn_packagename: "p", msdyn_operation: 0, msdyn_result: false },
    { msdyn_name: "D", msdyn_packagename: null, msdyn_operation: 0 },
  ]);
  assert.deepEqual([...m.get("p")], ["a"]);
});

test("parseCounts / countPath: Keys+Values collection, names JSON-encoded", () => {
  const c = M.parseCounts({ EntityRecordCountCollection: { Count: 2, IsReadOnly: false, Keys: ["Account", "contact"], Values: [3, 0] } });
  assert.deepEqual([...c], [["account", 3], ["contact", 0]]);
  assert.equal(M.countPath(["a_b"]), "RetrieveTotalRecordCount(EntityNames=@p1)?@p1=%5B%22a_b%22%5D");
});

test("verdictFor: platform, not found, no signal, unused, light, in use, fresh row", () => {
  const t = (rows, atLeast = false) => ({ logicalName: "x", entitySet: "xs", rows, atLeast });
  assert.equal(M.verdictFor(pkg("msdyn_PowerAppsCheckerAnchor", "1"), true, [t(0)]), "platform");
  assert.equal(M.verdictFor(pkg("A", "1"), false, []), "not-found");
  assert.equal(M.verdictFor(pkg("A", "1"), true, [t(null)]), "no-signal");
  assert.equal(M.verdictFor(pkg("A", "1"), true, [t(0), t(0)]), "unused");
  assert.equal(M.verdictFor(pkg("A", "1"), true, [t(0), t(M.LIGHT_MAX_ROWS)]), "light");
  assert.equal(M.verdictFor(pkg("A", "1"), true, [t(M.LIGHT_MAX_ROWS + 1)]), "in-use");
  assert.equal(M.verdictFor(pkg("A", "1"), true, [t(1, true)]), "in-use");
});

test("analyzeUnused: shared solutions and tables excluded, zeros re-checked live, sorted unused first", async () => {
  const dv = fakeDv();
  const r = await M.analyzeUnused({ dv, installed: installedPkgs });
  const by = Object.fromEntries(r.packages.map((p) => [p.pkg.uniqueName, p]));
  assert.equal(by.Busy, undefined, "packages mid-install are left out");
  assert.equal(r.history, true);
  // Sales: own msdyn_SalesCore (history) + msdyn_Sales (anchor); msdyn_Common shared with Gamification
  assert.equal(by.msdyn_Sales.mappedBy, "history+anchor");
  assert.deepEqual(by.msdyn_Sales.solutions.map((s) => s.uniqueName).sort(), ["msdyn_Sales", "msdyn_SalesCore"]);
  assert.deepEqual(by.msdyn_Sales.shared.map((s) => s.uniqueName), ["msdyn_Common"]);
  assert.deepEqual(by.msdyn_Sales.sharedTables, ["msdyn_shared"]);
  assert.equal(by.msdyn_Sales.verdict, "in-use");
  assert.ok(by.msdyn_Sales.tables.find((t) => t.logicalName === "msdyn_fresh").atLeast, "snapshot 0 but a live row: lower bound");
  // Gamification: msdyn_badge 0 (live check), account is not custom, msdyn_Gone not installed any more
  assert.equal(by.Gamification.verdict, "unused");
  assert.deepEqual(by.Gamification.tables.map((t) => [t.logicalName, t.rows]), [["msdyn_badge", 0]]);
  assert.deepEqual(by.Gamification.apps.map((a) => [a.name, a.roles]), [["Gamification", 0]]);
  assert.equal(by.SeedPkg.verdict, "light", "uninstall history rows ignored, Import row counted");
  assert.equal(by.msdyn_FlowApprovals.verdict, "platform");
  assert.equal(by.Ghost.verdict, "not-found");
  assert.equal(r.packages[0].pkg.uniqueName, "Gamification");
  assert.ok(dv.calls.includes("msdyn_badges?$select=msdyn_badgeid&$top=1"), "a snapshot zero is re-checked live");
  assert.ok(!dv.calls.some((q) => q.startsWith("msdyn_opps?")), "a positive snapshot count is not re-queried");
  assert.ok(!dv.calls.some((q) => q.startsWith("msdyn_shareds?")) && !dv.calls.some((q) => q.includes("msdyn_shared%22")), "shared tables are not counted");
  const csv = M.unusedCsv(r, "Dev");
  assert.match(csv.split("\r\n")[1], /^Dev,Gamification,Gamification,1\.0,Probably unused,0,1,,msdyn_Gami,msdyn_Common,Gamification \(0 roles\),history$/);
});

test("unusedShown: pressed verdicts (any, not found as no signal) override Show all; name filter on top", () => {
  const P = (uniqueName, verdict) => ({ pkg: pkg(uniqueName, "1.0", "Installed", { name: uniqueName.toUpperCase() }), verdict });
  const list = [P("a", "unused"), P("b", "in-use"), P("c", "not-found"), P("d", "platform"), P("e", "no-signal")];
  const names = (v) => M.unusedShown(list, { all: false, verdicts: new Set(), query: "", ...v }).map((p) => p.pkg.uniqueName).join(",");
  assert.equal(names({}), "a,c,e", "in use and platform hidden by default");
  assert.equal(names({ all: true }), "a,b,c,d,e");
  assert.equal(names({ verdicts: new Set(["in-use"]) }), "b", "a pressed verdict shows its rows without Show all");
  assert.equal(names({ verdicts: new Set(["no-signal", "unused"]), all: true }), "a,c,e", "no signal covers not found; pressed badges win over Show all");
  assert.equal(names({ all: true, query: " B " }), "b", "name filter, trimmed, case-insensitive");
  assert.equal(M.verdictGroup("not-found"), "no-signal");
});

test("runProblems: everything that did not succeed", () => {
  const items = M.toRunItems([1, 2, 3].map((n) => ({ env: env("a"), uniqueName: `p${n}`, name: `p${n}`, action: "update", from: "1", to: "2", customHandleUpgrade: false })));
  items[0].status = "succeeded";
  items[1].status = "failed";
  items[2].status = "stopped";
  assert.deepEqual(M.runProblems(items).map((i) => i.uniqueName), ["p2", "p3"]);
  assert.equal(M.runProblems([items[0]]).length, 0, "a clean run");
});

test("analyzeUnused: history filter refused → unfiltered read; history unreadable → anchors only", async () => {
  const a = await M.analyzeUnused({ dv: fakeDv({ historyNoFilter: true }), installed: installedPkgs });
  assert.equal(a.history, true);
  assert.equal(a.packages.find((p) => p.pkg.uniqueName === "Gamification").verdict, "unused");
  const b = await M.analyzeUnused({ dv: fakeDv({ historyFails: true }), installed: installedPkgs });
  assert.equal(b.history, false);
  assert.match(b.warnings[0], /history down/);
  assert.equal(b.packages.find((p) => p.pkg.uniqueName === "Gamification").verdict, "not-found");
  assert.equal(b.packages.find((p) => p.pkg.uniqueName === "msdyn_Sales").mappedBy, "anchor");
});

test("envTypes: present types once each, usual ones first in a fixed order, others A–Z", () => {
  const list = [env("a", "Sandbox"), env("b", "Teams"), env("c", "Production"), env("d", "sandbox"), env("e", ""), env("f", "Developer"), env("g", "Default"), env("h", "Custom")];
  assert.deepEqual(M.envTypes(list), ["Production", "Sandbox", "Developer", "Default", "Custom", "Teams"]);
  assert.deepEqual(M.envTypes([]), []);
});

test("envMatches: text (name, type, URL) and type filter combine", () => {
  const e = env("dev", "Sandbox");
  assert.ok(M.envMatches(e, "", ""));
  assert.ok(M.envMatches(e, " DEV ", "sandbox"), "trimmed, case-insensitive; type compared case-insensitively");
  assert.ok(M.envMatches(e, "crm4", ""), "URL matches");
  assert.ok(!M.envMatches(e, "dev", "Production"), "type filter excludes");
  assert.ok(!M.envMatches(e, "prod", "Sandbox"), "text filter excludes");
});

test("planGroupOpen: open up to PLAN_FOLD_OVER groups; past it only Production and hidden-column groups", () => {
  assert.equal(M.PLAN_FOLD_OVER, 5);
  assert.ok(M.planGroupOpen(env("a"), 5));
  assert.ok(!M.planGroupOpen(env("a"), 6));
  assert.ok(M.planGroupOpen(env("p", "Production"), 6));
  assert.ok(M.planGroupOpen(env("a"), 6, true));
});

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
  stdin: { contents: ["api", "matrix", "run", "export"].map((m) => `export * from "./src/apps/${m}";`).join("\n"), resolveDir: TOOL, loader: "ts" },
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

test("updateKeys skips custom-upgrade packages; planInstalls orders by environment then app", () => {
  const m = M.buildMatrix(results(), { showNotInstalled: true });
  assert.deepEqual(M.updateKeys(m), [M.cellKey("dev", "sales")]);
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

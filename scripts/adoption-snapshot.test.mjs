import assert from "node:assert/strict";
import test from "node:test";
import {
  PACKAGES,
  matchCatalog,
  monthWindows,
  renderSnapshot,
  usageSignals,
  collectSnapshot,
} from "./adoption-snapshot.mjs";

test("month windows end the day before the read date", () => {
  assert.deepEqual(monthWindows("2026-10-13"), [
    { id: "2026-09", start: "2026-09-01", end: "2026-09-30", partial: false },
    { id: "2026-10-01…2026-10-12", start: "2026-10-01", end: "2026-10-12", partial: true },
  ]);
});

test("the first day of a month has only the previous complete month", () => {
  assert.deepEqual(monthWindows("2026-10-01"), [
    { id: "2026-09", start: "2026-09-01", end: "2026-09-30", partial: false },
  ]);
  assert.deepEqual(monthWindows("2024-03-01"), [
    { id: "2024-02", start: "2024-02-01", end: "2024-02-29", partial: false },
  ]);
  assert.deepEqual(monthWindows("2025-03-01"), [
    { id: "2025-02", start: "2025-02-01", end: "2025-02-28", partial: false },
  ]);
});

test("catalog match uses the package id in the download URL", () => {
  const tools = [
    {
      name: "Solution XRay",
      status: "active",
      download: "https://example.test/packages/someone-else-solution-xray-1.0.0/someone-else-solution-xray-1.0.0.tar.gz",
      tool_analytics: { mau: 99, downloads: 99, rating: 5 },
      tool_maturity: { status: "verified" },
    },
    {
      name: "Solution XRay",
      status: "active",
      download:
        "https://stpptb.blob.core.windows.net/tools/packages/simplesmoothsafe-pptb-solution-xray-1.2.1/simplesmoothsafe-pptb-solution-xray-1.2.1.tar.gz",
      tool_analytics: { mau: 2, downloads: 47, rating: 0 },
      tool_maturity: { status: "unverified" },
    },
    {
      name: "Other",
      status: "active",
      download:
        "https://stpptb.blob.core.windows.net/tools/packages/simplesmoothsafe-pptb-d365-apps-0.3.2/simplesmoothsafe-pptb-d365-apps-0.3.2.tar.gz",
      tool_analytics: { mau: 0, downloads: 1, rating: 0 },
      tool_maturity: { status: "unverified" },
    },
  ];
  const matched = matchCatalog(tools);
  const xray = matched.find((row) => row.pkg.slug === "simplesmoothsafe-pptb-solution-xray");
  const d365 = matched.find((row) => row.pkg.slug === "simplesmoothsafe-pptb-d365-apps");
  const access = matched.find((row) => row.pkg.slug === "simplesmoothsafe-pptb-access-checker");
  assert.equal(xray.tool.tool_analytics.mau, 2);
  assert.equal(d365.tool.tool_analytics.downloads, 1);
  assert.equal(access.tool, null);
  assert.equal(matched.length, PACKAGES.length);
});

test("a shorter package id does not swallow a longer one", () => {
  const tools = [
    {
      download:
        "https://example.test/packages/simplesmoothsafe-pptb-d365-apps-0.3.2/simplesmoothsafe-pptb-d365-apps-0.3.2.tar.gz",
      tool_analytics: { mau: 4, downloads: 4, rating: 0 },
    },
  ];
  const packages = [
    { name: "short", npm: "@simplesmoothsafe/pptb-d365", slug: "simplesmoothsafe-pptb-d365" },
    { name: "long", npm: "@simplesmoothsafe/pptb-d365-apps", slug: "simplesmoothsafe-pptb-d365-apps" },
  ];
  const matched = matchCatalog(tools, packages);
  assert.equal(matched[0].tool, null);
  assert.equal(matched[1].tool.tool_analytics.mau, 4);
});

test("usage signals follow the 2-of-3 Verified thresholds", () => {
  assert.equal(usageSignals(null), null);
  assert.equal(usageSignals({ mau: 2, downloads: 47, rating: 0 }).label, "0/3");
  assert.equal(usageSignals({ mau: 1, downloads: 55, rating: 0 }).label, "1/3 (downloads)");
  assert.equal(usageSignals({ mau: 10, downloads: 49, rating: 2 }).label, "1/3 (MAU)");
  assert.equal(usageSignals({ mau: 10, downloads: 50, rating: 3 }).label, "3/3 (MAU, downloads, rating)");
  assert.equal(usageSignals({ mau: 9, downloads: 50, rating: 3 }).met, 2);
  assert.equal(usageSignals({ rating: 0 }).label, "0/3");
  assert.equal(usageSignals({}).mau, null);
});

test("snapshot markdown keeps unlisted tools and sums npm totals", () => {
  const markdown = renderSnapshot({
    asOf: "2026-10-13",
    windows: monthWindows("2026-10-13"),
    catalog: [
      {
        name: "Solution XRay",
        listed: true,
        status: "active",
        maturity: "unverified",
        analytics: { mau: 2, downloads: 47, rating: 0 },
      },
      {
        name: "EnvVar & ConnRef Matrix",
        listed: true,
        status: "active",
        maturity: "unverified",
        analytics: { mau: 1, downloads: 55, rating: 0 },
      },
      { name: "Access Checker", listed: false, status: null, maturity: null, analytics: null },
    ],
    npm: [
      { npm: "@simplesmoothsafe/pptb-solution-xray", latest: "1.2.1", counts: [970, 451] },
      { npm: "@simplesmoothsafe/pptb-envvar-matrix", latest: "1.6.1", counts: [1752, 494] },
    ],
  });
  assert.match(markdown, /### 2026-10-13/);
  assert.match(markdown, /Sem telemetria nas ferramentas/);
  assert.match(markdown, /\| Solution XRay \| listada \| 2 \| 47 \| 0 \| unverified \| 0\/3 \|/);
  assert.match(markdown, /\| EnvVar & ConnRef Matrix \| listada \| 1 \| 55 \| 0 \| unverified \| 1\/3 \(downloads\) \|/);
  assert.match(markdown, /\| Access Checker \| não listada \| — \| — \| — \| — \| — \|/);
  assert.match(markdown, /Ainda fora do catálogo: Access Checker/);
  assert.match(markdown, /\| \*\*Total\*\* \| \| \*\*2722\*\* \| \*\*945\*\* \|/);
  assert.match(markdown, /Não são pessoas/);
  assert.doesNotMatch(markdown, /user id|systemuserid|@[a-z0-9.-]+\.[a-z]{2,}/i);
});

test("collectSnapshot uses injected public readers and invents nothing", async () => {
  const snapshot = await collectSnapshot("2026-10-01", {
    catalog: async () => [
      {
        status: "active",
        download:
          "https://example.test/packages/simplesmoothsafe-pptb-audit-matrix-0.2.2/simplesmoothsafe-pptb-audit-matrix-0.2.2.tar.gz",
        tool_analytics: { mau: 3, downloads: 8, rating: 4 },
        tool_maturity: { status: "unverified" },
      },
    ],
    point: async (pkg, window) => (pkg.endsWith("audit-matrix") && window.id === "2026-09" ? 11 : 0),
    latest: async () => "0.2.2",
  });
  assert.equal(snapshot.windows.length, 1);
  const audit = snapshot.catalog.find((row) => row.name === "Audit Config Matrix");
  assert.equal(audit.listed, true);
  assert.equal(audit.analytics.mau, 3);
  assert.equal(snapshot.catalog.filter((row) => row.listed).length, 1);
  assert.deepEqual(
    snapshot.npm.map((row) => row.counts[0]),
    [0, 0, 0, 0, 0, 0, 11],
  );
  const markdown = renderSnapshot(snapshot);
  assert.match(markdown, /1\/3 \(rating\)/);
  assert.match(markdown, /Ainda fora do catálogo: Solution XRay, EnvVar & ConnRef Matrix/);
});

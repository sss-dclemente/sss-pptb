#!/usr/bin/env node
import { pathToFileURL } from "node:url";

/**
 * Monthly adoption snapshot for the seven @simplesmoothsafe/pptb-* tools.
 *
 * Reads two public aggregate sources and prints a Markdown section. It does
 * not send telemetry, store identifiers, call authenticated APIs, or write
 * files. npm totals count tarball requests (CI, mirrors, PPTB intake), not
 * people. Marketplace MAU, downloads and rating come from the public PPTB
 * catalog, which already publishes those three numbers per listed tool.
 *
 *   node scripts/adoption-snapshot.mjs
 *   node scripts/adoption-snapshot.mjs --date 2026-10-13
 */

export const NPM_DOWNLOADS = "https://api.npmjs.org/downloads/point";
export const NPM_REGISTRY = "https://registry.npmjs.org";
export const PPTB_CATALOG = "https://www.powerplatformtoolbox.com/api/tools";

/** Marketplace Verified thresholds (2 of 3). Rating stands in for "≥1 review ≥3" because the public catalog exposes one rating number, not a review count. */
export const THRESHOLDS = { mau: 10, downloads: 50, rating: 3 };

export const PACKAGES = [
  { name: "Solution XRay", npm: "@simplesmoothsafe/pptb-solution-xray", slug: "simplesmoothsafe-pptb-solution-xray" },
  { name: "EnvVar & ConnRef Matrix", npm: "@simplesmoothsafe/pptb-envvar-matrix", slug: "simplesmoothsafe-pptb-envvar-matrix" },
  { name: "Access Checker", npm: "@simplesmoothsafe/pptb-access-checker", slug: "simplesmoothsafe-pptb-access-checker" },
  { name: "Dependency Cleaner", npm: "@simplesmoothsafe/pptb-dependency-cleaner", slug: "simplesmoothsafe-pptb-dependency-cleaner" },
  { name: "D365 Apps Matrix", npm: "@simplesmoothsafe/pptb-d365-apps", slug: "simplesmoothsafe-pptb-d365-apps" },
  { name: "Offboarding Wizard", npm: "@simplesmoothsafe/pptb-offboarding-wizard", slug: "simplesmoothsafe-pptb-offboarding-wizard" },
  { name: "Audit Config Matrix", npm: "@simplesmoothsafe/pptb-audit-matrix", slug: "simplesmoothsafe-pptb-audit-matrix" },
];

const DAY = 24 * 60 * 60 * 1000;

function utc(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) throw new Error(`Expected YYYY-MM-DD, got ${iso}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY);
}

/**
 * Two windows ending the day before `asOf`: the previous complete calendar
 * month, then the current month through yesterday. The second window is
 * omitted on the 1st, when yesterday still belongs to the previous month.
 * npm's downloads API lags by about a day, so the read date itself is excluded.
 */
export function monthWindows(asOfIso) {
  const asOf = utc(asOfIso);
  const yesterday = addDays(asOf, -1);
  const firstOfThis = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  const lastOfPrev = addDays(firstOfThis, -1);
  const firstOfPrev = new Date(Date.UTC(lastOfPrev.getUTCFullYear(), lastOfPrev.getUTCMonth(), 1));
  const windows = [
    {
      id: iso(firstOfPrev).slice(0, 7),
      start: iso(firstOfPrev),
      end: iso(lastOfPrev),
      partial: false,
    },
  ];
  const start = iso(firstOfThis);
  const end = iso(yesterday);
  if (start <= end) {
    windows.push({ id: `${start}…${end}`, start, end, partial: true });
  }
  return windows;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function usageSignals(analytics) {
  if (!analytics || typeof analytics !== "object") return null;
  const mau = finiteNumber(analytics.mau);
  const downloads = finiteNumber(analytics.downloads);
  const rating = finiteNumber(analytics.rating);
  const met = [];
  if (mau !== null && mau >= THRESHOLDS.mau) met.push("MAU");
  if (downloads !== null && downloads >= THRESHOLDS.downloads) met.push("downloads");
  if (rating !== null && rating >= THRESHOLDS.rating) met.push("rating");
  return {
    mau,
    downloads,
    rating,
    met: met.length,
    label: met.length ? `${met.length}/3 (${met.join(", ")})` : "0/3",
  };
}

function slugPattern(slug) {
  return new RegExp(`/packages/${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d`);
}

/**
 * Match catalog rows to our packages by the package id embedded in the public
 * download URL. A display-name collision with another publisher does not match.
 */
export function matchCatalog(tools, packages = PACKAGES) {
  if (!Array.isArray(tools)) throw new Error("PPTB catalog was not a list");
  const found = new Map();
  for (const tool of tools) {
    const url = typeof tool?.download === "string" ? tool.download : "";
    for (const pkg of packages) {
      if (!slugPattern(pkg.slug).test(url)) continue;
      if (found.has(pkg.slug)) {
        throw new Error(`More than one catalog row matched ${pkg.slug}`);
      }
      found.set(pkg.slug, tool);
    }
  }
  return packages.map((pkg) => ({ pkg, tool: found.get(pkg.slug) ?? null }));
}

function cell(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function gapLine(name, signals) {
  const pending = [];
  if (signals.mau === null || signals.mau < THRESHOLDS.mau) pending.push(`MAU ${cell(signals.mau)}/${THRESHOLDS.mau}`);
  if (signals.downloads === null || signals.downloads < THRESHOLDS.downloads) {
    pending.push(`downloads ${cell(signals.downloads)}/${THRESHOLDS.downloads}`);
  }
  if (signals.rating === null || signals.rating < THRESHOLDS.rating) {
    pending.push(`rating ${cell(signals.rating)} (limiar ${THRESHOLDS.rating})`);
  }
  return `- ${name}: ${signals.label} — ${pending.join("; ")}`;
}

export function renderSnapshot({ asOf, windows, catalog, npm }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`Bad asOf ${asOf}`);
  const npmEnd = windows[windows.length - 1].end;
  const header = [
    `### ${asOf}`,
    "",
    `Leitura de contagens agregadas já públicas. Sem telemetria nas ferramentas. O npm fecha os totais no dia anterior (até ${npmEnd}).`,
    "",
    "#### Marketplace PPTB",
    "",
    "Catálogo público `GET https://www.powerplatformtoolbox.com/api/tools`. MAU, downloads e rating são os do marketplace. O badge Verified pede 2 de 3: MAU ≥ 10, downloads ≥ 50, pelo menos uma avaliação ≥ 3. O campo público `rating` é um número só; `0` significa que não há avaliação visível e não conta como review.",
    "",
    "| Ferramenta | Estado | MAU | Downloads | Rating | Maturidade | Sinais |",
    "|---|---|---:|---:|---:|---|---|",
  ];

  const gaps = [];
  const unlisted = [];
  for (const row of catalog) {
    const signals = usageSignals(row.analytics);
    if (!row.listed || !signals) {
      unlisted.push(row.name);
      header.push(`| ${row.name} | não listada | — | — | — | — | — |`);
      continue;
    }
    const estado = row.status && row.status !== "active" ? `listada (${row.status})` : "listada";
    header.push(
      `| ${row.name} | ${estado} | ${cell(signals.mau)} | ${cell(signals.downloads)} | ${cell(signals.rating)} | ${cell(row.maturity)} | ${signals.label} |`,
    );
    gaps.push(gapLine(row.name, signals));
  }
  if (unlisted.length) gaps.push(`- Ainda fora do catálogo: ${unlisted.join(", ")}.`);

  const monthHeaders = windows.map((w) => w.id).join(" | ");
  const align = windows.map(() => "---:").join(" | ");
  const lines = [
    ...header,
    "",
    ...gaps,
    "",
    "#### Downloads npm",
    "",
    "API pública `https://api.npmjs.org/downloads`. Cada número conta um pedido de tarball, incluindo CI, mirrors e o `npm pack` do intake do PPTB. Não são pessoas e não entram no limiar de MAU. Não repetir instalações para fazer subir estes números.",
    "",
    `| Pacote | npm latest | ${monthHeaders} |`,
    `|---|---| ${align} |`,
  ];

  const totals = windows.map(() => 0);
  for (const row of npm) {
    row.counts.forEach((count, i) => {
      totals[i] += count;
    });
    lines.push(`| \`${row.npm}\` | ${row.latest} | ${row.counts.join(" | ")} |`);
  }
  lines.push(`| **Total** | | ${totals.map((n) => `**${n}**`).join(" | ")} |`);
  lines.push("");
  return lines.join("\n");
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "sss-pptb-adoption-snapshot" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function npmPoint(pkg, window) {
  const url = `${NPM_DOWNLOADS}/${window.start}:${window.end}/${encodeURIComponent(pkg)}`;
  const body = await getJson(url);
  if (typeof body.downloads !== "number") throw new Error(`npm downloads missing for ${pkg} ${window.id}`);
  return body.downloads;
}

async function npmLatest(pkg) {
  const body = await getJson(`${NPM_REGISTRY}/${encodeURIComponent(pkg)}`);
  const latest = body?.["dist-tags"]?.latest;
  if (typeof latest !== "string" || !latest) throw new Error(`npm latest missing for ${pkg}`);
  return latest;
}

export async function collectSnapshot(asOf, fetchers = {}) {
  const windows = monthWindows(asOf);
  const catalogGet = fetchers.catalog ?? (() => getJson(PPTB_CATALOG));
  const point = fetchers.point ?? npmPoint;
  const latestOf = fetchers.latest ?? npmLatest;
  const tools = await catalogGet();
  const matched = matchCatalog(tools);
  const catalog = matched.map(({ pkg, tool }) => ({
    name: pkg.name,
    listed: Boolean(tool),
    status: tool?.status ?? null,
    maturity: tool?.tool_maturity?.status ?? null,
    analytics: tool?.tool_analytics ?? null,
  }));
  const npm = [];
  for (const pkg of PACKAGES) {
    const counts = [];
    for (const window of windows) counts.push(await point(pkg.npm, window));
    npm.push({ npm: pkg.npm, latest: await latestOf(pkg.npm), counts });
  }
  return { asOf, windows, catalog, npm };
}

function argDate(argv, fallback) {
  const index = argv.indexOf("--date");
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("--date expects YYYY-MM-DD");
  }
  return value;
}

async function main() {
  const asOf = argDate(process.argv.slice(2), new Date().toISOString().slice(0, 10));
  const snapshot = await collectSnapshot(asOf);
  process.stdout.write(renderSnapshot(snapshot));
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

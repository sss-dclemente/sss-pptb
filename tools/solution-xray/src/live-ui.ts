/**
 * Live mode panel (sidebar): solution picker for the connected environment, ExportSolution with spinner + cancel,
 * and "Check zip against environment" = Compare (environment → zip) + Upgrade risk with the environment as baseline.
 * Without a connection the panel is disabled with a hint; nothing here runs and offline use is unchanged.
 */

import "./live.css";
import { dlog, errorInfo } from "../../_shared/debug";
import { badge, h } from "../../_shared/dom";
import { dataverse, getConnections, notify, onConnectionChange, type LiveConnection } from "../../_shared/host";
import { diffSolutions } from "./xray/diff";
import { decodeExportResult, describeShape, envTag, exportRequest, LARGE_EXPORT_BYTES, setEnvTag, SLOW_EXPORT_MS, SOLUTION_COLUMNS, toEnvSolutions, type EnvSolution } from "./xray/live";
import { parseSolutionZip } from "./xray/parse";
import { scoreRisk } from "./xray/risk";
import type { SolutionInfo } from "./xray/types";

export interface LiveContext {
  /** Everything loaded (offline zips and environment exports). */
  solutions: () => SolutionInfo[];
  /** Add a parsed solution to the sidebar and re-render. */
  add: (s: SolutionInfo) => void;
  /** Point Compare (A = env, B = zip) and Upgrade risk (zip over env) at the pair and open Compare. */
  check: (env: SolutionInfo, zip: SolutionInfo) => void;
  openTab: (tab: string) => void;
}

export interface LiveUi {
  /** Re-sync the zip picker and summary with the loaded solutions (call after every sidebar render). */
  refresh: () => void;
}

const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

export function mountLive(root: HTMLElement, ctx: LiveContext): LiveUi {
  let conn: LiveConnection | null = null;
  let envSolutions: EnvSolution[] = [];
  let listError: string | null = null;
  let listLoading = false;
  /** Bumped by Cancel and by every new export: a result whose token is stale is discarded. */
  let token = 0;
  let busy: { label: string; started: number; timer: number } | null = null;
  let lastCheck: { env: SolutionInfo; zip: SolutionInfo } | null = null;

  const connLine = h("p", { class: "caption live-conn", id: "live-conn" });
  const solSel = h("select", { id: "live-solution", "aria-label": "Deployed solution" });
  const managed = h("input", { type: "checkbox", id: "live-managed" });
  const zipSel = h("select", { id: "live-zip", "aria-label": "Zip to check" });
  const btnCheck = h("button", { id: "live-check", class: "btn btn-primary btn-sm", type: "button" }, "Check zip against environment");
  const btnLoad = h("button", { id: "live-load", class: "btn btn-ghost btn-sm", type: "button", title: "Export the deployed solution and add it to the list without comparing" }, "Load only");
  const btnRefresh = h("button", { id: "live-refresh", class: "btn btn-ghost btn-sm", type: "button", title: "Reload the solution list" }, "↻");
  const busyText = h("span", { id: "live-busy-text" });
  const btnCancel = h("button", { id: "live-cancel", class: "btn btn-ghost btn-sm", type: "button" }, "Cancel");
  const busyBox = h("div", { id: "live-busy", class: "live-busy", role: "status", hidden: true }, h("span", { class: "spinner", "aria-hidden": "true" }), busyText, btnCancel);
  const hint = h("p", { class: "caption live-hint", id: "live-hint" });
  const result = h("div", { id: "live-result", class: "live-result" });

  root.replaceChildren(
    h("h2", { class: "eyebrow" }, "Environment"),
    connLine,
    h("label", { class: "live-field" }, h("span", { class: "caption" }, "Deployed solution"), h("span", { class: "live-row" }, solSel, btnRefresh)),
    h("label", { class: "live-field" }, h("span", { class: "caption" }, "Zip to check"), zipSel),
    h("label", { class: "check caption", title: "Off: export as unmanaged, the solution as it is in the environment. On: package it as managed." }, managed, " Export as managed"),
    h("div", { class: "actions" }, btnCheck, btnLoad),
    busyBox,
    hint,
    result,
  );

  const offline = (): SolutionInfo[] => ctx.solutions().filter((s) => !envTag(s));
  const pickedEnv = (): EnvSolution | undefined => envSolutions.find((s) => s.uniqueName === solSel.value);
  /** Stable option values, so the zip pick survives loads and removals. */
  const zipIds = new WeakMap<SolutionInfo, string>();
  let nextZipId = 1;
  const zipId = (s: SolutionInfo): string => zipIds.get(s) ?? (zipIds.set(s, `z${nextZipId++}`), zipIds.get(s)!);
  const pickedZip = (): SolutionInfo | undefined => offline().find((z) => zipId(z) === zipSel.value);

  /** An export of this solution from this connection (same managed flag) still in the sidebar: reused, not exported again. */
  const loadedExport = (name: string, asManaged: boolean): SolutionInfo | undefined =>
    conn
      ? [...ctx.solutions()].reverse().find((s) => {
          const t = envTag(s);
          return t && t.connectionId === conn!.conn.id && t.managedExport === asManaged && s.uniqueName.toLowerCase() === name.toLowerCase();
        })
      : undefined;

  function fillSolutions(): void {
    const prev = solSel.value;
    solSel.replaceChildren();
    if (!conn) solSel.append(h("option", { value: "" }, "No connection"));
    else if (listLoading) solSel.append(h("option", { value: "" }, "Loading…"));
    else if (listError) solSel.append(h("option", { value: "" }, "Could not load solutions"));
    else if (!envSolutions.length) solSel.append(h("option", { value: "" }, "No solutions"));
    else {
      const unmanaged = envSolutions.filter((s) => !s.managed);
      const mgd = envSolutions.filter((s) => s.managed);
      const opt = (s: EnvSolution, disabled = false) => h("option", { value: s.uniqueName, disabled }, `${s.friendlyName} v${s.version}`);
      solSel.append(...unmanaged.map((s) => opt(s)));
      if (mgd.length) solSel.append(h("optgroup", { label: "Managed (cannot be exported)" }, ...mgd.map((s) => opt(s, true))));
      if (unmanaged.some((s) => s.uniqueName === prev)) solSel.value = prev;
      else {
        // first pick: a deployed solution matching a loaded zip, else the first exportable one
        const names = new Set(offline().map((z) => z.uniqueName.toLowerCase()));
        const match = unmanaged.find((s) => names.has(s.uniqueName.toLowerCase()));
        solSel.value = (match ?? unmanaged[0])?.uniqueName ?? "";
      }
    }
  }

  function fillZips(): void {
    const zips = offline();
    const prevZip = pickedZip();
    zipSel.replaceChildren();
    if (!zips.length) zipSel.append(h("option", { value: "" }, "Add a zip first"));
    zips.forEach((z) => zipSel.append(h("option", { value: zipId(z) }, `${z.displayName || z.uniqueName} v${z.version} (${z.managed ? "managed" : "unmanaged"})`)));
    const env = pickedEnv();
    // keep the user's pick; else the last loaded zip with the deployed solution's unique name; else the last zip
    let i = prevZip ? zips.indexOf(prevZip) : -1;
    if (i < 0 && env) i = zips.map((z) => z.uniqueName.toLowerCase()).lastIndexOf(env.uniqueName.toLowerCase());
    if (i < 0) i = zips.length - 1;
    if (i >= 0) zipSel.value = zipId(zips[i]);
  }

  function update(): void {
    const env = pickedEnv();
    const zip = pickedZip();
    connLine.replaceChildren(conn ? h("span", {}, "Connected: ", h("strong", {}, conn.conn.name)) : "Not connected");
    connLine.title = conn?.conn.url ?? "";
    const off = !conn || !!busy;
    solSel.disabled = off || listLoading;
    btnRefresh.disabled = off || listLoading;
    managed.disabled = off;
    zipSel.disabled = !!busy || !offline().length;
    btnLoad.disabled = off || !env;
    btnCheck.disabled = off || !env || !zip;
    root.classList.toggle("is-disabled", !conn);

    let text: string;
    if (!conn) text = "Connect to an environment in ToolBox to check a zip against what is deployed there. Offline analysis needs no connection.";
    else if (listError) text = `Could not list solutions: ${listError}`;
    else if (!envSolutions.some((s) => !s.managed) && !listLoading) text = "No unmanaged solution to export here. Managed solutions cannot be exported from an environment.";
    else if (!zip) text = "Add the zip you plan to import, then check it against the deployed solution.";
    else if (env && zip.uniqueName.toLowerCase() !== env.uniqueName.toLowerCase()) text = `Different unique names (${env.uniqueName} vs ${zip.uniqueName}): the check still runs, but it compares two different solutions.`;
    else text = "Exports the deployed solution (read-only). Large solutions can take minutes and tens of MB.";
    hint.textContent = text;

    // the last check's summary stays while both solutions are still loaded
    if (lastCheck && !(ctx.solutions().includes(lastCheck.env) && ctx.solutions().includes(lastCheck.zip))) lastCheck = null;
    renderResult();
  }

  function renderResult(): void {
    result.replaceChildren();
    if (!lastCheck) return;
    const { env, zip } = lastCheck;
    const d = diffSolutions(env, zip);
    const rows = d.entries.filter((e) => e.category !== "Root component"); // the Compare tab hides root rows by default
    const n = (c: string) => rows.filter((e) => e.change === c).length;
    const r = scoreRisk(zip, env);
    const kind = r.band === "Low" ? "ok" : r.band === "Medium" ? "warn" : "bad";
    const open = (tab: string, text: string) => {
      const b = h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-open": tab }, text);
      b.addEventListener("click", () => ctx.openTab(tab));
      return b;
    };
    result.append(
      h("p", { class: "caption" }, `${zip.uniqueName} v${zip.version} over ${env.uniqueName} v${env.version} in ${envTag(env)?.connectionName ?? "environment"}`),
      h(
        "div",
        { class: "chips" },
        badge(d.versionOrder === "upgrade" ? "upgrade" : d.versionOrder === "same" ? "same version" : d.versionOrder === "downgrade" ? "downgrade" : "version n/a", d.versionOrder === "upgrade" ? "ok" : d.versionOrder === "downgrade" ? "bad" : d.versionOrder === "same" ? "warn" : "neutral"),
        badge(`+${n("added")}`, "ok"),
        badge(`~${n("changed")}`, "warn"),
        badge(`-${n("removed")}`, "bad"),
        badge(`risk ${r.score} ${r.band}`, kind),
      ),
      h("div", { class: "actions" }, open("compare", "Open Compare"), open("risk", "Open Upgrade risk")),
    );
  }

  async function loadList(): Promise<void> {
    const api = dataverse();
    if (!conn || !api) return;
    listLoading = true;
    listError = null;
    fillSolutions();
    update();
    try {
      const res = await api.getSolutions(SOLUTION_COLUMNS);
      envSolutions = toEnvSolutions(res?.value);
      dlog("info", "live", `solutions listed: ${envSolutions.length} shown of ${res?.value?.length ?? 0}`);
    } catch (e) {
      envSolutions = [];
      listError = (e as Error)?.message ?? String(e);
      dlog("error", "live", "getSolutions failed", errorInfo(e));
    }
    listLoading = false;
    fillSolutions();
    fillZips();
    update();
  }

  async function refreshConnection(): Promise<void> {
    const list = await getConnections();
    const next = dataverse() ? (list.find((c) => c.target === "primary") ?? null) : null;
    const changed = next?.conn.id !== conn?.conn.id;
    conn = next;
    if (changed) {
      envSolutions = [];
      listError = null;
      dlog("info", "live", conn ? `connection: ${conn.conn.name}` : "no connection");
      if (conn) await loadList();
    }
    fillSolutions();
    update();
  }

  function setBusy(label: string | null): void {
    if (busy) window.clearInterval(busy.timer);
    busy = null;
    if (label) {
      const started = Date.now();
      const tick = () => {
        const ms = Date.now() - started;
        busyText.textContent = `${label} ${Math.round(ms / 1000)} s${ms > SLOW_EXPORT_MS ? " · large solutions can take several minutes" : ""}`;
      };
      busy = { label, started, timer: window.setInterval(tick, 1000) };
      tick();
    }
    busyBox.hidden = !busy;
    update();
  }

  /** Export + parse, or the copy already loaded. Returns null when cancelled or failed (already reported). */
  async function getEnvSolution(env: EnvSolution): Promise<SolutionInfo | null> {
    const asManaged = managed.checked;
    const cached = loadedExport(env.uniqueName, asManaged);
    if (cached) {
      dlog("info", "live", `reusing loaded export of ${env.uniqueName}`);
      return cached;
    }
    const api = dataverse();
    const c = conn;
    if (!api || !c) return null;
    const mine = ++token;
    setBusy(`Exporting ${env.uniqueName}…`);
    try {
      const res = await api.execute(exportRequest(env.uniqueName, asManaged));
      if (mine !== token) {
        dlog("info", "live", `export of ${env.uniqueName} finished after cancel: discarded`);
        return null;
      }
      dlog("info", "live", "ExportSolution result shape", describeShape(res));
      const bytes = decodeExportResult(res);
      dlog("info", "live", `ExportSolutionFile decoded: ${bytes.length} bytes`);
      if (bytes.length > LARGE_EXPORT_BYTES) await notify("Large export", `${env.uniqueName}: ${mb(bytes.length)}; parsing may take a while.`, "warning");
      busyText.textContent = `Reading ${env.uniqueName} (${mb(bytes.length)})…`;
      const fileName = `${env.uniqueName}_${env.version.replace(/\./g, "_")}${asManaged ? "_managed" : ""}.zip`;
      const info = await parseSolutionZip(bytes, fileName);
      if (mine !== token) return null;
      setEnvTag(info, { connectionId: c.conn.id, connectionName: c.conn.name, url: c.conn.url, managedExport: asManaged });
      ctx.add(info);
      if (info.warnings.length) await notify("Loaded with warnings", `${env.uniqueName}: ${info.warnings[0]}`, "warning");
      return info;
    } catch (e) {
      if (mine !== token) return null;
      dlog("error", "live", `export of ${env.uniqueName} failed`, errorInfo(e));
      await notify("Export failed", `${env.uniqueName}: ${(e as Error)?.message ?? String(e)}`, "error");
      return null;
    } finally {
      if (mine === token) setBusy(null);
    }
  }

  btnCancel.addEventListener("click", () => {
    token++; // the host call cannot be aborted: its result is dropped when it arrives
    dlog("info", "live", "export cancelled by user");
    setBusy(null);
    void notify("Export cancelled", "The result will be discarded if it still arrives.", "info");
  });
  btnRefresh.addEventListener("click", () => void loadList());
  solSel.addEventListener("change", () => {
    fillZips();
    update();
  });
  zipSel.addEventListener("change", update);
  btnLoad.addEventListener("click", async () => {
    const env = pickedEnv();
    if (env) await getEnvSolution(env);
  });
  btnCheck.addEventListener("click", async () => {
    const env = pickedEnv();
    const zip = pickedZip();
    if (!env || !zip) return;
    const live = await getEnvSolution(env);
    if (!live || !ctx.solutions().includes(zip)) return;
    lastCheck = { env: live, zip };
    ctx.check(live, zip);
    update();
  });

  onConnectionChange(() => void refreshConnection());
  fillSolutions();
  fillZips();
  update();
  void refreshConnection();

  return {
    refresh: () => {
      fillZips();
      update();
    },
  };
}

/**
 * Post-import tab: reads an import job log (importjob.data XML) from a file, pasted text or, with a connection,
 * the environment's recent import jobs (read-only queryData), and lists component results failures first.
 * Self-contained: main.ts only mounts it and calls renderPostImport() when the tab or the loaded zips change.
 */
import { $, badge, card, emptyState, filteredEmpty, foldCard, h, shownOf, table, type BadgeKind } from "../../_shared/dom";
import { dataverse, getConnections, notify, onConnectionChange, openText, saveText } from "../../_shared/host";
import {
  countByType,
  importJobCsv,
  isProblem,
  linkToInventory,
  parseImportJob,
  topErrorCodes,
  type ImportComponent,
  type ImportJob,
  type ImportResult,
} from "./xray/importjob";
import type { SolutionInfo } from "./xray/types";

export interface PostImportHost {
  /** Zips currently loaded (for linking failed components to their inventory entry). */
  solutions: () => SolutionInfo[];
  /** Open the Inventory tab on `s` searching for `name`. */
  showInInventory: (s: SolutionInfo, name: string) => void;
}

/** Read-only: the 20 most recent import jobs with their log. */
export const IMPORT_JOBS_QUERY = "importjobs?$select=importjobid,solutionname,progress,completedon,data&$orderby=createdon desc&$top=20";

interface LiveJob {
  importjobid: string;
  solutionname: string | null;
  progress: number | null;
  completedon: string | null;
  data: string | null;
}

let host: PostImportHost;
let job: ImportJob | null = null;
let source = "";
let error = "";
let liveJobs: LiveJob[] = [];

const RESULT_KIND: Record<ImportResult, BadgeKind> = { failure: "bad", warning: "warn", success: "ok", unknown: "neutral" };
const resultBadge = (r: ImportResult): HTMLElement => badge(r, RESULT_KIND[r]);

function load(xml: string, from: string): void {
  try {
    job = parseImportJob(xml);
    source = from;
    error = "";
  } catch (e) {
    error = `${from}: ${(e as Error).message}`;
    void notify("Could not read import job log", error, "error");
  }
  renderPostImport();
}

/** Rows the table (and the exports) show: the result filter and the search. */
function visible(j: ImportJob) {
  const show = $<HTMLSelectElement>("#pi-show").value === "all" ? "all" : "problems";
  const raw = $<HTMLInputElement>("#pi-q").value.trim();
  const q = raw.toLowerCase();
  const rows = j.components.filter(
    (c) => (show === "all" || isProblem(c)) && (!q || [c.name, c.key, c.type, c.errorCode, c.errorText].some((t) => t.toLowerCase().includes(q))),
  );
  return { filter: { show, search: raw }, rows };
}

const fileBase = (j: ImportJob): string => {
  const n = j.solution ? `${j.solution.uniqueName}${j.solution.version ? `-${j.solution.version}` : ""}` : "importjob";
  return n.replace(/[^\w.-]+/g, "_");
};

export function renderPostImport(): void {
  const body = $("#pi-body");
  body.replaceChildren();
  $("#pi-export").toggleAttribute("disabled", !job);
  $("#pi-export-csv").toggleAttribute("disabled", !job);
  if (error) body.append(h("div", { class: "warnings" }, h("div", {}, error)));
  if (!job) {
    body.append(emptyState("No import job log", "Open or paste an import job's data XML (<importexportxml>, the importjob.data column). With a connection, load one of the environment's recent import jobs."));
    return;
  }
  const j = job;
  if (j.warnings.length) body.append(h("div", { class: "warnings" }, ...j.warnings.map((w) => h("div", {}, w))));

  const n = (r: ImportResult) => j.components.filter((c) => c.result === r).length;
  const s = j.solution;
  body.append(
    card(
      "Import job",
      h(
        "dl",
        { class: "kv" },
        h("div", {}, h("dt", {}, "Source"), h("dd", {}, source)),
        h("div", {}, h("dt", {}, "Solution"), h("dd", {}, s ? `${s.displayName}${s.displayName !== s.uniqueName ? ` (${s.uniqueName})` : ""}` : "?")),
        s?.version ? h("div", {}, h("dt", {}, "Version"), h("dd", {}, s.version)) : null,
        s && s.managed !== null ? h("div", {}, h("dt", {}, "Package"), h("dd", {}, s.managed ? "Managed" : "Unmanaged")) : null,
        h("div", {}, h("dt", {}, "Solution result"), h("dd", {}, s ? resultBadge(s.result) : badge("n/a", "neutral"))),
        s && (s.errorCode || s.errorText) ? h("div", {}, h("dt", {}, "Solution error"), h("dd", {}, [s.errorCode, s.errorText].filter(Boolean).join(": "))) : null,
        j.progress ? h("div", {}, h("dt", {}, "Progress"), h("dd", {}, `${j.progress}%`)) : null,
        h(
          "div",
          {},
          h("dt", {}, "Components"),
          h("dd", {}, h("div", { class: "chips pi-totals" }, badge(`${n("failure")} failed`, "bad"), badge(`${n("warning")} warnings`, "warn"), badge(`${n("success")} succeeded`, "ok"), n("unknown") ? badge(`${n("unknown")} other`, "neutral") : null)),
        ),
      ),
    ),
  );

  const types = countByType(j.components);
  body.append(
    foldCard(
      "Results by type",
      types.length,
      table(
        ["Type", "#Total", "#Failed", "#Warnings", "#Succeeded"],
        types.map((t) => [t.type, String(t.total), String(t.failure), String(t.warning), String(t.success)]),
      ),
      true,
      { key: "pi:types" },
    ),
  );

  const codes = topErrorCodes(j.components);
  if (codes.length) {
    body.append(
      foldCard(
        "Top error codes",
        codes.length,
        table(
          ["Error code", "#Count", "Example"],
          codes.map((c) => [h("span", { class: "mono" }, c.code), String(c.count), c.sample]),
        ),
        true,
        { key: "pi:codes" },
      ),
    );
  }

  const { rows, filter } = visible(j);
  const links = linkToInventory(j, host.solutions());
  const linkCell = (c: ImportComponent) => {
    const l = links.get(c);
    if (!l) return "";
    const b = h("button", { class: "btn btn-ghost btn-sm pi-link", type: "button", title: `Show ${l.name} in the Inventory of ${l.solution.uniqueName}` }, "Inventory");
    b.addEventListener("click", () => host.showInInventory(l.solution, l.name));
    return b;
  };
  const headers = ["Component", "Type", "Result", "Error code", "Error text", ...(links.size ? ["Zip"] : [])];
  const content = rows.length
    ? table(
        headers,
        rows.map((c) => [
          h("div", {}, h("div", {}, c.name), c.key !== c.name ? h("div", { class: "caption mono" }, c.key) : null),
          c.type,
          resultBadge(c.result),
          c.errorCode ? h("span", { class: "mono pi-code" }, c.errorCode) : "",
          c.errorText,
          ...(links.size ? [linkCell(c)] : []),
        ]),
        (i) => `pi-${rows[i].result}`,
      )
    : j.components.length
    ? filteredEmpty(
        filter.search ? "No components match" : "No failures or warnings",
        filter.search ? `Nothing matches "${filter.search}" with the current filter.` : `All ${j.components.length} components succeeded.`,
        () => {
          $<HTMLSelectElement>("#pi-show").value = "all";
          $<HTMLInputElement>("#pi-q").value = "";
          renderPostImport();
        },
        "Show all",
      )
    : h("p", { class: "caption" }, "The log has no component results.");
  body.append(card("Components", content, h("span", { class: "count-caption" }, shownOf(rows.length, j.components.length, "components"))));
}

async function refreshConnection(): Promise<void> {
  const live = !!dataverse() && (await getConnections()).length > 0;
  $("#pi-live").hidden = !live;
  if (!live) {
    liveJobs = [];
    fillJobs();
  }
}

function fillJobs(): void {
  const sel = $<HTMLSelectElement>("#pi-jobs");
  sel.replaceChildren(h("option", { value: "" }, liveJobs.length ? "Pick an import job…" : "No jobs loaded"));
  liveJobs.forEach((jb, i) => {
    const when = jb.completedon ? jb.completedon.replace("T", " ").replace(/\.\d+Z$|Z$/, "") : "not completed";
    sel.append(h("option", { value: String(i) }, `${jb.solutionname || "(no name)"} · ${when} · ${jb.progress ?? "?"}%`));
  });
  sel.disabled = !liveJobs.length;
}

async function loadLiveJobs(): Promise<void> {
  const dv = dataverse();
  if (!dv) return;
  const btn = $<HTMLButtonElement>("#pi-live-load");
  btn.disabled = true;
  try {
    const res = await dv.queryData(IMPORT_JOBS_QUERY);
    liveJobs = (res.value ?? []).map((r) => ({
      importjobid: String(r.importjobid ?? ""),
      solutionname: (r.solutionname as string | null) ?? null,
      progress: typeof r.progress === "number" ? Math.round(r.progress) : null,
      completedon: (r.completedon as string | null) ?? null,
      data: (r.data as string | null) ?? null,
    }));
    fillJobs();
    if (!liveJobs.length) await notify("No import jobs", "The environment returned no import jobs.", "info");
  } catch (e) {
    await notify("Could not read import jobs", (e as Error).message, "error");
  } finally {
    btn.disabled = false;
  }
}

function pickLiveJob(): void {
  const v = $<HTMLSelectElement>("#pi-jobs").value;
  const jb = v === "" ? undefined : liveJobs[Number(v)];
  if (!jb) return;
  const label = `Import job ${jb.solutionname || jb.importjobid} (${jb.importjobid})`;
  if (!jb.data) {
    error = `${label}: the job has no log data yet (still running, or the log was not kept).`;
    renderPostImport();
    return;
  }
  load(jb.data, label);
}

async function exportFile(name: string, content: string, mime: string): Promise<void> {
  if (await saveText(name, content, mime)) await notify("Exported", name, "success");
}

/** Build the tab's toolbar and body inside #tab-postimport and wire it. Call once, before the first render. */
export function mountPostImport(h0: PostImportHost): void {
  host = h0;
  const panel = $("#tab-postimport");
  const btn = (id: string, text: string, cls = "btn btn-ghost btn-sm") => h("button", { id, class: cls, type: "button" }, text);
  panel.replaceChildren(
    h(
      "div",
      { class: "toolbar" },
      btn("pi-open", "Open log file", "btn btn-primary btn-sm"),
      btn("pi-paste-toggle", "Paste XML"),
      h(
        "span",
        { id: "pi-live", class: "pi-live", hidden: true },
        btn("pi-live-load", "Load recent import jobs"),
        h("select", { id: "pi-jobs", "aria-label": "Import job", disabled: true }, h("option", { value: "" }, "No jobs loaded")),
      ),
      h("label", {}, "Show ", h("select", { id: "pi-show" }, h("option", { value: "problems" }, "Failures and warnings"), h("option", { value: "all" }, "All results"))),
      h("input", { id: "pi-q", type: "search", placeholder: "Filter components…", "aria-label": "Filter components" }),
      btn("pi-export", "Export JSON"),
      btn("pi-export-csv", "Export CSV"),
    ),
    h(
      "div",
      { id: "pi-paste", class: "pi-paste", hidden: true },
      h("textarea", { id: "pi-xml", rows: "8", spellcheck: "false", placeholder: "<importexportxml …>", "aria-label": "Import job XML" }),
      h("div", { class: "pi-paste-actions" }, btn("pi-parse", "Read log", "btn btn-primary btn-sm"), btn("pi-paste-cancel", "Cancel")),
    ),
    h("div", { id: "pi-body", class: "panel-body" }),
  );

  $("#pi-open").addEventListener("click", async () => {
    const f = await openText({ title: "Select an import job log (importjob data XML)", extensions: ["xml", "txt"] });
    if (f) load(f.text, f.name);
  });
  const paste = $("#pi-paste");
  $("#pi-paste-toggle").addEventListener("click", () => {
    paste.hidden = !paste.hidden;
    if (!paste.hidden) $("#pi-xml").focus();
  });
  $("#pi-paste-cancel").addEventListener("click", () => (paste.hidden = true));
  $("#pi-parse").addEventListener("click", () => {
    const ta = $<HTMLTextAreaElement>("#pi-xml");
    load(ta.value, "Pasted XML");
    if (job && !error) {
      ta.value = "";
      paste.hidden = true;
    }
  });
  $("#pi-show").addEventListener("change", renderPostImport);
  $("#pi-q").addEventListener("input", renderPostImport);
  $("#pi-live-load").addEventListener("click", () => void loadLiveJobs());
  $("#pi-jobs").addEventListener("change", pickLiveJob);
  $("#pi-export").addEventListener("click", () => {
    if (!job) return;
    const { filter, rows } = visible(job);
    const payload = { source, solution: job.solution, progress: job.progress, filter, countsByType: countByType(job.components), topErrorCodes: topErrorCodes(job.components), components: rows, warnings: job.warnings };
    void exportFile(`${fileBase(job)}.importjob.json`, JSON.stringify(payload, null, 2), "application/json");
  });
  $("#pi-export-csv").addEventListener("click", () => {
    if (job) void exportFile(`${fileBase(job)}.importjob.csv`, importJobCsv(visible(job).rows), "text/csv");
  });

  void refreshConnection();
  onConnectionChange(() => void refreshConnection());
}

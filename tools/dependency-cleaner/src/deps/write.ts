/**
 * Write path, plan §3: selected findings → prepared plan → ordered operations → execute.
 * Order: membership changes → form/view updates → one PublishXml for the touched tables.
 * RemoveSolutionComponent / AddSolutionComponent are actions with a JSON body, so a guid inside the
 * body is fine through execute (UNVERIFIED in the PPTB host: see README Limitations).
 */
import { fetchForms, fetchViews, type DataverseLike, type FormRecord, type MetaCache, type ViewRecord } from "./fetch";
import { stripForm, stripView } from "./xml";
import { CT, typeName, type Component, type Diagnosis, type Finding, type FixKind, type NamedComponent } from "./types";

export interface Selection {
  finding: Finding;
  fix: FixKind;
}

export interface LeavingComponent {
  component: Component;
  keep: boolean;
  why: string;
}

export interface ShellPlan {
  root: NamedComponent & { behavior: number };
  leaving: LeavingComponent[];
}

export interface FormEdit {
  form: FormRecord;
  after: string;
  removed: string[];
  kept: { name: string; reason: string }[];
  warnings: string[];
}
export interface ViewEdit {
  view: ViewRecord;
  after: { fetchxml: string; layoutxml: string };
  removed: string[];
  warnings: string[];
}

export interface Prepared {
  diagnosis: Diagnosis;
  shells: ShellPlan[];
  removes: NamedComponent[];
  forms: FormEdit[];
  views: ViewEdit[];
  /** selections that produce no operation, with the reason */
  skipped: { name: string; reason: string }[];
}

export type Op =
  | { kind: "remove"; component: NamedComponent; reason: string }
  | { kind: "add"; component: NamedComponent; doNotIncludeSubcomponents: boolean; reason: string }
  | { kind: "update-form"; edit: FormEdit }
  | { kind: "update-view"; edit: ViewEdit }
  | { kind: "publish"; tables: string[] };

export interface OpResult {
  op: Op;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

const named = (c: Component): NamedComponent => ({ type: c.type, id: c.objectId, name: c.name ?? c.objectId, table: c.table });
const reqNames = (f: Finding, type: number): string[] => [...new Set(f.required.filter((r) => r.type === type).map((r) => r.name))];

/** Fetch current form / view XML, compute strips, collect shell subcomponents. */
export async function prepare(api: DataverseLike, meta: MetaCache, diagnosis: Diagnosis, selections: Selection[]): Promise<Prepared> {
  const skipped: Prepared["skipped"] = [];
  const formSel = selections.filter((s) => s.fix === "edit-form");
  const viewSel = selections.filter((s) => s.fix === "edit-view");
  const [forms, views] = await Promise.all([
    formSel.length ? fetchForms(api, formSel.map((s) => s.finding.dependent.id)) : Promise.resolve([] as FormRecord[]),
    viewSel.length ? fetchViews(api, viewSel.map((s) => s.finding.dependent.id)) : Promise.resolve([] as ViewRecord[]),
  ]);

  const formEdits: FormEdit[] = [];
  for (const s of formSel) {
    const form = forms.find((f) => f.id === s.finding.dependent.id);
    if (!form) {
      skipped.push({ name: s.finding.dependent.name, reason: "form not found" });
      continue;
    }
    const protectedCols = await meta.protectedColumns(api, form.table);
    try {
      const r = stripForm(form.formxml, reqNames(s.finding, CT.Attribute), protectedCols, reqNames(s.finding, CT.Entity));
      if (!r.removed.length) skipped.push({ name: form.name, reason: `nothing to strip${r.kept.length ? `: kept ${r.kept.map((k) => `${k.name} (${k.reason})`).join(", ")}` : ""}` });
      else formEdits.push({ form, after: r.xml, removed: r.removed, kept: r.kept, warnings: r.warnings });
    } catch (e) {
      skipped.push({ name: form.name, reason: (e as Error).message });
    }
  }
  const viewEdits: ViewEdit[] = [];
  for (const s of viewSel) {
    const view = views.find((v) => v.id === s.finding.dependent.id);
    if (!view) {
      skipped.push({ name: s.finding.dependent.name, reason: "view not found" });
      continue;
    }
    try {
      const r = stripView(view.fetchxml, view.layoutxml, reqNames(s.finding, CT.Attribute), reqNames(s.finding, CT.Entity));
      if (!r.removed.length) skipped.push({ name: view.name, reason: "nothing to strip" });
      else viewEdits.push({ view, after: { fetchxml: r.fetchxml, layoutxml: r.layoutxml }, removed: r.removed, warnings: r.warnings });
    } catch (e) {
      skipped.push({ name: view.name, reason: (e as Error).message });
    }
  }

  // shells: one per root table, whichever findings asked for it
  const edited = new Set([...formEdits.map((f) => f.form.id), ...viewEdits.map((v) => v.view.id)]);
  const prefix = diagnosis.solution.prefix ? `${diagnosis.solution.prefix}_` : null;
  const shells: ShellPlan[] = [];
  for (const s of selections.filter((x) => x.fix === "shell")) {
    const root = s.finding.fixes.find((f) => f.kind === "shell")?.root;
    if (!root || shells.some((x) => x.root.id === root.id)) continue;
    const rootRow = diagnosis.components.find((c) => c.type === CT.Entity && c.objectId === root.id);
    const selfOwned = new Set(diagnosis.findings.filter((f) => f.dependent.selfOwned).map((f) => f.dependent.id));
    const leaving = diagnosis.components
      .filter((c) => rootRow && c.rootRowId === rootRow.rowId && c.rowId !== rootRow.rowId)
      .map((c): LeavingComponent => {
        const name = (c.name ?? "").toLowerCase();
        if (selfOwned.has(c.objectId)) return { component: c, keep: false, why: "belongs to a managed solution in scope" };
        if (edited.has(c.objectId)) return { component: c, keep: true, why: "edited in this plan" };
        if (prefix && name.startsWith(prefix)) return { component: c, keep: true, why: `your prefix ${prefix}` };
        // forms, views and charts carry display names: decide by owning solution, keep unless a filtered managed solution owns it
        if (c.type === CT.Form || c.type === CT.View || c.type === CT.Chart) {
          if (c.filteredOwner) return { component: c, keep: false, why: `owned by ${c.filteredOwner}` };
          if (c.filteredOwner === null) return { component: c, keep: true, why: "yours: not owned by a filtered managed solution" };
        }
        return { component: c, keep: false, why: "not yours" };
      })
      .sort((a, b) => Number(b.keep) - Number(a.keep) || a.component.type - b.component.type || (a.component.name ?? "").localeCompare(b.component.name ?? ""));
    shells.push({ root: { ...root, behavior: 0 }, leaving });
  }

  // a table both converted to a shell (from any finding) and removed: refuse, the order of the two would decide the result
  const conflicts = selections
    .filter((x) => x.fix === "remove" && x.finding.dependent.type === CT.Entity)
    .map((x) => shells.find((sh) => sh.root.id === x.finding.dependent.id))
    .filter((sh): sh is ShellPlan => !!sh);
  if (conflicts.length)
    throw new Error(
      `Conflicting fixes on table ${conflicts.map((sh) => sh.root.name).join(", ")}: one finding converts it to a shell, another removes it from the solution. Pick one of the two and preview again.`,
    );

  // removes: skip what leaves anyway with a shell conversion
  const shellRootRows = new Set(shells.map((sh) => diagnosis.components.find((c) => c.type === CT.Entity && c.objectId === sh.root.id)?.rowId));
  const removes: NamedComponent[] = [];
  for (const s of selections.filter((x) => x.fix === "remove")) {
    const comp = diagnosis.components.find((c) => c.objectId === s.finding.dependent.id && c.type === s.finding.dependent.type);
    if (comp?.rootRowId && shellRootRows.has(comp.rootRowId)) {
      skipped.push({ name: s.finding.dependent.name, reason: "leaves with the shell conversion of its table" });
      continue;
    }
    if (!removes.some((r) => r.id === s.finding.dependent.id)) removes.push(s.finding.dependent);
  }
  for (const s of selections.filter((x) => x.fix === "report")) skipped.push({ name: s.finding.dependent.name, reason: "report only" });

  return { diagnosis, shells, removes, forms: formEdits, views: viewEdits, skipped };
}

export function buildOps(p: Prepared): Op[] {
  const ops: Op[] = [];
  for (const sh of p.shells) {
    ops.push({ kind: "remove", component: sh.root, reason: `convert ${sh.root.name} to a shell` });
    ops.push({ kind: "add", component: sh.root, doNotIncludeSubcomponents: true, reason: "re-add as shell (no subcomponents)" });
    for (const l of sh.leaving.filter((x) => x.keep)) ops.push({ kind: "add", component: named(l.component), doNotIncludeSubcomponents: false, reason: `keep: ${l.why}` });
  }
  for (const r of p.removes) ops.push({ kind: "remove", component: r, reason: `remove ${typeName(r.type).toLowerCase()}` });
  for (const f of p.forms) ops.push({ kind: "update-form", edit: f });
  for (const v of p.views) ops.push({ kind: "update-view", edit: v });
  const tables = [...new Set([...p.forms.map((f) => f.form.table), ...p.views.map((v) => v.view.table)].filter(Boolean))].sort();
  if (tables.length) ops.push({ kind: "publish", tables });
  // identical membership ops (table roots included) run once
  const seen = new Set<string>();
  return ops.filter((op) => {
    if (op.kind !== "remove" && op.kind !== "add") return true;
    const k = `${op.kind}:${op.component.type}:${op.component.id}:${op.kind === "add" ? op.doNotIncludeSubcomponents : ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function publishXml(tables: string[]): string {
  const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<importexportxml><entities>${tables.map((t) => `<entity>${esc(t)}</entity>`).join("")}</entities></importexportxml>`;
}

export const removeRequest = (c: { id: string; type: number }, solution: string): DataverseAPI.ExecuteRequest => ({
  operationName: "RemoveSolutionComponent",
  operationType: "action",
  parameters: { ComponentId: c.id, ComponentType: c.type, SolutionUniqueName: solution },
});
export const addRequest = (c: { id: string; type: number }, solution: string, doNotIncludeSubcomponents: boolean): DataverseAPI.ExecuteRequest => ({
  operationName: "AddSolutionComponent",
  operationType: "action",
  parameters: { ComponentId: c.id, ComponentType: c.type, SolutionUniqueName: solution, DoNotIncludeSubcomponents: doNotIncludeSubcomponents, AddRequiredComponents: false },
});

/**
 * Run ops in order. The first failure stops the remaining membership and XML ops (restore from the backup),
 * but a PublishXml still runs when a form or view was already updated, so the UI does not keep unpublished edits.
 */
export async function executeOps(api: DataverseLike, ops: Op[], solution: string, onStep?: (i: number, n: number) => void): Promise<OpResult[]> {
  const out: OpResult[] = [];
  let failed = false;
  let xmlWritten = false;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    onStep?.(i, ops.length);
    if (failed && !(op.kind === "publish" && xmlWritten)) {
      out.push({ op, ok: false, skipped: true, error: "not run: an earlier step failed" });
      continue;
    }
    try {
      if (op.kind === "remove") await api.execute(removeRequest(op.component, solution));
      else if (op.kind === "add") await api.execute(addRequest(op.component, solution, op.doNotIncludeSubcomponents));
      else if (op.kind === "update-form") {
        await api.update("systemform", op.edit.form.id, { formxml: op.edit.after });
        xmlWritten = true;
      } else if (op.kind === "update-view") {
        await api.update("savedquery", op.edit.view.id, { fetchxml: op.edit.after.fetchxml, layoutxml: op.edit.after.layoutxml });
        xmlWritten = true;
      } else if (op.kind === "publish") await api.execute({ operationName: "PublishXml", operationType: "action", parameters: { ParameterXml: publishXml(op.tables) } });
      out.push({ op, ok: true });
    } catch (e) {
      failed = true;
      out.push({ op, ok: false, error: (e as Error).message ?? String(e) });
    }
  }
  onStep?.(ops.length, ops.length);
  return out;
}

export function opLabel(op: Op): string {
  switch (op.kind) {
    case "remove":
      return `RemoveSolutionComponent ${typeName(op.component.type)} ${op.component.name}`;
    case "add":
      return `AddSolutionComponent ${typeName(op.component.type)} ${op.component.name}${op.doNotIncludeSubcomponents ? " (DoNotIncludeSubcomponents)" : ""}`;
    case "update-form":
      return `Update form ${op.edit.form.name} (${op.edit.form.table}): formxml`;
    case "update-view":
      return `Update view ${op.edit.view.name} (${op.edit.view.table}): fetchxml + layoutxml`;
    case "publish":
      return `PublishXml ${op.tables.join(", ")}`;
  }
}

// ---------- diff ----------

export interface DiffLine {
  t: " " | "-" | "+" | "…";
  s: string;
}

const pretty = (xml: string): string[] => xml.replace(/>\s*</g, ">\n<").split("\n");

/** Line diff of two XML documents (one tag per line), with `context` unchanged lines around each change. */
export function xmlDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = pretty(before);
  const b = pretty(after);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const mid: DiffLine[] = [];
  if (am.length * bm.length > 4_000_000) {
    mid.push(...am.map((s) => ({ t: "-" as const, s })), ...bm.map((s) => ({ t: "+" as const, s })));
  } else {
    // LCS table over the changed middle only
    const n = am.length;
    const m = bm.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = am[i] === bm[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        mid.push({ t: " ", s: am[i++] });
        j++;
      } else if (j < m && (i >= n || L[i][j + 1] >= L[i + 1][j])) mid.push({ t: "+", s: bm[j++] });
      else mid.push({ t: "-", s: am[i++] });
    }
  }
  const all: DiffLine[] = [...a.slice(0, pre).map((s) => ({ t: " " as const, s })), ...mid, ...a.slice(a.length - suf).map((s) => ({ t: " " as const, s }))];
  const keep = all.map(() => false);
  all.forEach((l, k) => {
    if (l.t !== " ") for (let d = -context; d <= context; d++) if (all[k + d]) keep[k + d] = true;
  });
  const out: DiffLine[] = [];
  all.forEach((l, k) => {
    if (keep[k]) out.push(l);
    else if (out.length === 0 || out[out.length - 1].t !== "…") out.push({ t: "…", s: "" });
  });
  return out;
}

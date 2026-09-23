// Pure XML editors for Dataverse systemform.formxml and savedquery fetchxml/layoutxml.
// Browser-only (DOMParser / XMLSerializer), no dependencies. See docs/DEPENDENCY-CLEANER-PLAN.md §2–§3.

export interface StripResult {
  xml: string;
  removed: string[];
  kept: { name: string; reason: string }[];
  warnings: string[];
}

export interface ViewStripResult {
  fetchxml: string;
  layoutxml: string;
  removed: string[];
  warnings: string[];
}

// ---------- helpers ----------

const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

function parse(xml: string, what: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error(`${what}: invalid XML`);
  return doc;
}

/** Serialize without adding an XML declaration; re-emit the original one if the input had it. */
function serialize(doc: Document, original: string): string {
  const decl = /^﻿?\s*<\?xml[^?]*\?>\s*/.exec(original);
  // Chromium re-emits the parsed declaration (without its trailing newline); other engines don't. Normalize.
  const body = new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^?]*\?>\s*/, "");
  return (decl ? decl[0] : "") + body;
}

const els = (root: Document | Element, tag: string): Element[] => Array.from(root.getElementsByTagName(tag));
const childEls = (el: Element, tag?: string): Element[] =>
  Array.from(el.children).filter((c) => !tag || c.localName === tag);

/** Remove a node together with the whitespace-only text node that precedes it (its indentation). */
function removeNode(n: Element): void {
  const prev = n.previousSibling;
  if (prev && prev.nodeType === 3 && !(prev.nodeValue ?? "").trim()) prev.parentNode?.removeChild(prev);
  n.parentNode?.removeChild(n);
}

/** If a parent lost all its element children, collapse leftover whitespace so it serializes cleanly. */
function tidyEmpty(el: Element): void {
  if (el.children.length === 0 && !(el.textContent ?? "").trim()) while (el.firstChild) el.removeChild(el.firstChild);
}

const closest = (el: Element, tag: string): Element | null => {
  for (let p = el.parentElement; p; p = p.parentElement) if (p.localName === tag) return p;
  return null;
};

const label = (el: Element | null): string => {
  if (!el) return "";
  const lbl = el.getElementsByTagName("label")[0]?.getAttribute("description");
  return lbl || el.getAttribute("name") || el.getAttribute("id") || "";
};

/** Customization prefixes ("msdyn_") of the given logical names. */
const prefixesOf = (names: string[]) =>
  new Set(names.map((n) => /^([a-z0-9]+_)/.exec(n)?.[1]).filter((p): p is string => !!p));

// ---------- forms ----------

/** Remove controls bound to `columns` (logical names, lowercase) from Dataverse systemform.formxml.
 * Never removes columns in `protectedColumns` (primary name, ApplicationRequired) — lists them in `kept`.
 * `tables`: also remove subgrid / quick-view controls targeting these tables. */
export function stripForm(formxml: string, columns: string[], protectedColumns: string[], tables: string[] = []): StripResult {
  const cols = new Set(columns.map(lc));
  const prot = new Set(protectedColumns.map(lc));
  const tbls = new Set(tables.map(lc));
  const removed: string[] = [];
  const kept: { name: string; reason: string }[] = [];
  const warnings: string[] = [];
  const addRemoved = (s: string) => !removed.includes(s) && removed.push(s);
  const addKept = (name: string, reason: string) => !kept.some((k) => k.name === name) && kept.push({ name, reason });

  const doc = parse(formxml, "formxml");
  const removedControlIds = new Set<string>();
  const removedCols = new Set<string>();
  const touchedRows = new Set<Element>();
  const touchedSections = new Set<Element>();

  for (const control of els(doc, "control")) {
    if (!control.parentNode || !doc.documentElement.contains(control)) continue;
    const field = lc(control.getAttribute("datafieldname"));
    let why: string | null = null;
    if (field && cols.has(field)) {
      if (prot.has(field)) {
        addKept(field, "protected: primary name or ApplicationRequired column");
        continue;
      }
      why = field;
    } else if (tbls.size) {
      const params = control.getElementsByTagName("parameters")[0];
      if (params) {
        const target = lc(params.getElementsByTagName("TargetEntityType")[0]?.textContent);
        const qv = els(params, "QuickFormId").map((q) => lc(q.getAttribute("entityname"))).find((t) => tbls.has(t));
        if (target && tbls.has(target)) why = `subgrid ${control.getAttribute("id") ?? "?"} (${target})`;
        else if (qv) why = `quickview ${control.getAttribute("id") ?? "?"} (${qv})`;
      }
    }
    if (!why) continue;

    const cell = closest(control, "cell");
    const row = cell && closest(cell, "row");
    for (const id of [control.getAttribute("id"), control.getAttribute("uniqueid")]) if (id) removedControlIds.add(lc(id));
    if (field && why === field) removedCols.add(field);
    addRemoved(why);
    if (cell) {
      removeNode(cell);
      if (row) touchedRows.add(row);
    } else removeNode(control);
  }

  // Empty rows go; sections that end up without any control go (with a warning); tabs never go.
  for (const row of touchedRows) {
    const section = closest(row, "section");
    if (section) touchedSections.add(section);
    if (childEls(row, "cell").length === 0) {
      const parent = row.parentElement;
      removeNode(row);
      if (parent) tidyEmpty(parent);
    }
  }
  const touchedTabs = new Set<Element>();
  for (const section of touchedSections) {
    const tab = closest(section, "tab");
    if (tab) touchedTabs.add(tab);
    const hasControls = els(section, "row").some((r) => childEls(r, "cell").some((c) => c.getElementsByTagName("control").length > 0));
    if (!hasControls) {
      warnings.push(`Section "${label(section)}"${tab ? ` in tab "${label(tab)}"` : ""} became empty and was removed.`);
      const parent = section.parentElement;
      removeNode(section);
      if (parent) tidyEmpty(parent);
    }
  }
  for (const tab of touchedTabs) {
    if (els(tab, "control").length === 0) warnings.push(`Tab "${label(tab)}" is now empty (kept; remove or hide it by hand).`);
  }

  // PCF / custom controls: drop descriptions of removed controls, warn about others bound to removed columns.
  for (const cd of els(doc, "controlDescription")) {
    const forControl = lc(cd.getAttribute("forControl"));
    if (forControl && removedControlIds.has(forControl)) {
      const parent = cd.parentElement;
      removeNode(cd);
      if (parent) tidyEmpty(parent);
      continue;
    }
    const bound = els(cd, "*")
      .filter((e) => e.children.length === 0)
      .map((e) => lc(e.textContent))
      .find((t) => removedCols.has(t));
    if (bound) warnings.push(`Custom control (controlDescription for ${cd.getAttribute("forControl")}) references removed column ${bound}; review it by hand.`);
  }

  // Events / libraries: warn only.
  for (const ev of els(doc, "event")) {
    const attr = lc(ev.getAttribute("attribute"));
    if (attr && removedCols.has(attr)) {
      const handlers = els(ev, "Handler").map((h) => `${h.getAttribute("libraryName")}:${h.getAttribute("functionName")}`);
      warnings.push(`Event "${ev.getAttribute("name")}" on removed column ${attr} still has handlers${handlers.length ? ` (${handlers.join(", ")})` : ""}; review the form events.`);
    }
  }
  const prefixes = prefixesOf([...removedCols, ...tbls]);
  if (removed.length && prefixes.size) {
    const seen = new Set<string>();
    const libs = [
      ...els(doc, "Library").map((l) => l.getAttribute("name") ?? ""),
      ...els(doc, "Handler").map((h) => h.getAttribute("libraryName") ?? ""),
    ];
    for (const lib of libs) {
      const n = lc(lib);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      if ([...prefixes].some((p) => n.startsWith(p) || n.includes("/" + p)))
        warnings.push(`Form library "${lib}" belongs to the same publisher as removed components; it may still depend on them.`);
    }
  }

  return { xml: removed.length ? serialize(doc, formxml) : formxml, removed, kept, warnings };
}

// ---------- views ----------

/** Remove attributes/conditions/order on `columns` and entire <link-entity name=X> for X in `linkEntities` from
 * savedquery fetchxml, plus matching <cell name=...> from layoutxml (incl. aliased cells "alias.col" of removed link-entities). */
export function stripView(fetchxml: string, layoutxml: string, columns: string[], linkEntities: string[]): ViewStripResult {
  const cols = new Set(columns.map(lc));
  const links = new Set(linkEntities.map(lc));
  const removed: string[] = [];
  const warnings: string[] = [];
  const removedAliases = new Set<string>();
  const keptAliases = new Set<string>();
  let fetchChanged = false;

  let fetchOut = fetchxml;
  if (fetchxml.trim()) {
    const doc = parse(fetchxml, "fetchxml");
    const root = els(doc, "entity")[0];
    const rootOrdersBefore = root ? childEls(root, "order").length : 0;

    // 1. link-entities, outermost first (nested ones go with their parent).
    for (const le of els(doc, "link-entity")) {
      if (!doc.documentElement.contains(le)) continue;
      const name = lc(le.getAttribute("name"));
      const alias = lc(le.getAttribute("alias"));
      if (links.has(name)) {
        if (alias) removedAliases.add(alias);
        for (const inner of els(le, "link-entity")) if (inner.getAttribute("alias")) removedAliases.add(lc(inner.getAttribute("alias")));
        removed.push(`link-entity ${name}${alias ? ` (${alias})` : ""}`);
        removeNode(le);
        fetchChanged = true;
      } else if (alias) keptAliases.add(alias);
    }
    for (const le of els(doc, "link-entity")) {
      for (const a of ["from", "to"]) {
        const v = lc(le.getAttribute(a));
        if (v && cols.has(v)) warnings.push(`link-entity ${le.getAttribute("name")} joins ${a}="${v}", a removed column; the view will break until this join is fixed.`);
      }
    }

    // 2. attributes / orders / conditions on removed columns (or on removed aliases).
    for (const a of els(doc, "attribute")) {
      const n = lc(a.getAttribute("name"));
      if (cols.has(n)) {
        removed.push(`attribute ${n}`);
        removeNode(a);
        fetchChanged = true;
      }
    }
    let ordersRemoved = 0;
    for (const o of els(doc, "order")) {
      const n = lc(o.getAttribute("attribute"));
      const ent = lc(o.getAttribute("entityname"));
      if (cols.has(n) || (ent && removedAliases.has(ent))) {
        removed.push(`order ${ent ? ent + "." : ""}${n}`);
        removeNode(o);
        ordersRemoved++;
        fetchChanged = true;
      }
    }
    const touchedFilters = new Set<Element>();
    let conditionsRemoved = 0;
    for (const c of els(doc, "condition")) {
      const n = lc(c.getAttribute("attribute"));
      const ent = lc(c.getAttribute("entityname"));
      if (cols.has(n) || (ent && removedAliases.has(ent))) {
        removed.push(`condition ${ent ? ent + "." : ""}${n} ${c.getAttribute("operator") ?? ""}`.trim());
        const f = c.parentElement;
        removeNode(c);
        if (f?.localName === "filter") touchedFilters.add(f);
        conditionsRemoved++;
        fetchChanged = true;
      }
    }
    // Drop filters left without conditions or sub-filters, bubbling upward.
    const queue = [...touchedFilters];
    while (queue.length) {
      const f = queue.shift()!;
      if (!f.parentNode) continue;
      if (childEls(f).some((e) => e.localName === "condition" || e.localName === "filter")) continue;
      const parent = f.parentElement;
      removeNode(f);
      if (parent) {
        tidyEmpty(parent);
        if (parent.localName === "filter") queue.push(parent);
      }
    }
    if (conditionsRemoved)
      warnings.push(`${conditionsRemoved} filter condition(s) removed: the view now returns a different (usually larger) set of rows. Review the filter.`);
    if (ordersRemoved && rootOrdersBefore > 0 && root && childEls(root, "order").length === 0)
      warnings.push("The view's only sort order was removed; it will fall back to the default order.");
    if (root && fetchChanged && childEls(root, "attribute").length === 0 && !root.getElementsByTagName("all-attributes").length)
      warnings.push("The root entity has no attributes left in the view.");

    if (fetchChanged) fetchOut = serialize(doc, fetchxml);
  }

  // 3. layoutxml cells.
  let layoutOut = layoutxml;
  if (layoutxml.trim()) {
    const doc = parse(layoutxml, "layoutxml");
    let changed = false;
    for (const cell of els(doc, "cell")) {
      const n = lc(cell.getAttribute("name"));
      if (!n) continue;
      const dot = n.indexOf(".");
      const alias = dot >= 0 ? n.slice(0, dot) : "";
      const col = dot >= 0 ? n.slice(dot + 1) : n;
      const drop = alias ? removedAliases.has(alias) || (keptAliases.has(alias) && cols.has(col)) : cols.has(col);
      if (drop) {
        removed.push(`cell ${n}`);
        const parent = cell.parentElement;
        removeNode(cell);
        if (parent) tidyEmpty(parent);
        changed = true;
      }
    }
    for (const g of els(doc, "grid")) {
      const jump = lc(g.getAttribute("jump"));
      if (jump && cols.has(jump)) warnings.push(`Layout jump column "${jump}" was removed; set another primary column for the grid.`);
    }
    if (changed) layoutOut = serialize(doc, layoutxml);
  }

  return { fetchxml: fetchOut, layoutxml: layoutOut, removed, warnings };
}

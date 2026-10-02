import { mountDebug } from "../../_shared/debug-ui";
import { $, badge, card, emptyState, filteredEmpty, foldAllButtons, foldCard, h, keepFold, shownOf, table, wireTabs, type Child } from "../../_shared/dom";
import { persistControls, type PersistedControls } from "../../_shared/view-state";
import { filesFromDrop, initTheme, inToolbox, notify, pickZips, saveText } from "./host";
import { diffSolutions, type DiffEntry, type SolutionDiff } from "./xray/diff";
import { buildInventory, managedLabel, type InventoryGroup } from "./xray/inventory";
import { computeInstallOrder, latestByName } from "./xray/order";
import { parseSolutionZip } from "./xray/parse";
import { hasPublisherPrefix, scoreRisk } from "./xray/risk";
import type { AttributeInfo, SolutionInfo } from "./xray/types";

// ---------- state ----------
const solutions: SolutionInfo[] = [];
let activeTab = "inventory";
/** Stable per-load id used as <option> value, so selections survive loads and removals. */
const ids = new WeakMap<SolutionInfo, string>();
let nextId = 1;
/** Compare change-type + name filters (hide-root is persisted separately: clearing these must not re-hide root rows). */
let cmpFilters: PersistedControls;
/** Inventory "Find component" search. */
let invFind: PersistedControls;
/** Risk factors whose evidence list the user expanded past the first EVIDENCE_SHOWN items. */
const evidenceOpen = new Set<string>();
const EVIDENCE_SHOWN = 8;
/** Install-order edges ("from→to") whose reasons the user expanded past the first REASONS_SHOWN. */
const reasonsOpen = new Set<string>();
const REASONS_SHOWN = 5;

function idOf(s: SolutionInfo): string {
  let id = ids.get(s);
  if (!id) ids.set(s, (id = `s${nextId++}`));
  return id;
}

function selected(selector: string): SolutionInfo | undefined {
  const v = $<HTMLSelectElement>(selector).value;
  return v ? solutions.find((s) => idOf(s) === v) : undefined;
}

function label(s: SolutionInfo): string {
  return `${s.displayName || s.uniqueName} ${s.version ? `v${s.version}` : ""} (${s.managed ? "managed" : "unmanaged"})`;
}

// ---------- sidebar ----------
function renderSidebar(): void {
  const list = $("#solution-list");
  list.replaceChildren();
  if (!solutions.length) {
    list.append(h("li", { class: "empty" }, "No solutions loaded"));
  }
  solutions.forEach((s) => {
    const remove = h("button", { class: "btn-icon", type: "button", title: "Remove", "aria-label": `Remove ${s.uniqueName}` }, "×");
    remove.addEventListener("click", () => {
      const i = solutions.indexOf(s);
      if (i >= 0) solutions.splice(i, 1);
      renderAll();
    });
    list.append(
      h(
        "li",
        {},
        h("span", { class: "name" }, s.displayName || s.uniqueName),
        remove,
        h(
          "div",
          { class: "meta" },
          badge(managedLabel(s.managedFlag), s.managed ? "ok" : "warn"),
          s.version ? badge(`v${s.version}`, "neutral") : null,
          h("span", { class: "mono" }, s.uniqueName),
          s.warnings.length ? badge(`${s.warnings.length} warning${s.warnings.length > 1 ? "s" : ""}`, "bad") : null,
        ),
      ),
    );
  });

  for (const id of ["#inv-select", "#cmp-a", "#cmp-b", "#risk-select", "#risk-baseline"]) {
    const sel = $<HTMLSelectElement>(id);
    const prev = sel.value;
    sel.replaceChildren();
    if (id === "#risk-baseline") sel.append(h("option", { value: "" }, "none"));
    solutions.forEach((s) => sel.append(h("option", { value: idOf(s) }, label(s))));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  // B defaults to a different solution than A (e.g. after loading zips one at a time)
  const cmpA = $<HTMLSelectElement>("#cmp-a");
  const cmpB = $<HTMLSelectElement>("#cmp-b");
  if (solutions.length > 1 && cmpA.value === cmpB.value) {
    const other = solutions.find((s) => idOf(s) !== cmpA.value);
    if (other) cmpB.value = idOf(other);
  }
  $("#btn-clear").toggleAttribute("disabled", !solutions.length);
}

// ---------- inventory ----------
const hit = (q: string, ...texts: (string | null | undefined)[]): boolean => texts.some((t) => !!t && t.toLowerCase().includes(q));

/**
 * Fold key while searching: a separate key per query, so a search opens the cards (and column lists) holding matches
 * without overwriting what the user left open or closed outside the search; clearing it brings that layout back.
 */
const findKey = (key: string, q: string): string => (q ? `${key}?find=${q}` : key);

/** foldCard whose count badge reads "3 of 41" while a search hides rows. */
function shownFold(title: string, shown: number, total: number, body: Node, open: boolean, key: string): HTMLElement {
  return foldCard(title, shown === total ? total : `${shown} of ${total}`, body, open, { key });
}

/** A table row's "N columns" fold listing column name + type; opens when the search matched one of its columns. */
function columnsFold(table: string, cols: AttributeInfo[], q: string): HTMLElement {
  const matched = !!q && cols.some((c) => hit(q, c.name));
  return keepFold(
    h(
      "details",
      { class: "cols" },
      h("summary", { class: "chev" }, `${cols.length} ${cols.length === 1 ? "column" : "columns"}`),
      cols.length
        ? h("ul", { class: "cols-list" }, ...cols.map((c) => h("li", { class: q && hit(q, c.name) ? "is-match" : undefined }, h("span", { class: "mono" }, c.name), h("span", { class: "caption" }, c.type || "?"))))
        : h("p", { class: "caption" }, "No columns in this export."),
    ),
    findKey(`inv:cols:${table}`, matched ? q : ""),
    matched,
  );
}

function itemDetail(it: InventoryGroup["items"][number], q: string): Child {
  if (!it.columns) return it.detail ?? "";
  return h("div", { class: "row-detail" }, it.detail ? h("div", {}, it.detail) : null, columnsFold(it.name, it.columns, q));
}

/** Table hidden by "Hide system tables": no publisher prefix at all (same rule as the Risk tab; abc_thing is custom, just another publisher's). */
const isSystemTable = (name: string): boolean => !hasPublisherPrefix(name);

/** Untick "Hide system tables" the way the user would (saves the setting and re-renders). */
function showSystemTables(): void {
  const hide = $<HTMLInputElement>("#inv-hide-sys");
  hide.checked = false;
  hide.dispatchEvent(new Event("change"));
}

function renderInventory(): void {
  const body = $("#inv-body");
  body.replaceChildren();
  const s = selected("#inv-select");
  if (!s) {
    body.append(emptyState("No solution selected", "Add a solution zip to see its component inventory."));
    return;
  }
  const inv = buildInventory(s);
  const raw = $<HTMLInputElement>("#inv-q").value.trim();
  const q = raw.toLowerCase();
  const hideSys = $<HTMLInputElement>("#inv-hide-sys").checked;
  let shownCards = 0;
  let hiddenSys = 0;

  if (s.warnings.length) body.append(h("div", { class: "warnings" }, ...s.warnings.map((w) => h("div", {}, w))));

  body.append(
    card(
      "Summary",
      h("dl", { class: "kv" }, ...inv.summary.map((kv) => h("div", {}, h("dt", {}, kv.label), h("dd", {}, kv.value)))),
    ),
  );

  const byType = inv.rootComponentsByType.filter((r) => !q || hit(q, r.typeName, String(r.type)));
  if (byType.length) {
    shownCards++;
    body.append(
      shownFold(
        "Root components by type",
        byType.reduce((n, r) => n + r.count, 0),
        s.rootComponents.length,
        table(
          ["Type", "#Count"],
          byType.map((r) => [`${r.typeName} (${r.type})`, String(r.count)]),
        ),
        !!q,
        findKey("inv:root-by-type", q),
      ),
    );
  }

  // collections the tool does not itemise share one card after the itemised groups
  const others = inv.groups.filter((g) => g.key.startsWith("other:"));
  for (const g of inv.groups) {
    if (g.key.startsWith("other:")) continue;
    // "Hide system tables" narrows Tables first; the badge counts against every table
    const pool = hideSys && g.key === "entities" ? g.items.filter((it) => !isSystemTable(it.name)) : g.items;
    if (g.key === "entities") hiddenSys = g.items.length - pool.length;
    // rows match on name, detail or a table's column names
    const items = q ? pool.filter((it) => hit(q, it.name, it.detail) || !!it.columns?.some((c) => hit(q, c.name))) : pool;
    if (q && !items.length) continue;
    shownCards++;
    body.append(
      shownFold(
        g.label,
        items.length,
        g.count,
        items.length
          ? table(
              ["Name", "Detail"],
              items.map((it) => [h("span", { class: "mono" }, it.name), itemDetail(it, q)]),
            )
          : filteredEmpty(
              "Only system tables",
              `All ${g.count} ${g.count === 1 ? "table is a system table" : "tables are system tables"} (no publisher prefix) and hidden.`,
              showSystemTables,
              "Show system tables",
            ),
        !!q || g.key === "entities",
        findKey(`inv:${g.key}`, q),
      ),
    );
  }

  const otherRows = others.filter((g) => !q || hit(q, g.label));
  if (otherRows.length) {
    shownCards++;
    const sum = (gs: InventoryGroup[]) => gs.reduce((n, g) => n + g.count, 0);
    body.append(
      shownFold(
        "Other collections",
        sum(otherRows),
        sum(others),
        h(
          "div",
          {},
          h("p", { class: "caption" }, "Present in customizations.xml; not itemised by this tool."),
          table(
            ["Collection", "#Count"],
            otherRows.map((g) => [h("span", { class: "mono" }, g.label), String(g.count)]),
          ),
        ),
        !!q,
        findKey("inv:other", q),
      ),
    );
  }

  const ref = (r: SolutionInfo["missingDependencies"][number]["required"]) => `${r.typeName}: ${r.displayName ?? r.schemaName ?? r.id ?? "?"}`;
  const deps = s.missingDependencies.filter((d) => !q || hit(q, ref(d.required), d.required.solution, ref(d.dependent), d.dependent.parentSchemaName));
  if (deps.length) {
    shownCards++;
    body.append(
      shownFold(
        "Missing dependencies (as declared by the export)",
        deps.length,
        s.missingDependencies.length,
        table(
          ["Required", "From solution", "Needed by"],
          deps.map((d) => [
            ref(d.required),
            d.required.solution ?? "?",
            `${ref(d.dependent)}${d.dependent.parentSchemaName ? ` (${d.dependent.parentSchemaName})` : ""}`,
          ]),
        ),
        !!q,
        findKey("inv:missing-deps", q),
      ),
    );
  }

  if (q && !shownCards) {
    body.append(
      filteredEmpty(
        "No components match",
        `Nothing in ${s.uniqueName} matches "${raw}" (names, details and column names are searched)${hiddenSys ? `; ${hiddenSys} system ${hiddenSys === 1 ? "table is" : "tables are"} hidden` : ""}.`,
        () => {
          invFind.reset();
          renderInventory();
        },
        "Clear search",
      ),
    );
  }
}

// ---------- compare ----------
function currentDiff(): SolutionDiff | null {
  const a = selected("#cmp-a");
  const b = selected("#cmp-b");
  if (!a || !b) return null;
  return diffSolutions(a, b);
}

const CHANGES: DiffEntry["change"][] = ["added", "changed", "removed"];

/**
 * Rows the screen (and the export) shows: hide-root, change types and the name filter apply to the list, the counts and the file.
 * `total` is the row count before the type / name filters (after hide-root).
 */
function visibleDiff(d: SolutionDiff) {
  const hideRoot = $<HTMLInputElement>("#cmp-hide-root").checked;
  const changes = CHANGES.filter((c) => $<HTMLInputElement>(`#cmp-${c}`).checked);
  const name = $<HTMLInputElement>("#cmp-q").value.trim();
  const q = name.toLowerCase();
  const base = hideRoot ? d.entries.filter((e) => e.category !== "Root component") : d.entries;
  const entries = base.filter((e) => changes.includes(e.change) && (!q || [e.name, e.category, e.detail ?? ""].some((t) => t.toLowerCase().includes(q))));
  const count = (c: DiffEntry["change"]) => entries.filter((e) => e.change === c).length;
  return {
    filter: { hideRootComponents: hideRoot, changes, name },
    entries,
    total: base.length,
    hiddenRoot: d.entries.length - base.length,
    counts: { added: count("added"), removed: count("removed"), changed: count("changed") },
  };
}

/** "changed": one line per changed field (`Label: before → after`); the full before / after is in the tooltip. */
function diffDetail(e: DiffEntry): Child {
  if (!e.fields?.length) return e.detail ?? "";
  return h(
    "div",
    { class: "diff-fields", title: `Before: ${e.before ?? ""}\nAfter: ${e.after ?? ""}` },
    ...e.fields.map((f) => h("div", {}, h("span", { class: "field" }, `${f.field}: `), f.before, " → ", f.after)),
  );
}

function renderCompare(): void {
  const body = $("#cmp-body");
  body.replaceChildren();
  if (solutions.length < 2) {
    body.append(emptyState("Need two solutions", "Load two versions of a solution (or two different solutions) to compare."));
    return;
  }
  const d = currentDiff();
  if (!d) return;
  const { entries, total, hiddenRoot, counts } = visibleDiff(d);
  const hiddenNote = hiddenRoot ? `${hiddenRoot} root-component ${hiddenRoot === 1 ? "row" : "rows"} hidden` : null;
  const shownNote = cmpFilters.active() ? shownOf(entries.length, total, "changes") : null;

  const versionBadge =
    d.versionOrder === "upgrade" ? badge("upgrade", "ok") : d.versionOrder === "same" ? badge("same version", "warn") : d.versionOrder === "downgrade" ? badge("downgrade", "bad") : badge("version n/a", "neutral");

  body.append(
    card(
      "Comparison",
      h(
        "dl",
        { class: "kv" },
        h("div", {}, h("dt", {}, "A"), h("dd", {}, `${d.a.name} ${d.a.version} (${d.a.managed ? "managed" : "unmanaged"})`)),
        h("div", {}, h("dt", {}, "B"), h("dd", {}, `${d.b.name} ${d.b.version} (${d.b.managed ? "managed" : "unmanaged"})`)),
        h("div", {}, h("dt", {}, "Same unique name"), h("dd", {}, d.sameSolution ? "yes" : "no")),
        h("div", {}, h("dt", {}, "Version"), h("dd", {}, versionBadge)),
        h("div", {}, h("dt", {}, "Changes"), h("dd", {}, h("div", { class: "chips" }, badge(`+${counts.added}`, "ok"), badge(`~${counts.changed}`, "warn"), badge(`-${counts.removed}`, "bad"), shownNote && h("span", { class: "count-caption" }, shownNote), hiddenNote && h("span", { class: "count-caption" }, hiddenNote)))),
      ),
    ),
  );

  if (!entries.length) {
    const hidden = total - entries.length;
    body.append(
      hidden
        ? filteredEmpty("No changes match", `${hidden} ${hidden === 1 ? "change is" : "changes are"} hidden by the change-type and name filters.`, () => {
            cmpFilters.reset();
            renderCompare();
          })
        : hiddenRoot
        ? filteredEmpty("Only root-component differences", `${hiddenRoot} root-component ${hiddenRoot === 1 ? "difference is" : "differences are"} hidden.`, () => {
            const hide = $<HTMLInputElement>("#cmp-hide-root");
            hide.checked = false;
            hide.dispatchEvent(new Event("change")); // saves the setting and re-renders
          })
        : emptyState("No differences", "Both solutions expose the same components."),
    );
    return;
  }

  const byCat = new Map<string, typeof entries>();
  for (const e of entries) (byCat.get(e.category) ?? byCat.set(e.category, []).get(e.category)!).push(e);
  for (const [cat, list] of byCat) {
    body.append(
      foldCard(
        cat,
        list.length,
        table(
          ["Change", "Name", "Detail"],
          list.map((e) => [badge(e.change, e.change === "added" ? "ok" : e.change === "removed" ? "bad" : "warn"), h("span", { class: "mono" }, e.name), diffDetail(e)]),
          (i) => `diff-${list[i].change}`,
        ),
        list.length <= 20, // big categories start closed so the rest stays in view
        { key: `cmp:${cat}` },
      ),
    );
  }
}

// ---------- risk ----------
/** Evidence chips: the first EVIDENCE_SHOWN, then "+N more" expands the rest inline ("Show less" folds them back). */
function evidenceChips(id: string, items: string[]): HTMLElement {
  const box = h("div", { class: "evidence chips" });
  const draw = () => {
    const open = evidenceOpen.has(id);
    const rest = items.length - EVIDENCE_SHOWN;
    const more = rest > 0 ? h("button", { class: "btn btn-ghost btn-sm evidence-more", type: "button", "aria-expanded": String(open) }, open ? "Show less" : `+${rest} more`) : null;
    more?.addEventListener("click", () => {
      if (open) evidenceOpen.delete(id);
      else evidenceOpen.add(id);
      draw();
      box.querySelector<HTMLButtonElement>(".evidence-more")?.focus();
    });
    box.replaceChildren(...(open ? items : items.slice(0, EVIDENCE_SHOWN)).map((e) => badge(e, "neutral")));
    if (more) box.append(more);
  };
  draw();
  return box;
}

function renderRisk(): void {
  const body = $("#risk-body");
  body.replaceChildren();
  const s = selected("#risk-select");
  if (!s) {
    body.append(emptyState("No solution selected", "Add a solution zip to score its upgrade risk."));
    return;
  }
  const baseline = selected("#risk-baseline") ?? null;
  const r = scoreRisk(s, baseline === s ? null : baseline);

  const kind = r.band === "Low" ? "ok" : r.band === "Medium" ? "warn" : "bad";
  body.append(
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "score" },
        h("div", { class: "num" }, String(r.score), h("small", {}, " / 100")),
        h("div", { class: `meter${kind === "warn" ? " is-warn" : kind === "bad" ? " is-bad" : ""}` }, h("span", { style: `width:${r.score}%` })),
        badge(r.band, kind),
      ),
      h(
        "div",
        { class: "card-body caption" },
        `Heuristic score for importing ${s.uniqueName} ${s.version}${r.baseline ? ` over ${r.baseline}` : ""}. Sum of capped factors; a checklist, not a verdict.`,
      ),
    ),
  );

  if (!r.factors.length) {
    body.append(emptyState("No risk factors detected", "Managed, self-contained, no plugins, no flows, no missing dependencies."));
    return;
  }

  body.append(
    h(
      "div",
      { class: "card" },
      ...r.factors.map((f) =>
        h(
          "div",
          { class: "factor" },
          h("h3", {}, f.label),
          h("span", { class: "pts" }, `+${f.points}`, h("span", { class: "caption" }, ` / ${f.max}`)),
          f.evidence.length ? evidenceChips(f.id, f.evidence) : null,
          h("p", { class: "advice caption" }, f.advice),
        ),
      ),
    ),
  );
}

// ---------- order ----------
/** An edge's reasons: the first REASONS_SHOWN, then "(+N)" reveals the rest inline ("Show less" folds them back). */
function reasonsCell(id: string, reasons: string[]): HTMLElement {
  const box = h("span", { class: "reasons" });
  const draw = () => {
    const open = reasonsOpen.has(id);
    const rest = reasons.length - REASONS_SHOWN;
    const more = rest > 0 ? h("button", { class: "btn btn-ghost btn-sm reasons-more", type: "button", "aria-expanded": String(open) }, open ? "Show less" : `(+${rest})`) : null;
    more?.addEventListener("click", () => {
      if (open) reasonsOpen.delete(id);
      else reasonsOpen.add(id);
      draw();
      box.querySelector<HTMLButtonElement>(".reasons-more")?.focus();
    });
    if (more) more.title = open ? "Show the first reasons only" : `Show ${rest} more ${rest === 1 ? "reason" : "reasons"}`;
    box.replaceChildren((open ? reasons : reasons.slice(0, REASONS_SHOWN)).join("; "));
    if (more) box.append(" ", more);
  };
  draw();
  return box;
}

function renderOrder(): void {
  const body = $("#order-body");
  body.replaceChildren();
  if (solutions.length < 2) {
    body.append(emptyState("Need two or more solutions", "Load every solution you plan to import; the tool orders them by declared dependencies."));
    return;
  }
  const o = computeInstallOrder(solutions);
  const kept = latestByName(solutions);

  if (o.duplicates.length) body.append(h("div", { class: "warnings" }, `Duplicate unique names (highest version kept): ${o.duplicates.join(", ")}`));

  if (o.cycle.length) {
    body.append(
      card(
        "Dependency cycle",
        h(
          "div",
          {},
          h("p", {}, "These solutions depend on each other; no valid install order exists without splitting components:"),
          h("div", { class: "chips" }, ...o.cycle.map((n) => badge(n, "bad"))),
          o.cyclePath.length ? h("p", { class: "caption mono" }, o.cyclePath.join(" → ")) : null,
        ),
        badge("blocked", "bad"),
      ),
    );
  } else {
    body.append(
      card(
        "Install order",
        h("ol", { class: "order-list" }, ...o.order.map((n) => {
          const s = kept.get(n)!;
          return h("li", {}, h("span", { class: "name" }, n), h("span", { class: "caption" }, `${s.version} · ${s.managed ? "managed" : "unmanaged"}`));
        })),
        badge(`${o.order.length} solutions`, "ok"),
      ),
    );
  }

  body.append(
    foldCard(
      "Dependencies between loaded solutions",
      o.edges.length,
      o.edges.length
        ? table(
            ["Install first", "Then", "Because"],
            o.edges.map((e) => [h("span", { class: "mono" }, e.from), h("span", { class: "mono" }, e.to), reasonsCell(`${e.from}→${e.to}`, e.reasons)]),
          )
        : h("p", { class: "caption" }, "No dependencies detected between the loaded solutions; any order works."),
      true,
      { key: "order:edges" },
    ),
  );

  body.append(
    foldCard(
      "External dependencies (not loaded, not System)",
      o.external.length,
      o.external.length
        ? table(
            ["Solution", "Requires solution", "Component"],
            o.external.map((x) => [h("span", { class: "mono" }, x.solution), x.requiredSolution, x.component]),
          )
        : h("p", { class: "caption" }, "None. All declared dependencies are satisfied by loaded or built-in solutions."),
      o.external.length > 0,
      { key: "order:external" },
    ),
  );
}

// ---------- orchestration ----------
function renderActive(): void {
  const renderers: Record<string, () => void> = { inventory: renderInventory, compare: renderCompare, risk: renderRisk, order: renderOrder };
  renderers[activeTab]?.();
}

function renderAll(): void {
  renderSidebar();
  renderActive();
}

async function addFiles(files: { name: string; data: Uint8Array }[]): Promise<void> {
  for (const f of files) {
    try {
      const info = await parseSolutionZip(f.data, f.name);
      solutions.push(info);
      if (info.warnings.length) await notify("Loaded with warnings", `${f.name}: ${info.warnings[0]}`, "warning");
    } catch (err) {
      await notify("Could not read zip", `${f.name}: ${(err as Error).message}`, "error");
    }
  }
  renderAll();
}

async function exportJson(name: string, payload: unknown): Promise<void> {
  const ok = await saveText(name, JSON.stringify(payload, null, 2));
  if (ok) await notify("Exported", name, "success");
}

function wire(): void {
  persistControls("solution-xray", ["cmp-hide-root"]);
  cmpFilters = persistControls("solution-xray", ["cmp-added", "cmp-changed", "cmp-removed", "cmp-q"]);
  invFind = persistControls("solution-xray", ["inv-q"]);
  persistControls("solution-xray", ["inv-hide-sys"]); // separate: "Clear search" must not show system tables again
  // Expand / collapse all next to the export button (fold state is kept per card across re-renders)
  $("#inv-export").before(foldAllButtons(() => document.getElementById("inv-body"), "details.card"));
  $("#cmp-export").before(foldAllButtons(() => document.getElementById("cmp-body"), "details.card"));
  $("#btn-add").addEventListener("click", async () => addFiles(await pickZips(true)));
  $("#btn-clear").addEventListener("click", () => {
    solutions.length = 0;
    renderAll();
  });

  wireTabs((name) => {
    activeTab = name;
    renderActive();
  });

  $("#inv-select").addEventListener("change", renderInventory);
  $("#inv-q").addEventListener("input", renderInventory);
  $("#inv-hide-sys").addEventListener("change", renderInventory);
  $("#cmp-a").addEventListener("change", renderCompare);
  $("#cmp-b").addEventListener("change", renderCompare);
  for (const id of ["#cmp-hide-root", "#cmp-added", "#cmp-changed", "#cmp-removed"]) $(id).addEventListener("change", renderCompare);
  $("#cmp-q").addEventListener("input", renderCompare);
  $("#risk-select").addEventListener("change", renderRisk);
  $("#risk-baseline").addEventListener("change", renderRisk);

  $("#inv-export").addEventListener("click", () => {
    const s = selected("#inv-select");
    if (s) void exportJson(`${s.uniqueName}-${s.version || "inventory"}.xray.json`, { solution: s, inventory: buildInventory(s) });
  });
  $("#cmp-export").addEventListener("click", () => {
    const d = currentDiff();
    if (!d) return;
    // Export what the screen shows: hide-root, change-type and name filters apply to the file too.
    const { filter, entries, counts } = visibleDiff(d);
    void exportJson(`${d.a.name}-${d.a.version}_vs_${d.b.name}-${d.b.version}.diff.json`, { ...d, filter, entries, counts });
  });
  $("#risk-export").addEventListener("click", () => {
    const s = selected("#risk-select");
    const baseline = selected("#risk-baseline") ?? null;
    if (s) void exportJson(`${s.uniqueName}-${s.version}.risk.json`, scoreRisk(s, baseline === s ? null : baseline));
  });
  $("#order-export").addEventListener("click", () => void exportJson("install-order.json", computeInstallOrder(solutions)));

  // Drag & drop: browser-only convenience (unverified inside PPTB's iframe; harmless if unsupported).
  // Listen on body only: drops on the dropzone bubble up, so one listener = one load per drop.
  const dz = $("#dropzone");
  if (!inToolbox()) dz.hidden = false;
  document.body.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("is-over");
  });
  document.body.addEventListener("dragleave", () => dz.classList.remove("is-over"));
  document.body.addEventListener("drop", async (e) => {
    e.preventDefault();
    dz.classList.remove("is-over");
    if (e.dataTransfer) await addFiles(await filesFromDrop(e.dataTransfer));
  });

  $("#host-mode").textContent = inToolbox() ? "Running inside Power Platform ToolBox" : "Standalone mode (browser)";
}

mountDebug(document.querySelector("footer"), "solution-xray");
void initTheme((t) => document.documentElement.setAttribute("data-theme", t));
wire();
renderAll();

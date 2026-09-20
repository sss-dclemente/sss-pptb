import { filesFromDrop, initTheme, inToolbox, notify, pickZips, saveText } from "./host";
import { diffSolutions, type SolutionDiff } from "./xray/diff";
import { buildInventory, managedLabel } from "./xray/inventory";
import { computeInstallOrder } from "./xray/order";
import { parseSolutionZip } from "./xray/parse";
import { scoreRisk } from "./xray/risk";
import type { SolutionInfo } from "./xray/types";

// ---------- state ----------
const solutions: SolutionInfo[] = [];
let activeTab = "inventory";

// ---------- DOM helpers ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

function badge(text: string, kind: "" | "ok" | "warn" | "bad" | "neutral" = ""): HTMLElement {
  return h("span", { class: `badge${kind ? ` badge-${kind}` : ""}` }, text);
}

function emptyState(title: string, hint: string): HTMLElement {
  return h("div", { class: "empty-state" }, h("strong", {}, title), hint);
}

function table(headers: string[], rows: (Node | string)[][], rowClass?: (i: number) => string | undefined): HTMLElement {
  return h(
    "table",
    {},
    h("thead", {}, h("tr", {}, ...headers.map((t) => h("th", { class: t.startsWith("#") ? "r" : undefined }, t.replace(/^#/, ""))))),
    h(
      "tbody",
      {},
      ...rows.map((cells, i) =>
        h("tr", { class: rowClass?.(i) }, ...cells.map((c, j) => h("td", { class: headers[j]?.startsWith("#") ? "r" : undefined }, c))),
      ),
    ),
  );
}

function card(title: string, body: Node, extra?: Node): HTMLElement {
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", {}, title), extra ?? null), h("div", { class: "card-body" }, body));
}

function foldCard(title: string, count: number, body: Node, open = false): HTMLElement {
  return h(
    "details",
    { class: "card", open },
    h("summary", {}, h("div", { class: "card-head" }, h("h3", {}, title), h("span", { class: "count" }, badge(String(count), "neutral")))),
    h("div", { class: "card-body" }, body),
  );
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
  solutions.forEach((s, i) => {
    const remove = h("button", { class: "btn-icon", type: "button", title: "Remove", "aria-label": `Remove ${s.uniqueName}` }, "×");
    remove.addEventListener("click", () => {
      solutions.splice(i, 1);
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
    solutions.forEach((s, i) => sel.append(h("option", { value: String(i) }, label(s))));
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    else if (id === "#cmp-b" && solutions.length > 1) sel.value = "1";
  }
  $("#btn-clear").toggleAttribute("disabled", !solutions.length);
}

// ---------- inventory ----------
function renderInventory(): void {
  const body = $("#inv-body");
  body.replaceChildren();
  const s = solutions[Number($<HTMLSelectElement>("#inv-select").value)];
  if (!s) {
    body.append(emptyState("No solution selected", "Add a solution zip to see its component inventory."));
    return;
  }
  const inv = buildInventory(s);

  if (s.warnings.length) body.append(h("div", { class: "warnings" }, ...s.warnings.map((w) => h("div", {}, w))));

  body.append(
    card(
      "Summary",
      h("dl", { class: "kv" }, ...inv.summary.map((kv) => h("div", {}, h("dt", {}, kv.label), h("dd", {}, kv.value)))),
    ),
  );

  if (inv.rootComponentsByType.length) {
    body.append(
      foldCard(
        "Root components by type",
        s.rootComponents.length,
        table(
          ["Type", "#Count"],
          inv.rootComponentsByType.map((r) => [`${r.typeName} (${r.type})`, String(r.count)]),
        ),
      ),
    );
  }

  for (const g of inv.groups) {
    body.append(
      foldCard(
        g.label,
        g.count,
        g.items.length
          ? table(
              ["Name", "Detail"],
              g.items.map((it) => [h("span", { class: "mono" }, it.name), it.detail ?? ""]),
            )
          : h("p", { class: "caption" }, "Present in customizations.xml; not itemised by this tool."),
        g.key === "entities",
      ),
    );
  }

  if (s.missingDependencies.length) {
    body.append(
      foldCard(
        "Missing dependencies (as declared by the export)",
        s.missingDependencies.length,
        table(
          ["Required", "From solution", "Needed by"],
          s.missingDependencies.map((d) => [
            `${d.required.typeName}: ${d.required.displayName ?? d.required.schemaName ?? d.required.id ?? "?"}`,
            d.required.solution ?? "?",
            `${d.dependent.typeName}: ${d.dependent.displayName ?? d.dependent.schemaName ?? d.dependent.id ?? "?"}${d.dependent.parentSchemaName ? ` (${d.dependent.parentSchemaName})` : ""}`,
          ]),
        ),
      ),
    );
  }
}

// ---------- compare ----------
function currentDiff(): SolutionDiff | null {
  const a = solutions[Number($<HTMLSelectElement>("#cmp-a").value)];
  const b = solutions[Number($<HTMLSelectElement>("#cmp-b").value)];
  if (!a || !b) return null;
  return diffSolutions(a, b);
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
  const hideRoot = $<HTMLInputElement>("#cmp-hide-root").checked;
  const entries = hideRoot ? d.entries.filter((e) => e.category !== "Root component") : d.entries;

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
        h("div", {}, h("dt", {}, "Changes"), h("dd", {}, h("div", { class: "chips" }, badge(`+${d.counts.added}`, "ok"), badge(`~${d.counts.changed}`, "warn"), badge(`-${d.counts.removed}`, "bad")))),
      ),
    ),
  );

  if (!entries.length) {
    body.append(emptyState("No differences", "Both solutions expose the same components."));
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
          list.map((e) => [badge(e.change, e.change === "added" ? "ok" : e.change === "removed" ? "bad" : "warn"), h("span", { class: "mono" }, e.name), e.detail ?? ""]),
          (i) => `diff-${list[i].change}`,
        ),
        true,
      ),
    );
  }
}

// ---------- risk ----------
function renderRisk(): void {
  const body = $("#risk-body");
  body.replaceChildren();
  const s = solutions[Number($<HTMLSelectElement>("#risk-select").value)];
  if (!s) {
    body.append(emptyState("No solution selected", "Add a solution zip to score its upgrade risk."));
    return;
  }
  const baseIdx = $<HTMLSelectElement>("#risk-baseline").value;
  const baseline = baseIdx === "" ? null : solutions[Number(baseIdx)];
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
          f.evidence.length ? h("div", { class: "evidence chips" }, ...f.evidence.map((e) => badge(e, "neutral"))) : null,
          h("p", { class: "advice caption" }, f.advice),
        ),
      ),
    ),
  );
}

// ---------- order ----------
function renderOrder(): void {
  const body = $("#order-body");
  body.replaceChildren();
  if (solutions.length < 2) {
    body.append(emptyState("Need two or more solutions", "Load every solution you plan to import; the tool orders them by declared dependencies."));
    return;
  }
  const o = computeInstallOrder(solutions);

  if (o.duplicates.length) body.append(h("div", { class: "warnings" }, `Duplicate unique names ignored (first loaded wins): ${o.duplicates.join(", ")}`));

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
          const s = solutions.find((x) => x.uniqueName === n)!;
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
            o.edges.map((e) => [h("span", { class: "mono" }, e.from), h("span", { class: "mono" }, e.to), e.reasons.slice(0, 5).join("; ") + (e.reasons.length > 5 ? ` (+${e.reasons.length - 5})` : "")]),
          )
        : h("p", { class: "caption" }, "No dependencies detected between the loaded solutions; any order works."),
      true,
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
  $("#btn-add").addEventListener("click", async () => addFiles(await pickZips(true)));
  $("#btn-clear").addEventListener("click", () => {
    solutions.length = 0;
    renderAll();
  });

  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) =>
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab!;
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === btn));
      document.querySelectorAll<HTMLElement>(".panel").forEach((p) => (p.hidden = p.id !== `tab-${activeTab}`));
      renderActive();
    }),
  );

  $("#inv-select").addEventListener("change", renderInventory);
  $("#cmp-a").addEventListener("change", renderCompare);
  $("#cmp-b").addEventListener("change", renderCompare);
  $("#cmp-hide-root").addEventListener("change", renderCompare);
  $("#risk-select").addEventListener("change", renderRisk);
  $("#risk-baseline").addEventListener("change", renderRisk);

  $("#inv-export").addEventListener("click", () => {
    const s = solutions[Number($<HTMLSelectElement>("#inv-select").value)];
    if (s) void exportJson(`${s.uniqueName}-${s.version || "inventory"}.xray.json`, { solution: s, inventory: buildInventory(s) });
  });
  $("#cmp-export").addEventListener("click", () => {
    const d = currentDiff();
    if (d) void exportJson(`${d.a.name}-${d.a.version}_vs_${d.b.version}.diff.json`, d);
  });
  $("#risk-export").addEventListener("click", () => {
    const s = solutions[Number($<HTMLSelectElement>("#risk-select").value)];
    const baseIdx = $<HTMLSelectElement>("#risk-baseline").value;
    const baseline = baseIdx === "" ? null : solutions[Number(baseIdx)];
    if (s) void exportJson(`${s.uniqueName}-${s.version}.risk.json`, scoreRisk(s, baseline === s ? null : baseline));
  });
  $("#order-export").addEventListener("click", () => void exportJson("install-order.json", computeInstallOrder(solutions)));

  // Drag & drop: browser-only convenience (unverified inside PPTB's iframe; harmless if unsupported)
  const dz = $("#dropzone");
  if (!inToolbox()) dz.hidden = false;
  for (const target of [dz, document.body]) {
    target.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("is-over");
    });
    target.addEventListener("dragleave", () => dz.classList.remove("is-over"));
    target.addEventListener("drop", async (e) => {
      e.preventDefault();
      dz.classList.remove("is-over");
      if (e.dataTransfer) await addFiles(await filesFromDrop(e.dataTransfer));
    });
  }

  $("#host-mode").textContent = inToolbox() ? "Running inside Power Platform ToolBox" : "Standalone mode (browser)";
}

void initTheme((t) => document.documentElement.setAttribute("data-theme", t));
wire();
renderAll();

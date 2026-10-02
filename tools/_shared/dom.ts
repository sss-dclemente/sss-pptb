/** Shared DOM helpers for SSS tools. No framework, no innerHTML. */

export const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

export type Child = Node | string | null | undefined | false;

/** append() that skips null/undefined/false children. */
export function append(el: HTMLElement, ...children: Child[]): void {
  for (const c of children) if (c != null && c !== false) el.append(c);
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Child[]
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

export type BadgeKind = "" | "ok" | "warn" | "bad" | "neutral";
export const badge = (text: string, kind: BadgeKind = ""): HTMLElement => h("span", { class: `badge${kind ? ` badge-${kind}` : ""}` }, text);

export const emptyState = (title: string, hint: string): HTMLElement => h("div", { class: "empty-state" }, h("strong", {}, title), hint);

/** Header starting with "#" renders right-aligned. */
export function table(headers: string[], rows: Child[][], rowClass?: (i: number) => string | undefined, cls?: string): HTMLElement {
  return h(
    "table",
    { class: cls },
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

export function card(title: string, body: Node, extra?: Node): HTMLElement {
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h3", {}, title), extra ?? null), h("div", { class: "card-body" }, body));
}

/** Open/closed state of keyed folds, kept across re-renders for the lifetime of the page. */
const foldMemory = new Map<string, boolean>();

/**
 * Give a <details> a stable `key`: it opens as last left by the user (else `defaultOpen`) and records later toggles,
 * so a re-render (filter change, tab switch, refresh) does not close what the user opened.
 */
export function keepFold<T extends HTMLDetailsElement>(el: T, key: string, defaultOpen = false): T {
  el.open = foldMemory.get(key) ?? defaultOpen;
  el.dataset.foldKey = key;
  // setting `open` above also fires a toggle: don't record that default as a user choice, so a new default
  // (e.g. the row's verdict changed) still applies until the user folds or unfolds it
  el.addEventListener("toggle", () => {
    if (!foldMemory.has(key) && el.open === defaultOpen) return;
    foldMemory.set(key, el.open);
  });
  return el;
}

export interface FoldOptions {
  /** Remember open/closed across re-renders under this key (see keepFold). */
  key?: string;
  /** Extra header content shown before the count badge (e.g. a warning badge). */
  extra?: Child;
}

export function foldCard(title: string, count: number, body: Node, open = false, o: FoldOptions = {}): HTMLElement {
  const el = h(
    "details",
    { class: "card", open },
    h("summary", {}, h("div", { class: "card-head" }, h("h3", {}, title), h("span", { class: "count" }, o.extra ?? null, badge(String(count), "neutral")))),
    h("div", { class: "card-body" }, body),
  );
  return o.key ? keepFold(el, o.key, open) : el;
}

/** "Expand all" / "Collapse all" for every <details> matching `selector` inside `scope` at click time. */
export function foldAllButtons(scope: ParentNode | (() => ParentNode | null), selector = "details"): HTMLElement {
  const set = (open: boolean) => {
    const root = typeof scope === "function" ? scope() : scope;
    // folds inside something hidden (a filtered-out card or row) stay as they are
    root?.querySelectorAll<HTMLDetailsElement>(selector).forEach((d) => {
      if (!d.closest("[hidden]")) d.open = open;
    });
  };
  const btn = (label: string, open: boolean) => {
    const b = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, label);
    b.addEventListener("click", () => set(open));
    return b;
  };
  return h("span", { class: "fold-all" }, btn("Expand all", true), btn("Collapse all", false));
}

/** "12 of 340 tables" while filtered, "340 tables" otherwise. */
export const shownOf = (shown: number, total: number, noun: string): string => (shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`);

/** Empty state for "the filters hide everything", with a button that clears them (label overridable for a single toggle). */
export function filteredEmpty(title: string, hint: string, onClear: () => void, clearLabel = "Clear filters"): HTMLElement {
  const clear = h("button", { class: "btn btn-ghost btn-sm", type: "button" }, clearLabel);
  clear.addEventListener("click", onClear);
  const el = emptyState(title, hint);
  el.append(h("div", { class: "empty-actions" }, clear));
  return el;
}

export interface DialogOptions {
  title: string;
  body: Node;
  okLabel?: string; // empty/undefined = no OK button (info dialog)
  danger?: boolean;
  target?: Node; // rendered in the header's right side
}

/**
 * Modal on a page-level <dialog id="dlg"> with #dlg-title, #dlg-target, #dlg-body, #dlg-ok, #dlg-cancel.
 * Resolves only after the close event so a dialog opened right after is not closed by this one's stale event.
 */
export function showDialog(o: DialogOptions): Promise<boolean> {
  const dlg = $<HTMLDialogElement>("#dlg");
  $("#dlg-title").textContent = o.title;
  const t = $("#dlg-target");
  t.replaceChildren();
  if (o.target) t.append(o.target);
  $("#dlg-body").replaceChildren(o.body);
  const ok = $<HTMLButtonElement>("#dlg-ok");
  ok.textContent = o.okLabel ?? "";
  ok.className = `btn ${o.danger ? "btn-danger" : "btn-primary"}`;
  ok.style.flex = "none";
  ok.hidden = !o.okLabel;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      ok.onclick = null;
      $("#dlg-cancel").onclick = null;
      dlg.onclose = null;
      if (dlg.open) {
        dlg.addEventListener("close", () => resolve(v), { once: true });
        dlg.close();
      } else resolve(v);
    };
    ok.onclick = () => done(true);
    $("#dlg-cancel").onclick = () => done(false);
    dlg.onclose = () => done(false);
    dlg.showModal();
  });
}

/**
 * Tab buttons `.tab[data-tab]` toggle `.panel` sections by id `tab-<name>` (optional) and call `onChange`.
 * Sets tablist ARIA (aria-selected, aria-controls, tabpanel) and arrow / Home / End keys between tabs.
 */
export function wireTabs(onChange: (tab: string) => void): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>(".tab")];
  const sync = (active: HTMLButtonElement) =>
    tabs.forEach((t) => {
      const on = t === active;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    });
  const select = (btn: HTMLButtonElement) => {
    const name = btn.dataset.tab!;
    sync(btn);
    document.querySelectorAll<HTMLElement>(".panel[id^='tab-']").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
    onChange(name);
  };
  tabs.forEach((btn) => {
    btn.setAttribute("role", "tab");
    btn.id ||= `tabbtn-${btn.dataset.tab}`;
    const panel = document.getElementById(`tab-${btn.dataset.tab}`);
    if (panel) {
      btn.setAttribute("aria-controls", panel.id);
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", btn.id);
    }
    btn.addEventListener("click", () => select(btn));
    btn.addEventListener("keydown", (e) => {
      const live = tabs.filter((t) => !t.disabled);
      const i = live.indexOf(btn);
      const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? live.length - 1 : null;
      if (to === null || i < 0) return;
      e.preventDefault();
      const next = live[(to + live.length) % live.length];
      next.focus();
      select(next);
    });
  });
  const first = tabs.find((t) => t.classList.contains("is-active")) ?? tabs[0];
  if (first) sync(first);
}

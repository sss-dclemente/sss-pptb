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

export function foldCard(title: string, count: number, body: Node, open = false): HTMLElement {
  return h(
    "details",
    { class: "card", open },
    h("summary", {}, h("div", { class: "card-head" }, h("h3", {}, title), h("span", { class: "count" }, badge(String(count), "neutral")))),
    h("div", { class: "card-body" }, body),
  );
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

/** Tab buttons `.tab[data-tab]` toggle `.panel` sections by id `tab-<name>` (optional) and call `onChange`. */
export function wireTabs(onChange: (tab: string) => void): void {
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) =>
    btn.addEventListener("click", () => {
      const name = btn.dataset.tab!;
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === btn));
      document.querySelectorAll<HTMLElement>(".panel[id^='tab-']").forEach((p) => (p.hidden = p.id !== `tab-${name}`));
      onChange(name);
    }),
  );
}

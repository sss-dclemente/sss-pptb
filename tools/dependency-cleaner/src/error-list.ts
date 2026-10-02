/** Failed lookups: the first few inline, every one behind a "Show all N" fold (Diagnose and Upgrade blockers summaries). */
import { h, keepFold } from "../../_shared/dom";

const INLINE = 3;

/** `lead`: "RetrieveRequiredComponents failed for 7 component(s)"; `key` keeps the fold open across re-renders. */
export function errorList(lead: string, errors: { component: string; error: string }[], key: string): HTMLElement {
  const text = (e: { component: string; error: string }) => `${e.component} (${e.error})`;
  const more = errors.length > INLINE;
  const el = h("div", { class: "warnings error-list" }, `${lead}: ${errors.slice(0, INLINE).map(text).join("; ")}${more ? "; …" : ""}`);
  if (more)
    el.append(
      keepFold(
        h("details", { class: "error-all" }, h("summary", { class: "chev" }, `Show all ${errors.length}`), h("ul", { class: "plain" }, ...errors.map((e) => h("li", {}, text(e))))),
        key,
      ),
    );
  return el;
}

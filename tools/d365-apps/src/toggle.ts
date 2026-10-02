/** A summary badge that is also a filter toggle (aria-pressed). Local to this tool until _shared/dom.ts has one. */
import { h, type BadgeKind } from "../../_shared/dom";

export function toggleBadge(text: string, kind: BadgeKind, pressed: boolean, onToggle: () => void, attrs: Record<string, string | boolean | undefined> = {}): HTMLButtonElement {
  const b = h("button", { type: "button", class: `badge badge-toggle${kind ? ` badge-${kind}` : ""}`, "aria-pressed": String(pressed), ...attrs }, text);
  b.addEventListener("click", onToggle);
  return b;
}

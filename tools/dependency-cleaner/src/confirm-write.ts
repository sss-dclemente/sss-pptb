/**
 * Last confirmation before any Dataverse write: names the environment (connection name and url), the scope
 * (operation count and what they change) and the way back (the backup and what restores it) or says plainly
 * that there is none.
 */
import { $, h, showDialog } from "../../_shared/dom";
import type { Op } from "./deps/write";
import type { LiveConnection } from "./host";

declare const __UNVERIFIED_WRITES__: boolean | undefined;

/**
 * The writes of Upgrade blockers, Failed import and Cycles are not verified against a live environment yet (README,
 * Limitations). The release build leaves them out: analysis, plan and exports stay. Dev-watch and
 * `vite build --mode unverified` keep them, to verify them live (Load Local Tool) and for the e2e.
 */
export const unverifiedWrites = typeof __UNVERIFIED_WRITES__ === "boolean" && __UNVERIFIED_WRITES__;

/** Release build: the tab's apply bar shows only a note (styles.css `.writes-off`), its undo button is hidden; false. */
export function writesOn(bar: string, undo?: string): boolean {
  if (unverifiedWrites) return true;
  $(bar).classList.add("writes-off");
  $(bar).append(h("p", { class: "warnings unverified-note" }, "Apply is off in this release: these writes have not been verified against a live environment yet. Make the changes in the plan above by hand, or export it."));
  if (undo) $(undo).hidden = true;
  return false;
}

export interface WriteConfirm {
  title: string;
  /** the connection the operations are written to, as the host reports it right now */
  conn: LiveConnection;
  /** e.g. "12 operations on solution SssCore: 3 components leave the solution, 1 form updated" */
  scope: string;
  /** the way back: the backup and what restores it, or "This cannot be undone from this tool…" */
  wayBack: string;
  /** extra warnings, shown between the scope and the way back */
  warnings?: string[];
  okLabel: string;
  danger?: boolean;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function confirmWrite(o: WriteConfirm): Promise<boolean> {
  const c = o.conn.conn;
  return showDialog({
    title: o.title,
    target: h("span", { class: "caption" }, `${c.name} · ${c.environment}`),
    body: h(
      "div",
      { id: "dlg-write" },
      h("p", { id: "dlg-env" }, "Environment: ", h("strong", {}, c.name), ` (${c.url})`),
      h("p", { id: "dlg-scope" }, o.scope),
      ...(o.warnings ?? []).map((w) => h("div", { class: "warnings" }, w)),
      h("p", { id: "dlg-wayback", class: "caption" }, o.wayBack),
    ),
    okLabel: o.okLabel,
    danger: o.danger,
  });
}

/** "3 removed from the solution, 2 added, 1 form updated, …" for the operations of the write path. */
export function opsBreakdown(ops: Op[]): string {
  const n = (k: Op["kind"]) => ops.filter((o) => o.kind === k).length;
  const appComps = (k: "remove-app-components" | "add-app-components") =>
    ops.reduce((s, o) => s + (o.kind === k ? o.components.length : 0), 0);
  const parts = [
    n("remove") && `${plural(n("remove"), "component")} removed from the solution (RemoveSolutionComponent)`,
    n("add") && `${plural(n("add"), "component")} added to the solution (AddSolutionComponent)`,
    n("update-form") && `${plural(n("update-form"), "form")} updated (formxml)`,
    n("update-view") && `${plural(n("update-view"), "view")} updated (fetchxml, layoutxml)`,
    n("remove-app-components") && `${plural(appComps("remove-app-components"), "component")} removed from ${plural(n("remove-app-components"), "model-driven app")} (RemoveAppComponents)`,
    n("add-app-components") && `${plural(appComps("add-app-components"), "component")} added back to ${plural(n("add-app-components"), "model-driven app")} (AddAppComponents)`,
    (n("publish") || n("publish-apps")) && "then PublishXml",
  ].filter(Boolean);
  return parts.join(", ");
}

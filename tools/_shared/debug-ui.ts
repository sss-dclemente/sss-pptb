/** Footer switch for debug mode: "Debug log" toggle, Save log (n), Clear. See debug.ts. */
import { clearDebug, debugCount, debugFileName, debugOn, debugText, initDebug, onDebugChange, quietly, setDebug } from "./debug";
import { h } from "./dom";
import { getConnections, inToolbox, notify, powerplatform, saveText } from "./host";

/** Call first thing in main, before any host call. `tool` names the log file (`<tool>-debug-<timestamp>.txt`). */
export function mountDebug(where: Element | null, tool: string): void {
  initDebug(tool);
  const toggle = h("input", { type: "checkbox", id: "debug-toggle" }) as HTMLInputElement;
  const save = h("button", { id: "debug-save", class: "btn btn-ghost btn-sm", type: "button" }, "Save log");
  const clear = h("button", { id: "debug-clear", class: "btn btn-ghost btn-sm", type: "button" }, "Clear");
  const label = h("label", { class: "check", title: "Record every Dataverse, Power Platform and ToolBox call with its result or error, to save as a .txt file for troubleshooting. Responses include record data (truncated); secrets are redacted." }, toggle, "Debug log");
  where?.append(h("span", { class: "debugctl" }, label, save, clear));

  const sync = () => {
    toggle.checked = debugOn();
    save.hidden = clear.hidden = debugCount() === 0;
    save.textContent = `Save log (${debugCount()})`;
  };
  let pending = false;
  onDebugChange(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      sync();
    }, 100);
  });
  toggle.addEventListener("change", () => setDebug(toggle.checked));
  clear.addEventListener("click", () => clearDebug());
  save.addEventListener("click", async () => {
    const name = debugFileName();
    const ok = await quietly(async () => {
      const conns = await getConnections().catch(() => []);
      const text = debugText({
        host: inToolbox() ? "Power Platform ToolBox" : "standalone browser",
        powerplatformAPI: !!powerplatform(),
        connections: conns.map((c) => ({ target: c.target, name: c.conn.name, url: c.conn.url, environment: c.conn.environment })),
      });
      return saveText(name, text, "text/plain");
    });
    if (ok) await notify("Debug log saved", name, "success");
  });
  sync();
}

/**
 * Host adapter. Inside PPTB, window.toolboxAPI / window.dataverseAPI are injected.
 * Outside PPTB (plain browser) only snapshot columns work; file dialogs fall back to
 * <input type=file> and <a download>. No network access from this code.
 */
import type { Target } from "./matrix/types";

type Theme = "light" | "dark";
type W = { toolboxAPI?: ToolBoxAPI.API; dataverseAPI?: DataverseAPI.API };

const w = (): W => window as unknown as W;
export const toolbox = (): ToolBoxAPI.API | undefined => w().toolboxAPI;
export const dataverse = (): DataverseAPI.API | undefined => w().dataverseAPI;
export const inToolbox = (): boolean => !!toolbox()?.connections && !!dataverse();

export interface LiveConnection {
  target: Target;
  conn: ToolBoxAPI.Connection;
}

export async function getConnections(): Promise<LiveConnection[]> {
  const tb = toolbox();
  if (!tb?.connections) return [];
  const out: LiveConnection[] = [];
  const p = await tb.connections.getActiveConnection().catch(() => null);
  if (p) out.push({ target: "primary", conn: p });
  const s = await tb.connections.getSecondaryConnection?.().catch(() => null);
  if (s) out.push({ target: "secondary", conn: s });
  return out;
}

export function onConnectionChange(cb: () => void): void {
  try {
    toolbox()?.events?.on((_e: unknown, payload: ToolBoxAPI.ToolBoxEventPayload) => {
      if (typeof payload?.event === "string" && payload.event.startsWith("connection:")) cb();
    });
  } catch {
    /* outside PPTB */
  }
}

export async function initTheme(apply: (t: Theme) => void): Promise<void> {
  const tb = toolbox();
  let theme: Theme = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  if (tb?.utils?.getCurrentTheme) {
    try {
      theme = await tb.utils.getCurrentTheme();
    } catch {
      /* keep media query */
    }
  }
  apply(theme);
  try {
    tb?.events?.on((_e: unknown, payload: ToolBoxAPI.ToolBoxEventPayload) => {
      if (payload?.event === "settings:updated") {
        const t = (payload.data as { theme?: Theme } | undefined)?.theme;
        if (t === "light" || t === "dark") apply(t);
      }
    });
  } catch {
    /* no events */
  }
  if (!tb) window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", (e) => apply(e.matches ? "dark" : "light"));
}

export async function notify(title: string, body: string, type: "info" | "success" | "warning" | "error" = "info"): Promise<void> {
  const tb = toolbox();
  if (tb?.utils?.showNotification) {
    try {
      await tb.utils.showNotification({ title, body, type, duration: 4000 });
      return;
    } catch {
      /* fall through */
    }
  }
  console[type === "error" ? "error" : "log"](`${title}: ${body}`);
}

export async function saveText(defaultName: string, content: string, mime = "application/json"): Promise<boolean> {
  const tb = toolbox();
  if (tb?.fileSystem?.saveFile) return !!(await tb.fileSystem.saveFile(defaultName, content));
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export async function openText(): Promise<{ name: string; text: string } | null> {
  const tb = toolbox();
  if (tb?.fileSystem?.selectPath) {
    const path = await tb.fileSystem.selectPath({ type: "file", title: "Open matrix snapshot", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return null;
    return { name: path.split(/[\\/]/).pop() ?? path, text: await tb.fileSystem.readText(path) };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/**
 * Shared PPTB host adapter for SSS tools.
 * Inside ToolBox, window.toolboxAPI / window.dataverseAPI are injected by the host.
 * Outside (plain browser, e2e without mock) every helper degrades to a browser fallback.
 * Nothing here touches the network. Types come from each tool's tsconfig `types: ["@pptb/types"]`.
 */

export type Target = "primary" | "secondary";
export type Theme = "light" | "dark";
type W = { toolboxAPI?: ToolBoxAPI.API; dataverseAPI?: DataverseAPI.API };

const w = (): W => window as unknown as W;
export const toolbox = (): ToolBoxAPI.API | undefined => w().toolboxAPI;
export const dataverse = (): DataverseAPI.API | undefined => w().dataverseAPI;
/** True when the host injected the file-system API (desktop ToolBox). */
export const hasFileApi = (): boolean => !!toolbox()?.fileSystem?.selectPath;
/** True when connections + dataverse bridge are present. */
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
      /* keep media query value */
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

export interface PickedFile {
  name: string;
  data: Uint8Array;
}

export function toUint8(buf: unknown): Uint8Array {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  // Electron IPC may serialize a Buffer as { type: "Buffer", data: number[] }
  const o = buf as { type?: string; data?: number[] };
  if (o && o.type === "Buffer" && Array.isArray(o.data)) return Uint8Array.from(o.data);
  if (Array.isArray(buf)) return Uint8Array.from(buf as number[]);
  throw new Error("Unsupported binary payload from host");
}

function pickViaInput(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener("change", () => resolve(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

/** Pick binary files. ToolBox's selectPath is single-file; callers loop. Browser fallback honours `multiple`. */
export async function pickBinary(opts: { title: string; extensions: string[]; multiple?: boolean }): Promise<PickedFile[]> {
  const tb = toolbox();
  if (tb?.fileSystem?.selectPath) {
    const path = await tb.fileSystem.selectPath({
      type: "file",
      title: opts.title,
      filters: [
        { name: opts.extensions.map((e) => e.toUpperCase()).join(" / "), extensions: opts.extensions },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!path) return [];
    const raw = await tb.fileSystem.readBinary(path);
    return [{ name: path.split(/[\\/]/).pop() ?? path, data: toUint8(raw) }];
  }
  const files = await pickViaInput(opts.extensions.map((e) => `.${e}`).join(","), !!opts.multiple);
  return Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
}

/** Pick one text file. */
export async function openText(opts: { title: string; extensions: string[] }): Promise<{ name: string; text: string } | null> {
  const tb = toolbox();
  if (tb?.fileSystem?.selectPath) {
    const path = await tb.fileSystem.selectPath({ type: "file", title: opts.title, filters: [{ name: opts.extensions.join("/"), extensions: opts.extensions }] });
    if (!path) return null;
    return { name: path.split(/[\\/]/).pop() ?? path, text: await tb.fileSystem.readText(path) };
  }
  const [f] = await pickViaInput(opts.extensions.map((e) => `.${e}`).join(","), false);
  return f ? { name: f.name, text: await f.text() } : null;
}

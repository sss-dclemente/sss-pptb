/**
 * Host adapter. Inside PPTB, window.toolboxAPI is injected by the host and native
 * file dialogs are used. Outside PPTB (plain browser, dev), fall back to <input type=file>
 * and <a download>. Nothing here touches the network.
 */

export interface PickedFile {
  name: string;
  data: Uint8Array;
}

type Theme = "light" | "dark";

const tb = (): ToolBoxAPI.API | undefined => (window as unknown as { toolboxAPI?: ToolBoxAPI.API }).toolboxAPI;

export const inToolbox = (): boolean => !!tb()?.fileSystem?.selectPath;

function toUint8(buf: unknown): Uint8Array {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  // Electron IPC may serialize a Buffer as { type: "Buffer", data: number[] }
  const o = buf as { type?: string; data?: number[] };
  if (o && o.type === "Buffer" && Array.isArray(o.data)) return Uint8Array.from(o.data);
  if (Array.isArray(buf)) return Uint8Array.from(buf as number[]);
  throw new Error("Unsupported binary payload from host");
}

function pickViaInput(multiple: boolean): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.multiple = multiple;
    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
    });
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

/** Pick one or more solution zips. PPTB's selectPath is single-file; callers loop. */
export async function pickZips(multiple = true): Promise<PickedFile[]> {
  const api = tb();
  if (api?.fileSystem?.selectPath) {
    const path = await api.fileSystem.selectPath({
      type: "file",
      title: "Select a Dataverse solution zip",
      filters: [
        { name: "Solution zip", extensions: ["zip"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!path) return [];
    const raw = await api.fileSystem.readBinary(path);
    return [{ name: path.split(/[\\/]/).pop() ?? path, data: toUint8(raw) }];
  }
  return pickViaInput(multiple);
}

export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const files = Array.from(dt.files).filter((f) => /\.zip$/i.test(f.name));
  return Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
}

export async function saveText(defaultName: string, content: string, mime = "application/json"): Promise<boolean> {
  const api = tb();
  if (api?.fileSystem?.saveFile) {
    const p = await api.fileSystem.saveFile(defaultName, content);
    return !!p;
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

export async function notify(title: string, body: string, type: "info" | "success" | "warning" | "error" = "info"): Promise<void> {
  const api = tb();
  if (api?.utils?.showNotification) {
    try {
      await api.utils.showNotification({ title, body, type, duration: 4000 });
      return;
    } catch {
      /* fall through */
    }
  }
  console[type === "error" ? "error" : "log"](`${title}: ${body}`);
}

export async function initTheme(apply: (t: Theme) => void): Promise<void> {
  const api = tb();
  let theme: Theme = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  if (api?.utils?.getCurrentTheme) {
    try {
      theme = await api.utils.getCurrentTheme();
    } catch {
      /* keep media query value */
    }
  }
  apply(theme);
  try {
    api?.events?.on((_e: unknown, payload: ToolBoxAPI.ToolBoxEventPayload) => {
      if (payload?.event === "settings:updated") {
        const t = (payload.data as { theme?: Theme } | undefined)?.theme;
        if (t === "light" || t === "dark") apply(t);
      }
    });
  } catch {
    /* no events outside PPTB */
  }
  if (!api) {
    window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", (e) => apply(e.matches ? "dark" : "light"));
  }
}

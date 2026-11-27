/** XRay host adapter: shared PPTB bridge + zip-specific helpers. */
import { notify, pickBinary, toolbox, type PickedFile } from "../../_shared/host";
import { loadView, saveView } from "../../_shared/view-state";

export { hasFileApi as inToolbox, initTheme, notify, saveText, type PickedFile } from "../../_shared/host";

/** Pick one or more solution zips. PPTB's selectPath is single-file; callers loop. */
export const pickZips = (multiple = true): Promise<PickedFile[]> =>
  pickBinary({ title: "Select a Dataverse solution zip", extensions: ["zip"], multiple });

export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const files = Array.from(dt.files).filter((f) => /\.zip$/i.test(f.name));
  return Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
}

/** Tool setting: ToolBox settings store inside PPTB, localStorage in the browser. Never throws. */
export async function loadSetting<T>(key: string, fallback: T): Promise<T> {
  const st = toolbox()?.settings;
  if (!st) return loadView("solution-xray", key, fallback);
  try {
    return ((await st.get(key)) as T | undefined) ?? fallback;
  } catch {
    return fallback;
  }
}

export async function saveSetting(key: string, value: unknown): Promise<void> {
  const st = toolbox()?.settings;
  if (!st) return saveView("solution-xray", key, value);
  try {
    await st.set(key, value);
  } catch (err) {
    await notify("Could not save setting", (err as Error).message, "warning");
  }
}

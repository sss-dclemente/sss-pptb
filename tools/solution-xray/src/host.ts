/** XRay host adapter: shared PPTB bridge + zip-specific helpers. */
import { pickBinary, type PickedFile } from "../../_shared/host";

export { hasFileApi as inToolbox, initTheme, notify, saveText, type PickedFile } from "../../_shared/host";

/** Pick one or more solution zips. PPTB's selectPath is single-file; callers loop. */
export const pickZips = (multiple = true): Promise<PickedFile[]> =>
  pickBinary({ title: "Select a Dataverse solution zip", extensions: ["zip"], multiple });

export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const files = Array.from(dt.files).filter((f) => /\.zip$/i.test(f.name));
  return Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
}

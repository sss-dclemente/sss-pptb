/**
 * Per-viewer view settings (filters, toggles, hidden columns) kept in localStorage under `sss-view:<tool>`.
 * Storage can be blocked (private window, previews): every access is wrapped, and the tool works without it.
 */

type Saved = Record<string, unknown>;

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readAll(tool: string): Saved {
  try {
    const raw = store()?.getItem(`sss-view:${tool}`);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Saved) : {};
  } catch {
    return {};
  }
}

function writeAll(tool: string, all: Saved): void {
  try {
    store()?.setItem(`sss-view:${tool}`, JSON.stringify(all));
  } catch {
    /* storage blocked or full */
  }
}

/** A saved non-DOM value (e.g. hidden column keys), or `fallback`. */
export function loadView<T>(tool: string, key: string, fallback: T): T {
  const v = readAll(tool)[key];
  return v === undefined ? fallback : (v as T);
}

export function saveView(tool: string, key: string, value: unknown): void {
  const all = readAll(tool);
  if (value === undefined) delete all[key];
  else all[key] = value;
  writeAll(tool, all);
}

type Control = HTMLInputElement | HTMLSelectElement;

const isCheck = (c: Control): boolean => c instanceof HTMLInputElement && (c.type === "checkbox" || c.type === "radio");
function defaultOf(c: Control): string | boolean {
  if (c instanceof HTMLSelectElement) return [...c.options].find((o) => o.defaultSelected)?.value ?? c.options[0]?.value ?? "";
  return isCheck(c) ? c.defaultChecked : c.defaultValue;
}
const valueOf = (c: Control): string | boolean => (c instanceof HTMLInputElement && isCheck(c) ? c.checked : c.value);
function setValue(c: Control, v: unknown): void {
  if (c instanceof HTMLInputElement && isCheck(c)) {
    if (typeof v === "boolean") c.checked = v;
  } else if (typeof v === "string") {
    // a select only takes a value it currently offers; restore() again once its options are loaded
    if (c instanceof HTMLSelectElement && ![...c.options].some((o) => o.value === v)) return;
    c.value = v;
  }
}

export interface PersistedControls {
  /** Re-apply saved values, e.g. after a select's options were (re)loaded. */
  restore(): void;
  /** True when any control differs from its HTML default. */
  active(): boolean;
  /** Back to HTML defaults and saved; the caller re-renders once. */
  reset(): void;
}

/**
 * Save the given toolbar controls (by element id) on change and restore them now. Call before the first render.
 * Text inputs are saved too, so a search survives reopening the tool.
 */
export function persistControls(tool: string, ids: string[]): PersistedControls {
  const controls = ids.map((id) => document.getElementById(id)).filter((c): c is Control => c instanceof HTMLInputElement || c instanceof HTMLSelectElement);
  const key = (c: Control) => `ctl:${c.id}`;
  const save = (c: Control) => saveView(tool, key(c), valueOf(c) === defaultOf(c) ? undefined : valueOf(c));
  const restore = () => {
    const all = readAll(tool);
    for (const c of controls) if (key(c) in all) setValue(c, all[key(c)]);
  };
  for (const c of controls) c.addEventListener(isCheck(c) || c instanceof HTMLSelectElement ? "change" : "input", () => save(c));
  restore();
  return {
    restore,
    active: () => controls.some((c) => valueOf(c) !== defaultOf(c)),
    reset: () => {
      for (const c of controls) {
        setValue(c, defaultOf(c));
        save(c);
      }
    },
  };
}

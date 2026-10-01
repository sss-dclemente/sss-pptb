/**
 * Debug mode for SSS tools: while on, every host call (dataverseAPI, powerplatformAPI, toolboxAPI), its result or
 * error, notifications, connection events and uncaught errors go to an in-memory log the user saves as a .txt file.
 * Off by default; the switch is remembered per tool (localStorage) and `?debug=1` in the URL turns it on.
 * Secrets are redacted by key name, long strings, arrays and binary payloads are truncated. No imports: host.ts uses it.
 */

declare const __TOOL_VERSION__: string | undefined;

export type DebugLevel = "info" | "warn" | "error";

const MAX_BYTES = 5_000_000;
const MAX_STRING = 1500;
const MAX_ITEMS = 25;
const MAX_DEPTH = 6;
const MAX_LINE = 12_000;
const SECRET = /secret|password|passwd|token|authorization|cookie|credential|apikey|api_key/i;

let tool = "sss-tool";
let on = false;
let seq = 0;
let bytes = 0;
let dropped = 0;
let lines: string[] = [];
const started = Date.now();
const listeners = new Set<() => void>();

export const toolVersion = (): string => (typeof __TOOL_VERSION__ === "string" && __TOOL_VERSION__ ? __TOOL_VERSION__ : "dev");
export const debugOn = (): boolean => on;
export const debugCount = (): number => lines.length;
export const onDebugChange = (cb: () => void): void => void listeners.add(cb);
const changed = () => listeners.forEach((cb) => cb());

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Call once at start-up, before the first host call. */
export function initDebug(name: string): void {
  tool = name;
  let flag = false;
  try {
    flag = store()?.getItem(`sss-debug:${tool}`) === "1";
  } catch {
    /* storage blocked */
  }
  try {
    if (new URLSearchParams(window.location.search).get("debug") === "1") flag = true;
  } catch {
    /* no location */
  }
  window.addEventListener("error", (e) => dlog("error", "window", e.message || "error", { source: e.filename, line: e.lineno, stack: (e.error as Error | undefined)?.stack }));
  window.addEventListener("unhandledrejection", (e) => dlog("error", "window", "unhandled rejection", errorInfo(e.reason)));
  if (flag) setDebug(true);
}

export function setDebug(value: boolean): void {
  if (value === on) return;
  if (value) {
    on = true;
    dlog("info", "debug", `debug on: ${tool} ${toolVersion()}`, { userAgent: navigator.userAgent, url: location.href.split("?")[0] });
  } else {
    dlog("info", "debug", "debug off");
    on = false;
  }
  try {
    store()?.setItem(`sss-debug:${tool}`, value ? "1" : "0");
  } catch {
    /* storage blocked */
  }
  changed();
}

/** Run `fn` without recording (saving the log must not log its own content). */
export async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const was = on;
  on = false;
  try {
    return await fn();
  } finally {
    on = was;
  }
}

export function clearDebug(): void {
  lines = [];
  bytes = 0;
  dropped = 0;
  changed();
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function stamp(): string {
  const d = new Date();
  return `${d.toISOString()} +${pad(Math.round((d.getTime() - started) / 1000), 5)}s`;
}

/** Add a line (no-op while debug is off). `data` is serialized with redaction and truncation. */
export function dlog(level: DebugLevel, category: string, message: string, data?: unknown): void {
  if (!on) return;
  let line = `${stamp()} ${level.toUpperCase().padEnd(5)} [${category}] ${message}`;
  if (data !== undefined) line += ` ${format(data)}`;
  if (line.length > MAX_LINE) line = `${line.slice(0, MAX_LINE)} …(+${line.length - MAX_LINE} chars)`;
  lines.push(line);
  bytes += line.length + 1;
  while (bytes > MAX_BYTES && lines.length > 1) {
    bytes -= (lines.shift() as string).length + 1;
    dropped++;
  }
  changed();
}

/** The log as text, with a header. `context` lines (connections, host) go at the top. */
export function debugText(context: Record<string, unknown> = {}): string {
  const head = [
    `SSS ${tool} ${toolVersion()} debug log`,
    `saved ${new Date().toISOString()}, ${lines.length} lines${dropped ? `, ${dropped} oldest dropped (5 MB cap)` : ""}`,
    ...Object.entries(context).map(([k, v]) => `${k}: ${format(v)}`),
    "Secrets are redacted by key name; record data in responses is included (truncated). Review before sharing.",
    "-".repeat(80),
  ];
  return `${head.join("\n")}\n${lines.join("\n")}\n`;
}

export function debugFileName(at = new Date()): string {
  return `${tool}-debug-${at.toISOString().replace(/[:.]/g, "-").slice(0, 19)}.txt`;
}

// ---------- serialization ----------

function isBinary(v: unknown): number | null {
  if (v instanceof ArrayBuffer) return v.byteLength;
  if (ArrayBuffer.isView(v)) return v.byteLength;
  const o = v as { type?: unknown; data?: unknown };
  if (o && typeof o === "object" && o.type === "Buffer" && Array.isArray(o.data)) return o.data.length;
  return null;
}

function shrink(v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)} …(+${v.length - MAX_STRING} chars)` : v;
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "function") return `[function ${v.name || "anonymous"}]`;
  if (typeof v !== "object") return String(v);
  const bin = isBinary(v);
  if (bin !== null) return `[binary ${bin} bytes]`;
  if (v instanceof Error) return errorInfo(v);
  if (seen.has(v)) return "[circular]";
  if (depth >= MAX_DEPTH) return Array.isArray(v) ? `[array ${v.length}]` : "[object]";
  seen.add(v);
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ITEMS).map((x) => shrink(x, depth + 1, seen));
    if (v.length > MAX_ITEMS) out.push(`…(+${v.length - MAX_ITEMS} more)`);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET.test(k) && x != null && x !== "" ? "[redacted]" : shrink(x, depth + 1, seen);
  return out;
}

export function format(v: unknown): string {
  try {
    const s = shrink(v, 0, new WeakSet());
    return typeof s === "string" ? JSON.stringify(s) : (JSON.stringify(s) ?? String(s));
  } catch (e) {
    return `[unserializable: ${(e as Error).message}]`;
  }
}

export function errorInfo(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    const extra: Record<string, unknown> = {};
    for (const k of ["status", "statusCode", "code", "response", "body"]) if (k in e) extra[k] = (e as unknown as Record<string, unknown>)[k];
    return { name: e.name, message: e.message, ...extra, stack: e.stack?.split("\n").slice(0, 6).join(" | ") };
  }
  return { error: e as unknown };
}

// ---------- instrumentation ----------

const wrappers = new WeakMap<object, Map<string, unknown>>();

/**
 * A stand-in for a host object that logs each method call while debug is on, and is transparent while it is off.
 * The proxy target is an empty object, so property invariants of frozen host objects (Electron contextBridge) never
 * apply. Nested plain objects (powerplatformAPI.Connectivity) are wrapped too, under `label.prop`.
 */
export function instrument<T extends object>(real: T, label: string): T {
  let cache = wrappers.get(real);
  if (!cache) wrappers.set(real, (cache = new Map()));
  const hit = cache.get(label);
  if (hit) return hit as T;
  const proxy = new Proxy(Object.create(null) as object, {
    has: (_t, p) => p in real,
    get: (_t, p) => {
      const v = Reflect.get(real, p) as unknown;
      if (typeof p !== "string") return v;
      if (typeof v === "function") return wrapFn(real, v as (...a: unknown[]) => unknown, `${label}.${p}`);
      if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return instrument(v as object, `${label}.${p}`);
      return v;
    },
  });
  cache.set(label, proxy);
  return proxy as T;
}

function wrapFn(self: object, fn: (...a: unknown[]) => unknown, name: string): (...a: unknown[]) => unknown {
  return (...args: unknown[]) => {
    if (!on) return fn.apply(self, args);
    const id = ++seq;
    const t = performance.now();
    const ms = () => `${Math.round(performance.now() - t)} ms`;
    dlog("info", "call", `#${id} ${name}`, args);
    let r: unknown;
    try {
      r = fn.apply(self, args);
    } catch (e) {
      dlog("error", "call", `#${id} ${name} threw after ${ms()}`, errorInfo(e));
      throw e;
    }
    if (r && typeof (r as Promise<unknown>).then === "function")
      return (r as Promise<unknown>).then(
        (res) => {
          dlog("info", "call", `#${id} ${name} ok ${ms()}`, res);
          return res;
        },
        (e) => {
          dlog("error", "call", `#${id} ${name} failed after ${ms()}`, errorInfo(e));
          throw e;
        },
      );
    dlog("info", "call", `#${id} ${name} returned ${ms()}`, r);
    return r;
  };
}

/**
 * Run log: one entry per write the tool performs (or refuses), across every write path, for audit evidence.
 * Kept in memory and mirrored to localStorage (best effort, capped) so it survives a tool reload; exported as JSON or CSV.
 */
import { csvCell } from "./export";

export interface RunLogEntry {
  at: string;
  /** e.g. "set env var", "bind", "merge: update flow", "delete reference", "turn on flow", "add to solution" */
  action: string;
  environment: string;
  url: string;
  /** what was written: variable, reference or flow name */
  item: string;
  /** before → after, or other short detail */
  detail: string;
  ok: boolean;
  error?: string;
}

export const RUN_LOG_MAX = 2000;
const KEY = "sss-envvar-matrix-runlog";

export interface StoreLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export class RunLog {
  private entries: RunLogEntry[] = [];
  constructor(private store: StoreLike | null = null) {
    try {
      const raw = store?.getItem(KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : [];
      if (Array.isArray(parsed)) this.entries = (parsed as RunLogEntry[]).filter((e) => e && typeof e.action === "string").slice(-RUN_LOG_MAX);
    } catch {
      this.entries = [];
    }
  }

  get all(): readonly RunLogEntry[] {
    return this.entries;
  }

  add(e: Omit<RunLogEntry, "at"> & { at?: string }): void {
    this.entries.push({ ...e, at: e.at ?? new Date().toISOString() });
    if (this.entries.length > RUN_LOG_MAX) this.entries.splice(0, this.entries.length - RUN_LOG_MAX);
    this.persist();
  }

  clear(): void {
    this.entries = [];
    try {
      this.store?.removeItem(KEY);
    } catch {
      /* storage unavailable */
    }
  }

  private persist(): void {
    try {
      this.store?.setItem(KEY, JSON.stringify(this.entries));
    } catch {
      /* quota or storage unavailable: the in-memory log still works */
    }
  }

  json(): string {
    return JSON.stringify({ kind: "sss-envvar-matrix-runlog", version: 1, exportedAt: new Date().toISOString(), entries: this.entries }, null, 2);
  }

  csv(): string {
    const head = ["at", "action", "environment", "url", "item", "detail", "result", "error"];
    const rows = this.entries.map((e) => [e.at, e.action, e.environment, e.url, e.item, e.detail, e.ok ? "ok" : "failed", e.error ?? ""]);
    return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
  }
}

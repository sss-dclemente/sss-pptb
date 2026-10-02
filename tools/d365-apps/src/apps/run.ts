/**
 * Run installs (plan §3): one at a time per environment, up to `envConcurrency` environments at once.
 * Each install is polled until it ends: by operation id when the install response carried one, otherwise by the
 * package's state in the environment (plan D7). "Stop waiting" only stops polling: an install already started keeps
 * running in the environment (the API has no cancel).
 */
import { errText, operationStatus, packageState, startInstall, type PpLike } from "./api";
import type { PlannedInstall, RunItem } from "./types";

export interface RunOptions {
  pp: PpLike;
  items: RunItem[];
  envConcurrency?: number;
  pollMs?: number;
  /** give up waiting on one install after this long (default 4 h) */
  maxWaitMs?: number;
  onChange: (item: RunItem) => void;
  stopped: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export const toRunItems = (plan: PlannedInstall[]): RunItem[] => plan.map((p) => ({ ...p, status: "queued", operationId: null, message: null, startedAt: null, endedAt: null }));

const MAX_POLL_ERRORS = 5;
/** consecutive refused installs after which the rest of that environment's queue is not started */
export const MAX_REFUSED = 2;

/** The host returns no response body, so a bare HTTP 400 gets the usual causes appended. */
export function refusalMessage(e: unknown): string {
  const m = errText(e);
  return /^HTTP 400\s*$/i.test(m.trim())
    ? "HTTP 400: the environment refused the install. Usual causes: another install or update is already running there, the app needs a prerequisite app first, or the environment does not allow it (Dynamics 365 apps not enabled, wrong environment type). Check PPAC → the environment → Dynamics 365 apps."
    : m;
}

export async function runInstalls(o: RunOptions): Promise<void> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = o.pollMs ?? 15_000;
  const maxWait = o.maxWaitMs ?? 4 * 3600_000;
  const set = (it: RunItem, patch: Partial<RunItem>) => {
    Object.assign(it, patch);
    if (patch.status && patch.status !== "starting" && patch.status !== "running" && patch.status !== "queued") it.endedAt = new Date().toISOString();
    o.onChange(it);
  };

  const groups = new Map<string, RunItem[]>();
  for (const it of o.items) groups.set(it.env.id, [...(groups.get(it.env.id) ?? []), it]);

  const runEnv = async (list: RunItem[]) => {
    let refused = 0;
    for (const it of list) {
      if (o.stopped()) {
        set(it, { status: "stopped", message: "not started" });
        continue;
      }
      // an environment that refused two installs in a row refuses the rest too (seen on a real tenant): stop asking
      if (refused >= MAX_REFUSED) {
        set(it, { status: "stopped", message: `not started: the environment refused the previous ${MAX_REFUSED} installs` });
        continue;
      }
      set(it, { status: "starting", startedAt: new Date().toISOString() });
      let opId: string | null;
      try {
        opId = await startInstall(o.pp, it.env.id, it.uniqueName);
        refused = 0;
      } catch (e) {
        refused++;
        set(it, { status: "failed", message: refusalMessage(e) });
        continue;
      }
      set(it, { status: "running", operationId: opId, message: opId ? null : "no operation id: watching the package state" });
      const start = Date.now();
      let pollErrors = 0;
      for (;;) {
        await sleep(pollMs);
        if (o.stopped()) {
          set(it, { status: "stopped", message: "stopped waiting; the install continues in the environment" });
          break;
        }
        if (Date.now() - start > maxWait) {
          set(it, { status: "stopped", message: "still running after the wait limit; check the environment in PPAC" });
          break;
        }
        try {
          const st = opId ? await operationStatus(o.pp, it.env.id, opId) : await packageState(o.pp, it.env.id, it.uniqueName);
          pollErrors = 0;
          if (st.status === "Succeeded") {
            set(it, { status: "succeeded", message: null });
            break;
          }
          if (st.status === "Failed") {
            set(it, { status: "failed", message: st.message ?? "failed" });
            break;
          }
          if (st.status === "Canceled") {
            set(it, { status: "canceled", message: st.message });
            break;
          }
          if (st.message !== it.message) set(it, { message: st.message });
        } catch (e) {
          if (++pollErrors >= MAX_POLL_ERRORS) {
            set(it, { status: "stopped", message: `lost track of the install: ${errText(e)}` });
            break;
          }
        }
      }
    }
  };

  const queue = [...groups.values()];
  const workers = Array.from({ length: Math.min(o.envConcurrency ?? 3, queue.length) }, async () => {
    for (let g = queue.shift(); g; g = queue.shift()) await runEnv(g);
  });
  await Promise.all(workers);
}

/** The items "Only problems" keeps: everything that did not succeed (failed, stopped, canceled, still queued or running). A run without any is clean. */
export const runProblems = (items: RunItem[]): RunItem[] => items.filter((i) => i.status !== "succeeded");

/** D365 Apps Matrix model. See docs/D365-APPS-PLAN.md. */

export interface Environment {
  id: string;
  name: string;
  /** Production, Sandbox, Developer, Trial, Default… as the API reports it */
  type: string;
  state: string;
  url: string | null;
  geo: string | null;
  hasDataverse: boolean;
}

/** One package entry as listed for an environment (installed instance or catalog entry), normalized. */
export interface Package {
  uniqueName: string;
  name: string;
  version: string | null;
  /** InstancePackageState: Installed, InstallFailed, Installing, None… ("" when absent) */
  state: string;
  publisher: string | null;
  customHandleUpgrade: boolean;
  error: string | null;
  learnMoreUrl: string | null;
}

export interface EnvPackages {
  env: Environment;
  installed: Package[];
  available: Package[];
  /** set when the environment could not be read */
  error: string | null;
  setupError: boolean;
}

export type CellKind = "current" | "update" | "failed" | "busy" | "available" | "absent";
export type ActionKind = "update" | "retry" | "install";

export interface Cell {
  kind: CellKind;
  installed: Package | null;
  /** newer catalog entry (update) or the entry to install (available) */
  target: Package | null;
  action: ActionKind | null;
  /** shown under the version: error message, state, custom upgrade note */
  note: string | null;
}

export interface Row {
  uniqueName: string;
  name: string;
  publisher: string | null;
  customHandleUpgrade: boolean;
  /** env id → cell */
  cells: Map<string, Cell>;
}

export interface Matrix {
  envs: Environment[];
  rows: Row[];
  /** env id → read error */
  errors: Map<string, string>;
}

export interface PlannedInstall {
  env: Environment;
  uniqueName: string;
  name: string;
  action: ActionKind;
  from: string | null;
  to: string | null;
  customHandleUpgrade: boolean;
}

export type RunStatus = "queued" | "starting" | "running" | "succeeded" | "failed" | "canceled" | "stopped";

export interface RunItem extends PlannedInstall {
  status: RunStatus;
  operationId: string | null;
  message: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

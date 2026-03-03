export interface WatchHealth {
  connected: boolean;
  sourceLabel: string;
  warnings: string[];
}

export interface WatchSnapshot<TAgent> {
  agents: TAgent[];
  health: WatchHealth;
}

export interface WatchSource<TAgent> {
  connect?(): Promise<void> | void;
  disconnect?(): Promise<void> | void;
  readSnapshot(now?: number): Promise<WatchSnapshot<TAgent>> | WatchSnapshot<TAgent>;
  getWatchPaths?(): string[];
}

export const WATCH_LIFECYCLE_KIND = {
  joined: "joined",
  statusChanged: "statusChanged",
  heartbeat: "heartbeat",
  left: "left",
} as const;
export type WatchLifecycleKind = (typeof WATCH_LIFECYCLE_KIND)[keyof typeof WATCH_LIFECYCLE_KIND];

export const WATCH_RUNTIME_EVENT_TYPES = {
  snapshot: "snapshot",
  lifecycle: "lifecycle",
  state: "state",
  error: "error",
} as const;

export const WATCH_RUNTIME_STATES = {
  started: "started",
  stopped: "stopped",
} as const;

export const WATCH_RUNTIME_ERROR_MESSAGES = {
  notRunning: "Watch runtime is not running.",
  stoppedBeforeRefreshCompleted: "Watch runtime stopped before refresh completed.",
} as const;

export const WATCH_RUNTIME_ERROR_CODES = {
  notRunning: "NOT_RUNNING",
  stoppedBeforeRefreshCompleted: "STOPPED_BEFORE_REFRESH_COMPLETED",
} as const;
export type WatchRuntimeErrorCode =
  (typeof WATCH_RUNTIME_ERROR_CODES)[keyof typeof WATCH_RUNTIME_ERROR_CODES];

export class WatchRuntimeError extends Error {
  code: WatchRuntimeErrorCode;

  constructor(code: WatchRuntimeErrorCode, message: string) {
    super(message);
    this.name = "WatchRuntimeError";
    this.code = code;
  }
}

export function isWatchRuntimeError(error: unknown): error is WatchRuntimeError {
  return error instanceof WatchRuntimeError;
}

export const AGENT_SUBSCRIPTION_EVENT_TYPES = {
  snapshot: "snapshot",
  updated: "updated",
  errored: "errored",
  started: "started",
  stopped: "stopped",
} as const;

export interface WatchLifecycleEvent<TStatus extends string = string> {
  kind: WatchLifecycleKind;
  agentId: string;
  at: number;
  fromStatus: TStatus | null;
  toStatus: TStatus | null;
}

export interface LifecycleSnapshot<TAgent, TStatus extends string = string> {
  getId(agent: TAgent): string;
  getStatus(agent: TAgent): TStatus;
}

export interface WatchRuntimeOptions<TAgent, TStatus extends string = string> {
  source: WatchSource<TAgent>;
  lifecycle: LifecycleSnapshot<TAgent, TStatus>;
  debounceMs?: number;
  now?: () => number;
  watchPaths?: string[];
  subscribeToChanges?: (
    watchPath: string,
    onEvent: () => void,
    onError: (error: Error) => void,
  ) => { close(): void };
}

export type WatchRuntimeEvent<TAgent, TStatus extends string = string> =
  | {
      type: typeof WATCH_RUNTIME_EVENT_TYPES.snapshot;
      at: number;
      snapshot: WatchSnapshot<TAgent>;
    }
  | {
      type: typeof WATCH_RUNTIME_EVENT_TYPES.lifecycle;
      at: number;
      events: WatchLifecycleEvent<TStatus>[];
    }
  | {
      type: typeof WATCH_RUNTIME_EVENT_TYPES.state;
      at: number;
      state: (typeof WATCH_RUNTIME_STATES)[keyof typeof WATCH_RUNTIME_STATES];
    }
  | { type: typeof WATCH_RUNTIME_EVENT_TYPES.error; at: number; error: unknown };

export interface WatchRuntime<TAgent, TStatus extends string = string> {
  start(): Promise<void>;
  stop(): Promise<void>;
  refreshNow(): Promise<WatchSnapshot<TAgent>>;
  subscribe(listener: (event: WatchRuntimeEvent<TAgent, TStatus>) => void): () => void;
}

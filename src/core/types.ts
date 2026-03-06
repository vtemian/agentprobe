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

export interface WatchRuntimeSnapshotEvent<TAgent> {
  type: typeof WATCH_RUNTIME_EVENT_TYPES.snapshot;
  at: number;
  snapshot: WatchSnapshot<TAgent>;
}

export interface WatchRuntimeLifecycleEvent<TStatus extends string = string> {
  type: typeof WATCH_RUNTIME_EVENT_TYPES.lifecycle;
  at: number;
  events: WatchLifecycleEvent<TStatus>[];
}

export interface WatchRuntimeStateEvent {
  type: typeof WATCH_RUNTIME_EVENT_TYPES.state;
  at: number;
  state: (typeof WATCH_RUNTIME_STATES)[keyof typeof WATCH_RUNTIME_STATES];
}

export interface WatchRuntimeErrorEvent {
  type: typeof WATCH_RUNTIME_EVENT_TYPES.error;
  at: number;
  error: Error;
}

export type WatchRuntimeEvent<TAgent, TStatus extends string = string> =
  | WatchRuntimeSnapshotEvent<TAgent>
  | WatchRuntimeLifecycleEvent<TStatus>
  | WatchRuntimeStateEvent
  | WatchRuntimeErrorEvent;

export interface WatchRuntime<TAgent, TStatus extends string = string> {
  start(): Promise<void>;
  stop(): Promise<void>;
  refreshNow(): Promise<WatchSnapshot<TAgent>>;
  subscribe(listener: (event: WatchRuntimeEvent<TAgent, TStatus>) => void): () => void;
}

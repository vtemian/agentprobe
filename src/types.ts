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

export type WatchLifecycleKind = "joined" | "statusChanged" | "heartbeat" | "left";

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
  | { type: "snapshot"; at: number; snapshot: WatchSnapshot<TAgent> }
  | { type: "lifecycle"; at: number; events: WatchLifecycleEvent<TStatus>[] }
  | { type: "state"; at: number; state: "started" | "stopped" }
  | { type: "error"; at: number; error: unknown };

export interface WatchRuntime<TAgent, TStatus extends string = string> {
  start(): Promise<void>;
  stop(): Promise<void>;
  refreshNow(): Promise<WatchSnapshot<TAgent>>;
  subscribe(listener: (event: WatchRuntimeEvent<TAgent, TStatus>) => void): () => void;
}

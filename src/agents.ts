import { statSync, watch } from "node:fs";
import path from "node:path";
import { createWatchRuntime } from "./runtime";
import { resolveTranscriptDirectories, resolveTranscriptSourcePaths } from "./discovery";
import { createCursorTranscriptSource } from "./transcripts";
import type { WatchSource } from "./types";
import {
  AGENT_SUBSCRIPTION_EVENT_TYPES,
  WATCH_RUNTIME_EVENT_TYPES,
  WATCH_RUNTIME_STATES,
} from "./types";
import type {
  AgentLifecycleEvent,
  AgentSnapshot,
  AgentSourceReadResult,
  AgentStatus,
} from "@shared/types";
import { AGENT_SOURCE_KIND } from "@shared/types";

interface AgentSourceLike {
  connect(): Promise<void> | void;
  disconnect(): Promise<void> | void;
  readSnapshot(now?: number): Promise<AgentSourceReadResult> | AgentSourceReadResult;
  getWatchPaths?(): string[];
}

interface WatcherLike {
  close(): void;
  on(event: typeof WATCHER_ERROR_EVENT, listener: (error: Error) => void): void;
}

const WATCHER_ERROR_EVENT = "error" as const;
const WATCHER_OPTIONS = { persistent: false } as const;

export interface AgentStateSnapshot {
  at: number;
  agents: AgentSnapshot[];
  health: AgentSubscriptionHealth;
}

export interface AgentSubscriptionHealth {
  connected: boolean;
  sourceLabel: string;
  warnings: string[];
}

export type AgentChange = AgentLifecycleEvent;

export interface AgentUpdatedEvent {
  type: typeof AGENT_SUBSCRIPTION_EVENT_TYPES.updated;
  at: number;
  change: AgentChange;
  agent: AgentSnapshot;
  snapshot: AgentStateSnapshot;
}

export interface AgentSnapshotEvent {
  type: typeof AGENT_SUBSCRIPTION_EVENT_TYPES.snapshot;
  at: number;
  snapshot: AgentStateSnapshot;
  agent: AgentSnapshot | undefined;
}

export type AgentSubscriptionEvent =
  | AgentSnapshotEvent
  | AgentUpdatedEvent
  | {
      type: typeof AGENT_SUBSCRIPTION_EVENT_TYPES.errored;
      at: number;
      error: unknown;
      agent: AgentSnapshot | undefined;
    }
  | { type: typeof AGENT_SUBSCRIPTION_EVENT_TYPES.started; at: number; agent: AgentSnapshot | undefined }
  | { type: typeof AGENT_SUBSCRIPTION_EVENT_TYPES.stopped; at: number; agent: AgentSnapshot | undefined };

export interface AgentSubscriptionOptions {
  projectPath: string;
  projectPaths?: string[];
  debounceMs?: number;
  now?: () => number;
  sourceFactory?: (projectPath: string) => AgentSourceLike;
  watchFactory?: (watchPath: string, onEvent: () => void) => WatcherLike;
}

export interface AgentSubscription {
  start(): Promise<void>;
  stop(): Promise<void>;
  refreshNow(): Promise<AgentStateSnapshot>;
  getLatestSnapshot(): AgentStateSnapshot | undefined;
  subscribe(listener: (event: AgentSubscriptionEvent) => void): () => void;
  subscribeToAgentChanges(listener: (event: AgentUpdatedEvent) => void): () => void;
  subscribeToSnapshots(listener: (event: AgentSnapshotEvent) => void): () => void;
}

export function createAgentSubscription(options: AgentSubscriptionOptions): AgentSubscription {
  const now = options.now ?? (() => Date.now());
  const sourceFactory = options.sourceFactory;
  const watchFactory = options.watchFactory ?? createDefaultWatcher;
  const workspacePaths = normalizeSourcePaths(options.projectPaths ?? [options.projectPath]);
  const listeners = new Set<(event: AgentSubscriptionEvent) => void>();
  const snapshotAtByRef = new WeakMap<object, number>();
  let previousSnapshot: AgentStateSnapshot | undefined;
  let latestSnapshot: AgentStateSnapshot | undefined;

  const source = sourceFactory
    ? sourceFactory(options.projectPath)
    : createDefaultSourceFactory(workspacePaths);
  const sourceWatchPaths = source.getWatchPaths?.() ?? [];
  const watchRoots = resolveWatchRoots(sourceWatchPaths);

  const runtime = createWatchRuntime<AgentSnapshot, AgentStatus>({
    source: {
      connect: () => source.connect(),
      disconnect: () => source.disconnect(),
      readSnapshot: async (at?: number) => {
        const result = await source.readSnapshot(at);
        return {
          agents: result.agents,
          health: {
            connected: result.connected,
            sourceLabel: result.sourceLabel,
            warnings: result.warnings,
          },
        };
      },
    } satisfies WatchSource<AgentSnapshot>,
    lifecycle: {
      getId: (agent) => agent.id,
      getStatus: (agent) => agent.status,
    },
    debounceMs: options.debounceMs,
    now,
    watchPaths: watchRoots,
    subscribeToChanges: (watchPath, onEvent, onError) => {
      const watcher = watchFactory(watchPath, onEvent);
      watcher.on(WATCHER_ERROR_EVENT, onError);
      return { close: () => watcher.close() };
    },
  });

  runtime.subscribe((event) => {
    if (event.type === WATCH_RUNTIME_EVENT_TYPES.snapshot) {
      snapshotAtByRef.set(event.snapshot as object, event.at);
      previousSnapshot = latestSnapshot;
      latestSnapshot = {
        at: event.at,
        agents: event.snapshot.agents,
        health: event.snapshot.health,
      };
      emit({
        type: AGENT_SUBSCRIPTION_EVENT_TYPES.snapshot,
        at: event.at,
        snapshot: latestSnapshot,
        agent: undefined,
      });
      return;
    }

    if (event.type === WATCH_RUNTIME_EVENT_TYPES.lifecycle) {
      if (!latestSnapshot) {
        return;
      }
      const currentById = indexAgentsById(latestSnapshot.agents);
      const previousById = indexAgentsById(previousSnapshot?.agents ?? []);
      for (const change of event.events) {
        const agent = currentById.get(change.agentId) ?? previousById.get(change.agentId);
        if (!agent) {
          continue;
        }
        emit({
          type: AGENT_SUBSCRIPTION_EVENT_TYPES.updated,
          at: event.at,
          change,
          agent,
          snapshot: latestSnapshot,
        });
      }
      return;
    }

    if (event.type === WATCH_RUNTIME_EVENT_TYPES.error) {
      emit({
        type: AGENT_SUBSCRIPTION_EVENT_TYPES.errored,
        at: event.at,
        error: event.error,
        agent: undefined,
      });
      return;
    }

    if (event.state === WATCH_RUNTIME_STATES.started) {
      emit({ type: AGENT_SUBSCRIPTION_EVENT_TYPES.started, at: event.at, agent: undefined });
      return;
    }
    emit({ type: AGENT_SUBSCRIPTION_EVENT_TYPES.stopped, at: event.at, agent: undefined });
  });

  function subscribe(listener: (event: AgentSubscriptionEvent) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function subscribeToAgentChanges(listener: (event: AgentUpdatedEvent) => void): () => void {
    return subscribe((event) => {
      if (isAgentUpdatedEvent(event)) {
        listener(event);
      }
    });
  }

  function subscribeToSnapshots(listener: (event: AgentSnapshotEvent) => void): () => void {
    return subscribe((event) => {
      if (event.type === AGENT_SUBSCRIPTION_EVENT_TYPES.snapshot) {
        listener(event);
      }
    });
  }

  async function refreshNow(): Promise<AgentStateSnapshot> {
    const snapshot = await runtime.refreshNow();
    const at = snapshotAtByRef.get(snapshot as object) ?? now();
    return {
      at,
      agents: snapshot.agents,
      health: snapshot.health,
    };
  }

  function emit(event: AgentSubscriptionEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Keep subscription fan-out resilient to listener failures.
      }
    }
  }

  return {
    start: () => runtime.start(),
    stop: () => runtime.stop(),
    refreshNow,
    getLatestSnapshot: () => latestSnapshot,
    subscribe,
    subscribeToAgentChanges,
    subscribeToSnapshots,
  };
}

export function isAgentUpdatedEvent(event: AgentSubscriptionEvent): event is AgentUpdatedEvent {
  return event.type === AGENT_SUBSCRIPTION_EVENT_TYPES.updated;
}

function indexAgentsById(agents: AgentSnapshot[]): Map<string, AgentSnapshot> {
  const byId = new Map<string, AgentSnapshot>();
  for (const agent of agents) {
    byId.set(agent.id, agent);
  }
  return byId;
}

function createDefaultSourceFactory(workspacePaths: string[]): AgentSourceLike {
  const watchRoots = resolveTranscriptDirectories({ workspacePaths });
  let connected = false;

  return {
    connect(): void {
      connected = true;
    },
    disconnect(): void {
      connected = false;
    },
    async readSnapshot(nowAt?: number): Promise<AgentSourceReadResult> {
      if (!connected) {
        return {
          agents: [],
          connected: false,
          sourceLabel: AGENT_SOURCE_KIND.cursorTranscripts,
          warnings: ["Cursor transcript source is disconnected."],
        };
      }

      const sourcePaths = normalizeSourcePaths(
        resolveTranscriptSourcePaths({
          workspacePaths,
        }),
      );
      const source = createCursorTranscriptSource({
        sourcePaths,
      });
      source.connect();
      return source.readSnapshot(nowAt);
    },
    getWatchPaths(): string[] {
      return watchRoots;
    },
  };
}

function normalizeSourcePaths(sourcePaths: readonly string[]): string[] {
  return sourcePaths
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function createDefaultWatcher(watchPath: string, onEvent: () => void): WatcherLike {
  const onChange = (): void => {
    onEvent();
  };

  const useRecursive = supportsRecursiveWatch(watchPath);
  if (useRecursive) {
    try {
      return watch(watchPath, { ...WATCHER_OPTIONS, recursive: true }, onChange);
    } catch {
      // Fall back to non-recursive watch when recursive mode is unavailable.
    }
  }

  return watch(watchPath, WATCHER_OPTIONS, onChange);
}

function resolveWatchRoots(sourcePaths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const sourcePath of sourcePaths) {
    const trimmed = sourcePath.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let candidate = trimmed;
    try {
      const stats = statSync(trimmed);
      candidate = stats.isDirectory() ? trimmed : path.dirname(trimmed);
    } catch {
      candidate = path.dirname(trimmed);
    }
    const watchRoot = findExistingDirectory(candidate);
    if (watchRoot) {
      roots.add(watchRoot);
    }
  }
  return Array.from(roots);
}

function findExistingDirectory(entryPath: string): string | undefined {
  let current = entryPath;
  while (current.length > 0) {
    if (isFilesystemRoot(current)) {
      return undefined;
    }
    try {
      if (statSync(current).isDirectory()) {
        return current;
      }
    } catch {
      // Keep walking up until an existing parent is found.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

function isFilesystemRoot(entryPath: string): boolean {
  return path.dirname(entryPath) === entryPath;
}

function supportsRecursiveWatch(watchPath: string): boolean {
  try {
    return statSync(watchPath).isDirectory();
  } catch {
    return false;
  }
}

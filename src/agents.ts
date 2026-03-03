import { statSync, watch } from "node:fs";
import path from "node:path";
import { createAgentSource } from "@ext/sources";
import { resolveTranscriptSourcePaths } from "@ext/sources/discovery";
import { createWatchRuntime } from "./runtime";
import type { WatchHealth, WatchLifecycleEvent, WatchSource } from "./types";
import type { AgentSnapshot, AgentSourceReadResult, AgentStatus } from "@shared/types";

interface AgentSourceLike {
  connect(): Promise<void> | void;
  disconnect(): Promise<void> | void;
  readSnapshot(now?: number): Promise<AgentSourceReadResult> | AgentSourceReadResult;
  getWatchPaths?(): string[];
}

interface WatcherLike {
  close(): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface AgentStateSnapshot {
  at: number;
  agents: AgentSnapshot[];
  health: WatchHealth;
}

export type AgentChange = WatchLifecycleEvent<AgentStatus>;

export type AgentSubscriptionEvent =
  | {
      type: "updated";
      at: number;
      change: AgentChange;
      agent: AgentSnapshot;
      snapshot: AgentStateSnapshot;
    }
  | { type: "errored"; at: number; error: unknown; agent: AgentSnapshot | undefined }
  | { type: "started"; at: number; agent: AgentSnapshot | undefined }
  | { type: "stopped"; at: number; agent: AgentSnapshot | undefined };

export interface AgentSubscriptionOptions {
  projectPath: string;
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
}

export function createAgentSubscription(options: AgentSubscriptionOptions): AgentSubscription {
  const now = options.now ?? (() => Date.now());
  const sourceFactory = options.sourceFactory ?? createDefaultSourceFactory;
  const watchFactory = options.watchFactory ?? createDefaultWatcher;
  const listeners = new Set<(event: AgentSubscriptionEvent) => void>();
  let previousSnapshot: AgentStateSnapshot | undefined;
  let latestSnapshot: AgentStateSnapshot | undefined;

  const source = sourceFactory(options.projectPath);
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
      watcher.on("error", onError);
      return { close: () => watcher.close() };
    },
  });

  runtime.subscribe((event) => {
    if (event.type === "snapshot") {
      previousSnapshot = latestSnapshot;
      latestSnapshot = {
        at: event.at,
        agents: event.snapshot.agents,
        health: event.snapshot.health,
      };
      return;
    }

    if (event.type === "lifecycle") {
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
          type: "updated",
          at: event.at,
          change,
          agent,
          snapshot: latestSnapshot,
        });
      }
      return;
    }

    if (event.type === "error") {
      emit({ type: "errored", at: event.at, error: event.error, agent: undefined });
      return;
    }

    if (event.state === "started") {
      emit({ type: "started", at: event.at, agent: undefined });
      return;
    }
    emit({ type: "stopped", at: event.at, agent: undefined });
  });

  function subscribe(listener: (event: AgentSubscriptionEvent) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  async function refreshNow(): Promise<AgentStateSnapshot> {
    const snapshot = await runtime.refreshNow();
    if (latestSnapshot) {
      return latestSnapshot;
    }
    return {
      at: now(),
      agents: snapshot.agents,
      health: snapshot.health,
    };
  }

  function emit(event: AgentSubscriptionEvent): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  return {
    start: () => runtime.start(),
    stop: () => runtime.stop(),
    refreshNow,
    getLatestSnapshot: () => latestSnapshot,
    subscribe,
  };
}

function indexAgentsById(agents: AgentSnapshot[]): Map<string, AgentSnapshot> {
  const byId = new Map<string, AgentSnapshot>();
  for (const agent of agents) {
    byId.set(agent.id, agent);
  }
  return byId;
}

function createDefaultSourceFactory(projectPath: string): AgentSourceLike {
  const sourcePaths = resolveTranscriptSourcePaths({
    workspacePaths: [projectPath],
  });
  return createAgentSource({
    transcriptOptions: { sourcePaths },
  });
}

function createDefaultWatcher(watchPath: string, onEvent: () => void): WatcherLike {
  const watcher = watch(watchPath, { persistent: false }, () => {
    onEvent();
  });
  return watcher;
}

function resolveWatchRoots(sourcePaths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const sourcePath of sourcePaths) {
    const trimmed = sourcePath.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let isDirectory = false;
    try {
      const stats = statSync(trimmed);
      isDirectory = stats.isDirectory();
    } catch {
      // Fall back to parent directory when stat fails.
    }

    roots.add(isDirectory ? trimmed : path.dirname(trimmed));
  }
  return Array.from(roots);
}

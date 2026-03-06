import { createWatchRuntime } from "./runtime/index";
import { WATCH_RUNTIME_EVENT_TYPES, WATCH_RUNTIME_STATES, type WatchSource } from "./types";
import type { CanonicalAgentSnapshot, CanonicalAgentStatus } from "./model";
import type {
  CanonicalSnapshot,
  DiscoveryInput,
  DiscoveryResult,
  TranscriptProvider,
  TranscriptReadResult,
} from "./providers";
import type { WatchHealth, WatchLifecycleEvent } from "./types";

export const OBSERVER_EVENT_TYPES = {
  snapshot: "snapshot",
  updated: "updated",
  errored: "errored",
  started: "started",
  stopped: "stopped",
} as const;

export interface ObserverSnapshot {
  at: number;
  agents: CanonicalAgentSnapshot[];
  health: WatchHealth;
}

export interface ObserverUpdatedEvent {
  type: typeof OBSERVER_EVENT_TYPES.updated;
  at: number;
  change: WatchLifecycleEvent<CanonicalAgentStatus>;
  agent: CanonicalAgentSnapshot;
  snapshot: ObserverSnapshot;
}

export interface ObserverSnapshotEvent {
  type: typeof OBSERVER_EVENT_TYPES.snapshot;
  at: number;
  snapshot: ObserverSnapshot;
  agent: CanonicalAgentSnapshot | undefined;
}

export interface ObserverErroredEvent {
  type: typeof OBSERVER_EVENT_TYPES.errored;
  at: number;
  error: Error;
  agent: CanonicalAgentSnapshot | undefined;
}

export interface ObserverStartedEvent {
  type: typeof OBSERVER_EVENT_TYPES.started;
  at: number;
  agent: CanonicalAgentSnapshot | undefined;
}

export interface ObserverStoppedEvent {
  type: typeof OBSERVER_EVENT_TYPES.stopped;
  at: number;
  agent: CanonicalAgentSnapshot | undefined;
}

export type ObserverEvent =
  | ObserverSnapshotEvent
  | ObserverUpdatedEvent
  | ObserverErroredEvent
  | ObserverStartedEvent
  | ObserverStoppedEvent;

export interface ObserverOptions {
  provider: TranscriptProvider;
  workspacePaths: string[];
  debounceMs?: number;
  now?: () => number;
}

export interface Observer {
  start(): Promise<void>;
  stop(): Promise<void>;
  refreshNow(): Promise<ObserverSnapshot>;
  getLatestSnapshot(): ObserverSnapshot | undefined;
  subscribe(listener: (event: ObserverEvent) => void): () => void;
  subscribeToAgentChanges(listener: (event: ObserverUpdatedEvent) => void): () => void;
  subscribeToSnapshots(listener: (event: ObserverSnapshotEvent) => void): () => void;
}

export function createObserver(options: ObserverOptions): Observer {
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(event: ObserverEvent) => void>();
  const workspacePaths = options.workspacePaths
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  let latestSnapshot: ObserverSnapshot | undefined;
  let previousSnapshot: ObserverSnapshot | undefined;
  let discovery: DiscoveryResult | undefined;

  const source: WatchSource<CanonicalAgentSnapshot> = {
    connect: async () => {
      discovery = await options.provider.discover(workspacePaths);
      await options.provider.connect?.();
    },
    disconnect: () => options.provider.disconnect?.(),
    readSnapshot: async (at?: number) => {
      const observedAt = at ?? now();
      const resolved =
        discovery ?? (await options.provider.discover(workspacePaths));
      discovery = resolved;
      const readResult = await options.provider.read(resolved.inputs, observedAt);
      const normalized = await options.provider.normalize(readResult, observedAt);
      return mergeSnapshotWarnings(normalized, readResult, resolved);
    },
    getWatchPaths: () => discovery?.watchPaths ?? [],
  };
  const providerWatch = options.provider.watch;

  const runtime = createWatchRuntime<CanonicalAgentSnapshot, CanonicalAgentStatus>({
    source,
    lifecycle: {
      getId: (agent) => agent.id,
      getStatus: (agent) => agent.status,
    },
    debounceMs: options.debounceMs ?? options.provider.watch?.debounceMs,
    now,
    subscribeToChanges: providerWatch
      ? (watchPath, onEvent, onError) => providerWatch.subscribe(watchPath, onEvent, onError)
      : undefined,
  });

  runtime.subscribe((event) => {
    if (event.type === WATCH_RUNTIME_EVENT_TYPES.snapshot) {
      previousSnapshot = latestSnapshot;
      latestSnapshot = {
        at: event.at,
        agents: event.snapshot.agents,
        health: event.snapshot.health,
      };
      emit({
        type: OBSERVER_EVENT_TYPES.snapshot,
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
          type: OBSERVER_EVENT_TYPES.updated,
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
        type: OBSERVER_EVENT_TYPES.errored,
        at: event.at,
        error: event.error,
        agent: undefined,
      });
      return;
    }

    if (event.state === WATCH_RUNTIME_STATES.started) {
      emit({ type: OBSERVER_EVENT_TYPES.started, at: event.at, agent: undefined });
      return;
    }
    emit({ type: OBSERVER_EVENT_TYPES.stopped, at: event.at, agent: undefined });
  });

  function subscribe(listener: (event: ObserverEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function subscribeToAgentChanges(listener: (event: ObserverUpdatedEvent) => void): () => void {
    return subscribe((event) => {
      if (isObserverUpdatedEvent(event)) {
        listener(event);
      }
    });
  }

  function subscribeToSnapshots(listener: (event: ObserverSnapshotEvent) => void): () => void {
    return subscribe((event) => {
      if (event.type === OBSERVER_EVENT_TYPES.snapshot) {
        listener(event);
      }
    });
  }

  async function refreshNow(): Promise<ObserverSnapshot> {
    const snapshot = await runtime.refreshNow();
    const at = latestSnapshot?.at ?? now();
    return {
      at,
      agents: snapshot.agents,
      health: snapshot.health,
    };
  }

  function emit(event: ObserverEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Keep observer fan-out resilient to listener failures.
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

export function isObserverUpdatedEvent(event: ObserverEvent): event is ObserverUpdatedEvent {
  return event.type === OBSERVER_EVENT_TYPES.updated;
}

function mergeSnapshotWarnings(
  normalized: CanonicalSnapshot,
  readResult: TranscriptReadResult,
  discovery: DiscoveryResult,
): CanonicalSnapshot {
  const warnings = [
    ...discovery.warnings,
    ...readResult.health.warnings,
    ...normalized.health.warnings,
  ];
  return {
    agents: normalized.agents,
    health: {
      connected: normalized.health.connected,
      sourceLabel: normalized.health.sourceLabel,
      warnings: warnings.length > 0 ? [...new Set(warnings)] : [],
    },
  };
}

function indexAgentsById(agents: CanonicalAgentSnapshot[]): Map<string, CanonicalAgentSnapshot> {
  const byId = new Map<string, CanonicalAgentSnapshot>();
  for (const agent of agents) {
    byId.set(agent.id, agent);
  }
  return byId;
}

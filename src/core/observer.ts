import {
  CANONICAL_AGENT_STATUS,
  type CanonicalAgentSnapshot,
  type CanonicalAgentStatus,
} from "./model";
import type {
  CanonicalSnapshot,
  DiscoveryResult,
  TranscriptProvider,
  TranscriptReadResult,
} from "./providers";
import { createWatchRuntime } from "./runtime/index";
import { emitToListeners } from "./runtime/shared";
import type { WatchHealth, WatchLifecycleEvent } from "./types";
import { WATCH_LIFECYCLE_KIND, WATCH_RUNTIME_EVENT_TYPES, type WatchSource } from "./types";

export interface ObserverSnapshot {
  at: number;
  agents: CanonicalAgentSnapshot[];
  health: WatchHealth;
}

export interface ObserverChangeEvent {
  change: WatchLifecycleEvent<CanonicalAgentStatus>;
  agent: CanonicalAgentSnapshot;
  snapshot: ObserverSnapshot;
}

export interface ObserverOptions {
  provider: TranscriptProvider;
  workspacePaths: string[];
  debounceMs?: number;
  checkIdleDelayMs?: number | false;
  now?: () => number;
}

export interface Observer {
  start(): Promise<void>;
  stop(): Promise<void>;
  refreshNow(): Promise<ObserverSnapshot>;
  subscribe(listener: (event: ObserverChangeEvent) => void): () => void;
}

export function createObserver(options: ObserverOptions): Observer {
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(event: ObserverChangeEvent) => void>();
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
      const resolved = await options.provider.discover(workspacePaths);
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
    checkIdleDelayMs: options.checkIdleDelayMs,
    now,
    subscribeToChanges: providerWatch
      ? (watchPath, onEvent, onError) => providerWatch.subscribe(watchPath, onEvent, onError)
      : undefined,
  });

  function handleSnapshotEvent(event: {
    at: number;
    snapshot: { agents: CanonicalAgentSnapshot[]; health: WatchHealth };
  }): void {
    previousSnapshot = latestSnapshot;
    latestSnapshot = {
      at: event.at,
      agents: event.snapshot.agents,
      health: event.snapshot.health,
    };
  }

  function handleLifecycleEvents(events: WatchLifecycleEvent<CanonicalAgentStatus>[]): void {
    if (!latestSnapshot) {
      return;
    }
    const currentById = indexAgentsById(latestSnapshot.agents);
    const previousById = indexAgentsById(previousSnapshot?.agents ?? []);
    for (const change of events) {
      const agent = resolveAgentForChange(change, currentById, previousById);
      if (agent) {
        emit({ change, agent, snapshot: latestSnapshot });
      }
    }
  }

  runtime.subscribe((event) => {
    if (event.type === WATCH_RUNTIME_EVENT_TYPES.snapshot) {
      handleSnapshotEvent(event);
      return;
    }

    if (event.type === WATCH_RUNTIME_EVENT_TYPES.lifecycle) {
      handleLifecycleEvents(event.events);
      return;
    }
  });

  function subscribe(listener: (event: ObserverChangeEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
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

  function emit(event: ObserverChangeEvent): void {
    emitToListeners(listeners, event);
  }

  async function stop(): Promise<void> {
    await runtime.stop();
    listeners.clear();
    latestSnapshot = undefined;
    previousSnapshot = undefined;
    discovery = undefined;
  }

  return {
    start: () => runtime.start(),
    stop,
    refreshNow,
    subscribe,
  };
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
  return new Map(agents.map((agent) => [agent.id, agent]));
}

function isStaleJoinEvent(
  change: WatchLifecycleEvent<CanonicalAgentStatus>,
  agent: CanonicalAgentSnapshot,
): boolean {
  return (
    change.kind === WATCH_LIFECYCLE_KIND.joined &&
    (agent.status === CANONICAL_AGENT_STATUS.completed ||
      agent.status === CANONICAL_AGENT_STATUS.error)
  );
}

function resolveAgentForChange(
  change: WatchLifecycleEvent<CanonicalAgentStatus>,
  currentById: Map<string, CanonicalAgentSnapshot>,
  previousById: Map<string, CanonicalAgentSnapshot>,
): CanonicalAgentSnapshot | undefined {
  if (change.kind === WATCH_LIFECYCLE_KIND.heartbeat) {
    return undefined;
  }
  const agent = currentById.get(change.agentId) ?? previousById.get(change.agentId);
  if (!agent || isStaleJoinEvent(change, agent)) {
    return undefined;
  }
  return agent;
}

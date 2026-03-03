import { createLifecycleMapper } from "./lifecycle";
import type { WatchRuntime, WatchRuntimeEvent, WatchRuntimeOptions, WatchSnapshot } from "./types";
import {
  WATCH_RUNTIME_ERROR_MESSAGES,
  WATCH_RUNTIME_EVENT_TYPES,
  WATCH_RUNTIME_STATES,
} from "./types";

const DEFAULT_DEBOUNCE_MS = 150;

type RefreshWaiter<TAgent> = {
  resolve: (snapshot: WatchSnapshot<TAgent>) => void;
  reject: (error: unknown) => void;
};

type ChangeSubscription = {
  close(): void;
};

export function createWatchRuntime<TAgent, TStatus extends string = string>(
  options: WatchRuntimeOptions<TAgent, TStatus>,
): WatchRuntime<TAgent, TStatus> {
  const source = options.source;
  const now = options.now ?? (() => Date.now());
  const lifecycle = createLifecycleMapper(options.lifecycle);
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const subscribeToChanges = options.subscribeToChanges;
  const configuredWatchPaths =
    options.watchPaths && options.watchPaths.length > 0
      ? options.watchPaths
      : (source.getWatchPaths?.() ?? []);

  const listeners = new Set<(event: WatchRuntimeEvent<TAgent, TStatus>) => void>();
  const subscriptions: ChangeSubscription[] = [];

  let running = false;
  let pendingRefresh = false;
  let refreshLoop: Promise<void> | null = null;
  let debounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let queuedWaiters: RefreshWaiter<TAgent>[] = [];

  async function start(): Promise<void> {
    if (running) {
      return;
    }

    running = true;
    try {
      await source.connect?.();
      initializeSubscriptions();
      emit({
        type: WATCH_RUNTIME_EVENT_TYPES.state,
        at: now(),
        state: WATCH_RUNTIME_STATES.started,
      });
      queueRefresh();
    } catch (error) {
      running = false;
      clearDebounceTimer();
      closeSubscriptions();
      lifecycle.reset();
      rejectAllQueuedWaiters(error);
      await disconnectQuietly(source);
      throw error;
    }
  }

  async function stop(): Promise<void> {
    if (!running) {
      return;
    }

    running = false;
    clearDebounceTimer();
    closeSubscriptions();
    lifecycle.reset();

    const stoppedError = createStoppedError();
    rejectAllQueuedWaiters(stoppedError);

    try {
      await source.disconnect?.();
    } finally {
      emit({
        type: WATCH_RUNTIME_EVENT_TYPES.state,
        at: now(),
        state: WATCH_RUNTIME_STATES.stopped,
      });
    }
  }

  function refreshNow(): Promise<WatchSnapshot<TAgent>> {
    if (!running) {
      return Promise.reject(createNotRunningError());
    }

    return new Promise<WatchSnapshot<TAgent>>((resolve, reject) => {
      queuedWaiters.push({ resolve, reject });
      queueRefresh();
    });
  }

  function subscribe(listener: (event: WatchRuntimeEvent<TAgent, TStatus>) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function queueRefresh(): void {
    if (!running) {
      return;
    }

    pendingRefresh = true;
    ensureWorker();
  }

  function ensureWorker(): void {
    if (refreshLoop) {
      return;
    }
    refreshLoop = runWorker();
  }

  async function runWorker(): Promise<void> {
    while (running && pendingRefresh) {
      pendingRefresh = false;
      const waitersForCycle = queuedWaiters;
      queuedWaiters = [];
      await runRefreshCycle(waitersForCycle);
    }

    refreshLoop = null;
    if (running && pendingRefresh) {
      ensureWorker();
    }
  }

  async function runRefreshCycle(waitersForCycle: RefreshWaiter<TAgent>[]): Promise<void> {
    try {
      const at = now();
      const snapshot = await source.readSnapshot(at);

      if (!running) {
        rejectWaiters(waitersForCycle, createStoppedError());
        return;
      }

      emit({
        type: WATCH_RUNTIME_EVENT_TYPES.snapshot,
        at,
        snapshot,
      });

      emit({
        type: WATCH_RUNTIME_EVENT_TYPES.lifecycle,
        at,
        events: lifecycle.map(snapshot.agents, at),
      });

      resolveWaiters(waitersForCycle, snapshot);
    } catch (error) {
      if (!running) {
        rejectWaiters(waitersForCycle, createStoppedError());
        return;
      }

      emit({
        type: WATCH_RUNTIME_EVENT_TYPES.error,
        at: now(),
        error,
      });
      rejectWaiters(waitersForCycle, error);
    }
  }

  function initializeSubscriptions(): void {
    if (!subscribeToChanges) {
      return;
    }

    for (const watchPath of configuredWatchPaths) {
      const trimmed = watchPath.trim();
      if (!trimmed) {
        continue;
      }

      const subscription = subscribeToChanges(trimmed, onWatchedEvent, onWatchedError);
      subscriptions.push(subscription);
    }
  }

  function onWatchedEvent(): void {
    if (!running) {
      return;
    }

    if (debounceTimer) {
      globalThis.clearTimeout(debounceTimer);
    }
    debounceTimer = globalThis.setTimeout(() => {
      debounceTimer = null;
      queueRefresh();
    }, debounceMs);
  }

  function onWatchedError(error: Error): void {
    emit({
      type: WATCH_RUNTIME_EVENT_TYPES.error,
      at: now(),
      error,
    });
  }

  function clearDebounceTimer(): void {
    if (!debounceTimer) {
      return;
    }
    globalThis.clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  function closeSubscriptions(): void {
    const activeSubscriptions = subscriptions.splice(0, subscriptions.length);
    for (const subscription of activeSubscriptions) {
      subscription.close();
    }
  }

  function rejectAllQueuedWaiters(error: unknown): void {
    const waiters = queuedWaiters;
    queuedWaiters = [];
    rejectWaiters(waiters, error);
  }

  function emit(event: WatchRuntimeEvent<TAgent, TStatus>): void {
    for (const listener of listeners) {
      listener(event);
    }
  }

  return {
    start,
    stop,
    refreshNow,
    subscribe,
  };
}

function resolveWaiters<TAgent>(
  waiters: RefreshWaiter<TAgent>[],
  snapshot: WatchSnapshot<TAgent>,
): void {
  for (const waiter of waiters) {
    waiter.resolve(snapshot);
  }
}

function rejectWaiters<TAgent>(waiters: RefreshWaiter<TAgent>[], error: unknown): void {
  for (const waiter of waiters) {
    waiter.reject(error);
  }
}

function createNotRunningError(): Error {
  return new Error(WATCH_RUNTIME_ERROR_MESSAGES.notRunning);
}

function createStoppedError(): Error {
  return new Error(WATCH_RUNTIME_ERROR_MESSAGES.stoppedBeforeRefreshCompleted);
}

async function disconnectQuietly(source: { disconnect?(): Promise<void> | void }): Promise<void> {
  await Promise.resolve(source.disconnect?.()).catch(() => undefined);
}

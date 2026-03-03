import { createLifecycleMapper } from "./lifecycle";
import type { WatchRuntime, WatchRuntimeEvent, WatchRuntimeOptions, WatchSnapshot } from "./types";
import {
  WATCH_RUNTIME_ERROR_CODES,
  WATCH_RUNTIME_ERROR_MESSAGES,
  WATCH_RUNTIME_EVENT_TYPES,
  WATCH_RUNTIME_STATES,
  WatchRuntimeError,
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

  let state: "stopped" | "starting" | "started" | "stopping" = "stopped";
  let desiredRunning = false;
  let lifecycleToken = 0;
  let pendingRefresh = false;
  let refreshLoop: Promise<void> | null = null;
  let debounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let queuedWaiters: RefreshWaiter<TAgent>[] = [];
  let activeCycleWaiters: RefreshWaiter<TAgent>[] = [];
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  async function start(): Promise<void> {
    desiredRunning = true;
    if (state === "started") {
      return;
    }
    if (state === "starting" && startPromise) {
      return startPromise;
    }
    if (state === "stopping" && stopPromise) {
      await stopPromise;
    }

    state = "starting";
    const token = ++lifecycleToken;
    const operation = (async () => {
      try {
        await source.connect?.();
        if (token !== lifecycleToken || state !== "starting" || !desiredRunning) {
          if (token === lifecycleToken) {
            state = "stopped";
          }
          await disconnectQuietly(source);
          return;
        }

        initializeSubscriptions(token);
        state = "started";
        emit({
          type: WATCH_RUNTIME_EVENT_TYPES.state,
          at: now(),
          state: WATCH_RUNTIME_STATES.started,
        });
        queueRefresh();
      } catch (error) {
        if (token === lifecycleToken) {
          state = "stopped";
          clearDebounceTimer();
          closeSubscriptions();
          lifecycle.reset();
          rejectAllQueuedWaiters(error);
        }
        await disconnectQuietly(source);
        throw error;
      }
    })();
    startPromise = operation;
    try {
      await operation;
    } finally {
      if (startPromise === operation) {
        startPromise = null;
      }
    }
  }

  async function stop(): Promise<void> {
    desiredRunning = false;
    if (state === "stopped") {
      return;
    }
    if (state === "stopping" && stopPromise) {
      return stopPromise;
    }
    if (state === "starting" && startPromise) {
      try {
        await startPromise;
      } catch {
        // Continue stopping after failed start.
      }
      if (state === "stopped") {
        return;
      }
    }

    state = "stopping";
    const token = ++lifecycleToken;
    clearDebounceTimer();
    closeSubscriptions();
    lifecycle.reset();

    const stoppedError = createStoppedError();
    rejectAllQueuedWaiters(stoppedError);
    rejectActiveCycleWaiters(stoppedError);

    const operation = (async () => {
      try {
        await source.disconnect?.();
      } finally {
        if (token !== lifecycleToken) {
          return;
        }
        state = "stopped";
        emit({
          type: WATCH_RUNTIME_EVENT_TYPES.state,
          at: now(),
          state: WATCH_RUNTIME_STATES.stopped,
        });
      }
    })();
    stopPromise = operation;
    try {
      await operation;
    } finally {
      if (stopPromise === operation) {
        stopPromise = null;
      }
    }
  }

  function refreshNow(): Promise<WatchSnapshot<TAgent>> {
    if (state !== "started") {
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
    if (state !== "started") {
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
    while (state === "started" && pendingRefresh) {
      pendingRefresh = false;
      const waitersForCycle = queuedWaiters;
      queuedWaiters = [];
      activeCycleWaiters = waitersForCycle;
      try {
        await runRefreshCycle(waitersForCycle);
      } finally {
        activeCycleWaiters = [];
      }
    }

    refreshLoop = null;
    if (state === "started" && pendingRefresh) {
      ensureWorker();
    }
  }

  async function runRefreshCycle(waitersForCycle: RefreshWaiter<TAgent>[]): Promise<void> {
    try {
      const at = now();
      const snapshot = await source.readSnapshot(at);

      if (state !== "started") {
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
      if (state !== "started") {
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

  function initializeSubscriptions(token: number): void {
    if (!subscribeToChanges) {
      return;
    }

    for (const watchPath of configuredWatchPaths) {
      const trimmed = watchPath.trim();
      if (!trimmed) {
        continue;
      }

      const subscription = subscribeToChanges(
        trimmed,
        () => onWatchedEvent(token),
        (error) => onWatchedError(error, token),
      );
      subscriptions.push(subscription);
    }
  }

  function onWatchedEvent(token: number): void {
    if (state !== "started" || token !== lifecycleToken) {
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

  function onWatchedError(error: Error, token: number): void {
    if (state !== "started" || token !== lifecycleToken) {
      return;
    }
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

  function rejectActiveCycleWaiters(error: unknown): void {
    const waiters = activeCycleWaiters;
    activeCycleWaiters = [];
    rejectWaiters(waiters, error);
  }

  function emit(event: WatchRuntimeEvent<TAgent, TStatus>): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Keep runtime loop healthy even if consumer listeners throw.
      }
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
  return new WatchRuntimeError(
    WATCH_RUNTIME_ERROR_CODES.notRunning,
    WATCH_RUNTIME_ERROR_MESSAGES.notRunning,
  );
}

function createStoppedError(): Error {
  return new WatchRuntimeError(
    WATCH_RUNTIME_ERROR_CODES.stoppedBeforeRefreshCompleted,
    WATCH_RUNTIME_ERROR_MESSAGES.stoppedBeforeRefreshCompleted,
  );
}

async function disconnectQuietly(source: { disconnect?(): Promise<void> | void }): Promise<void> {
  await Promise.resolve(source.disconnect?.()).catch(() => undefined);
}

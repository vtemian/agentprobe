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
const WATCH_RESUBSCRIBE_BASE_DELAY_MS = 500;
const WATCH_RESUBSCRIBE_MAX_DELAY_MS = 8_000;

type RefreshWaiter<TAgent> = {
  resolve: (snapshot: WatchSnapshot<TAgent>) => void;
  reject: (error: unknown) => void;
};

type ChangeSubscription = {
  watchPath: string;
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
  const resubscribeTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
  const resubscribeAttempts = new Map<string, number>();

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

  function advanceLifecycleToken(): number {
    lifecycleToken += 1;
    return lifecycleToken;
  }

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
    const token = advanceLifecycleToken();
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
    }

    state = "stopping";
    const token = advanceLifecycleToken();
    clearDebounceTimer();
    closeSubscriptions();
    clearResubscribeTimers();
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

    const subscribedPaths = new Set<string>();
    for (const watchPath of configuredWatchPaths) {
      const trimmed = watchPath.trim();
      if (!trimmed || subscribedPaths.has(trimmed)) {
        continue;
      }
      subscribedPaths.add(trimmed);
      trySubscribeWatchPath(trimmed, token);
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

  function onWatchedError(watchPath: string, error: Error, token: number): void {
    if (state !== "started" || token !== lifecycleToken) {
      return;
    }
    emit({
      type: WATCH_RUNTIME_EVENT_TYPES.error,
      at: now(),
      error,
    });
    resubscribeWatchPath(watchPath, token);
  }

  function resubscribeWatchPath(watchPath: string, token: number): void {
    if (!subscribeToChanges || state !== "started" || token !== lifecycleToken) {
      return;
    }

    unsubscribeByWatchPath(watchPath);
    trySubscribeWatchPath(watchPath, token);
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
      try {
        subscription.close();
      } catch (error) {
        emit({
          type: WATCH_RUNTIME_EVENT_TYPES.error,
          at: now(),
          error,
        });
      }
    }
  }

  function subscribeForWatchPath(watchPath: string, subscription: { close(): void }): void {
    subscriptions.push({
      watchPath,
      close: () => subscription.close(),
    });
  }

  function trySubscribeWatchPath(watchPath: string, token: number): void {
    if (
      !subscribeToChanges ||
      (state !== "started" && state !== "starting") ||
      token !== lifecycleToken
    ) {
      return;
    }
    try {
      const subscription = subscribeToChanges(
        watchPath,
        () => onWatchedEvent(token),
        (error) => onWatchedError(watchPath, error, token),
      );
      subscribeForWatchPath(watchPath, subscription);
      clearResubscribeState(watchPath);
    } catch (error) {
      emit({
        type: WATCH_RUNTIME_EVENT_TYPES.error,
        at: now(),
        error,
      });
      scheduleResubscribe(watchPath, token);
    }
  }

  function scheduleResubscribe(watchPath: string, token: number): void {
    if (!subscribeToChanges || state !== "started" || token !== lifecycleToken) {
      return;
    }

    const existing = resubscribeTimers.get(watchPath);
    if (existing) {
      return;
    }

    const attempt = (resubscribeAttempts.get(watchPath) ?? 0) + 1;
    resubscribeAttempts.set(watchPath, attempt);
    const delayMs = Math.min(
      WATCH_RESUBSCRIBE_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
      WATCH_RESUBSCRIBE_MAX_DELAY_MS,
    );
    const timer = globalThis.setTimeout(() => {
      resubscribeTimers.delete(watchPath);
      if (state !== "started" || token !== lifecycleToken) {
        return;
      }
      resubscribeWatchPath(watchPath, token);
    }, delayMs);
    resubscribeTimers.set(watchPath, timer);
  }

  function clearResubscribeState(watchPath: string): void {
    const timer = resubscribeTimers.get(watchPath);
    if (timer) {
      globalThis.clearTimeout(timer);
      resubscribeTimers.delete(watchPath);
    }
    resubscribeAttempts.delete(watchPath);
  }

  function clearResubscribeTimers(): void {
    for (const timer of resubscribeTimers.values()) {
      globalThis.clearTimeout(timer);
    }
    resubscribeTimers.clear();
    resubscribeAttempts.clear();
  }

  function unsubscribeByWatchPath(watchPath: string): void {
    for (let index = subscriptions.length - 1; index >= 0; index -= 1) {
      if (subscriptions[index]?.watchPath !== watchPath) {
        continue;
      }
      const [subscription] = subscriptions.splice(index, 1);
      try {
        subscription?.close();
      } catch {
        // Recovery path should remain best-effort.
      }
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

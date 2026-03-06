import { add, uniq } from "lodash-es";
import { createLifecycleMapper } from "./lifecycle";
import { toError } from "./errors";
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
const TOKEN_INCREMENT = 1;
const INITIAL_LIFECYCLE_TOKEN = 0;
const EMPTY_LENGTH = 0;
const FIRST_RESUBSCRIBE_ATTEMPT = 1;
const RESUBSCRIBE_EXPONENTIAL_BASE = 2;
const REVERSE_ITERATION_STEP = 1;

const WATCH_RUNTIME_INTERNAL_STATES = {
  stopped: "stopped",
  starting: "starting",
  started: "started",
  stopping: "stopping",
} as const;

type RefreshWaiter<TAgent> = {
  resolve: (snapshot: WatchSnapshot<TAgent>) => void;
  reject: (error: unknown) => void;
};

type ChangeSubscription = {
  watchPath: string;
  close(): void;
};

type RuntimeStatus =
  (typeof WATCH_RUNTIME_INTERNAL_STATES)[keyof typeof WATCH_RUNTIME_INTERNAL_STATES];

export function createWatchRuntime<TAgent, TStatus extends string = string>(
  options: WatchRuntimeOptions<TAgent, TStatus>,
): WatchRuntime<TAgent, TStatus> {
  const source = options.source;
  const now = options.now ?? (() => Date.now());
  const lifecycle = createLifecycleMapper(options.lifecycle);
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const subscribeToChanges = options.subscribeToChanges;

  const listeners = new Set<(event: WatchRuntimeEvent<TAgent, TStatus>) => void>();
  const subscriptions: ChangeSubscription[] = [];
  const resubscribeTimers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
  const resubscribeAttempts = new Map<string, number>();

  const runtimeState = {
    state: WATCH_RUNTIME_INTERNAL_STATES.stopped as RuntimeStatus,
    desiredRunning: false,
    lifecycleToken: INITIAL_LIFECYCLE_TOKEN,
    pendingRefresh: false,
    refreshLoop: null as Promise<void> | null,
    debounceTimer: null as ReturnType<typeof globalThis.setTimeout> | null,
    queuedWaiters: [] as RefreshWaiter<TAgent>[],
    activeCycleWaiters: [] as RefreshWaiter<TAgent>[],
    startPromise: null as Promise<void> | null,
    stopPromise: null as Promise<void> | null,
  };

  function isState(value: RuntimeStatus): boolean {
    return runtimeState.state === value;
  }

  function isTokenCurrent(token: number): boolean {
    return token === runtimeState.lifecycleToken;
  }

  function isStartedWithToken(token: number): boolean {
    return isState(WATCH_RUNTIME_INTERNAL_STATES.started) && isTokenCurrent(token);
  }

  function nextLifecycleToken(): number {
    runtimeState.lifecycleToken = add(runtimeState.lifecycleToken, TOKEN_INCREMENT);
    return runtimeState.lifecycleToken;
  }

  async function runStartOperation(token: number): Promise<void> {
    try {
      await source.connect?.();
      if (
        !isTokenCurrent(token) ||
        !isState(WATCH_RUNTIME_INTERNAL_STATES.starting) ||
        !runtimeState.desiredRunning
      ) {
        if (isTokenCurrent(token)) {
          runtimeState.state = WATCH_RUNTIME_INTERNAL_STATES.stopped;
        }
        await disconnectQuietly(source);
        return;
      }

      initializeSubscriptions(token);
      runtimeState.state = WATCH_RUNTIME_INTERNAL_STATES.started;
      emit({
        type: WATCH_RUNTIME_EVENT_TYPES.state,
        at: now(),
        state: WATCH_RUNTIME_STATES.started,
      });
      queueRefresh();
    } catch (error) {
      if (isTokenCurrent(token)) {
        runtimeState.state = WATCH_RUNTIME_INTERNAL_STATES.stopped;
        clearDebounceTimer();
        closeSubscriptions();
        lifecycle.reset();
        rejectAllQueuedWaiters(error);
      }
      await disconnectQuietly(source);
      throw error;
    }
  }

  async function start(): Promise<void> {
    runtimeState.desiredRunning = true;
    if (isState(WATCH_RUNTIME_INTERNAL_STATES.started)) {
      return;
    }
    if (isState(WATCH_RUNTIME_INTERNAL_STATES.starting) && runtimeState.startPromise) {
      return runtimeState.startPromise;
    }
    if (isState(WATCH_RUNTIME_INTERNAL_STATES.stopping) && runtimeState.stopPromise) {
      await runtimeState.stopPromise;
    }

    runtimeState.state = WATCH_RUNTIME_INTERNAL_STATES.starting;
    const token = nextLifecycleToken();
    const operation = runStartOperation(token);
    runtimeState.startPromise = operation;
    try {
      await operation;
    } finally {
      if (runtimeState.startPromise === operation) {
        runtimeState.startPromise = null;
      }
    }
  }

  async function stop(): Promise<void> {
    runtimeState.desiredRunning = false;
    if (isState(WATCH_RUNTIME_INTERNAL_STATES.stopped)) {
      return;
    }
    if (isState(WATCH_RUNTIME_INTERNAL_STATES.stopping) && runtimeState.stopPromise) {
      return runtimeState.stopPromise;
    }
    if (isState(WATCH_RUNTIME_INTERNAL_STATES.starting) && runtimeState.startPromise) {
      try {
        await runtimeState.startPromise;
      } catch {
        // Continue stopping after failed start.
      }
    }

    runtimeState.state = WATCH_RUNTIME_INTERNAL_STATES.stopping;
    const token = nextLifecycleToken();
    clearDebounceTimer();
    closeSubscriptions();
    clearResubscribeTimers();
    lifecycle.reset();

    const stoppedError = createStoppedError();
    rejectAllQueuedWaiters(stoppedError);
    rejectActiveCycleWaiters(stoppedError);

    const operation = (async () => {
      let shouldEmitStopped = false;
      try {
        await source.disconnect?.();
      } finally {
        shouldEmitStopped = isTokenCurrent(token);
      }
      if (shouldEmitStopped) {
        runtimeState.state = WATCH_RUNTIME_INTERNAL_STATES.stopped;
        emit({
          type: WATCH_RUNTIME_EVENT_TYPES.state,
          at: now(),
          state: WATCH_RUNTIME_STATES.stopped,
        });
      }
    })();
    runtimeState.stopPromise = operation;
    try {
      await operation;
    } finally {
      if (runtimeState.stopPromise === operation) {
        runtimeState.stopPromise = null;
      }
    }
  }

  function refreshNow(): Promise<WatchSnapshot<TAgent>> {
    if (!isState(WATCH_RUNTIME_INTERNAL_STATES.started)) {
      return Promise.reject(createNotRunningError());
    }

    return new Promise<WatchSnapshot<TAgent>>((resolve, reject) => {
      runtimeState.queuedWaiters.push({ resolve, reject });
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
    if (!isState(WATCH_RUNTIME_INTERNAL_STATES.started)) {
      return;
    }

    runtimeState.pendingRefresh = true;
    ensureWorker();
  }

  function ensureWorker(): void {
    if (runtimeState.refreshLoop) {
      return;
    }
    runtimeState.refreshLoop = runWorker();
  }

  async function runWorker(): Promise<void> {
    while (isState(WATCH_RUNTIME_INTERNAL_STATES.started) && runtimeState.pendingRefresh) {
      runtimeState.pendingRefresh = false;
      const waitersForCycle = runtimeState.queuedWaiters;
      runtimeState.queuedWaiters = [];
      runtimeState.activeCycleWaiters = waitersForCycle;
      try {
        await runRefreshCycle(waitersForCycle);
      } finally {
        runtimeState.activeCycleWaiters = [];
      }
    }

    runtimeState.refreshLoop = null;
    if (isState(WATCH_RUNTIME_INTERNAL_STATES.started) && runtimeState.pendingRefresh) {
      ensureWorker();
    }
  }

  async function runRefreshCycle(waitersForCycle: RefreshWaiter<TAgent>[]): Promise<void> {
    try {
      const at = now();
      const snapshot = await source.readSnapshot(at);

      if (!isState(WATCH_RUNTIME_INTERNAL_STATES.started)) {
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
      if (!isState(WATCH_RUNTIME_INTERNAL_STATES.started)) {
        rejectWaiters(waitersForCycle, createStoppedError());
        return;
      }

      emit({
        type: WATCH_RUNTIME_EVENT_TYPES.error,
        at: now(),
        error: toError(error),
      });
      rejectWaiters(waitersForCycle, error);
    }
  }

  function initializeSubscriptions(token: number): void {
    if (!subscribeToChanges) {
      return;
    }

    const configuredWatchPaths =
      options.watchPaths && options.watchPaths.length > EMPTY_LENGTH
        ? options.watchPaths
        : (source.getWatchPaths?.() ?? []);
    const normalizedWatchPaths = uniq(
      configuredWatchPaths
        .map((watchPath) => watchPath.trim())
        .filter((watchPath) => watchPath.length > EMPTY_LENGTH),
    );
    for (const watchPath of normalizedWatchPaths) {
      trySubscribeWatchPath(watchPath, token);
    }
  }

  function onWatchedEvent(token: number): void {
    if (!isStartedWithToken(token)) {
      return;
    }

    if (runtimeState.debounceTimer) {
      globalThis.clearTimeout(runtimeState.debounceTimer);
    }
    runtimeState.debounceTimer = globalThis.setTimeout(() => {
      runtimeState.debounceTimer = null;
      queueRefresh();
    }, debounceMs);
  }

  function onWatchedError(watchPath: string, error: Error, token: number): void {
    if (!isStartedWithToken(token)) {
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
    if (!subscribeToChanges || !isStartedWithToken(token)) {
      return;
    }

    unsubscribeByWatchPath(watchPath);
    trySubscribeWatchPath(watchPath, token);
  }

  function clearDebounceTimer(): void {
    if (!runtimeState.debounceTimer) {
      return;
    }
    globalThis.clearTimeout(runtimeState.debounceTimer);
    runtimeState.debounceTimer = null;
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
          error: toError(error),
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
      (!isState(WATCH_RUNTIME_INTERNAL_STATES.started) &&
        !isState(WATCH_RUNTIME_INTERNAL_STATES.starting)) ||
      !isTokenCurrent(token)
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
        error: toError(error),
      });
      scheduleResubscribe(watchPath, token);
    }
  }

  function scheduleResubscribe(watchPath: string, token: number): void {
    if (!subscribeToChanges || !isStartedWithToken(token)) {
      return;
    }

    const existing = resubscribeTimers.get(watchPath);
    if (existing) {
      return;
    }

    const attempt =
      (resubscribeAttempts.get(watchPath) ?? INITIAL_LIFECYCLE_TOKEN) + FIRST_RESUBSCRIBE_ATTEMPT;
    resubscribeAttempts.set(watchPath, attempt);
    const delayMs = Math.min(
      WATCH_RESUBSCRIBE_BASE_DELAY_MS *
        RESUBSCRIBE_EXPONENTIAL_BASE **
          Math.max(INITIAL_LIFECYCLE_TOKEN, attempt - FIRST_RESUBSCRIBE_ATTEMPT),
      WATCH_RESUBSCRIBE_MAX_DELAY_MS,
    );
    const timer = globalThis.setTimeout(() => {
      resubscribeTimers.delete(watchPath);
      if (!isStartedWithToken(token)) {
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
    for (
      let index = subscriptions.length - FIRST_RESUBSCRIBE_ATTEMPT;
      index >= INITIAL_LIFECYCLE_TOKEN;
      index -= REVERSE_ITERATION_STEP
    ) {
      if (subscriptions[index]?.watchPath !== watchPath) {
        continue;
      }
      const [subscription] = subscriptions.splice(index, FIRST_RESUBSCRIBE_ATTEMPT);
      try {
        subscription?.close();
      } catch {
        // Recovery path should remain best-effort.
      }
    }
  }

  function rejectAllQueuedWaiters(error: unknown): void {
    const waiters = runtimeState.queuedWaiters;
    runtimeState.queuedWaiters = [];
    rejectWaiters(waiters, error);
  }

  function rejectActiveCycleWaiters(error: unknown): void {
    const waiters = runtimeState.activeCycleWaiters;
    runtimeState.activeCycleWaiters = [];
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
  try {
    await Promise.resolve(source.disconnect?.());
  } catch {
    // Best-effort cleanup should not override prior runtime failures.
  }
}

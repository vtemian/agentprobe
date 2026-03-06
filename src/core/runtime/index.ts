import { createLifecycleMapper } from "@/core/lifecycle";
import { toError } from "@/core/errors";
import {
  DEFAULT_DEBOUNCE_MS,
  type RefreshWaiter,
  type RuntimeState,
  type RuntimeStatus,
  WATCH_RUNTIME_INTERNAL_STATES,
  createNotRunningError,
  createStoppedError,
  disconnectQuietly,
  rejectWaiters,
  resolveWaiters,
} from "./shared";
import { createRuntimeSubscriptions } from "./subscriptions";
import type {
  WatchRuntime,
  WatchRuntimeEvent,
  WatchRuntimeOptions,
  WatchSnapshot,
} from "@/core/types";
import { WATCH_RUNTIME_EVENT_TYPES } from "@/core/types";

export function createWatchRuntime<TAgent, TStatus extends string = string>(
  options: WatchRuntimeOptions<TAgent, TStatus>,
): WatchRuntime<TAgent, TStatus> {
  const source = options.source;
  const now = options.now ?? (() => Date.now());
  const lifecycle = createLifecycleMapper(options.lifecycle);
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const subscribeToChanges = options.subscribeToChanges;

  const listeners = new Set<(event: WatchRuntimeEvent<TAgent, TStatus>) => void>();

  const runtimeState: RuntimeState<TAgent> = {
    state: WATCH_RUNTIME_INTERNAL_STATES.stopped,
    desiredRunning: false,
    lifecycleToken: 0,
    pendingRefresh: false,
    refreshLoop: null,
    queuedWaiters: [],
    activeCycleWaiters: [],
    startPromise: null,
    stopPromise: null,
  };

  // Lifecycle guards and token helpers.
  function isState(value: RuntimeStatus): boolean {
    return runtimeState.state === value;
  }

  function isStarted(): boolean {
    return isState(WATCH_RUNTIME_INTERNAL_STATES.started);
  }

  function isStopped(): boolean {
    return isState(WATCH_RUNTIME_INTERNAL_STATES.stopped);
  }

  function isStarting(): boolean {
    return isState(WATCH_RUNTIME_INTERNAL_STATES.starting);
  }

  function isStopping(): boolean {
    return isState(WATCH_RUNTIME_INTERNAL_STATES.stopping);
  }

  function isTokenCurrent(token: number): boolean {
    return token === runtimeState.lifecycleToken;
  }

  function isStartedWithToken(token: number): boolean {
    return isStarted() && isTokenCurrent(token);
  }

  function canSubscribeWithToken(token: number): boolean {
    return (isStarted() || isStarting()) && isTokenCurrent(token);
  }

  function nextLifecycleToken(): number {
    runtimeState.lifecycleToken += 1;
    return runtimeState.lifecycleToken;
  }

  function emitStateEvent(state: "started" | "stopped"): void {
    emit({
      type: WATCH_RUNTIME_EVENT_TYPES.state,
      at: now(),
      state,
    });
  }

  function emitRuntimeError(error: Error): void {
    emit({
      type: WATCH_RUNTIME_EVENT_TYPES.error,
      at: now(),
      error,
    });
  }

  const {
    initializeSubscriptions,
    clearDebounceTimer,
    closeSubscriptions,
    clearResubscribeTimers,
  } = createRuntimeSubscriptions({
    watchPaths: options.watchPaths,
    getWatchPaths: source.getWatchPaths,
    subscribeToChanges,
    debounceMs,
    queueRefresh,
    isStartedWithToken,
    canSubscribeWithToken,
    emitError: emitRuntimeError,
  });

  // Start/stop operations are split out to keep orchestration readable.
  async function runStartOperation(token: number): Promise<void> {
    try {
      await source.connect?.();

      const superseded = !isTokenCurrent(token);
      const aborted = !isStarting() || !runtimeState.desiredRunning;
      if (superseded || aborted) {
        if (!superseded) {
          runtimeState.state = WATCH_RUNTIME_INTERNAL_STATES.stopped;
        }
        await disconnectQuietly(source);
        return;
      }

      initializeSubscriptions(token);
      runtimeState.state = WATCH_RUNTIME_INTERNAL_STATES.started;
      emitStateEvent(WATCH_RUNTIME_INTERNAL_STATES.started);
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

  async function runStopOperation(token: number): Promise<void> {
    try {
      await source.disconnect?.();
    } finally {
      if (isTokenCurrent(token)) {
        runtimeState.state = WATCH_RUNTIME_INTERNAL_STATES.stopped;
        emitStateEvent(WATCH_RUNTIME_INTERNAL_STATES.stopped);
      }
    }
  }

  async function start(): Promise<void> {
    runtimeState.desiredRunning = true;
    if (isStarted()) {
      return;
    }
    if (isStarting() && runtimeState.startPromise) {
      return runtimeState.startPromise;
    }
    if (isStopping() && runtimeState.stopPromise) {
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
    if (isStopped()) {
      return;
    }
    if (isStopping() && runtimeState.stopPromise) {
      return runtimeState.stopPromise;
    }
    if (isStarting() && runtimeState.startPromise) {
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

    const operation = runStopOperation(token);
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
    if (!isStarted()) {
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
    if (!isStarted()) {
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
    while (isStarted() && runtimeState.pendingRefresh) {
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
    if (isStarted() && runtimeState.pendingRefresh) {
      ensureWorker();
    }
  }

  async function runRefreshCycle(waitersForCycle: RefreshWaiter<TAgent>[]): Promise<void> {
    try {
      const at = now();
      const snapshot = await source.readSnapshot(at);

      if (!isStarted()) {
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
      if (!isStarted()) {
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

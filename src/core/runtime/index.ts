import { toError } from "@/core/errors";
import { createLifecycleMapper } from "@/core/lifecycle";
import type {
  WatchRuntime,
  WatchRuntimeEvent,
  WatchRuntimeOptions,
  WatchSnapshot,
} from "@/core/types";
import { WATCH_LIFECYCLE_KIND, WATCH_RUNTIME_EVENT_TYPES } from "@/core/types";
import { createEventBus, RUNTIME_BUS_EVENT_TYPES } from "./event-bus";
import {
  createNotRunningError,
  createStoppedError,
  DEFAULT_CHECK_IDLE_DELAY_MS,
  DEFAULT_DEBOUNCE_MS,
  disconnectQuietly,
  emitToListeners,
  type RuntimeState,
  type RuntimeStatus,
  rejectWaiters,
  resolveWaiters,
  WATCH_RUNTIME_INTERNAL_STATES,
} from "./shared";
import { createRuntimeSubscriptions } from "./subscriptions";

type RuntimeBusEvent =
  | { type: typeof RUNTIME_BUS_EVENT_TYPES.fileChanged }
  | { type: typeof RUNTIME_BUS_EVENT_TYPES.checkIdle }
  | { type: typeof RUNTIME_BUS_EVENT_TYPES.refreshRequested };

export function createWatchRuntime<TAgent, TStatus extends string = string>(
  options: WatchRuntimeOptions<TAgent, TStatus>,
): WatchRuntime<TAgent, TStatus> {
  const source = options.source;
  const now = options.now ?? (() => Date.now());
  const lifecycle = createLifecycleMapper(options.lifecycle);
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const subscribeToChanges = options.subscribeToChanges;
  const checkIdleDelayMs =
    options.checkIdleDelayMs === false
      ? 0
      : (options.checkIdleDelayMs ?? DEFAULT_CHECK_IDLE_DELAY_MS);

  const listeners = new Set<(event: WatchRuntimeEvent<TAgent, TStatus>) => void>();

  let idleTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const runtimeState: RuntimeState<TAgent> = {
    state: WATCH_RUNTIME_INTERNAL_STATES.stopped,
    desiredRunning: false,
    lifecycleToken: 0,
    queuedWaiters: [],
    activeCycleWaiters: [],
    startPromise: null,
    stopPromise: null,
  };

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

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      globalThis.clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleCheckIdle(): void {
    if (checkIdleDelayMs <= 0 || !isStarted()) {
      return;
    }
    clearIdleTimer();
    idleTimer = globalThis.setTimeout(() => {
      idleTimer = null;
      bus.dispatch({ type: RUNTIME_BUS_EVENT_TYPES.checkIdle }, runtimeState.lifecycleToken);
    }, checkIdleDelayMs);
  }

  async function readAndEmit(): Promise<{
    snapshot: WatchSnapshot<TAgent>;
    hasStatusChanges: boolean;
  }> {
    const at = now();
    const snapshot = await source.readSnapshot(at);
    if (!isStarted()) {
      throw createStoppedError();
    }
    const lifecycleEvents = lifecycle.map(snapshot.agents, at);
    const hasStatusChanges = lifecycleEvents.some(
      (e) =>
        e.kind === WATCH_LIFECYCLE_KIND.statusChanged ||
        e.kind === WATCH_LIFECYCLE_KIND.joined ||
        e.kind === WATCH_LIFECYCLE_KIND.left,
    );
    if (hasStatusChanges) {
      emit({ type: WATCH_RUNTIME_EVENT_TYPES.snapshot, at, snapshot });
      emit({ type: WATCH_RUNTIME_EVENT_TYPES.lifecycle, at, events: lifecycleEvents });
    }
    return { snapshot, hasStatusChanges };
  }

  const bus = createEventBus<RuntimeBusEvent>({
    getToken: () => runtimeState.lifecycleToken,
    handlers: {
      [RUNTIME_BUS_EVENT_TYPES.fileChanged]: async () => {
        if (!isStarted()) {
          return;
        }
        try {
          await readAndEmit();
          scheduleCheckIdle();
        } catch (error) {
          if (!isStarted()) {
            return;
          }
          emitRuntimeError(toError(error));
        }
      },

      [RUNTIME_BUS_EVENT_TYPES.checkIdle]: async () => {
        if (!isStarted()) {
          return;
        }
        try {
          const { snapshot } = await readAndEmit();
          if (snapshot.agents.length > 0) {
            scheduleCheckIdle();
          }
        } catch (error) {
          if (!isStarted()) {
            return;
          }
          emitRuntimeError(toError(error));
        }
      },

      [RUNTIME_BUS_EVENT_TYPES.refreshRequested]: async () => {
        const waiters = runtimeState.queuedWaiters;
        runtimeState.queuedWaiters = [];
        if (waiters.length === 0 || !isStarted()) {
          rejectWaiters(waiters, createStoppedError());
          return;
        }
        runtimeState.activeCycleWaiters = waiters;
        try {
          const { snapshot } = await readAndEmit();
          resolveWaiters(waiters, snapshot);
          scheduleCheckIdle();
        } catch (error) {
          if (!isStarted()) {
            rejectWaiters(waiters, createStoppedError());
            return;
          }
          emitRuntimeError(toError(error));
          rejectWaiters(waiters, error);
        } finally {
          runtimeState.activeCycleWaiters = [];
        }
      },
    },
  });

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
    onFileChanged: () => {
      bus.dispatch({ type: RUNTIME_BUS_EVENT_TYPES.fileChanged }, runtimeState.lifecycleToken);
    },
    isStartedWithToken,
    canSubscribeWithToken,
    emitError: emitRuntimeError,
  });

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
      bus.dispatch({ type: RUNTIME_BUS_EVENT_TYPES.fileChanged }, token);
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
    clearIdleTimer();
    closeSubscriptions();
    clearResubscribeTimers();
    bus.clear();
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
      bus.dispatch({ type: RUNTIME_BUS_EVENT_TYPES.refreshRequested }, runtimeState.lifecycleToken);
    });
  }

  function subscribe(listener: (event: WatchRuntimeEvent<TAgent, TStatus>) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
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
    emitToListeners(listeners, event);
  }

  return {
    start,
    stop,
    refreshNow,
    subscribe,
  };
}

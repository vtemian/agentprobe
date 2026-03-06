import { toError } from "@/core/errors";
import { WATCH_RESUBSCRIBE_BASE_DELAY_MS, WATCH_RESUBSCRIBE_MAX_DELAY_MS } from "./shared";

type Subscription = { close(): void };

type SubscribeToChanges = (
  watchPath: string,
  onEvent: () => void,
  onError: (error: Error) => void,
) => Subscription;

type RuntimeSubscriptionsOptions = {
  watchPaths?: string[];
  getWatchPaths?: () => string[];
  subscribeToChanges?: SubscribeToChanges;
  debounceMs: number;
  queueRefresh: () => void;
  isStartedWithToken: (token: number) => boolean;
  canSubscribeWithToken: (token: number) => boolean;
  emitError: (error: Error) => void;
};

type ChangeSubscription = {
  watchPath: string;
  close(): void;
};

export function createRuntimeSubscriptions(options: RuntimeSubscriptionsOptions): {
  initializeSubscriptions(token: number): void;
  clearDebounceTimer(): void;
  closeSubscriptions(): void;
  clearResubscribeTimers(): void;
} {
  const subscriptions: ChangeSubscription[] = [];
  const resubscribeState = new Map<
    string,
    { timer: ReturnType<typeof globalThis.setTimeout>; attempts: number }
  >();
  let debounceTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  function initializeSubscriptions(token: number): void {
    if (!options.subscribeToChanges) {
      return;
    }

    const watchPaths = getWatchPaths();
    const normalizedWatchPaths = normalizeWatchPaths(watchPaths);
    for (const watchPath of normalizedWatchPaths) {
      trySubscribeWatchPath(watchPath, token);
    }
  }

  function getWatchPaths(): string[] {
    return options.watchPaths?.length ? options.watchPaths : (options.getWatchPaths?.() ?? []);
  }

  function normalizeWatchPaths(watchPaths: readonly string[]): string[] {
    return [
      ...new Set(
        watchPaths.map((watchPath) => watchPath.trim()).filter((watchPath) => watchPath.length > 0),
      ),
    ];
  }

  function onWatchedEvent(token: number): void {
    if (!options.isStartedWithToken(token)) {
      return;
    }

    if (debounceTimer) {
      globalThis.clearTimeout(debounceTimer);
    }
    debounceTimer = globalThis.setTimeout(() => {
      debounceTimer = null;
      options.queueRefresh();
    }, options.debounceMs);
  }

  function onWatchedError(watchPath: string, error: Error, token: number): void {
    if (!options.isStartedWithToken(token)) {
      return;
    }
    options.emitError(error);
    resubscribeWatchPath(watchPath, token);
  }

  function resubscribeWatchPath(watchPath: string, token: number): void {
    if (!options.subscribeToChanges || !options.isStartedWithToken(token)) {
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
        options.emitError(toError(error));
      }
    }
  }

  function subscribeForWatchPath(watchPath: string, subscription: Subscription): void {
    subscriptions.push({
      watchPath,
      close: () => subscription.close(),
    });
  }

  function trySubscribeWatchPath(watchPath: string, token: number): void {
    if (!options.subscribeToChanges || !options.canSubscribeWithToken(token)) {
      return;
    }
    try {
      const subscription = options.subscribeToChanges(
        watchPath,
        () => onWatchedEvent(token),
        (error) => onWatchedError(watchPath, error, token),
      );
      subscribeForWatchPath(watchPath, subscription);
      clearResubscribeStateForPath(watchPath);
    } catch (error) {
      options.emitError(toError(error));
      scheduleResubscribe(watchPath, token);
    }
  }

  function scheduleResubscribe(watchPath: string, token: number): void {
    if (!options.subscribeToChanges || !options.isStartedWithToken(token)) {
      return;
    }

    if (resubscribeState.has(watchPath)) {
      return;
    }

    const previousAttempts = resubscribeState.get(watchPath)?.attempts ?? 0;
    const attempts = previousAttempts + 1;
    const delayMs = Math.min(
      WATCH_RESUBSCRIBE_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1),
      WATCH_RESUBSCRIBE_MAX_DELAY_MS,
    );
    const timer = globalThis.setTimeout(() => {
      resubscribeState.delete(watchPath);
      if (!options.isStartedWithToken(token)) {
        return;
      }
      resubscribeWatchPath(watchPath, token);
    }, delayMs);
    resubscribeState.set(watchPath, { timer, attempts });
  }

  function clearResubscribeStateForPath(watchPath: string): void {
    const entry = resubscribeState.get(watchPath);
    if (entry) {
      globalThis.clearTimeout(entry.timer);
      resubscribeState.delete(watchPath);
    }
  }

  function clearResubscribeTimers(): void {
    for (const entry of resubscribeState.values()) {
      globalThis.clearTimeout(entry.timer);
    }
    resubscribeState.clear();
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

  return {
    initializeSubscriptions,
    clearDebounceTimer,
    closeSubscriptions,
    clearResubscribeTimers,
  };
}

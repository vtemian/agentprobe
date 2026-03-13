import type { WatchSnapshot } from "@/core/types";
import {
  WATCH_RUNTIME_ERROR_CODES,
  WATCH_RUNTIME_ERROR_MESSAGES,
  WatchRuntimeError,
} from "@/core/errors";

export const DEFAULT_DEBOUNCE_MS = 150;
export const DEFAULT_CHECK_IDLE_DELAY_MS = 2_000;
export const WATCH_RESUBSCRIBE_BASE_DELAY_MS = 500;
export const WATCH_RESUBSCRIBE_MAX_DELAY_MS = 8_000;
export const WATCH_RUNTIME_INTERNAL_STATES = {
  stopped: "stopped",
  starting: "starting",
  started: "started",
  stopping: "stopping",
} as const;

export type RuntimeStatus =
  (typeof WATCH_RUNTIME_INTERNAL_STATES)[keyof typeof WATCH_RUNTIME_INTERNAL_STATES];

export type RefreshWaiter<TAgent> = {
  resolve: (snapshot: WatchSnapshot<TAgent>) => void;
  reject: (error: unknown) => void;
};

export type RuntimeState<TAgent> = {
  state: RuntimeStatus;
  desiredRunning: boolean;
  lifecycleToken: number;
  queuedWaiters: RefreshWaiter<TAgent>[];
  activeCycleWaiters: RefreshWaiter<TAgent>[];
  startPromise: Promise<void> | null;
  stopPromise: Promise<void> | null;
};

export function resolveWaiters<TAgent>(
  waiters: RefreshWaiter<TAgent>[],
  snapshot: WatchSnapshot<TAgent>,
): void {
  for (const waiter of waiters) {
    waiter.resolve(snapshot);
  }
}

export function rejectWaiters<TAgent>(waiters: RefreshWaiter<TAgent>[], error: unknown): void {
  for (const waiter of waiters) {
    waiter.reject(error);
  }
}

export function createNotRunningError(): Error {
  return new WatchRuntimeError(
    WATCH_RUNTIME_ERROR_CODES.notRunning,
    WATCH_RUNTIME_ERROR_MESSAGES.notRunning,
  );
}

export function createStoppedError(): Error {
  return new WatchRuntimeError(
    WATCH_RUNTIME_ERROR_CODES.stoppedBeforeRefreshCompleted,
    WATCH_RUNTIME_ERROR_MESSAGES.stoppedBeforeRefreshCompleted,
  );
}

export function emitToListeners<TEvent>(
  listeners: Set<(event: TEvent) => void>,
  event: TEvent,
): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Keep event fan-out resilient to listener failures.
    }
  }
}

export async function disconnectQuietly(source: {
  disconnect?(): Promise<void> | void;
}): Promise<void> {
  try {
    await Promise.resolve(source.disconnect?.());
  } catch {
    // Best-effort cleanup should not override prior runtime failures.
  }
}

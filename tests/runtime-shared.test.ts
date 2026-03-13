import {
  resolveWaiters,
  rejectWaiters,
  createNotRunningError,
  createStoppedError,
  disconnectQuietly,
  emitToListeners,
} from "@/core/runtime/shared";
import { isWatchRuntimeError, WATCH_RUNTIME_ERROR_CODES } from "@/core/errors";
import { describe, expect, it, vi } from "vitest";

describe("resolveWaiters", () => {
  it("resolves every waiter with the given snapshot", () => {
    const snapshot = {
      agents: [{ id: "a" }],
      health: { connected: true, sourceLabel: "t", warnings: [] },
    };
    const resolved: unknown[] = [];
    const waiters = [
      { resolve: (v: unknown) => resolved.push(v), reject: vi.fn() },
      { resolve: (v: unknown) => resolved.push(v), reject: vi.fn() },
    ];

    resolveWaiters(waiters, snapshot);

    expect(resolved).toEqual([snapshot, snapshot]);
    for (const w of waiters) {
      expect(w.reject).not.toHaveBeenCalled();
    }
  });

  it("handles an empty waiters array", () => {
    expect(() =>
      resolveWaiters([], {
        agents: [],
        health: { connected: true, sourceLabel: "t", warnings: [] },
      }),
    ).not.toThrow();
  });
});

describe("rejectWaiters", () => {
  it("rejects every waiter with the given error", () => {
    const error = new Error("boom");
    const rejected: unknown[] = [];
    const waiters = [
      { resolve: vi.fn(), reject: (e: unknown) => rejected.push(e) },
      { resolve: vi.fn(), reject: (e: unknown) => rejected.push(e) },
    ];

    rejectWaiters(waiters, error);

    expect(rejected).toEqual([error, error]);
    for (const w of waiters) {
      expect(w.resolve).not.toHaveBeenCalled();
    }
  });
});

describe("createNotRunningError", () => {
  it("returns a WatchRuntimeError with NOT_RUNNING code", () => {
    const error = createNotRunningError();
    expect(isWatchRuntimeError(error)).toBe(true);
    if (isWatchRuntimeError(error)) {
      expect(error.code).toBe(WATCH_RUNTIME_ERROR_CODES.notRunning);
    }
  });
});

describe("createStoppedError", () => {
  it("returns a WatchRuntimeError with STOPPED_BEFORE_REFRESH_COMPLETED code", () => {
    const error = createStoppedError();
    expect(isWatchRuntimeError(error)).toBe(true);
    if (isWatchRuntimeError(error)) {
      expect(error.code).toBe(WATCH_RUNTIME_ERROR_CODES.stoppedBeforeRefreshCompleted);
    }
  });
});

describe("disconnectQuietly", () => {
  it("calls disconnect on the source", async () => {
    const disconnect = vi.fn();
    await disconnectQuietly({ disconnect });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("swallows errors thrown by disconnect", async () => {
    const disconnect = vi.fn(() => {
      throw new Error("disconnect failed");
    });
    await expect(disconnectQuietly({ disconnect })).resolves.toBeUndefined();
  });

  it("swallows rejected promises from disconnect", async () => {
    const disconnect = vi.fn(() => Promise.reject(new Error("async fail")));
    await expect(disconnectQuietly({ disconnect })).resolves.toBeUndefined();
  });

  it("handles sources without a disconnect method", async () => {
    await expect(disconnectQuietly({})).resolves.toBeUndefined();
  });
});

describe("emitToListeners", () => {
  it("calls every listener with the event", () => {
    const received: string[] = [];
    const listeners = new Set<(event: string) => void>([
      (e) => received.push(`a:${e}`),
      (e) => received.push(`b:${e}`),
    ]);
    emitToListeners(listeners, "hello");
    expect(received).toEqual(["a:hello", "b:hello"]);
  });

  it("continues calling listeners when one throws", () => {
    const received: string[] = [];
    const listeners = new Set<(event: string) => void>([
      () => {
        throw new Error("boom");
      },
      (e) => received.push(e),
    ]);
    emitToListeners(listeners, "hello");
    expect(received).toEqual(["hello"]);
  });
});

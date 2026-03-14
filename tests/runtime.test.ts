import { describe, expect, it, vi } from "vitest";
import {
  createWatchRuntime,
  isWatchRuntimeError,
  WATCH_RUNTIME_EVENT_TYPES,
  WATCH_RUNTIME_STATES,
} from "@/core/index";
import type { WatchRuntimeEvent, WatchSnapshot, WatchSource } from "@/core/types";

type TestAgent = { id: string; status: "running" | "idle" };
type TestStatus = "running" | "idle";

function createTestSource(overrides: Partial<WatchSource<TestAgent>> = {}): WatchSource<TestAgent> {
  let reads = 0;
  return {
    connect: () => undefined,
    disconnect: () => undefined,
    readSnapshot: () => {
      reads += 1;
      return {
        agents: [{ id: "a", status: reads > 1 ? "idle" : "running" }],
        health: { connected: true, sourceLabel: "test", warnings: [] },
      };
    },
    ...overrides,
  };
}

function collectEvents(runtime: ReturnType<typeof createWatchRuntime<TestAgent, TestStatus>>) {
  const events: WatchRuntimeEvent<TestAgent, TestStatus>[] = [];
  runtime.subscribe((event) => events.push(event));
  return events;
}

describe("createWatchRuntime", () => {
  it("starts, emits snapshot and lifecycle events, and supports refreshNow", async () => {
    let reads = 0;
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: {
        connect: () => undefined,
        disconnect: () => undefined,
        readSnapshot: () => {
          reads += 1;
          return {
            agents: [{ id: "a", status: reads > 1 ? "idle" : "running" }],
            health: { connected: true, sourceLabel: "test", warnings: [] },
          };
        },
      },
      lifecycle: {
        getId: (agent) => agent.id,
        getStatus: (agent) => agent.status,
      },
      now: () => 1000 + reads,
    });

    const events: string[] = [];
    runtime.subscribe((event) => {
      events.push(event.type);
      if (event.type === WATCH_RUNTIME_EVENT_TYPES.state) {
        events.push(event.state);
      }
    });

    await runtime.start();
    await runtime.refreshNow();
    await runtime.stop();

    expect(events[0]).toBe(WATCH_RUNTIME_EVENT_TYPES.state);
    expect(events[1]).toBe(WATCH_RUNTIME_STATES.started);
    expect(events).toContain(WATCH_RUNTIME_EVENT_TYPES.snapshot);
    expect(events).toContain(WATCH_RUNTIME_EVENT_TYPES.lifecycle);
    expect(events.at(-2)).toBe(WATCH_RUNTIME_EVENT_TYPES.state);
    expect(events.at(-1)).toBe(WATCH_RUNTIME_STATES.stopped);
  });

  it("throws a typed runtime error when refreshing while stopped", async () => {
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: {
        readSnapshot: () => ({
          agents: [{ id: "a", status: "running" }],
          health: { connected: true, sourceLabel: "test", warnings: [] },
        }),
      },
      lifecycle: { getId: (agent) => agent.id, getStatus: (agent) => agent.status },
    });

    const error = await runtime.refreshNow().catch((reason: unknown) => reason);
    expect(isWatchRuntimeError(error)).toBe(true);
    if (isWatchRuntimeError(error)) {
      expect(error.code).toBe("NOT_RUNNING");
    }
  });

  it("start is idempotent when already started", async () => {
    const connectFn = vi.fn();
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource({ connect: connectFn }),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
    });

    await runtime.start();
    await runtime.start();
    await runtime.start();

    expect(connectFn).toHaveBeenCalledOnce();
    await runtime.stop();
  });

  it("stop is idempotent when already stopped", async () => {
    const disconnectFn = vi.fn();
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource({ disconnect: disconnectFn }),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
    });

    await runtime.stop();
    await runtime.stop();

    expect(disconnectFn).not.toHaveBeenCalled();
  });

  it("can restart after stop", async () => {
    const events: string[] = [];
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource(),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
    });
    runtime.subscribe((event) => {
      if (event.type === WATCH_RUNTIME_EVENT_TYPES.state) {
        events.push(event.state);
      }
    });

    await runtime.start();
    await runtime.stop();
    await runtime.start();
    await runtime.stop();

    expect(events).toEqual([
      WATCH_RUNTIME_STATES.started,
      WATCH_RUNTIME_STATES.stopped,
      WATCH_RUNTIME_STATES.started,
      WATCH_RUNTIME_STATES.stopped,
    ]);
  });

  it("emits error event when readSnapshot throws", async () => {
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource({
        readSnapshot: () => {
          throw new Error("read failed");
        },
      }),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
    });

    const events = collectEvents(runtime);
    await runtime.start();

    const refreshError = await runtime.refreshNow().catch((e: unknown) => e);
    expect(refreshError).toBeInstanceOf(Error);
    if (refreshError instanceof Error) {
      expect(refreshError.message).toBe("read failed");
    }

    const errorEvents = events.filter((e) => e.type === WATCH_RUNTIME_EVENT_TYPES.error);
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);

    await runtime.stop();
  });

  it("concurrent refreshNow calls are batched into a single cycle", async () => {
    let readCount = 0;
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource({
        readSnapshot: () => {
          readCount++;
          return {
            agents: [{ id: "a", status: "running" }],
            health: { connected: true, sourceLabel: "test", warnings: [] },
          };
        },
      }),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
    });

    await runtime.start();
    const readsAfterStart = readCount;

    const [snap1, snap2, snap3] = await Promise.all([
      runtime.refreshNow(),
      runtime.refreshNow(),
      runtime.refreshNow(),
    ]);

    expect(snap1).toBeDefined();
    expect(snap2).toBeDefined();
    expect(snap3).toBeDefined();
    expect(snap1).toStrictEqual(snap2);
    expect(snap2).toStrictEqual(snap3);
    expect(readCount - readsAfterStart).toBeLessThanOrEqual(2);

    await runtime.stop();
  });

  it("stop rejects in-flight refreshNow waiters with STOPPED_BEFORE_REFRESH_COMPLETED", async () => {
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource({
        readSnapshot: () => new Promise<WatchSnapshot<TestAgent>>(() => {}),
      }),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
    });

    await runtime.start();

    const refreshPromise = runtime.refreshNow().catch((e: unknown) => e);

    await runtime.stop();

    const error = await refreshPromise;
    expect(isWatchRuntimeError(error)).toBe(true);
    if (isWatchRuntimeError(error)) {
      expect(error.code).toBe("STOPPED_BEFORE_REFRESH_COMPLETED");
    }
  });

  it("subscribe returns an unsubscribe function", async () => {
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource(),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
    });

    const events: string[] = [];
    const unsubscribe = runtime.subscribe((event) => events.push(event.type));

    await runtime.start();
    unsubscribe();
    await runtime.refreshNow().catch(() => {});
    await runtime.stop();

    const stateEvents = events.filter((e) => e === WATCH_RUNTIME_EVENT_TYPES.state);
    expect(stateEvents).toHaveLength(1);
  });

  it("listener errors do not crash the runtime", async () => {
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource(),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
    });

    const goodEvents: string[] = [];
    runtime.subscribe(() => {
      throw new Error("bad listener");
    });
    runtime.subscribe((event) => goodEvents.push(event.type));

    await runtime.start();
    await runtime.refreshNow();
    await runtime.stop();

    expect(goodEvents.length).toBeGreaterThan(0);
    expect(goodEvents).toContain(WATCH_RUNTIME_EVENT_TYPES.snapshot);
  });

  it("connect failure prevents started state", async () => {
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource({
        connect: () => {
          throw new Error("connect failed");
        },
      }),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
    });

    const events = collectEvents(runtime);
    await expect(runtime.start()).rejects.toThrow("connect failed");

    const stateEvents = events.filter((e) => e.type === WATCH_RUNTIME_EVENT_TYPES.state);
    expect(stateEvents).toHaveLength(0);
  });

  it("check-idle fires after initial readSnapshot", async () => {
    vi.useFakeTimers();
    let readCount = 0;
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource({
        readSnapshot: () => {
          readCount += 1;
          return {
            agents: [{ id: "a", status: "running" }],
            health: { connected: true, sourceLabel: "test", warnings: [] },
          };
        },
      }),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
      checkIdleDelayMs: 100,
    });

    try {
      await runtime.start();
      expect(readCount).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(readCount).toBe(2);

      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("check-idle self-reschedules while agents exist", async () => {
    vi.useFakeTimers();
    let readCount = 0;
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource({
        readSnapshot: () => {
          readCount += 1;
          return {
            agents: [{ id: "a", status: "running" }],
            health: { connected: true, sourceLabel: "test", warnings: [] },
          };
        },
      }),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
      checkIdleDelayMs: 100,
    });

    try {
      await runtime.start();
      expect(readCount).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(readCount).toBe(2);

      await vi.advanceTimersByTimeAsync(100);
      expect(readCount).toBe(3);

      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("check-idle stops when snapshot has no agents", async () => {
    vi.useFakeTimers();
    let readCount = 0;
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource({
        readSnapshot: () => {
          readCount += 1;
          return {
            agents: readCount === 1 ? [{ id: "a", status: "running" }] : [],
            health: { connected: true, sourceLabel: "test", warnings: [] },
          };
        },
      }),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
      checkIdleDelayMs: 100,
    });

    try {
      await runtime.start();
      expect(readCount).toBe(1);

      await vi.advanceTimersByTimeAsync(100);
      expect(readCount).toBe(2);

      await vi.advanceTimersByTimeAsync(500);
      expect(readCount).toBe(2);

      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkIdleDelayMs: false disables idle checking", async () => {
    vi.useFakeTimers();
    let readCount = 0;
    const runtime = createWatchRuntime<TestAgent, TestStatus>({
      source: createTestSource({
        readSnapshot: () => {
          readCount += 1;
          return {
            agents: [{ id: "a", status: "running" }],
            health: { connected: true, sourceLabel: "test", warnings: [] },
          };
        },
      }),
      lifecycle: { getId: (a) => a.id, getStatus: (a) => a.status },
      checkIdleDelayMs: false,
    });

    try {
      await runtime.start();
      expect(readCount).toBe(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(readCount).toBe(1);

      await runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it, vi } from "vitest";
import { createEventBus, RUNTIME_BUS_EVENT_TYPES } from "@/core/runtime/event-bus";
import { delay, waitUntil } from "./helpers";

type TestEvent = { type: string; id?: string };

describe("createEventBus", () => {
  it("processes events sequentially so async handlers do not overlap", async () => {
    const order: string[] = [];
    const handlers: Record<string, (e: TestEvent) => Promise<void>> = {
      a: async (e) => {
        order.push(`start-${e.id}`);
        await delay(30);
        order.push(`end-${e.id}`);
      },
    };
    const bus = createEventBus<TestEvent>({
      handlers,
      getToken: () => 1,
    });

    bus.dispatch({ type: "a", id: "1" }, 1);
    bus.dispatch({ type: "a", id: "2" }, 1);
    bus.dispatch({ type: "a", id: "3" }, 1);

    await waitUntil(() => order.length >= 6, 500);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  it("drops events dispatched with a token that no longer matches getToken()", async () => {
    let currentToken = 1;
    const handledEvents: string[] = [];

    const bus = createEventBus<TestEvent>({
      handlers: {
        a: (event) => {
          handledEvents.push(event.type);
        },
      },
      getToken: () => currentToken,
    });

    bus.dispatch({ type: "a" }, 1); // token matches
    currentToken = 2; // token changes
    bus.dispatch({ type: "a" }, 1); // stale token — should be dropped

    await waitUntil(() => handledEvents.length >= 1, 200);
    expect(handledEvents).toEqual(["a"]);
  });

  it("handlers can dispatch new events that are queued after current handler", async () => {
    const order: string[] = [];
    const token = 1;
    const bus = createEventBus<TestEvent>({
      handlers: {
        a: (e) => {
          order.push(`a-${e.id}`);
          bus.dispatch({ type: "b", id: "from-a" }, token);
        },
        b: (e) => {
          order.push(`b-${e.id}`);
        },
      },
      getToken: () => token,
    });

    bus.dispatch({ type: "a", id: "1" }, 1);

    await waitUntil(() => order.length >= 2, 500);
    expect(order).toEqual(["a-1", "b-from-a"]);
  });

  it("events with no handler are silently dropped", async () => {
    const handler = vi.fn<() => void>();
    const bus = createEventBus<TestEvent>({
      handlers: { a: handler },
      getToken: () => 1,
    });

    bus.dispatch({ type: "unknown" }, 1);
    bus.dispatch({ type: "a" }, 1);

    await waitUntil(() => handler.mock.calls.length >= 1, 200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("handler errors do not crash the bus and next events still process", async () => {
    const calls: string[] = [];
    const bus = createEventBus<TestEvent>({
      handlers: {
        fail: () => {
          calls.push("fail");
          throw new Error("handler error");
        },
        ok: (e) => {
          calls.push(`ok-${e.id}`);
        },
      },
      getToken: () => 1,
    });

    bus.dispatch({ type: "fail" }, 1);
    bus.dispatch({ type: "ok", id: "1" }, 1);

    await waitUntil(() => calls.length >= 2, 500);
    expect(calls).toEqual(["fail", "ok-1"]);
  });

  it("clear discards queued events", async () => {
    const handler = vi.fn<() => Promise<void>>(async () => {
      await delay(50);
    });
    const bus = createEventBus<TestEvent>({
      handlers: { a: handler },
      getToken: () => 1,
    });

    bus.dispatch({ type: "a" }, 1);
    bus.dispatch({ type: "a" }, 1);
    bus.clear();

    await delay(100);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("RUNTIME_BUS_EVENT_TYPES", () => {
  it("exports correct values", () => {
    expect(RUNTIME_BUS_EVENT_TYPES).toEqual({
      fileChanged: "file-changed",
      checkIdle: "check-idle",
      refreshRequested: "refresh-requested",
    });
  });
});

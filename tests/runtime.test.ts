import {
  createWatchRuntime,
  WATCH_RUNTIME_EVENT_TYPES,
  WATCH_RUNTIME_STATES,
  isWatchRuntimeError,
} from "../src/core/index";
import { describe, expect, it } from "vitest";

describe("createWatchRuntime", () => {
  it("starts, emits snapshot and lifecycle events, and supports refreshNow", async () => {
    let reads = 0;
    const runtime = createWatchRuntime<
      { id: string; status: "running" | "idle" },
      "running" | "idle"
    >({
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

    expect(events).toContain(WATCH_RUNTIME_EVENT_TYPES.snapshot);
    expect(events).toContain(WATCH_RUNTIME_EVENT_TYPES.lifecycle);
    expect(events).toContain(WATCH_RUNTIME_STATES.started);
    expect(events).toContain(WATCH_RUNTIME_STATES.stopped);
  });

  it("throws a typed runtime error when refreshing while stopped", async () => {
    const runtime = createWatchRuntime<{ id: string; status: "running" }, "running">({
      source: {
        readSnapshot: () => ({
          agents: [{ id: "a", status: "running" }],
          health: { connected: true, sourceLabel: "test", warnings: [] },
        }),
      },
      lifecycle: {
        getId: (agent) => agent.id,
        getStatus: (agent) => agent.status,
      },
    });

    await expect(runtime.refreshNow()).rejects.toSatisfy((error: unknown) => {
      return isWatchRuntimeError(error) && error.code === "NOT_RUNNING";
    });
  });
});

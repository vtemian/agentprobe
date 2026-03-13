import { describe, expect, it } from "vitest";
import { createLifecycleMapper, WATCH_LIFECYCLE_KIND } from "@/core/index";

describe("createLifecycleMapper", () => {
  it("reset clears previous status tracking so agents re-emit joined", () => {
    const mapper = createLifecycleMapper<{ id: string; status: string }, string>({
      getId: (agent) => agent.id,
      getStatus: (agent) => agent.status,
    });

    // First call — agent joins
    const firstEvents = mapper.map([{ id: "a", status: "running" }], 10);
    expect(firstEvents).toEqual([
      expect.objectContaining({ kind: WATCH_LIFECYCLE_KIND.joined, agentId: "a" }),
    ]);

    // Second call — same agent, heartbeat only
    const secondEvents = mapper.map([{ id: "a", status: "running" }], 20);
    expect(secondEvents).toEqual([
      expect.objectContaining({ kind: WATCH_LIFECYCLE_KIND.heartbeat }),
    ]);

    // Reset — clears tracking
    mapper.reset();

    // Third call — agent "joins" again because tracking was cleared
    const thirdEvents = mapper.map([{ id: "a", status: "running" }], 30);
    expect(thirdEvents).toEqual([
      expect.objectContaining({ kind: WATCH_LIFECYCLE_KIND.joined, agentId: "a" }),
    ]);
  });

  it("emits joined, statusChanged, heartbeat, and left events", () => {
    const mapper = createLifecycleMapper<{ id: string; status: string }, string>({
      getId: (agent) => agent.id,
      getStatus: (agent) => agent.status,
    });

    const first = mapper.map(
      [
        { id: "a", status: "running" },
        { id: "b", status: "idle" },
      ],
      10,
    );
    expect(first.map((event) => event.kind)).toEqual([
      WATCH_LIFECYCLE_KIND.joined,
      WATCH_LIFECYCLE_KIND.joined,
    ]);

    const second = mapper.map(
      [
        { id: "a", status: "idle" },
        { id: "b", status: "idle" },
      ],
      20,
    );
    expect(second.map((event) => event.kind)).toEqual([
      WATCH_LIFECYCLE_KIND.statusChanged,
      WATCH_LIFECYCLE_KIND.heartbeat,
    ]);

    const third = mapper.map([{ id: "b", status: "idle" }], 30);
    expect(third.map((event) => event.kind)).toEqual([
      WATCH_LIFECYCLE_KIND.heartbeat,
      WATCH_LIFECYCLE_KIND.left,
    ]);
  });
});

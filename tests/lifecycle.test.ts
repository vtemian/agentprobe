import { createLifecycleMapper, WATCH_LIFECYCLE_KIND } from "../src/core/index";
import { describe, expect, it } from "vitest";

describe("createLifecycleMapper", () => {
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

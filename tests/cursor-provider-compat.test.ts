import {
  createAgentSubscription as createFromLegacyAgents,
  resolveTranscriptDirectories as resolveFromLegacyDiscovery,
  createCursorTranscriptSource as createFromLegacyTranscripts,
} from "../src/index";
import {
  createAgentSubscription as createFromProvider,
  resolveTranscriptDirectories as resolveFromProvider,
  createCursorTranscriptSource as createFromProviderTranscripts,
} from "../src/providers/cursor/index";
import { describe, expect, it } from "vitest";

describe("cursor provider compatibility exports", () => {
  it("keeps agent subscription and adapters wired through provider module", () => {
    expect(createFromLegacyAgents).toBe(createFromProvider);
    expect(resolveFromLegacyDiscovery).toBe(resolveFromProvider);
    expect(createFromLegacyTranscripts).toBe(createFromProviderTranscripts);
  });

  it("keeps subscription behavior parity for runtime events", async () => {
    type Status = "running" | "idle";
    let currentStatus: Status = "running";
    const errorListeners: Array<(error: Error) => void> = [];

    const sourceFactory = () => ({
      connect: () => undefined,
      disconnect: () => undefined,
      readSnapshot: () => ({
        agents: [
          {
            id: "agent-1",
            name: "Agent One",
            kind: "local" as const,
            isSubagent: false,
            status: currentStatus,
            taskSummary: "Task",
            updatedAt: Date.now(),
            source: "mock",
          },
        ],
        connected: true,
        sourceLabel: "test",
        warnings: [],
      }),
      getWatchPaths: () => ["/tmp"],
    });

    const watchFactory = (_watchPath: string, onEvent: () => void) => ({
      close: () => undefined,
      on: (_event: "error", callback: (error: Error) => void) => {
        errorListeners.push(callback);
      },
      trigger: onEvent,
    });

    const subA = createFromLegacyAgents({
      projectPath: "/tmp/project",
      sourceFactory,
      watchFactory: (watchPath, onEvent) => watchFactory(watchPath, onEvent),
    });
    const subB = createFromProvider({
      projectPath: "/tmp/project",
      sourceFactory,
      watchFactory: (watchPath, onEvent) => watchFactory(watchPath, onEvent),
    });

    const eventsA: string[] = [];
    const eventsB: string[] = [];
    subA.subscribe((event) => eventsA.push(event.type));
    subB.subscribe((event) => eventsB.push(event.type));

    await subA.start();
    await subB.start();
    await subA.refreshNow();
    await subB.refreshNow();

    currentStatus = "idle";
    await subA.refreshNow();
    await subB.refreshNow();

    for (const callback of [...errorListeners]) {
      callback(new Error("boom"));
    }

    await subA.stop();
    await subB.stop();

    expect(eventsA).toEqual(eventsB);
    expect(eventsA).toContain("started");
    expect(eventsA).toContain("snapshot");
    expect(eventsA).toContain("updated");
    expect(eventsA).toContain("stopped");
  });
});

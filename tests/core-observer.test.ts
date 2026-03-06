import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  createObserver,
  OBSERVER_EVENT_TYPES,
  PROVIDER_KINDS,
  type TranscriptProvider,
} from "@/core";
import { createCursorTranscriptProvider } from "@/providers/cursor";
import { afterEach, describe, expect, it } from "vitest";

describe("createObserver", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it("composes runtime events with provider injection", async () => {
    let reads = 0;
    const provider: TranscriptProvider = {
      id: PROVIDER_KINDS.cursor,
      discover: () => ({
        inputs: [{ uri: "/tmp/transcript.jsonl", kind: "file" }],
        watchPaths: ["/tmp"],
        warnings: [],
      }),
      read: () => ({
        records: [],
        health: { connected: true, sourceLabel: "mock", warnings: [] },
      }),
      normalize: () => {
        reads += 1;
        return {
          agents: [
            {
              id: "agent-1",
              name: "Agent One",
              kind: "local",
              isSubagent: false,
              status: reads > 1 ? "idle" : "running",
              taskSummary: "Test task",
              updatedAt: Date.now(),
              source: "mock",
            },
          ],
          health: { connected: true, sourceLabel: "mock", warnings: [] },
        };
      },
    };

    const observer = createObserver({
      provider,
      workspacePaths: ["/tmp/workspace"],
      now: () => 1_000 + reads,
    });

    const eventTypes: string[] = [];
    observer.subscribe((event) => eventTypes.push(event.type));

    await observer.start();
    const snapshot = await observer.refreshNow();
    await observer.stop();

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0].status).toBe("idle");
    expect(eventTypes[0]).toBe(OBSERVER_EVENT_TYPES.started);
    expect(eventTypes).toContain(OBSERVER_EVENT_TYPES.snapshot);
    expect(eventTypes).toContain(OBSERVER_EVENT_TYPES.updated);
    expect(eventTypes.at(-1)).toBe(OBSERVER_EVENT_TYPES.stopped);
  });

  it("works with injected Cursor transcript provider", async () => {
    const workspacePath = path.join(
      "/tmp",
      `observer-core-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const transcriptDir = workspaceToTranscriptDir(workspacePath);
    cleanupPaths.push(transcriptDir);
    const transcriptPath = path.join(transcriptDir, "session.jsonl");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        agentId: "a1",
        agentName: "Agent One",
        kind: "local",
        status: "running",
        task: "Build observer API",
        updatedAt: Date.now(),
      })}\n`,
      "utf8",
    );

    const observer = createObserver({
      provider: createCursorTranscriptProvider(),
      workspacePaths: [workspacePath],
    });

    await observer.start();
    const snapshot = await observer.refreshNow();
    await observer.stop();

    expect(snapshot.health.connected).toBe(true);
    expect(snapshot.agents.length).toBeGreaterThan(0);
    expect(snapshot.agents[0].id).toBe("a1");
  });
});

function workspaceToTranscriptDir(workspacePath: string): string {
  const workspaceId = path.resolve(workspacePath).replace(/^\/+/, "").split(/[\\/]/).join("-");
  return path.join(homedir(), ".cursor", "projects", workspaceId, "agent-transcripts");
}

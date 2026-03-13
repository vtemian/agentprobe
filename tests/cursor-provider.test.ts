import { describe, expect, it } from "vitest";
import { CURSOR_WATCH_DEBOUNCE_MS, createCursorTranscriptProvider } from "@/providers/cursor";

describe("cursor transcript provider", () => {
  it("includes watch by default", () => {
    const provider = createCursorTranscriptProvider();
    expect(provider.watch).toBeDefined();
    expect(provider.watch?.debounceMs).toBe(CURSOR_WATCH_DEBOUNCE_MS);
  });

  it("accepts custom watch debounce", () => {
    const provider = createCursorTranscriptProvider({ watch: { debounceMs: 500 } });
    expect(provider.watch?.debounceMs).toBe(500);
  });

  it("allows disabling watch with false", () => {
    const provider = createCursorTranscriptProvider({ watch: false });
    expect(provider.watch).toBeUndefined();
  });

  it("returns empty agents when payload has no agents array", async () => {
    const provider = createCursorTranscriptProvider();

    const snapshot = await provider.normalize(
      {
        records: [
          {
            provider: "cursor",
            inputUri: "cursor://transcripts",
            observedAt: Date.now(),
            payload: { broken: true },
          },
        ],
        health: {
          connected: true,
          sourceLabel: "cursor-transcripts",
          warnings: [],
        },
      },
      Date.now(),
    );

    expect(snapshot.agents).toHaveLength(0);
  });

  it("returns empty agents when payload is null", async () => {
    const provider = createCursorTranscriptProvider();
    const health = { connected: true, sourceLabel: "cursor-transcripts", warnings: [] };

    const snapshot = await provider.normalize(
      {
        records: [
          {
            provider: "cursor",
            inputUri: "cursor://transcripts",
            observedAt: Date.now(),
            payload: null,
          },
        ],
        health,
      },
      Date.now(),
    );

    expect(snapshot.agents).toHaveLength(0);
  });

  it("returns empty agents when payload is missing agents field", async () => {
    const provider = createCursorTranscriptProvider();
    const health = { connected: true, sourceLabel: "cursor-transcripts", warnings: [] };

    const snapshot = await provider.normalize(
      {
        records: [
          {
            provider: "cursor",
            inputUri: "cursor://transcripts",
            observedAt: Date.now(),
            payload: { notAgents: [] },
          },
        ],
        health,
      },
      Date.now(),
    );

    expect(snapshot.agents).toHaveLength(0);
  });

  it("extracts agents from valid payload regardless of other field shapes", async () => {
    const provider = createCursorTranscriptProvider();
    const now = Date.now();

    const snapshot = await provider.normalize(
      {
        records: [
          {
            provider: "cursor",
            inputUri: "cursor://transcripts",
            observedAt: now,
            payload: {
              agents: [
                {
                  id: "agent-1",
                  name: "Agent One",
                  kind: "local",
                  isSubagent: false,
                  status: "running",
                  taskSummary: "Task",
                  updatedAt: now,
                  source: "cursor-transcripts",
                },
              ],
              connected: true,
              sourceLabel: "cursor-transcripts",
              warnings: [123],
            },
          },
        ],
        health: { connected: true, sourceLabel: "cursor-transcripts", warnings: [] },
      },
      now,
    );

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0].id).toBe("agent-1");
  });
});

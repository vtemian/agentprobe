import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCursorTranscriptSource } from "../src/providers/cursor/transcripts";
import { describe, expect, it } from "vitest";

describe("cursor transcripts", () => {
  it("uses the newest agent snapshot per id across transcript files", async () => {
    const baseDir = path.join(
      "/tmp",
      `observer-transcripts-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(baseDir, { recursive: true });
    const oldPath = path.join(baseDir, "old.jsonl");
    const newPath = path.join(baseDir, "new.jsonl");

    writeFileSync(
      oldPath,
      `${JSON.stringify({
        agentId: "a1",
        agentName: "Agent One",
        status: "running",
        task: "Old task",
        updatedAt: 100,
      })}\n`,
      "utf8",
    );
    writeFileSync(
      newPath,
      `${JSON.stringify({
        agentId: "a1",
        agentName: "Agent One",
        status: "idle",
        task: "New task",
        updatedAt: 200,
      })}\n`,
      "utf8",
    );

    const source = createCursorTranscriptSource({ sourcePaths: [oldPath, newPath] });
    source.connect();
    const snapshot = await source.readSnapshot();

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]?.status).toBe("idle");
    expect(snapshot.agents[0]?.taskSummary).toBe("New task");

    rmSync(baseDir, { recursive: true, force: true });
  });

  it("derives conversation-only task summary from user_query tags", async () => {
    const baseDir = path.join(
      "/tmp",
      `observer-transcripts-conv-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(baseDir, { recursive: true });
    const transcriptPath = path.join(baseDir, "session.jsonl");
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: "<user_query>Investigate flaky test now</user_query>",
              },
            ],
          },
        }),
        JSON.stringify({
          role: "assistant",
          message: {
            content: [{ type: "text", text: "done and completed successfully" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const source = createCursorTranscriptSource({ sourcePaths: [transcriptPath] });
    source.connect();
    const snapshot = await source.readSnapshot(Date.now() + 300_000);

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]?.taskSummary).toBe("Investigate flaky test now");

    rmSync(baseDir, { recursive: true, force: true });
  });
});

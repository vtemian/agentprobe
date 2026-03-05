import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCursorTranscriptSource } from "@/providers/cursor/transcripts";
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

  it("parses UTF-8 BOM prefixed jsonl lines", async () => {
    const baseDir = path.join(
      "/tmp",
      `observer-transcripts-bom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(baseDir, { recursive: true });
    const transcriptPath = path.join(baseDir, "session.jsonl");
    writeFileSync(
      transcriptPath,
      `\uFEFF${JSON.stringify({
        agentId: "a2",
        agentName: "Agent Two",
        status: "running",
        task: "Task from BOM file",
        updatedAt: 300,
      })}\n`,
      "utf8",
    );

    const source = createCursorTranscriptSource({ sourcePaths: [transcriptPath] });
    source.connect();
    const snapshot = await source.readSnapshot();

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]?.id).toBe("a2");

    rmSync(baseDir, { recursive: true, force: true });
  });

  it("emits warnings for unrecognized json object lines", async () => {
    const baseDir = path.join(
      "/tmp",
      `observer-transcripts-warning-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(baseDir, { recursive: true });
    const transcriptPath = path.join(baseDir, "session.jsonl");
    writeFileSync(transcriptPath, `${JSON.stringify({ foo: "bar", unknown: true })}\n`, "utf8");

    const source = createCursorTranscriptSource({ sourcePaths: [transcriptPath] });
    source.connect();
    const snapshot = await source.readSnapshot();

    expect(snapshot.agents).toHaveLength(0);
    expect(snapshot.warnings.length).toBeGreaterThan(0);
    expect(snapshot.warnings[0]).toContain("Unrecognized transcript record");

    rmSync(baseDir, { recursive: true, force: true });
  });
});

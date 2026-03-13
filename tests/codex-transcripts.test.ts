import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexTranscriptSource } from "@/providers/codex/transcripts";

describe("codex transcripts", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  function createTempDir(label: string): string {
    const dir = path.join(
      "/tmp",
      `codex-transcripts-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    cleanupPaths.push(dir);
    return dir;
  }

  function writeSession(dir: string, filename: string, records: unknown[]): string {
    const filePath = path.join(dir, filename);
    writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join("\n"), "utf8");
    return filePath;
  }

  function setFileMtime(filePath: string, mtimeMs: number): void {
    const secs = mtimeMs / 1000;
    utimesSync(filePath, secs, secs);
  }

  const sessionMeta = {
    type: "session_meta" as const,
    timestamp: "2026-03-10T07:00:00.000Z",
    payload: {
      id: "test-id",
      cwd: "/test",
      source: "cli",
      cli_version: "0.114.0",
      git: {
        branch: "main",
        commit_hash: "abc",
        repository_url: "git@github.com:test/test.git",
      },
    },
  };

  function userMessage(content: string, timestamp = "2026-03-10T07:00:01.000Z") {
    return {
      type: "response_item" as const,
      timestamp,
      payload: {
        type: "message" as const,
        role: "user" as const,
        content: [{ type: "input_text", text: content }],
      },
    };
  }

  function assistantMessage(timestamp = "2026-03-10T07:00:02.000Z") {
    return {
      type: "response_item" as const,
      timestamp,
      payload: {
        type: "message" as const,
        role: "assistant" as const,
        content: "I'll help with that.",
      },
    };
  }

  function functionCall(name: string, timestamp = "2026-03-10T07:00:03.000Z") {
    return {
      type: "response_item" as const,
      timestamp,
      payload: {
        type: "function_call" as const,
        name,
        arguments: "{}",
        call_id: `call-${name}`,
      },
    };
  }

  function turnContext(model: string, timestamp = "2026-03-10T07:00:04.000Z") {
    return {
      type: "turn_context" as const,
      timestamp,
      payload: { model },
    };
  }

  it("returns disconnected warning when not connected", async () => {
    const source = createCodexTranscriptSource({ sourcePaths: ["/nonexistent"] });
    const snapshot = await source.readSnapshot();

    expect(snapshot.connected).toBe(false);
    expect(snapshot.agents).toHaveLength(0);
    expect(snapshot.warnings).toContain("Codex transcript source is disconnected.");
  });

  it("returns empty when no source paths configured", async () => {
    const source = createCodexTranscriptSource({ sourcePaths: [] });
    source.connect();
    const snapshot = await source.readSnapshot();

    expect(snapshot.connected).toBe(false);
    expect(snapshot.agents).toHaveLength(0);
    expect(snapshot.warnings).toContain("No session paths configured.");
  });

  it("parses session_meta to extract sessionId, cwd, gitBranch", async () => {
    const dir = createTempDir("meta");
    const filePath = writeSession(dir, "session.jsonl", [
      sessionMeta,
      userMessage("hello"),
      assistantMessage(),
    ]);

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCodexTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents).toHaveLength(1);
    const agent = snapshot.agents[0];
    expect(agent.id).toBe("test-id");
    expect(agent.metadata?.cwd).toBe("/test");
    expect(agent.metadata?.gitBranch).toBe("main");
    expect(agent.metadata?.cliVersion).toBe("0.114.0");
    expect(agent.metadata?.source).toBe("cli");
  });

  it("counts user messages (messageCount) from response_item message/user records", async () => {
    const dir = createTempDir("msgcount");
    const filePath = writeSession(dir, "session.jsonl", [
      sessionMeta,
      userMessage("first", "2026-03-10T07:00:01.000Z"),
      assistantMessage("2026-03-10T07:00:02.000Z"),
      userMessage("second", "2026-03-10T07:00:03.000Z"),
      assistantMessage("2026-03-10T07:00:04.000Z"),
      userMessage("third", "2026-03-10T07:00:05.000Z"),
    ]);

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCodexTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    const agent = snapshot.agents[0];
    expect(agent.metadata?.messageCount).toBe(5);
  });

  it("counts tool calls (toolCallCount) from response_item function_call records", async () => {
    const dir = createTempDir("toolcount");
    const filePath = writeSession(dir, "session.jsonl", [
      sessionMeta,
      userMessage("do stuff"),
      assistantMessage(),
      functionCall("shell", "2026-03-10T07:00:03.000Z"),
      functionCall("read_file", "2026-03-10T07:00:04.000Z"),
      functionCall("write_file", "2026-03-10T07:00:05.000Z"),
    ]);

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCodexTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    const agent = snapshot.agents[0];
    expect(agent.metadata?.toolCallCount).toBe(3);
  });

  it("extracts model from turn_context records", async () => {
    const dir = createTempDir("model");
    const filePath = writeSession(dir, "session.jsonl", [
      sessionMeta,
      userMessage("hello"),
      turnContext("o3-mini"),
      assistantMessage(),
    ]);

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCodexTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0]?.metadata?.model).toBe("o3-mini");
  });

  it("extracts latest user content from user message input_text", async () => {
    const dir = createTempDir("usercontent");
    const filePath = writeSession(dir, "session.jsonl", [
      sessionMeta,
      userMessage("first task", "2026-03-10T07:00:01.000Z"),
      assistantMessage("2026-03-10T07:00:02.000Z"),
      userMessage("second task", "2026-03-10T07:00:03.000Z"),
    ]);

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCodexTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].taskSummary).toBe("second task");
  });

  it("derives status as running when file mtime is within 3s of now", async () => {
    const dir = createTempDir("running");
    const filePath = writeSession(dir, "session.jsonl", [
      sessionMeta,
      userMessage("task"),
      assistantMessage(),
    ]);

    const now = Date.now();
    setFileMtime(filePath, now - 1000);

    const source = createCodexTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].status).toBe("running");
  });

  it("derives status as idle when file mtime is within 60s of now", async () => {
    const dir = createTempDir("idle");
    const filePath = writeSession(dir, "session.jsonl", [
      sessionMeta,
      userMessage("task"),
      assistantMessage(),
    ]);

    const now = Date.now();
    setFileMtime(filePath, now - 10_000);

    const source = createCodexTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].status).toBe("idle");
  });

  it("derives status as completed when file mtime is beyond 60s of now", async () => {
    const dir = createTempDir("completed");
    const filePath = writeSession(dir, "session.jsonl", [
      sessionMeta,
      userMessage("task"),
      assistantMessage(),
    ]);

    const now = Date.now();
    setFileMtime(filePath, now - 120_000);

    const source = createCodexTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].status).toBe("completed");
  });

  it("skips records with invalid timestamps without corrupting agent snapshots", async () => {
    const dir = createTempDir("bad-timestamp");
    // Put the invalid-timestamp record first so that firstTimestamp becomes NaN
    // before any valid timestamp can be set
    const filePath = writeSession(dir, "session.jsonl", [
      {
        type: "response_item" as const,
        timestamp: "not-a-date",
        payload: {
          type: "message" as const,
          role: "user" as const,
          content: [{ type: "input_text", text: "bad timestamp task" }],
        },
      },
      sessionMeta,
      userMessage("valid task", "2026-03-10T07:00:01.000Z"),
      assistantMessage("2026-03-10T07:00:02.000Z"),
    ]);

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCodexTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents).toHaveLength(1);
    const agent = snapshot.agents[0];
    // No NaN should appear in any numeric field
    for (const key of ["startedAt", "updatedAt"] as const) {
      expect(Number.isNaN(agent[key])).toBe(false);
    }
    // startedAt should reflect the earliest VALID timestamp
    expect(agent.startedAt).toBe(new Date("2026-03-10T07:00:00.000Z").getTime());
    // The record with invalid timestamp should be skipped entirely,
    // so messageCount should only include the valid user + assistant messages
    expect(agent.metadata?.messageCount).toBe(2);
  });
});

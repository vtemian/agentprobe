import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeTranscriptSource } from "@/providers/claude-code/transcripts";

describe("claude-code transcripts", () => {
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
      `claude-transcripts-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
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

  const baseFields = {
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: "/projects/test",
    sessionId: "sess-001",
    version: "2.1.72",
    gitBranch: "main",
  };

  it("extracts parent agent from a simple user/assistant session", async () => {
    const dir = createTempDir("simple");
    const filePath = writeSession(dir, "sess-001.jsonl", [
      {
        ...baseFields,
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-10T07:00:00.000Z",
        message: { role: "user", content: "fix the bug" },
      },
      {
        ...baseFields,
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-03-10T07:00:01.000Z",
        requestId: "req-1",
        message: {
          model: "claude-opus-4-6",
          role: "assistant",
          content: [{ type: "text", text: "I'll fix it." }],
          stop_reason: "end_turn",
        },
      },
    ]);

    const source = createClaudeCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(new Date("2026-03-10T07:00:02.000Z").getTime());

    expect(snapshot.connected).toBe(true);
    expect(snapshot.agents.length).toBeGreaterThanOrEqual(1);
    const parent = snapshot.agents.find((a) => !a.isSubagent);
    expect(parent).toBeDefined();
    expect(parent?.id).toBe("sess-001");
    expect(parent?.taskSummary).toBe("fix the bug");
    expect(parent?.status).toBe("running");
    expect(parent?.source).toBe("claude-code-sessions");
    expect(parent?.metadata).toEqual(
      expect.objectContaining({
        model: "claude-opus-4-6",
        gitBranch: "main",
        version: "2.1.72",
      }),
    );
  });

  it("marks agent idle after RUNNING_WINDOW_MS", async () => {
    const dir = createTempDir("idle");
    const filePath = writeSession(dir, "sess-idle.jsonl", [
      {
        ...baseFields,
        sessionId: "sess-idle",
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-10T07:00:00.000Z",
        message: { role: "user", content: "do something" },
      },
      {
        ...baseFields,
        sessionId: "sess-idle",
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-03-10T07:00:01.000Z",
        requestId: "req-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "working on it" }],
          stop_reason: "end_turn",
        },
      },
    ]);

    const source = createClaudeCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    // 10 seconds after last record -> idle
    const snapshot = await source.readSnapshot(new Date("2026-03-10T07:00:11.000Z").getTime());

    const agent = snapshot.agents.find((a) => !a.isSubagent);
    expect(agent?.status).toBe("idle");
  });

  it("marks agent completed after IDLE_WINDOW_MS", async () => {
    const dir = createTempDir("completed");
    const filePath = writeSession(dir, "sess-done.jsonl", [
      {
        ...baseFields,
        sessionId: "sess-done",
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-10T07:00:00.000Z",
        message: { role: "user", content: "quick task" },
      },
      {
        ...baseFields,
        sessionId: "sess-done",
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-03-10T07:00:01.000Z",
        requestId: "req-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stop_reason: "end_turn",
        },
      },
    ]);

    const source = createClaudeCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    // 2 minutes after last record -> completed
    const snapshot = await source.readSnapshot(new Date("2026-03-10T07:02:01.000Z").getTime());

    const agent = snapshot.agents.find((a) => !a.isSubagent);
    expect(agent?.status).toBe("completed");
  });

  it("extracts subagents from agent_progress events", async () => {
    const dir = createTempDir("subagent");
    const filePath = writeSession(dir, "sess-sub.jsonl", [
      {
        ...baseFields,
        sessionId: "sess-sub",
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-10T07:00:00.000Z",
        message: { role: "user", content: "explore the code" },
      },
      {
        ...baseFields,
        sessionId: "sess-sub",
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-03-10T07:00:01.000Z",
        requestId: "req-1",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tool-1", name: "Agent", input: {} }],
          stop_reason: "tool_use",
        },
      },
      {
        ...baseFields,
        sessionId: "sess-sub",
        type: "progress",
        uuid: "p1",
        parentUuid: "a1",
        timestamp: "2026-03-10T07:00:02.000Z",
        data: {
          type: "agent_progress",
          agentId: "sub-agent-001",
          prompt: "Explore the codebase thoroughly",
          message: {},
        },
        toolUseID: "agent-tool-1",
        parentToolUseID: "tool-1",
      },
      {
        ...baseFields,
        sessionId: "sess-sub",
        type: "progress",
        uuid: "p2",
        parentUuid: "a1",
        timestamp: "2026-03-10T07:00:03.000Z",
        data: {
          type: "agent_progress",
          agentId: "sub-agent-001",
          prompt: "Explore the codebase thoroughly",
          message: {},
        },
        toolUseID: "agent-tool-1",
        parentToolUseID: "tool-1",
      },
    ]);

    const source = createClaudeCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(new Date("2026-03-10T07:00:04.000Z").getTime());

    const subagent = snapshot.agents.find((a) => a.isSubagent);
    expect(subagent).toBeDefined();
    expect(subagent?.id).toBe("sess-sub:sub-agent-001");
    expect(subagent?.name).toBe("Subagent sub-ag");
    expect(subagent?.isSubagent).toBe(true);
    expect(subagent?.taskSummary).toBe("Explore the codebase thoroughly");
    expect(subagent?.status).toBe("running");
    expect(subagent?.metadata).toEqual(
      expect.objectContaining({
        parentSessionId: "sess-sub",
        progressCount: 2,
      }),
    );
  });

  it("returns disconnected when not connected", async () => {
    const source = createClaudeCodeTranscriptSource({ sourcePaths: [] });
    const snapshot = await source.readSnapshot();

    expect(snapshot.connected).toBe(false);
    expect(snapshot.agents).toHaveLength(0);
  });

  it("uses incremental parsing on file append", async () => {
    const dir = createTempDir("incremental");
    const filePath = writeSession(dir, "sess-inc.jsonl", [
      {
        ...baseFields,
        sessionId: "sess-inc",
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-10T07:00:00.000Z",
        message: { role: "user", content: "first task" },
      },
    ]);

    const source = createClaudeCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snap1 = await source.readSnapshot(new Date("2026-03-10T07:00:01.000Z").getTime());
    expect(snap1.agents[0]?.taskSummary).toBe("first task");

    // Append new user message
    appendFileSync(
      filePath,
      `\n${JSON.stringify({
        ...baseFields,
        sessionId: "sess-inc",
        type: "user",
        uuid: "u2",
        parentUuid: "u1",
        timestamp: "2026-03-10T07:00:05.000Z",
        message: { role: "user", content: "second task" },
      })}`,
      "utf8",
    );

    const snap2 = await source.readSnapshot(new Date("2026-03-10T07:00:06.000Z").getTime());
    expect(snap2.agents[0]?.taskSummary).toBe("second task");
  });

  it("includes rich metadata", async () => {
    const dir = createTempDir("metadata");
    const filePath = writeSession(dir, "sess-meta.jsonl", [
      {
        ...baseFields,
        sessionId: "sess-meta",
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-10T07:00:00.000Z",
        message: { role: "user", content: "hello" },
        permissionMode: "bypassPermissions",
      },
      {
        ...baseFields,
        sessionId: "sess-meta",
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-03-10T07:00:01.000Z",
        requestId: "req-1",
        message: {
          model: "claude-sonnet-4-6",
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            { type: "tool_use", id: "t1", name: "Read", input: {} },
          ],
          stop_reason: "tool_use",
        },
      },
    ]);

    const source = createClaudeCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(new Date("2026-03-10T07:00:02.000Z").getTime());

    const agent = snapshot.agents.find((a) => !a.isSubagent);
    expect(agent?.metadata).toEqual(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        gitBranch: "main",
        version: "2.1.72",
        cwd: "/projects/test",
        permissionMode: "bypassPermissions",
        messageCount: 2,
        toolCallCount: 1,
      }),
    );
  });

  it("skips file-history-snapshot and queue-operation records without warnings", async () => {
    const dir = createTempDir("skip");
    const filePath = writeSession(dir, "sess-skip.jsonl", [
      {
        type: "file-history-snapshot",
        messageId: "u1",
        isSnapshotUpdate: false,
        snapshot: {
          messageId: "u1",
          timestamp: "2026-03-10T07:00:00.000Z",
          trackedFileBackups: {},
        },
      },
      {
        ...baseFields,
        sessionId: "sess-skip",
        type: "user",
        uuid: "u1",
        timestamp: "2026-03-10T07:00:00.000Z",
        message: { role: "user", content: "real task" },
      },
    ]);

    const source = createClaudeCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(new Date("2026-03-10T07:00:01.000Z").getTime());

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]?.taskSummary).toBe("real task");
    expect(snapshot.warnings).toHaveLength(0);
  });
});

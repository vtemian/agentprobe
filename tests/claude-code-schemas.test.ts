import { describe, expect, it } from "vitest";
import {
  parseSessionRecord,
  type ClaudeCodeSessionRecord,
} from "@/providers/claude-code/schemas";

describe("claude-code schemas", () => {
  it("parses a user record with string content", () => {
    const raw = {
      parentUuid: "abc-123",
      isSidechain: false,
      userType: "external",
      cwd: "/projects/foo",
      sessionId: "sess-001",
      version: "2.1.72",
      gitBranch: "main",
      timestamp: "2026-03-10T07:35:50.757Z",
      uuid: "uuid-001",
      type: "user",
      message: {
        role: "user",
        content: "hello world",
      },
    };

    const result = parseSessionRecord(raw);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("user");
  });

  it("parses a user record with array content", () => {
    const raw = {
      parentUuid: "abc-123",
      isSidechain: false,
      userType: "external",
      cwd: "/projects/foo",
      sessionId: "sess-001",
      version: "2.1.72",
      gitBranch: "main",
      timestamp: "2026-03-10T07:35:50.757Z",
      uuid: "uuid-001",
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    };

    const result = parseSessionRecord(raw);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("user");
  });

  it("parses an assistant record with tool_use content", () => {
    const raw = {
      parentUuid: "uuid-001",
      isSidechain: false,
      userType: "external",
      cwd: "/projects/foo",
      sessionId: "sess-001",
      version: "2.1.72",
      gitBranch: "main",
      timestamp: "2026-03-10T07:36:00.000Z",
      uuid: "uuid-002",
      type: "assistant",
      requestId: "req_001",
      message: {
        model: "claude-opus-4-6",
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that file." },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/foo.ts" } },
        ],
        stop_reason: "tool_use",
      },
    };

    const result = parseSessionRecord(raw);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("assistant");
  });

  it("parses a progress record with agent_progress data", () => {
    const raw = {
      parentUuid: "uuid-002",
      isSidechain: false,
      userType: "external",
      cwd: "/projects/foo",
      sessionId: "sess-001",
      version: "2.1.72",
      gitBranch: "main",
      timestamp: "2026-03-10T07:36:05.000Z",
      uuid: "uuid-003",
      type: "progress",
      data: {
        type: "agent_progress",
        agentId: "a359541c133c9c115",
        prompt: "Explore the codebase",
        message: {},
      },
      toolUseID: "tool-agent-1",
      parentToolUseID: "tool-1",
    };

    const result = parseSessionRecord(raw);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("progress");
  });

  it("parses a system record", () => {
    const raw = {
      parentUuid: "uuid-002",
      isSidechain: false,
      userType: "external",
      cwd: "/projects/foo",
      sessionId: "sess-001",
      version: "2.1.72",
      gitBranch: "main",
      timestamp: "2026-03-10T07:40:00.000Z",
      uuid: "uuid-004",
      type: "system",
      subtype: "turn_duration",
      slug: "some-slug",
    };

    const result = parseSessionRecord(raw);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("system");
  });

  it("returns null for file-history-snapshot records", () => {
    const raw = {
      type: "file-history-snapshot",
      messageId: "uuid-001",
      isSnapshotUpdate: false,
      snapshot: { messageId: "uuid-001", timestamp: "2026-03-10T07:35:50.757Z", trackedFileBackups: {} },
    };

    const result = parseSessionRecord(raw);
    expect(result).toBeNull();
  });

  it("returns null for queue-operation records", () => {
    const raw = {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-03-10T07:36:00.000Z",
      sessionId: "sess-001",
      content: "/cost",
    };

    const result = parseSessionRecord(raw);
    expect(result).toBeNull();
  });

  it("returns null for invalid/unknown records", () => {
    const result = parseSessionRecord({ foo: "bar" });
    expect(result).toBeNull();
  });
});

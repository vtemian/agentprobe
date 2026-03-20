import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCortexCodeTranscriptSource } from "@/providers/cortex-code/transcripts";

describe("cortex-code transcripts", () => {
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
      `cortex-transcripts-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    cleanupPaths.push(dir);
    return dir;
  }

  function writeConversation(
    dir: string,
    filename: string,
    overrides: Record<string, unknown> = {},
  ): string {
    const filePath = path.join(dir, filename);
    const data = {
      session_id: filename.replace(".json", ""),
      title: "Test session",
      working_directory: "/test",
      session_type: "main",
      created_at: "2026-03-10T07:00:00.000Z",
      last_updated: "2026-03-10T07:05:00.000Z",
      connection_name: "devrel",
      history: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I can help with that." }],
        },
      ],
      ...overrides,
    };
    writeFileSync(filePath, JSON.stringify(data), "utf8");
    return filePath;
  }

  function setFileMtime(filePath: string, mtimeMs: number): void {
    const secs = mtimeMs / 1000;
    utimesSync(filePath, secs, secs);
  }

  it("returns disconnected warning when not connected", async () => {
    const source = createCortexCodeTranscriptSource({ sourcePaths: ["/nonexistent"] });
    const snapshot = await source.readSnapshot();

    expect(snapshot.connected).toBe(false);
    expect(snapshot.agents).toHaveLength(0);
    expect(snapshot.warnings).toContain("Cortex Code transcript source is disconnected.");
  });

  it("returns empty when no source paths configured", async () => {
    const source = createCortexCodeTranscriptSource({ sourcePaths: [] });
    source.connect();
    const snapshot = await source.readSnapshot();

    expect(snapshot.connected).toBe(false);
    expect(snapshot.agents).toHaveLength(0);
    expect(snapshot.warnings).toContain("No session paths configured.");
  });

  it("parses session_id and metadata from conversation", async () => {
    const dir = createTempDir("meta");
    const filePath = writeConversation(dir, "sess-abc.json", {
      connection_name: "prod",
      session_type: "main",
    });

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCortexCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents).toHaveLength(1);
    const agent = snapshot.agents[0];
    expect(agent.id).toBe("sess-abc");
    expect(agent.source).toBe("cortex-code-sessions");
    expect(agent.kind).toBe("local");
    expect(agent.metadata?.connectionName).toBe("prod");
    expect(agent.metadata?.sessionType).toBe("main");
  });

  it("counts user messages (messageCount)", async () => {
    const dir = createTempDir("msgcount");
    const filePath = writeConversation(dir, "sess-count.json", {
      history: [
        {
          role: "user",
          content: [{ type: "text", text: "first" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "reply" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "second" }],
        },
      ],
    });

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCortexCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].metadata?.messageCount).toBe(2);
  });

  it("counts tool calls (toolCallCount)", async () => {
    const dir = createTempDir("toolcount");
    const filePath = writeConversation(dir, "sess-tools.json", {
      history: [
        {
          role: "user",
          content: [{ type: "text", text: "do stuff" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              tool_use: { tool_use_id: "tu-1", name: "bash", input: {} },
            },
            {
              type: "tool_use",
              tool_use: { tool_use_id: "tu-2", name: "read", input: {} },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_result: { tool_use_id: "tu-1", content: "ok" },
            },
            {
              type: "tool_result",
              tool_result: { tool_use_id: "tu-2", content: "ok" },
            },
          ],
        },
      ],
    });

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCortexCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].metadata?.toolCallCount).toBe(2);
  });

  it("extracts task summary from first user text", async () => {
    const dir = createTempDir("summary");
    const filePath = writeConversation(dir, "sess-summary.json", {
      history: [
        {
          role: "user",
          content: [{ type: "text", text: "fix the flaky test in auth.ts" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "I'll look into it." }],
        },
      ],
    });

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCortexCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].taskSummary).toBe("fix the flaky test in auth.ts");
  });

  it("marks subagent sessions correctly", async () => {
    const dir = createTempDir("subagent");
    const filePath = writeConversation(dir, "sess-sub.json", {
      session_type: "subagent",
    });

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCortexCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].isSubagent).toBe(true);
  });

  it("derives status as running when recently updated with active tool use", async () => {
    const dir = createTempDir("running");
    const now = Date.now();
    const filePath = writeConversation(dir, "sess-running.json", {
      last_updated: new Date(now - 1000).toISOString(),
      history: [
        {
          role: "user",
          content: [{ type: "text", text: "run tests" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              tool_use: { tool_use_id: "tu-1", name: "bash", input: {} },
            },
          ],
        },
      ],
    });

    setFileMtime(filePath, now - 1000);

    const source = createCortexCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].status).toBe("running");
  });

  it("derives status as idle when within 60s but not actively working", async () => {
    const dir = createTempDir("idle");
    const now = Date.now();
    const filePath = writeConversation(dir, "sess-idle.json", {
      last_updated: new Date(now - 10_000).toISOString(),
      history: [
        {
          role: "user",
          content: [{ type: "text", text: "task" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      ],
    });

    setFileMtime(filePath, now - 10_000);

    const source = createCortexCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].status).toBe("idle");
  });

  it("derives status as completed when beyond 60s since update", async () => {
    const dir = createTempDir("completed");
    const filePath = writeConversation(dir, "sess-completed.json", {
      history: [
        {
          role: "user",
          content: [{ type: "text", text: "task" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      ],
    });

    const now = Date.now();
    setFileMtime(filePath, now - 120_000);

    const source = createCortexCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].status).toBe("completed");
  });

  it("uses title as agent name when available", async () => {
    const dir = createTempDir("title");
    const filePath = writeConversation(dir, "sess-titled.json", {
      title: "Fix auth bug",
    });

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCortexCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].name).toBe("Fix auth bug");
  });

  it("uses session_id prefix as name when title is default format", async () => {
    const dir = createTempDir("notitle");
    const filePath = writeConversation(dir, "abcdef-1234-5678.json", {
      title: "Chat for session: abcdef-1234-5678",
    });

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCortexCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents[0].name).toBe("abcdef");
  });

  it("handles invalid JSON gracefully with warning", async () => {
    const dir = createTempDir("badjson");
    const filePath = path.join(dir, "bad.json");
    writeFileSync(filePath, "not json{{{", "utf8");

    const now = Date.now();
    setFileMtime(filePath, now);

    const source = createCortexCodeTranscriptSource({ sourcePaths: [filePath] });
    source.connect();
    const snapshot = await source.readSnapshot(now);

    expect(snapshot.agents).toHaveLength(0);
    expect(snapshot.warnings.some((w) => w.includes("Failed to parse conversation"))).toBe(true);
  });
});

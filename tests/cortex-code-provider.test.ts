import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_KINDS } from "@/core/providers";
import { cortexCode } from "@/providers/cortex-code/provider";

describe("cortex-code provider", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  function setupCortexHome(label: string): {
    cortexHome: string;
    conversationsDir: string;
  } {
    const cortexHome = path.join(
      "/tmp",
      `cortex-provider-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const conversationsDir = path.join(cortexHome, "conversations");
    mkdirSync(conversationsDir, { recursive: true });
    cleanupPaths.push(cortexHome);
    return { cortexHome, conversationsDir };
  }

  function writeConversationFile(
    conversationsDir: string,
    filename: string,
    workspacePath: string,
  ): string {
    const filePath = path.join(conversationsDir, filename);
    const data = {
      session_id: filename.replace(".json", ""),
      title: "Test session",
      working_directory: workspacePath,
      session_type: "main",
      created_at: new Date().toISOString(),
      last_updated: new Date().toISOString(),
      connection_name: "devrel",
      history: [
        {
          role: "user",
          content: [{ type: "text", text: "implement the cortex adapter" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              tool_use: {
                tool_use_id: "tu-1",
                name: "bash",
                input: { command: "ls" },
              },
            },
          ],
        },
      ],
    };
    writeFileSync(filePath, JSON.stringify(data), "utf8");
    return filePath;
  }

  it("discovers, reads, and normalizes into a valid CanonicalSnapshot", async () => {
    const workspacePath = "/tmp/test-cortex-workspace";
    const { cortexHome, conversationsDir } = setupCortexHome("full");
    const sessionPath = writeConversationFile(
      conversationsDir,
      "sess-cortex-001.json",
      workspacePath,
    );

    const provider = cortexCode({ cortexHomePath: cortexHome, watch: false });
    provider.connect?.();

    const discovery = await provider.discover([workspacePath]);
    expect(discovery).toEqual(
      expect.objectContaining({
        inputs: expect.arrayContaining([
          expect.objectContaining({ uri: sessionPath, kind: "file" }),
        ]),
        watchPaths: expect.arrayContaining([path.join(cortexHome, "conversations")]),
      }),
    );

    const readResult = await provider.read(discovery.inputs, Date.now());
    expect(readResult.health.connected).toBe(true);

    const normalized = await provider.normalize(readResult, Date.now());
    expect(normalized.agents.length).toBeGreaterThan(0);

    const agent = normalized.agents[0];
    expect(agent.taskSummary).toBe("implement the cortex adapter");
    expect(agent.source).toBe("cortex-code-sessions");
    expect(agent.kind).toBe("local");
    expect(agent.isSubagent).toBe(false);
    expect(agent.metadata).toEqual(
      expect.objectContaining({
        connectionName: "devrel",
        messageCount: 1,
        toolCallCount: 1,
        sessionType: "main",
      }),
    );
  });

  it("returns empty inputs for non-matching workspace", async () => {
    const { cortexHome, conversationsDir } = setupCortexHome("nomatch");
    writeConversationFile(conversationsDir, "sess-cortex-002.json", "/some/other/project");

    const provider = cortexCode({ cortexHomePath: cortexHome, watch: false });
    const discovery = await provider.discover(["/nonexistent/workspace"]);
    expect(discovery.inputs).toHaveLength(0);
  });

  it("returns cached discovery on second call with same workspace and files", async () => {
    const workspacePath = "/tmp/test-cortex-cache";
    const { cortexHome, conversationsDir } = setupCortexHome("cache");
    writeConversationFile(conversationsDir, "sess-cortex-003.json", workspacePath);

    const provider = cortexCode({ cortexHomePath: cortexHome, watch: false });

    const first = await provider.discover([workspacePath]);
    const second = await provider.discover([workspacePath]);
    expect(second).toBe(first);
  });

  it("disconnect clears caches so next discover returns fresh result", async () => {
    const workspacePath = "/tmp/test-cortex-disconnect";
    const { cortexHome, conversationsDir } = setupCortexHome("disconnect");
    writeConversationFile(conversationsDir, "sess-cortex-004.json", workspacePath);

    const provider = cortexCode({ cortexHomePath: cortexHome, watch: false });

    const first = await provider.discover([workspacePath]);
    provider.disconnect?.();
    const afterDisconnect = await provider.discover([workspacePath]);
    expect(afterDisconnect).not.toBe(first);
    expect(afterDisconnect.inputs).toHaveLength(first.inputs.length);
  });

  it("has correct provider id", () => {
    const provider = cortexCode({ watch: false });
    expect(provider.id).toBe(PROVIDER_KINDS.cortexCode);
  });
});

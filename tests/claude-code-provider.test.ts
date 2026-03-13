import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_KINDS } from "@/core/providers";
import { claudeCode } from "@/providers/claude-code/provider";

describe("claude-code provider", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  function setupClaudeHome(
    label: string,
    workspacePath: string,
  ): {
    claudeHome: string;
    projectDir: string;
  } {
    const claudeHome = path.join(
      "/tmp",
      `claude-provider-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const encoded = workspacePath.replace(/\//g, "-");
    const projectDir = path.join(claudeHome, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });
    cleanupPaths.push(claudeHome);
    return { claudeHome, projectDir };
  }

  it("has correct provider id", () => {
    const provider = claudeCode();
    expect(provider.id).toBe(PROVIDER_KINDS.claudeCode);
  });

  it("discovers, reads, and normalizes session files", async () => {
    const workspacePath = "/tmp/test-project-provider";
    const { claudeHome, projectDir } = setupClaudeHome("full", workspacePath);

    const sessionPath = path.join(projectDir, "sess-001.jsonl");
    const baseFields = {
      parentUuid: null,
      isSidechain: false,
      userType: "external",
      cwd: workspacePath,
      sessionId: "sess-001",
      version: "2.1.72",
      gitBranch: "main",
    };

    writeFileSync(
      sessionPath,
      [
        JSON.stringify({
          ...baseFields,
          type: "user",
          uuid: "u1",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "build a feature" },
        }),
        JSON.stringify({
          ...baseFields,
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          timestamp: new Date().toISOString(),
          requestId: "req-1",
          message: {
            model: "claude-opus-4-6",
            role: "assistant",
            content: [{ type: "text", text: "On it." }],
            stop_reason: "end_turn",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const provider = claudeCode({ claudeHomePath: claudeHome });
    provider.connect?.();

    const discovery = provider.discover([workspacePath]);
    expect(discovery).toEqual(
      expect.objectContaining({
        inputs: expect.arrayContaining([
          expect.objectContaining({ uri: sessionPath, kind: "file" }),
        ]),
        watchPaths: expect.arrayContaining([projectDir]),
      }),
    );

    const readResult = await provider.read(
      (discovery as { inputs: import("@/core/providers").DiscoveryInput[] }).inputs,
      Date.now(),
    );
    expect(readResult.health.connected).toBe(true);

    const normalized = await provider.normalize(readResult, Date.now());
    expect(normalized.agents.length).toBeGreaterThan(0);
    expect(normalized.agents[0].taskSummary).toBe("build a feature");
    expect(normalized.agents[0].source).toBe("claude-code-sessions");
  });

  it("returns empty when no claude project directory exists", async () => {
    const claudeHome = path.join(
      "/tmp",
      `claude-provider-empty-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(claudeHome, { recursive: true });
    cleanupPaths.push(claudeHome);

    const provider = claudeCode({ claudeHomePath: claudeHome });
    provider.connect?.();

    const discovery = provider.discover(["/nonexistent/workspace"]);
    const readResult = await provider.read(
      (discovery as { inputs: import("@/core/providers").DiscoveryInput[] }).inputs,
      Date.now(),
    );
    const normalized = await provider.normalize(readResult, Date.now());

    expect(normalized.agents).toHaveLength(0);
  });
});

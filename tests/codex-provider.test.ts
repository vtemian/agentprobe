import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_KINDS } from "@/core/providers";
import { codex } from "@/providers/codex/provider";

describe("codex provider", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  function setupCodexHome(label: string): {
    codexHome: string;
    sessionsDir: string;
  } {
    const codexHome = path.join(
      "/tmp",
      `codex-provider-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const today = new Date();
    const yyyy = today.getFullYear().toString();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const sessionsDir = path.join(codexHome, "sessions", yyyy, mm, dd);
    mkdirSync(sessionsDir, { recursive: true });
    cleanupPaths.push(codexHome);
    return { codexHome, sessionsDir };
  }

  function writeSessionFile(sessionsDir: string, fileName: string, workspacePath: string): string {
    const sessionPath = path.join(sessionsDir, fileName);
    const ts = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: ts,
        payload: {
          id: fileName.replace(".jsonl", ""),
          cwd: workspacePath,
          source: "cli",
          cli_version: "0.5.0",
          git: { branch: "feat/codex-test" },
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: ts,
        payload: {
          type: "message",
          role: "user",
          content: "implement the codex adapter",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: ts,
        payload: {
          type: "function_call",
          name: "shell",
          arguments: '{"cmd":"ls"}',
          call_id: "call-1",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: ts,
        payload: {
          model: "o3",
          cwd: workspacePath,
        },
      }),
    ];
    writeFileSync(sessionPath, lines.join("\n"), "utf8");
    return sessionPath;
  }

  it("discovers, reads, and normalizes into a valid CanonicalSnapshot", async () => {
    const workspacePath = "/tmp/test-codex-workspace";
    const { codexHome, sessionsDir } = setupCodexHome("full");
    const sessionPath = writeSessionFile(sessionsDir, "sess-codex-001.jsonl", workspacePath);

    const provider = codex({ codexHomePath: codexHome, watch: false });
    provider.connect?.();

    const discovery = provider.discover([workspacePath]);
    expect(discovery).toEqual(
      expect.objectContaining({
        inputs: expect.arrayContaining([
          expect.objectContaining({ uri: sessionPath, kind: "file" }),
        ]),
        watchPaths: expect.arrayContaining([path.join(codexHome, "sessions")]),
      }),
    );

    const readResult = await provider.read(
      (discovery as { inputs: import("@/core/providers").DiscoveryInput[] }).inputs,
      Date.now(),
    );
    expect(readResult.health.connected).toBe(true);

    const normalized = await provider.normalize(readResult, Date.now());
    expect(normalized.agents.length).toBeGreaterThan(0);

    const agent = normalized.agents[0];
    expect(agent.taskSummary).toBe("implement the codex adapter");
    expect(agent.source).toBe("codex");
    expect(agent.kind).toBe("local");
    expect(agent.isSubagent).toBe(false);
    expect(agent.metadata).toEqual(
      expect.objectContaining({
        model: "o3",
        gitBranch: "feat/codex-test",
        cwd: workspacePath,
        cliVersion: "0.5.0",
        messageCount: 1,
        toolCallCount: 1,
      }),
    );
  });

  it("returns empty inputs for non-matching workspace", () => {
    const { codexHome, sessionsDir } = setupCodexHome("nomatch");
    writeSessionFile(sessionsDir, "sess-codex-002.jsonl", "/some/other/project");

    const provider = codex({ codexHomePath: codexHome, watch: false });
    const discovery = provider.discover(["/nonexistent/workspace"]);
    expect((discovery as { inputs: unknown[] }).inputs).toHaveLength(0);
  });

  it("returns cached discovery on second call with same workspace and files", () => {
    const workspacePath = "/tmp/test-codex-cache";
    const { codexHome, sessionsDir } = setupCodexHome("cache");
    writeSessionFile(sessionsDir, "sess-codex-003.jsonl", workspacePath);

    const provider = codex({ codexHomePath: codexHome, watch: false });

    const first = provider.discover([workspacePath]);
    const second = provider.discover([workspacePath]);
    expect(second).toBe(first);
  });

  it("disconnect clears caches so next discover returns fresh result", () => {
    const workspacePath = "/tmp/test-codex-disconnect";
    const { codexHome, sessionsDir } = setupCodexHome("disconnect");
    writeSessionFile(sessionsDir, "sess-codex-004.jsonl", workspacePath);

    const provider = codex({ codexHomePath: codexHome, watch: false });

    const first = provider.discover([workspacePath]);
    provider.disconnect?.();
    const afterDisconnect = provider.discover([workspacePath]);
    expect(afterDisconnect).not.toBe(first);
    expect((afterDisconnect as { inputs: unknown[] }).inputs).toHaveLength(
      (first as { inputs: unknown[] }).inputs.length,
    );
  });

  it("has correct provider id", () => {
    const provider = codex({ watch: false });
    expect(provider.id).toBe(PROVIDER_KINDS.codex);
  });
});

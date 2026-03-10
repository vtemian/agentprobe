import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createObserver } from "@/index";
import { afterEach, describe, expect, it } from "vitest";

describe("multi-provider createObserver", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it("discovers agents from both cursor and claude code by default", async () => {
    const workspacePath = path.join(
      "/tmp",
      `multi-provider-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );

    // Set up Cursor transcript
    const cursorWorkspaceId = path.resolve(workspacePath).replace(/^\/+/, "").split(/[\\/]/).join("-");
    const cursorDir = path.join(homedir(), ".cursor", "projects", cursorWorkspaceId, "agent-transcripts");
    mkdirSync(cursorDir, { recursive: true });
    cleanupPaths.push(cursorDir);
    writeFileSync(
      path.join(cursorDir, "cursor-session.jsonl"),
      `${JSON.stringify({
        agentId: "cursor-agent",
        agentName: "Cursor Agent",
        kind: "local",
        status: "running",
        task: "Cursor task",
        updatedAt: Date.now(),
      })}\n`,
      "utf8",
    );

    // Set up Claude Code session
    const claudeEncoded = workspacePath.replace(/\//g, "-");
    const claudeDir = path.join(homedir(), ".claude", "projects", claudeEncoded);
    mkdirSync(claudeDir, { recursive: true });
    cleanupPaths.push(claudeDir);
    writeFileSync(
      path.join(claudeDir, "claude-session.jsonl"),
      [
        JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          userType: "external",
          cwd: workspacePath,
          sessionId: "claude-session",
          version: "2.1.72",
          gitBranch: "main",
          type: "user",
          uuid: "u1",
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "Claude task" },
        }),
      ].join("\n"),
      "utf8",
    );

    const observer = createObserver({ workspacePaths: [workspacePath] });
    await observer.start();
    const snapshot = await observer.refreshNow();
    await observer.stop();

    const sources = snapshot.agents.map((a) => a.source);
    expect(sources).toContain("cursor-transcripts");
    expect(sources).toContain("claude-code-sessions");
  });
});

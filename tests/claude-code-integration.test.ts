import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createObserver } from "@/core";
import { claudeCode } from "@/providers/claude-code";
import type { ObserverChangeEvent } from "@/core/observer";

describe("claude-code integration", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  function setupSession(
    label: string,
    workspacePath: string,
    claudeHome: string,
    records: unknown[],
  ): string {
    const encoded = workspacePath.replace(/\//g, "-");
    const projectDir = path.join(claudeHome, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });
    const sessionPath = path.join(projectDir, `${label}.jsonl`);
    writeFileSync(sessionPath, records.map((r) => JSON.stringify(r)).join("\n"), "utf8");
    return sessionPath;
  }

  it("observer emits joined events for claude code agents", async () => {
    const claudeHome = path.join(
      "/tmp",
      `claude-int-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(claudeHome, { recursive: true });
    cleanupPaths.push(claudeHome);

    const workspacePath = "/tmp/integration-project";
    const baseFields = {
      parentUuid: null,
      isSidechain: false,
      userType: "external",
      cwd: workspacePath,
      sessionId: "int-sess",
      version: "2.1.72",
      gitBranch: "feature-branch",
    };

    setupSession("int-sess", workspacePath, claudeHome, [
      {
        ...baseFields,
        type: "user",
        uuid: "u1",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "implement the feature" },
      },
      {
        ...baseFields,
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: new Date().toISOString(),
        requestId: "req-1",
        message: {
          model: "claude-opus-4-6",
          role: "assistant",
          content: [{ type: "text", text: "Working on it." }],
          stop_reason: "end_turn",
        },
      },
    ]);

    const provider = claudeCode({ claudeHomePath: claudeHome });
    const observer = createObserver({
      provider,
      workspacePaths: [workspacePath],
    });

    const events: ObserverChangeEvent[] = [];
    observer.subscribe((event) => events.push(event));

    await observer.start();
    const snapshot = await observer.refreshNow();
    await observer.stop();

    expect(snapshot.health.connected).toBe(true);
    expect(snapshot.agents.length).toBeGreaterThan(0);
    expect(snapshot.agents[0].source).toBe("claude-code-sessions");
    expect(snapshot.agents[0].metadata).toEqual(
      expect.objectContaining({ model: "claude-opus-4-6", gitBranch: "feature-branch" }),
    );
    expect(events.some((e) => e.change.kind === "joined")).toBe(true);
  });
});

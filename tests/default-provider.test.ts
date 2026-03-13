import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createObserver } from "@/index";

describe("root createObserver default provider", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it("defaults to both providers and discovers agents when providers is omitted", async () => {
    const workspacePath = path.join(
      "/tmp",
      `observer-default-provider-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const transcriptDir = workspaceToTranscriptDir(workspacePath);
    cleanupPaths.push(transcriptDir);
    const transcriptPath = path.join(transcriptDir, "session.jsonl");
    mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        agentId: "default-provider-agent",
        agentName: "Agent One",
        kind: "local",
        status: "running",
        task: "Use root default provider",
        updatedAt: Date.now(),
      })}\n`,
      "utf8",
    );

    const observer = createObserver({
      workspacePaths: [workspacePath],
    });

    await observer.start();
    const snapshot = await observer.refreshNow();
    await observer.stop();

    expect(snapshot.health.connected).toBe(true);
    expect(snapshot.agents.length).toBeGreaterThan(0);
    expect(snapshot.agents[0].id).toBe("default-provider-agent");
  });
});

function workspaceToTranscriptDir(workspacePath: string): string {
  const workspaceId = path.resolve(workspacePath).replace(/^\/+/, "").split(/[\\/]/).join("-");
  return path.join(homedir(), ".cursor", "projects", workspaceId, "agent-transcripts");
}

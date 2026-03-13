import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ObserverChangeEvent } from "@/core/observer";
import { createObserver } from "@/index";
import { cursor } from "@/providers/cursor";
import { delay, waitForCount } from "./helpers";

describe("cursor watch integration", () => {
  const cleanupPaths: string[] = [];
  const observers: { stop(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const obs of observers) {
      await obs.stop().catch(() => {});
    }
    observers.length = 0;
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it("observer re-reads transcripts when files change on disk", async () => {
    const workspacePath = tmpWorkspace();
    const transcriptDir = workspaceToTranscriptDir(workspacePath);
    mkdirSync(transcriptDir, { recursive: true });
    cleanupPaths.push(transcriptDir);

    const transcriptPath = path.join(transcriptDir, "session-a.jsonl");
    writeTranscriptRecord(transcriptPath, {
      agentId: "agent-1",
      agentName: "Agent One",
      kind: "local",
      status: "running",
      task: "Initial task",
      updatedAt: Date.now(),
    });

    const provider = cursor({ watch: { debounceMs: 50 } });
    const observer = createObserver({
      providers: [provider],
      workspacePaths: [workspacePath],
      debounceMs: 50,
    });
    observers.push(observer);

    const events: ObserverChangeEvent[] = [];
    observer.subscribe((event) => events.push(event));

    await observer.start();
    await waitForCount(events, 1, 3000);
    expect(events.some((e) => e.agent.id === "agent-1")).toBe(true);

    writeTranscriptRecord(path.join(transcriptDir, "session-b.jsonl"), {
      agentId: "agent-2",
      agentName: "Agent Two",
      kind: "local",
      status: "running",
      task: "New task from file change",
      updatedAt: Date.now(),
    });

    await waitForCount(events, 2, 3000);
    expect(events.some((e) => e.agent.id === "agent-2")).toBe(true);
  });

  it("observer with watch disabled does not re-read on file changes", async () => {
    const workspacePath = tmpWorkspace();
    const transcriptDir = workspaceToTranscriptDir(workspacePath);
    mkdirSync(transcriptDir, { recursive: true });
    cleanupPaths.push(transcriptDir);

    writeTranscriptRecord(path.join(transcriptDir, "session.jsonl"), {
      agentId: "agent-1",
      agentName: "Agent One",
      kind: "local",
      status: "running",
      task: "Initial task",
      updatedAt: Date.now(),
    });

    const provider = cursor({ watch: false });
    const observer = createObserver({
      providers: [provider],
      workspacePaths: [workspacePath],
    });
    observers.push(observer);

    const events: ObserverChangeEvent[] = [];
    observer.subscribe((event) => events.push(event));

    await observer.start();
    await waitForCount(events, 1, 3000);

    writeTranscriptRecord(path.join(transcriptDir, "session-b.jsonl"), {
      agentId: "agent-2",
      agentName: "Agent Two",
      kind: "local",
      status: "running",
      task: "Should not appear automatically",
      updatedAt: Date.now(),
    });

    await delay(500);
    expect(events.every((e) => e.agent.id === "agent-1")).toBe(true);
  });
});

function tmpWorkspace(): string {
  return path.join("/tmp", `cursor-watch-int-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function workspaceToTranscriptDir(workspacePath: string): string {
  const workspaceId = path.resolve(workspacePath).replace(/^\/+/, "").split(/[\\/]/).join("-");
  return path.join(homedir(), ".cursor", "projects", workspaceId, "agent-transcripts");
}

function writeTranscriptRecord(filePath: string, record: Record<string, unknown>): void {
  writeFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
}

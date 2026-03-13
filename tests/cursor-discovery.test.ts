import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveTranscriptDirectories,
  resolveTranscriptSourcePaths,
} from "@/providers/cursor/discovery";

function workspaceToTranscriptDir(workspacePath: string): string {
  const workspaceId = path.resolve(workspacePath).replace(/^\/+/, "").split(/[\\/]/).join("-");
  return path.join(homedir(), ".cursor", "projects", workspaceId, "agent-transcripts");
}

function uniqueWorkspacePath(): string {
  return path.join(
    "/tmp",
    `observer-discovery-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

function cleanupTranscriptDir(workspacePath: string): void {
  const workspaceId = path.resolve(workspacePath).replace(/^\/+/, "").split(/[\\/]/).join("-");
  rmSync(path.join(homedir(), ".cursor", "projects", workspaceId), {
    recursive: true,
    force: true,
  });
}

describe("cursor discovery", () => {
  const workspacePaths: string[] = [];

  afterEach(() => {
    for (const wp of workspacePaths) {
      cleanupTranscriptDir(wp);
    }
    workspacePaths.length = 0;
  });

  function trackWorkspace(): string {
    const wp = uniqueWorkspacePath();
    workspacePaths.push(wp);
    return wp;
  }

  it("resolves directories and returns newest jsonl files first", () => {
    const workspacePath = trackWorkspace();
    const transcriptDir = workspaceToTranscriptDir(workspacePath);
    const nestedDir = path.join(transcriptDir, "nested");
    mkdirSync(nestedDir, { recursive: true });

    const oldFile = path.join(transcriptDir, "old.jsonl");
    const newFile = path.join(nestedDir, "new.jsonl");
    const ignoredFile = path.join(transcriptDir, "ignore.txt");

    writeFileSync(oldFile, "{}\n", "utf8");
    writeFileSync(newFile, "{}\n", "utf8");
    writeFileSync(ignoredFile, "ignore\n", "utf8");

    const now = Date.now() / 1000;
    utimesSync(oldFile, now - 20, now - 20);
    utimesSync(newFile, now - 5, now - 5);

    const directories = resolveTranscriptDirectories({ workspacePaths: [workspacePath] });
    const files = resolveTranscriptSourcePaths({ workspacePaths: [workspacePath] });

    expect(directories).toContain(transcriptDir);
    expect(files[0]).toBe(newFile);
    expect(files[1]).toBe(oldFile);
    expect(files.some((entry) => entry.endsWith(".txt"))).toBe(false);
  });

  it("returns empty arrays for empty workspace paths", () => {
    const directories = resolveTranscriptDirectories({ workspacePaths: [] });
    const files = resolveTranscriptSourcePaths({ workspacePaths: [] });

    expect(directories).toEqual([]);
    expect(files).toEqual([]);
  });

  it("filters out blank and whitespace-only workspace paths", () => {
    const directories = resolveTranscriptDirectories({ workspacePaths: ["", "  ", "\t"] });
    expect(directories).toEqual([]);
  });

  it("deduplicates identical workspace paths", () => {
    const workspacePath = trackWorkspace();
    const transcriptDir = workspaceToTranscriptDir(workspacePath);
    mkdirSync(transcriptDir, { recursive: true });

    const directories = resolveTranscriptDirectories({
      workspacePaths: [workspacePath, workspacePath, workspacePath],
    });

    expect(directories).toEqual([transcriptDir]);
  });

  it("deduplicates paths that resolve to the same directory", () => {
    const workspacePath = trackWorkspace();
    const transcriptDir = workspaceToTranscriptDir(workspacePath);
    mkdirSync(transcriptDir, { recursive: true });

    const withTrailingSlash = `${workspacePath}/`;
    const directories = resolveTranscriptDirectories({
      workspacePaths: [workspacePath, withTrailingSlash],
    });

    expect(directories).toEqual([transcriptDir]);
  });

  it("handles non-existent workspace paths gracefully", () => {
    const files = resolveTranscriptSourcePaths({
      workspacePaths: ["/non/existent/path/that/definitely/does/not/exist"],
    });

    expect(files).toEqual([]);
  });

  it("discovers files in deeply nested directories", () => {
    const workspacePath = trackWorkspace();
    const transcriptDir = workspaceToTranscriptDir(workspacePath);
    const deepDir = path.join(transcriptDir, "a", "b", "c");
    mkdirSync(deepDir, { recursive: true });

    const deepFile = path.join(deepDir, "deep.jsonl");
    writeFileSync(deepFile, "{}\n", "utf8");

    const files = resolveTranscriptSourcePaths({ workspacePaths: [workspacePath] });
    expect(files).toContain(deepFile);
  });

  it("returns files from multiple workspace paths", () => {
    const wp1 = trackWorkspace();
    const wp2 = trackWorkspace();
    const dir1 = workspaceToTranscriptDir(wp1);
    const dir2 = workspaceToTranscriptDir(wp2);
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    const file1 = path.join(dir1, "a.jsonl");
    const file2 = path.join(dir2, "b.jsonl");
    writeFileSync(file1, "{}\n", "utf8");
    writeFileSync(file2, "{}\n", "utf8");

    const files = resolveTranscriptSourcePaths({ workspacePaths: [wp1, wp2] });
    expect(files).toContain(file1);
    expect(files).toContain(file2);
    expect(files).toHaveLength(2);
  });
});

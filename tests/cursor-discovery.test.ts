import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  resolveTranscriptDirectories,
  resolveTranscriptSourcePaths,
} from "../src/providers/cursor/discovery";
import { describe, expect, it } from "vitest";

function workspaceToTranscriptDir(workspacePath: string): string {
  const workspaceId = path.resolve(workspacePath).replace(/^\/+/, "").split(/[\\/]/).join("-");
  return path.join(homedir(), ".cursor", "projects", workspaceId, "agent-transcripts");
}

describe("cursor discovery", () => {
  it("resolves directories and returns newest jsonl files first", () => {
    const workspacePath = path.join(
      "/tmp",
      `observer-discovery-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
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

    rmSync(
      path.join(
        homedir(),
        ".cursor",
        "projects",
        path.resolve(workspacePath).replace(/^\/+/, "").split(/[\\/]/).join("-"),
      ),
      {
        recursive: true,
        force: true,
      },
    );
  });
});

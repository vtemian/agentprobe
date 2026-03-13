import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listSessionFileNames,
  resolveSessionSourcePaths,
  resolveSessionsDirectory,
} from "@/providers/codex/discovery";

describe("codex discovery", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  function createTempCodexHome(label: string): string {
    const dir = path.join(
      "/tmp",
      `codex-home-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    cleanupPaths.push(dir);
    return dir;
  }

  function sessionMetaLine(id: string, cwd: string): string {
    return JSON.stringify({
      type: "session_meta",
      timestamp: "2026-03-13T10:00:00Z",
      payload: { id, cwd, source: "cli", cli_version: "0.114.0" },
    });
  }

  function writeSessionFile(sessionsDir: string, name: string, firstLine: string): string {
    const dateDir = path.join(sessionsDir, "2026", "03", "13");
    mkdirSync(dateDir, { recursive: true });
    const filePath = path.join(dateDir, name);
    writeFileSync(filePath, `${firstLine}\n`, "utf8");
    return filePath;
  }

  it("discovers files matching workspace cwd, skips non-matching", () => {
    const codexHome = createTempCodexHome("match");
    const sessionsDir = path.join(codexHome, "sessions");

    const matchFile = writeSessionFile(
      sessionsDir,
      "match.jsonl",
      sessionMetaLine("s1", "/workspace/project-a"),
    );
    writeSessionFile(sessionsDir, "other.jsonl", sessionMetaLine("s2", "/workspace/project-b"));

    const paths = resolveSessionSourcePaths({
      workspacePaths: ["/workspace/project-a"],
      codexHomePath: codexHome,
    });

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(matchFile);
  });

  it("skips old-format files (no type field in line 1)", () => {
    const codexHome = createTempCodexHome("oldformat");
    const sessionsDir = path.join(codexHome, "sessions");

    const oldFormatLine = JSON.stringify({
      id: "old-session",
      timestamp: "2025-01-01T00:00:00Z",
      instructions: null,
    });
    writeSessionFile(sessionsDir, "old.jsonl", oldFormatLine);
    const validFile = writeSessionFile(
      sessionsDir,
      "valid.jsonl",
      sessionMetaLine("s1", "/workspace/project-a"),
    );

    const paths = resolveSessionSourcePaths({
      workspacePaths: ["/workspace/project-a"],
      codexHomePath: codexHome,
    });

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(validFile);
  });

  it("returns empty for non-existent sessions dir", () => {
    const codexHome = createTempCodexHome("nodir");

    const paths = resolveSessionSourcePaths({
      workspacePaths: ["/workspace/project-a"],
      codexHomePath: codexHome,
    });

    expect(paths).toEqual([]);
  });

  it("respects maxFiles cap", () => {
    const codexHome = createTempCodexHome("cap");
    const sessionsDir = path.join(codexHome, "sessions");

    const now = Date.now() / 1000;
    for (let i = 0; i < 5; i++) {
      const filePath = writeSessionFile(
        sessionsDir,
        `session-${i}.jsonl`,
        sessionMetaLine(`s${i}`, "/workspace/capped"),
      );
      utimesSync(filePath, now - i, now - i);
    }

    const paths = resolveSessionSourcePaths({
      workspacePaths: ["/workspace/capped"],
      codexHomePath: codexHome,
      maxFiles: 3,
    });

    expect(paths).toHaveLength(3);
  });

  it("returns empty for empty workspace paths", () => {
    const codexHome = createTempCodexHome("empty-ws");
    const sessionsDir = path.join(codexHome, "sessions");
    writeSessionFile(sessionsDir, "session.jsonl", sessionMetaLine("s1", "/workspace/project-a"));

    const paths = resolveSessionSourcePaths({
      workspacePaths: [],
      codexHomePath: codexHome,
    });

    expect(paths).toEqual([]);
  });

  it("resolveSessionsDirectory returns correct path", () => {
    const codexHome = createTempCodexHome("dir");

    const result = resolveSessionsDirectory({
      workspacePaths: [],
      codexHomePath: codexHome,
    });

    expect(result).toBe(path.join(codexHome, "sessions"));
  });

  it("listSessionFileNames returns sorted file paths", () => {
    const codexHome = createTempCodexHome("list");
    const sessionsDir = path.join(codexHome, "sessions");

    const fileB = writeSessionFile(
      sessionsDir,
      "beta.jsonl",
      sessionMetaLine("s2", "/workspace/project-b"),
    );
    const fileA = writeSessionFile(
      sessionsDir,
      "alpha.jsonl",
      sessionMetaLine("s1", "/workspace/project-a"),
    );

    const names = listSessionFileNames({
      workspacePaths: [],
      codexHomePath: codexHome,
    });

    expect(names).toHaveLength(2);
    expect(names[0]).toBe(fileA);
    expect(names[1]).toBe(fileB);
  });
});

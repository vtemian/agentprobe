import { mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveSessionDirectories,
  resolveSessionSourcePaths,
  listSessionFileNames,
  encodeWorkspacePath,
} from "@/providers/claude-code/discovery";

describe("claude-code discovery", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  function createTempClaudeHome(label: string): string {
    const dir = path.join(
      "/tmp",
      `claude-home-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    cleanupPaths.push(dir);
    return dir;
  }

  it("encodes workspace paths by replacing / with -", () => {
    expect(encodeWorkspacePath("/Users/whitemonk/projects/ai/agentprobe")).toBe(
      "-Users-whitemonk-projects-ai-agentprobe",
    );
  });

  it("encodes root path", () => {
    expect(encodeWorkspacePath("/")).toBe("-");
  });

  it("resolves session directories for workspace paths", () => {
    const claudeHome = createTempClaudeHome("resolve");
    const workspacePath = "/Users/test/my-project";
    const encoded = encodeWorkspacePath(workspacePath);
    const projectDir = path.join(claudeHome, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });

    const dirs = resolveSessionDirectories({
      workspacePaths: [workspacePath],
      claudeHomePath: claudeHome,
    });

    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toBe(projectDir);
  });

  it("skips workspace paths with no matching claude project directory", () => {
    const claudeHome = createTempClaudeHome("missing");
    const dirs = resolveSessionDirectories({
      workspacePaths: ["/nonexistent/path"],
      claudeHomePath: claudeHome,
    });

    expect(dirs).toHaveLength(0);
  });

  it("discovers .jsonl files sorted by mtime descending", () => {
    const claudeHome = createTempClaudeHome("discover");
    const workspacePath = "/Users/test/project";
    const encoded = encodeWorkspacePath(workspacePath);
    const projectDir = path.join(claudeHome, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });

    // Create files with known order
    const oldFile = path.join(projectDir, "old-session.jsonl");
    const newFile = path.join(projectDir, "new-session.jsonl");
    writeFileSync(oldFile, "{}\n", "utf8");
    // Small delay to ensure different mtime
    const now = Date.now();
    utimesSync(oldFile, now / 1000 - 10, now / 1000 - 10);
    writeFileSync(newFile, "{}\n", "utf8");

    const paths = resolveSessionSourcePaths({
      workspacePaths: [workspacePath],
      claudeHomePath: claudeHome,
    });

    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe(newFile); // newest first
    expect(paths[1]).toBe(oldFile);
  });

  it("ignores non-jsonl files", () => {
    const claudeHome = createTempClaudeHome("filter");
    const workspacePath = "/Users/test/filtered";
    const encoded = encodeWorkspacePath(workspacePath);
    const projectDir = path.join(claudeHome, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(path.join(projectDir, "session.jsonl"), "{}\n", "utf8");
    writeFileSync(path.join(projectDir, "notes.txt"), "text", "utf8");
    mkdirSync(path.join(projectDir, "some-subdir"), { recursive: true });

    const paths = resolveSessionSourcePaths({
      workspacePaths: [workspacePath],
      claudeHomePath: claudeHome,
    });

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("session.jsonl");
  });

  it("respects max file cap", () => {
    const claudeHome = createTempClaudeHome("cap");
    const workspacePath = "/Users/test/capped";
    const encoded = encodeWorkspacePath(workspacePath);
    const projectDir = path.join(claudeHome, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(projectDir, `session-${i}.jsonl`), "{}\n", "utf8");
    }

    const paths = resolveSessionSourcePaths({
      workspacePaths: [workspacePath],
      claudeHomePath: claudeHome,
      maxFiles: 3,
    });

    expect(paths).toHaveLength(3);
  });

  it("lists all session file names for cache invalidation", () => {
    const claudeHome = createTempClaudeHome("list");
    const workspacePath = "/Users/test/listed";
    const encoded = encodeWorkspacePath(workspacePath);
    const projectDir = path.join(claudeHome, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(path.join(projectDir, "a.jsonl"), "{}\n", "utf8");
    writeFileSync(path.join(projectDir, "b.jsonl"), "{}\n", "utf8");

    const names = listSessionFileNames({
      workspacePaths: [workspacePath],
      claudeHomePath: claudeHome,
    });

    expect(names).toHaveLength(2);
    expect(names).toEqual(
      expect.arrayContaining([
        expect.stringContaining("a.jsonl"),
        expect.stringContaining("b.jsonl"),
      ]),
    );
  });

  it("deduplicates workspace paths", () => {
    const claudeHome = createTempClaudeHome("dedup");
    const workspacePath = "/Users/test/deduped";
    const encoded = encodeWorkspacePath(workspacePath);
    const projectDir = path.join(claudeHome, "projects", encoded);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(path.join(projectDir, "session.jsonl"), "{}\n", "utf8");

    const paths = resolveSessionSourcePaths({
      workspacePaths: [workspacePath, workspacePath],
      claudeHomePath: claudeHome,
    });

    expect(paths).toHaveLength(1);
  });
});

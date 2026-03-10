import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeWorkspacePath,
  stripTrailingSeparators,
  escapeForRegExp,
  tryStatSync,
  dedupePaths,
  formatLineWarning,
  collectJsonlFiles,
} from "@/providers/shared/discovery-utils";

describe("shared discovery utils", () => {
  it("normalizeWorkspacePath resolves and strips trailing separators", () => {
    expect(normalizeWorkspacePath("  /tmp/foo/  ")).toBe("/tmp/foo");
    expect(normalizeWorkspacePath("")).toBe("");
    expect(normalizeWorkspacePath("  ")).toBe("");
  });

  it("stripTrailingSeparators preserves root", () => {
    expect(stripTrailingSeparators("/")).toBe("/");
    expect(stripTrailingSeparators("/foo/bar/")).toBe("/foo/bar");
  });

  it("escapeForRegExp escapes special chars", () => {
    expect(escapeForRegExp("foo.bar")).toBe("foo\\.bar");
    expect(escapeForRegExp("a+b")).toBe("a\\+b");
  });

  it("tryStatSync returns undefined for non-existent paths", () => {
    expect(tryStatSync("/nonexistent/path/xyz")).toBeUndefined();
  });

  it("dedupePaths removes duplicates preserving order", () => {
    expect(dedupePaths(["/a", "/b", "/a", "/c"])).toEqual(["/a", "/b", "/c"]);
  });

  it("formatLineWarning formats path:line reason", () => {
    expect(formatLineWarning("/foo.jsonl", 5, "Bad line.")).toBe("/foo.jsonl:5 Bad line.");
  });
});

describe("collectJsonlFiles", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  function createTempDir(label: string): string {
    const dir = path.join(
      "/tmp",
      `shared-discovery-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    cleanupPaths.push(dir);
    return dir;
  }

  it("collects .jsonl files from a flat directory", () => {
    const dir = createTempDir("flat");
    writeFileSync(path.join(dir, "a.jsonl"), "{}");
    writeFileSync(path.join(dir, "b.txt"), "nope");
    writeFileSync(path.join(dir, "c.jsonl"), "{}");

    const result = collectJsonlFiles([dir], { recursive: false });
    expect(result).toHaveLength(2);
    expect(result.map((f) => path.basename(f.path)).sort()).toEqual(["a.jsonl", "c.jsonl"]);
  });

  it("collects .jsonl files recursively", () => {
    const dir = createTempDir("recursive");
    mkdirSync(path.join(dir, "sub"), { recursive: true });
    writeFileSync(path.join(dir, "a.jsonl"), "{}");
    writeFileSync(path.join(dir, "sub", "b.jsonl"), "{}");

    const result = collectJsonlFiles([dir], { recursive: true });
    expect(result).toHaveLength(2);
  });

  it("skips non-existent directories", () => {
    const result = collectJsonlFiles(["/nonexistent/path"], { recursive: false });
    expect(result).toHaveLength(0);
  });
});

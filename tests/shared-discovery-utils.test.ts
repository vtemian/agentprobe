import { describe, expect, it } from "vitest";
import {
  normalizeWorkspacePath,
  stripTrailingSeparators,
  escapeForRegExp,
  tryStatSync,
  dedupePaths,
  formatLineWarning,
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

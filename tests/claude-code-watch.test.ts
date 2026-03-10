import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeWatch } from "@/providers/claude-code/watch";

describe("claude-code watch", () => {
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
      `claude-watch-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    cleanupPaths.push(dir);
    return dir;
  }

  it("has configurable debounce", () => {
    const watch = createClaudeCodeWatch({ debounceMs: 200 });
    expect(watch.debounceMs).toBe(200);
  });

  it("uses default debounce when not specified", () => {
    const watch = createClaudeCodeWatch();
    expect(watch.debounceMs).toBe(150);
  });

  it("subscribes to directory and can close", () => {
    const dir = createTempDir("subscribe");
    const watch = createClaudeCodeWatch();
    const sub = watch.subscribe(dir, () => {}, () => {});
    expect(sub).toHaveProperty("close");
    sub.close();
  });
});

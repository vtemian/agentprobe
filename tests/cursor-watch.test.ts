import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURSOR_WATCH_DEBOUNCE_MS, createCursorWatch } from "@/providers/cursor/watch";

function tmpDir(): string {
  return path.join(
    "/tmp",
    `cursor-watch-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await delay(50);
  }
}

/**
 * Probes watcher readiness by repeatedly writing a sentinel file until the
 * watcher fires, avoiding fragile fixed-duration delays. Returns the
 * subscription once the watcher is confirmed active.
 */
async function probeWatcherReady(
  dir: string,
  onEvent: () => void,
  onError: (error: Error) => void,
  watch: ReturnType<typeof createCursorWatch>,
): Promise<{ close(): void }> {
  let ready = false;
  const sub = watch.subscribe(
    dir,
    () => {
      ready = true;
      onEvent();
    },
    onError,
  );
  const start = Date.now();
  let tick = 0;
  while (!ready) {
    if (Date.now() - start > 3000) {
      sub.close();
      throw new Error("probeWatcherReady timed out after 3000ms");
    }
    writeFileSync(path.join(dir, `.probe-${tick++}`), "", "utf8");
    await delay(30);
  }
  return sub;
}

describe("createCursorWatch", () => {
  const cleanupPaths: string[] = [];
  const subscriptions: { close(): void }[] = [];

  afterEach(() => {
    for (const sub of subscriptions) {
      try {
        sub.close();
      } catch {
        // already closed
      }
    }
    subscriptions.length = 0;
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it("uses default debounce when no options given", () => {
    const watch = createCursorWatch();
    expect(watch.debounceMs).toBe(CURSOR_WATCH_DEBOUNCE_MS);
  });

  it("accepts a custom debounce", () => {
    const watch = createCursorWatch({ debounceMs: 500 });
    expect(watch.debounceMs).toBe(500);
  });

  it("fires onEvent when a file is written to the watched directory", async () => {
    const dir = tmpDir();
    mkdirSync(dir, { recursive: true });
    cleanupPaths.push(dir);

    const watch = createCursorWatch();
    let eventCount = 0;
    const sub = await probeWatcherReady(
      dir,
      () => {
        eventCount += 1;
      },
      () => {},
      watch,
    );
    subscriptions.push(sub);

    eventCount = 0;
    writeFileSync(path.join(dir, "test.jsonl"), '{"role":"user"}\n', "utf8");

    await waitUntil(() => eventCount > 0, 3000);
    expect(eventCount).toBeGreaterThanOrEqual(1);
  });

  it("fires onEvent when a file in a subdirectory changes", async () => {
    const dir = tmpDir();
    mkdirSync(dir, { recursive: true });
    cleanupPaths.push(dir);

    const watch = createCursorWatch();
    let eventCount = 0;
    const sub = await probeWatcherReady(
      dir,
      () => {
        eventCount += 1;
      },
      () => {},
      watch,
    );
    subscriptions.push(sub);

    eventCount = 0;
    const subDir = path.join(dir, "agent-abc");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(path.join(subDir, "session.jsonl"), '{"role":"user"}\n', "utf8");

    await waitUntil(() => eventCount > 0, 3000);
    expect(eventCount).toBeGreaterThanOrEqual(1);
  });

  it("close stops further events", async () => {
    const dir = tmpDir();
    mkdirSync(dir, { recursive: true });
    cleanupPaths.push(dir);

    const watch = createCursorWatch();
    let eventCount = 0;
    const sub = await probeWatcherReady(
      dir,
      () => {
        eventCount += 1;
      },
      () => {},
      watch,
    );

    eventCount = 0;
    sub.close();

    writeFileSync(path.join(dir, "test.jsonl"), '{"role":"user"}\n', "utf8");
    await delay(300);
    expect(eventCount).toBe(0);
  });

  it("throws when watching a non-existent path", () => {
    const watch = createCursorWatch();
    expect(() =>
      watch.subscribe(
        `/tmp/cursor-watch-nonexistent-path-${Date.now()}`,
        () => {},
        () => {},
      ),
    ).toThrow();
  });
});

# Post-Review Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Address all findings from the 4-agent code review — fix bugs, eliminate duplication, close test gaps, and consolidate tooling.

**Architecture:** Six sequential groups: (1) critical bug fixes and build gaps, (2) extract shared test helpers, (3) extract shared watch factory, (4) add missing tests, (5) event bus error observability and subscription cleanup, (6) consolidate CI workflows.

**Tech Stack:** TypeScript, Vitest, tsup, GitHub Actions.

---

## Task 1: Add Codex provider to build entry points and package exports

**Files:**
- Modify: `tsup.config.ts:4-9`
- Modify: `package.json:20-57`

**Step 1: Add Codex entry to tsup.config.ts**

```typescript
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "core/index": "src/core/index.ts",
    "providers/cursor/index": "src/providers/cursor/index.ts",
    "providers/claude-code/index": "src/providers/claude-code/index.ts",
    "providers/codex/index": "src/providers/codex/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  target: "node20",
});
```

**Step 2: Add Codex export to package.json**

Add after the `./providers/claude-code` export entry:

```json
"./providers/codex": {
  "types": "./dist/providers/codex/index.d.ts",
  "import": "./dist/providers/codex/index.js",
  "require": "./dist/providers/codex/index.cjs",
  "default": "./dist/providers/codex/index.js"
}
```

Add to `typesVersions`:

```json
"providers/codex": [
  "dist/providers/codex/index.d.ts"
]
```

**Step 3: Verify build succeeds**

Run: `npm run build`
Expected: dist/providers/codex/ directory created with index.js, index.cjs, index.d.ts

**Step 4: Run full quality gate**

Run: `npm run check`
Expected: All 178 tests pass, no lint errors

**Step 5: Commit**

```bash
git add tsup.config.ts package.json
git commit -m "build: add Codex provider to entry points and package exports"
```

---

## Task 2: Fix NaN timestamp parsing in Claude-Code and Codex transcripts

**Files:**
- Modify: `src/providers/claude-code/transcripts.ts:326`
- Modify: `src/providers/codex/transcripts.ts:271`
- Modify: `src/providers/shared/providers.ts` (add shared helper)
- Test: `tests/claude-code-transcripts.test.ts`
- Test: `tests/codex-transcripts.test.ts`

**Step 1: Write failing tests for invalid timestamps**

In `tests/claude-code-transcripts.test.ts`, add a test with an invalid timestamp in a session record:

```typescript
it("skips records with invalid timestamps without corrupting state", () => {
  // Write a JSONL file where one record has timestamp: "not-a-date"
  // Verify the agent snapshot still has valid updatedAt and startedAt
  // Verify no NaN propagates to status derivation
});
```

In `tests/codex-transcripts.test.ts`, add the same:

```typescript
it("skips records with invalid timestamps without corrupting state", () => {
  // Write a JSONL file where one record has timestamp: "INVALID"
  // Verify agent status is derived correctly from remaining valid records
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- --reporter=verbose tests/claude-code-transcripts.test.ts tests/codex-transcripts.test.ts`
Expected: New tests FAIL (NaN corrupts state)

**Step 3: Add shared timestamp parser to shared/providers.ts**

```typescript
export function parseTimestampMs(value: string): number | undefined {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}
```

**Step 4: Use the shared parser in Claude-Code transcripts**

Replace `src/providers/claude-code/transcripts.ts:326`:

```typescript
// Before:
const timestamp = new Date(record.timestamp).getTime();

// After:
const timestamp = parseTimestampMs(record.timestamp);
if (timestamp === undefined) {
  return;
}
```

**Step 5: Use the shared parser in Codex transcripts**

Replace `src/providers/codex/transcripts.ts:271`:

```typescript
// Before:
const timestamp = new Date(record.timestamp).getTime();

// After:
const timestamp = parseTimestampMs(record.timestamp);
if (timestamp === undefined) {
  return;
}
```

**Step 6: Run tests to verify they pass**

Run: `npm run check`
Expected: All tests pass including new timestamp tests

**Step 7: Commit**

```bash
git add src/providers/shared/providers.ts src/providers/claude-code/transcripts.ts src/providers/codex/transcripts.ts tests/claude-code-transcripts.test.ts tests/codex-transcripts.test.ts
git commit -m "fix: guard against NaN timestamps in Claude-Code and Codex transcript parsing"
```

---

## Task 3: Extract shared test helpers

**Files:**
- Create: `tests/helpers.ts`
- Modify: `tests/runtime-event-bus.test.ts:6-18`
- Modify: `tests/cursor-watch.test.ts:13-25`
- Modify: `tests/cursor-watch-integration.test.ts:119-135`

**Step 1: Create shared test helpers file**

```typescript
// tests/helpers.ts

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number = 3000,
  pollIntervalMs: number = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
    }
    await delay(pollIntervalMs);
  }
}

export async function waitForCount<T>(
  items: T[],
  count: number,
  timeoutMs: number = 3000,
  pollIntervalMs: number = 50,
): Promise<void> {
  await waitUntil(() => items.length >= count, timeoutMs, pollIntervalMs);
}
```

**Step 2: Replace duplicated helpers in each test file**

In `tests/runtime-event-bus.test.ts`, remove the local `delay` and `waitUntil` functions (lines 6-18) and add:
```typescript
import { delay, waitUntil } from "./helpers";
```

In `tests/cursor-watch.test.ts`, remove the local `delay` and `waitUntil` functions (lines 13-25) and add:
```typescript
import { delay, waitUntil } from "./helpers";
```

In `tests/cursor-watch-integration.test.ts`, remove the local `delay` and `waitForCount` functions and add:
```typescript
import { delay, waitForCount } from "./helpers";
```

**Step 3: Run tests to verify nothing broke**

Run: `npm run check`
Expected: All 178 tests pass

**Step 4: Commit**

```bash
git add tests/helpers.ts tests/runtime-event-bus.test.ts tests/cursor-watch.test.ts tests/cursor-watch-integration.test.ts
git commit -m "refactor: extract shared test helpers (delay, waitUntil, waitForCount)"
```

---

## Task 4: Extract shared watch factory

**Files:**
- Create: `src/providers/shared/watch.ts`
- Modify: `src/providers/cursor/watch.ts`
- Modify: `src/providers/claude-code/watch.ts`
- Modify: `src/providers/codex/watch.ts`

The three watch implementations are 95% identical. Only Codex adds a `.jsonl` filename filter.

**Step 1: Write the shared watch factory**

```typescript
// src/providers/shared/watch.ts

import { type FSWatcher, watch as fsWatch } from "node:fs";
import { toError } from "@/core/errors";

export interface ProviderWatchOptions {
  debounceMs?: number;
  defaultDebounceMs: number;
  shouldEmitForFilename?: (filename: string) => boolean;
}

export interface ProviderWatch {
  readonly debounceMs: number;
  subscribe(
    watchPath: string,
    onEvent: () => void,
    onError: (error: Error) => void,
  ): { close(): void };
}

export function createProviderWatch(options: ProviderWatchOptions): ProviderWatch {
  const debounceMs = options.debounceMs ?? options.defaultDebounceMs;
  const shouldEmit = options.shouldEmitForFilename;

  function subscribe(
    watchPath: string,
    onEvent: () => void,
    onError: (error: Error) => void,
  ): { close(): void } {
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(watchPath, { recursive: true }, (_event, filename) => {
        if (shouldEmit && typeof filename === "string" && !shouldEmit(filename)) {
          return;
        }
        onEvent();
      });
    } catch (error) {
      throw toError(error);
    }

    watcher.on("error", (error) => {
      onError(toError(error));
    });

    return {
      close() {
        watcher.close();
      },
    };
  }

  return { debounceMs, subscribe };
}
```

**Step 2: Rewrite Cursor watch to use shared factory**

```typescript
// src/providers/cursor/watch.ts

import { type ProviderWatch, createProviderWatch } from "@/providers/shared/watch";
import { CURSOR_WATCH_DEBOUNCE_MS } from "./constants";

export { CURSOR_WATCH_DEBOUNCE_MS };
export type CursorWatch = ProviderWatch;
export interface CursorWatchOptions { debounceMs?: number; }

export function createCursorWatch(options: CursorWatchOptions = {}): CursorWatch {
  return createProviderWatch({
    debounceMs: options.debounceMs,
    defaultDebounceMs: CURSOR_WATCH_DEBOUNCE_MS,
  });
}
```

**Step 3: Rewrite Claude-Code watch to use shared factory**

Same pattern as Cursor, with `CLAUDE_CODE_WATCH_DEBOUNCE_MS`.

**Step 4: Rewrite Codex watch to use shared factory with filename filter**

```typescript
// src/providers/codex/watch.ts

import { type ProviderWatch, createProviderWatch } from "@/providers/shared/watch";
import { CODEX_WATCH_DEBOUNCE_MS } from "./constants";

export { CODEX_WATCH_DEBOUNCE_MS };
export type CodexWatch = ProviderWatch;
export interface CodexWatchOptions { debounceMs?: number; }

export function createCodexWatch(options: CodexWatchOptions = {}): CodexWatch {
  return createProviderWatch({
    debounceMs: options.debounceMs,
    defaultDebounceMs: CODEX_WATCH_DEBOUNCE_MS,
    shouldEmitForFilename: (filename) => filename.endsWith(".jsonl"),
  });
}
```

**Step 5: Run tests**

Run: `npm run check`
Expected: All tests pass. Watch behavior is unchanged.

**Step 6: Commit**

```bash
git add src/providers/shared/watch.ts src/providers/cursor/watch.ts src/providers/claude-code/watch.ts src/providers/codex/watch.ts
git commit -m "refactor: extract shared watch factory, eliminate watch duplication"
```

---

## Task 5: Add event bus error observability

**Files:**
- Modify: `src/core/runtime/event-bus.ts:10-13,43-48`
- Test: `tests/runtime-event-bus.test.ts`

The event bus silently swallows handler errors. The `emitRuntimeError` infrastructure already exists — the bus just needs an `onHandlerError` callback.

**Step 1: Write failing test**

In `tests/runtime-event-bus.test.ts`:

```typescript
it("reports handler errors via onHandlerError callback", async () => {
  const reportedErrors: Error[] = [];
  const bus = createEventBus({
    handlers: {
      test: async () => {
        throw new Error("handler boom");
      },
    },
    getToken: () => 1,
    onHandlerError: (error) => {
      reportedErrors.push(error);
    },
  });

  bus.dispatch({ type: "test" }, 1);
  await waitUntil(() => reportedErrors.length > 0);

  expect(reportedErrors).toHaveLength(1);
  expect(reportedErrors[0]?.message).toBe("handler boom");
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/runtime-event-bus.test.ts`
Expected: FAIL — `onHandlerError` does not exist in the interface

**Step 3: Add onHandlerError to EventBusOptions**

In `src/core/runtime/event-bus.ts`:

```typescript
export interface EventBusOptions<TEvent extends { type: string }> {
  handlers: Record<string, (event: TEvent) => Promise<void> | void>;
  getToken: () => number;
  onHandlerError?: (error: Error) => void;
}
```

**Step 4: Call onHandlerError in the catch block**

Replace lines 43-48:

```typescript
try {
  await handler(event);
} catch (error) {
  // Handler errors must not crash the bus — a failing handler would block all
  // subsequent events in the queue, causing the runtime to silently stop responding.
  options.onHandlerError?.(toError(error));
}
```

**Step 5: Wire it up in the runtime**

In `src/core/runtime/index.ts`, where `createEventBus` is called, add:

```typescript
const bus = createEventBus({
  handlers: busHandlers,
  getToken: () => runtimeState.lifecycleToken,
  onHandlerError: emitRuntimeError,
});
```

**Step 6: Run tests**

Run: `npm run check`
Expected: All tests pass including new error observability test

**Step 7: Commit**

```bash
git add src/core/runtime/event-bus.ts src/core/runtime/index.ts tests/runtime-event-bus.test.ts
git commit -m "feat: add error observability to event bus via onHandlerError callback"
```

---

## Task 6: Add subscription dispose() method

**Files:**
- Modify: `src/core/runtime/subscriptions.ts`
- Modify: `src/core/runtime/index.ts:311-314`
- Test: `tests/runtime-subscriptions.test.ts`

The runtime calls 3 cleanup functions in a specific order. A single `dispose()` prevents ordering bugs.

**Step 1: Write failing test**

In `tests/runtime-subscriptions.test.ts`:

```typescript
it("dispose() clears all timers and closes all subscriptions", () => {
  let fileChangedCount = 0;
  const event = createCallbackHolder();
  const closeFn = vi.fn();
  const options = createTestOptions({
    watchPaths: ["/a"],
    onFileChanged: () => { fileChangedCount++; },
    subscribeToChanges: (_path: string, onEvent: () => void) => {
      event.capture(onEvent);
      return { close: closeFn };
    },
  });

  const subs = createRuntimeSubscriptions(options);
  subs.initializeSubscriptions(1);

  event.fire();
  subs.dispose();

  vi.advanceTimersByTime(10_000);
  expect(fileChangedCount).toBe(0);
  expect(closeFn).toHaveBeenCalled();
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test -- tests/runtime-subscriptions.test.ts`
Expected: FAIL — `dispose` does not exist

**Step 3: Add dispose() to subscriptions**

In `src/core/runtime/subscriptions.ts`, add after `clearResubscribeTimers`:

```typescript
function dispose(): void {
  clearDebounceTimer();
  closeSubscriptions();
  clearResubscribeTimers();
}
```

Add `dispose` to the return object.

**Step 4: Use dispose() in the runtime**

Replace `src/core/runtime/index.ts:311-314`:

```typescript
// Before:
subs.clearDebounceTimer();
clearIdleTimer();
subs.closeSubscriptions();
subs.clearResubscribeTimers();

// After:
subs.dispose();
clearIdleTimer();
```

**Step 5: Run tests**

Run: `npm run check`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/core/runtime/subscriptions.ts src/core/runtime/index.ts tests/runtime-subscriptions.test.ts
git commit -m "refactor: add dispose() to subscriptions for atomic cleanup"
```

---

## Task 7: Add composite provider partial failure resilience tests

**Files:**
- Test: `tests/composite-provider.test.ts`

**Step 1: Add partial failure tests**

```typescript
describe("partial failure resilience", () => {
  it("returns results from healthy providers when one provider read() throws", async () => {
    // Provider A returns agents, Provider B throws
    // Composite should return Provider A's agents + warning, not throw
  });

  it("returns results from healthy providers when one provider discover() throws", () => {
    // Provider A discovers inputs, Provider B throws
    // Composite should return Provider A's inputs, not throw
  });

  it("connects remaining providers when one provider connect() throws", () => {
    // Provider A connects fine, Provider B throws
    // Provider A should still be connected
  });
});
```

**Step 2: Run tests to understand current behavior**

Run: `npm run test -- tests/composite-provider.test.ts`
Expected: New tests reveal whether composite currently throws or degrades gracefully

**Step 3: Fix composite if needed**

If `discover()` and `read()` don't handle partial failures, wrap each provider call in try-catch and collect warnings. The `disconnect()` and `subscribeAll()` functions already handle this pattern — mirror their approach.

**Step 4: Run tests**

Run: `npm run check`
Expected: All tests pass

**Step 5: Commit**

```bash
git add tests/composite-provider.test.ts src/core/composite.ts
git commit -m "feat: add partial failure resilience to composite provider discover/read"
```

---

## Task 8: Consolidate CI workflows

**Files:**
- Modify: `.github/workflows/quality-gate.yml`
- Delete: `.github/workflows/ci.yml`

**Step 1: Update quality-gate.yml to include build step**

```yaml
name: Quality Gate

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest

    strategy:
      matrix:
        node-version: [20, 22]

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: "npm"

      - run: npm ci

      - name: Quality gate
        run: npm run check

      - name: Build
        run: npm run build
```

**Step 2: Delete ci.yml**

```bash
rm .github/workflows/ci.yml
```

**Step 3: Run quality gate locally to verify**

Run: `npm run check && npm run build`
Expected: All checks pass, build succeeds

**Step 4: Commit**

```bash
git add .github/workflows/quality-gate.yml
git rm .github/workflows/ci.yml
git commit -m "ci: consolidate CI workflows into single quality-gate with build step"
```

---

## Execution Summary

| Task | Type | Risk | Files |
|------|------|------|-------|
| 1. Codex build exports | Bug fix | Low | 2 |
| 2. NaN timestamp guard | Bug fix | Medium | 5 |
| 3. Test helper extraction | Refactor | Low | 4 |
| 4. Shared watch factory | Refactor | Medium | 5 |
| 5. Event bus error observability | Feature | Low | 3 |
| 6. Subscription dispose() | Refactor | Low | 3 |
| 7. Composite partial failures | Feature + Test | Medium | 2 |
| 8. CI consolidation | Config | Low | 2 |

**Batch 1 (no dependencies):** Tasks 1, 2, 3 — can run in parallel
**Batch 2 (depends on shared code):** Task 4 — depends on shared directory existing
**Batch 3 (no dependencies):** Tasks 5, 6 — can run in parallel
**Batch 4 (depends on composite):** Task 7
**Batch 5 (independent):** Task 8

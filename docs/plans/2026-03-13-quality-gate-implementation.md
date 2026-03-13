# Code Quality Gate — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Establish an automated code quality pipeline — fix all 41 audit violations, configure Biome + ESLint, add pre-commit hooks and CI enforcement.

**Architecture:** Five sequential phases: (1) project CLAUDE.md rules, (2) fix source violations file-by-file, (3) refactor mock-heavy tests, (4) configure linter stack, (5) add enforcement hooks. Phases 2-3 are parallelizable per file.

**Tech Stack:** Biome 2.4.x, ESLint 9.x (flat config), @typescript-eslint 8.x, eslint-plugin-sonarjs 1.x, eslint-plugin-unicorn 55.x, husky 9.x, lint-staged 15.x, GitHub Actions.

**Working directory:** `/Users/whitemonk/projects/ai/agentprobe/.worktrees/quality-gate`

**Design doc:** `docs/plans/2026-03-13-quality-gate-design.md`

---

## Task 1: Create Project CLAUDE.md

**Files:**
- Create: `CLAUDE.md`

**Step 1: Write the project CLAUDE.md**

```markdown
# AgentProbe — Project Rules

## Code Style

- No classes for business logic — use factory functions + closures
- No nesting beyond 2 levels inside a function body
- Max function length: 25 lines of logic
- No magic numbers/strings — use named constants
- No `any` types, no type assertions (`as Type`) — use type guards
- No comments explaining *what* — only *why* when non-obvious
- Double quotes, semicolons, trailing commas (enforced by Biome)

## Engineering Principles

- DRY — extract shared patterns, no copy-paste
- YAGNI — no speculative features or unused abstractions
- Fail fast — validate inputs early, return/throw before the happy path
- Dependency injection — pass dependencies in, don't import singletons
- Errors are values — custom error types with context, no bare `catch {}`

## TypeScript-Specific

- Names are contracts — domain-meaningful, no `data`/`result`/`temp`
- Discriminated unions over class hierarchies
- Explicit return types on exported functions
- `readonly` on data structures that shouldn't mutate
- Imports via `@/` path aliases, no `../` relative imports

## Testing

- Test real behavior, not mocked behavior — if a mock is the only thing being verified, the test is wrong
- Mock data, not behavior — inject test data, don't spy on implementation details
- All error paths must have tests
- All public exports must have tests
- Test output must be pristine — capture and validate expected errors

## Tooling

- `npm run check` runs the full quality gate: `biome check . && eslint . && tsc --noEmit && vitest run`
- Pre-commit hook runs Biome format + ESLint on staged files via lint-staged
- CI runs full `npm run check` on every PR
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add project-level CLAUDE.md with quality rules"
```

---

## Task 2: Extract Shared `emitToListeners` Utility

This is a cross-file dependency needed before Tasks 3-4. Two identical `emit()` functions exist in `observer.ts` and `runtime/index.ts`.

**Files:**
- Modify: `src/core/runtime/shared.ts` (add utility)
- Modify: `src/core/runtime/index.ts:367-375` (replace inline emit)
- Modify: `src/core/observer.ts:139-147` (replace inline emit)
- Test: `tests/runtime-shared.test.ts` (add test)

**Step 1: Write the failing test**

Add to `tests/runtime-shared.test.ts`:

```typescript
describe("emitToListeners", () => {
  it("calls every listener with the event", () => {
    const received: string[] = [];
    const listeners = new Set<(event: string) => void>([
      (e) => received.push(`a:${e}`),
      (e) => received.push(`b:${e}`),
    ]);
    emitToListeners(listeners, "hello");
    expect(received).toEqual(["a:hello", "b:hello"]);
  });

  it("continues calling listeners when one throws", () => {
    const received: string[] = [];
    const listeners = new Set<(event: string) => void>([
      () => { throw new Error("boom"); },
      (e) => received.push(e),
    ]);
    emitToListeners(listeners, "hello");
    expect(received).toEqual(["hello"]);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/runtime-shared.test.ts
```

Expected: FAIL — `emitToListeners` is not exported.

**Step 3: Write minimal implementation**

Add to `src/core/runtime/shared.ts`:

```typescript
export function emitToListeners<TEvent>(
  listeners: Set<(event: TEvent) => void>,
  event: TEvent,
): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Keep event fan-out resilient to listener failures.
    }
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run tests/runtime-shared.test.ts
```

Expected: PASS

**Step 5: Replace inline emit in `runtime/index.ts`**

At `src/core/runtime/index.ts:367-375`, replace:

```typescript
function emit(event: WatchRuntimeEvent<TAgent, TStatus>): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Keep runtime loop healthy even if consumer listeners throw.
    }
  }
}
```

With:

```typescript
function emit(event: WatchRuntimeEvent<TAgent, TStatus>): void {
  emitToListeners(listeners, event);
}
```

Add import: `import { emitToListeners } from "./shared.js";` (if not already importing from shared).

**Step 6: Replace inline emit in `observer.ts`**

At `src/core/observer.ts:139-147`, replace:

```typescript
function emit(event: ObserverChangeEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Keep observer fan-out resilient to listener failures.
    }
  }
}
```

With:

```typescript
function emit(event: ObserverChangeEvent): void {
  emitToListeners(listeners, event);
}
```

Add import: `import { emitToListeners } from "./runtime/shared.js";`

**Step 7: Run full test suite**

```bash
npm run check
```

Expected: All 83 tests pass, no lint errors.

**Step 8: Commit**

```bash
git add src/core/runtime/shared.ts src/core/runtime/index.ts src/core/observer.ts tests/runtime-shared.test.ts
git commit -m "refactor: extract shared emitToListeners utility

Eliminates duplicated emit pattern between observer.ts and runtime/index.ts."
```

---

## Task 3: Decompose `transcripts.ts` — `readSnapshot`

The `readSnapshot` function (lines 125-238) is 113 lines with 4+ nesting levels and multiple responsibilities: connection validation, file stat caching, incremental parsing, and agent merging.

**Files:**
- Modify: `src/providers/cursor/transcripts.ts:125-238`
- Test: `tests/cursor-transcripts.test.ts` (existing tests must keep passing)

**Step 1: Extract `tryStatFile` helper**

Add above `createCursorTranscriptSource` (around line 105):

```typescript
function tryStatFile(
  sourcePath: string,
): { mtimeMs: number; sizeBytes: number } | null {
  try {
    const stats = statSync(sourcePath);
    return { mtimeMs: Math.round(stats.mtimeMs), sizeBytes: stats.size };
  } catch {
    // File may have been deleted between discovery and read — skip gracefully.
    return null;
  }
}
```

**Step 2: Extract `shouldReuseCache` helper**

```typescript
function shouldReuseCache(
  cached: TranscriptFileCache | undefined,
  stats: { mtimeMs: number; sizeBytes: number },
): "full-reuse" | "mtime-changed-same-size" | "needs-parse" {
  if (!cached) return "needs-parse";
  if (cached.mtimeMs === stats.mtimeMs) return "full-reuse";
  if (cached.sizeBytes === stats.sizeBytes) return "mtime-changed-same-size";
  return "needs-parse";
}
```

**Step 3: Extract `parseTranscriptFile` helper**

```typescript
function parseTranscriptFile(
  sourcePath: string,
  contents: string,
  cached: TranscriptFileCache | undefined,
  warnings: string[],
): { state: TranscriptParseState; lineCount: number } {
  const lines = contents.split(/\r?\n/);
  const canResume = cached && cached.sizeBytes < Buffer.byteLength(contents) && cached.lineCount <= lines.length;
  const startLine = canResume ? cached.lineCount : 0;
  const state = canResume ? cloneParseState(cached.state) : createInitialParseState();
  accumulateLines(state, lines, startLine, sourcePath, warnings);
  return { state, lineCount: lines.length };
}
```

**Step 4: Rewrite `readSnapshot` using helpers**

The new `readSnapshot` should be ~30 lines, calling the extracted helpers. Structure:

```typescript
async readSnapshot(now = Date.now()): Promise<TranscriptSourceResult> {
  if (!connected) { return { agents: [], ... }; }
  if (sourcePaths.length === 0) { return { agents: [], ... }; }

  const warnings: string[] = [];
  const orderedIds: string[] = [];
  const latestById = new Map<string, CanonicalAgentSnapshot>();
  let hasReadError = false;
  let successfulReads = 0;

  for (const sourcePath of sourcePaths) {
    const stats = tryStatFile(sourcePath);
    if (!stats) { hasReadError = true; continue; }

    const cacheDecision = shouldReuseCache(fileCache.get(sourcePath), stats);
    const cached = fileCache.get(sourcePath);

    if (cacheDecision === "full-reuse" || cacheDecision === "mtime-changed-same-size") {
      // Reuse cached state, update mtime if changed
      if (cacheDecision === "mtime-changed-same-size" && cached) {
        fileCache.set(sourcePath, { ...cached, mtimeMs: stats.mtimeMs });
      }
      const agents = resolveAgentsFromState(cached!.state, sourcePath, cached!.mtimeMs, now);
      mergeAgents(agents, orderedIds, latestById);
      successfulReads++;
      continue;
    }

    const contents = await readFile(sourcePath, "utf8");
    const { state, lineCount } = parseTranscriptFile(sourcePath, contents, cached, warnings);
    fileCache.set(sourcePath, { state, mtimeMs: stats.mtimeMs, sizeBytes: stats.sizeBytes, lineCount });
    const agents = resolveAgentsFromState(state, sourcePath, stats.mtimeMs, now);
    mergeAgents(agents, orderedIds, latestById);
    successfulReads++;
  }

  pruneStaleEntries(fileCache, sourcePaths);
  const agents = orderedIds.map((id) => latestById.get(id)!);
  return { agents, warnings, hasReadError, successfulReads };
}
```

**Step 5: Run tests**

```bash
npx vitest run tests/cursor-transcripts.test.ts
```

Expected: All 5 existing tests pass.

**Step 6: Run full suite**

```bash
npm run check
```

Expected: All 83 tests pass.

**Step 7: Commit**

```bash
git add src/providers/cursor/transcripts.ts
git commit -m "refactor: decompose readSnapshot into focused helpers

Extract tryStatFile, shouldReuseCache, parseTranscriptFile.
Reduces readSnapshot from 113 lines to ~30."
```

---

## Task 4: Flatten `deriveConversationStatus`

The function (lines 486-529) has 5 nesting levels with cascading conditionals.

**Files:**
- Modify: `src/providers/cursor/transcripts.ts:486-529`
- Test: existing tests must keep passing

**Step 1: Extract age-based status helpers**

Add before `deriveConversationStatus`:

```typescript
function statusAfterAssistantReply(ageMs: number): CanonicalAgentStatus {
  if (ageMs <= STREAMING_QUIET_WINDOW_MS) return CANONICAL_AGENT_STATUS.running;
  if (ageMs <= AGENT_COMPLETION_QUIET_WINDOW_MS) return CANONICAL_AGENT_STATUS.idle;
  return CANONICAL_AGENT_STATUS.completed;
}

function statusWhileAwaitingAssistant(ageMs: number): CanonicalAgentStatus {
  if (ageMs <= IDLE_WINDOW_MS) return CANONICAL_AGENT_STATUS.idle;
  return CANONICAL_AGENT_STATUS.completed;
}
```

**Step 2: Rewrite `deriveConversationStatus` with guard clauses**

```typescript
function deriveConversationStatus(
  now: number,
  updatedAt: number,
  latestSignal: ConversationSignal | undefined,
  latestRole: string | undefined,
  hasAssistantReplyAfterLatestUser: boolean,
): CanonicalAgentStatus {
  if (latestSignal === "error") return CANONICAL_AGENT_STATUS.error;
  if (latestSignal === "completed") return CANONICAL_AGENT_STATUS.completed;

  const ageMs = Math.max(0, now - updatedAt);
  const assistantDone =
    hasAssistantReplyAfterLatestUser &&
    isAssistantRole(latestRole ?? "") &&
    latestSignal !== "active";

  if (assistantDone) return statusAfterAssistantReply(ageMs);
  if (ageMs <= RUNNING_WINDOW_MS) return CANONICAL_AGENT_STATUS.running;
  if (latestSignal === "active" && !hasAssistantReplyAfterLatestUser) {
    return statusWhileAwaitingAssistant(ageMs);
  }
  if (ageMs <= IDLE_WINDOW_MS) return CANONICAL_AGENT_STATUS.idle;
  return CANONICAL_AGENT_STATUS.completed;
}
```

**Step 3: Run tests**

```bash
npx vitest run tests/cursor-transcripts.test.ts
```

Expected: All 5 tests pass.

**Step 4: Commit**

```bash
git add src/providers/cursor/transcripts.ts
git commit -m "refactor: flatten deriveConversationStatus with guard clauses

Extract statusAfterAssistantReply and statusWhileAwaitingAssistant.
Reduces nesting from 5 levels to 1."
```

---

## Task 5: Simplify `accumulateLines`

The function (lines 271-300) has 3 nesting levels: for loop + try-catch + if-else.

**Files:**
- Modify: `src/providers/cursor/transcripts.ts:271-300`

**Step 1: Extract `tryParseJsonLine` helper**

```typescript
function tryParseJsonLine(
  line: string,
  sourcePath: string,
  lineIndex: number,
  warnings: string[],
): unknown | null {
  try {
    return JSON.parse(line);
  } catch {
    warnings.push(formatLineWarning(sourcePath, lineIndex + 1, "Invalid JSON line."));
    return null;
  }
}
```

**Step 2: Extract `dispatchParsedRecord` helper**

```typescript
function dispatchParsedRecord(
  parsed: unknown,
  state: TranscriptParseState,
  sourcePath: string,
  warnings: string[],
  lineIndex: number,
): void {
  const flatRecord = parseFlatRecord(parsed);
  if (flatRecord) {
    accumulateFlatRecord(state, flatRecord, sourcePath, warnings, lineIndex);
  } else {
    accumulateConversationLine(state, parsed, sourcePath, warnings, lineIndex);
  }
}
```

**Step 3: Simplify `accumulateLines`**

```typescript
function accumulateLines(
  state: TranscriptParseState,
  lines: string[],
  startIndex: number,
  sourcePath: string,
  warnings: string[],
): void {
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;

    const parsed = tryParseJsonLine(line, sourcePath, i, warnings);
    if (parsed) dispatchParsedRecord(parsed, state, sourcePath, warnings, i);
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run tests/cursor-transcripts.test.ts
```

Expected: All 5 tests pass.

**Step 5: Commit**

```bash
git add src/providers/cursor/transcripts.ts
git commit -m "refactor: simplify accumulateLines with extracted helpers

Extract tryParseJsonLine and dispatchParsedRecord.
Reduces nesting from 3 levels to 1."
```

---

## Task 6: Extract Magic Numbers to Constants

**Files:**
- Modify: `src/providers/cursor/constants.ts` (add constants)
- Modify: `src/providers/cursor/transcripts.ts` (use constants)
- Modify: `src/providers/cursor/discovery.ts` (move constants)

**Step 1: Add missing constants to `constants.ts`**

Currently `constants.ts` has:
```
AGENT_COMPLETION_QUIET_WINDOW_MS = 30_000
STREAMING_QUIET_WINDOW_MS = 2_000
CURSOR_WATCH_DEBOUNCE_MS = 150
CURSOR_SOURCE_KIND = "cursor-transcripts"
```

Add:

```typescript
export const RUNNING_WINDOW_MS = 3_000;
export const IDLE_WINDOW_MS = 60_000;
export const AGENT_NAME_PREFIX_LENGTH = 6;
export const TRANSCRIPT_FILE_EXTENSION = ".jsonl";
export const SUBAGENT_PATH_SEGMENT = "/subagents/";
export const MAX_DISCOVERED_TRANSCRIPT_FILES = 400;
```

**Step 2: Update `transcripts.ts` to use constants**

Replace in `transcripts.ts`:
- Line ~76: `const RUNNING_WINDOW_MS = 3_000;` → remove, import from constants
- Line ~77: `const IDLE_WINDOW_MS = 60_000;` → remove, import from constants
- Line ~540: `agentId.slice(0, 6)` → `agentId.slice(0, AGENT_NAME_PREFIX_LENGTH)`
- Line ~534: `".jsonl"` → `TRANSCRIPT_FILE_EXTENSION`
- Line ~544: `"/subagents/"` → `SUBAGENT_PATH_SEGMENT`

**Step 3: Update `discovery.ts` to use constants**

Replace in `discovery.ts`:
- Line ~9: `const TRANSCRIPT_FILE_EXTENSION = ".jsonl";` → remove, import from constants
- Line ~10: `const MAX_DISCOVERED_TRANSCRIPT_FILES = 400;` → remove, import from constants

**Step 4: Run tests**

```bash
npm run check
```

Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/providers/cursor/constants.ts src/providers/cursor/transcripts.ts src/providers/cursor/discovery.ts
git commit -m "refactor: extract magic numbers to named constants

Move RUNNING_WINDOW_MS, IDLE_WINDOW_MS, AGENT_NAME_PREFIX_LENGTH,
TRANSCRIPT_FILE_EXTENSION, SUBAGENT_PATH_SEGMENT, MAX_DISCOVERED_TRANSCRIPT_FILES
to constants.ts."
```

---

## Task 7: Fix Naming and Catch Blocks

**Files:**
- Modify: `src/providers/cursor/provider.ts:135-145` (rename params)
- Modify: `src/providers/cursor/discovery.ts:74` (add catch rationale)
- Modify: `src/core/runtime/subscriptions.ts:188` (add catch rationale)
- Modify: `src/core/errors.ts:10` (add catch rationale)
- Modify: `src/core/runtime/event-bus.ts:46` (add catch rationale)

**Step 1: Rename `arraysEqual` parameters in `provider.ts`**

At `src/providers/cursor/provider.ts:135-145`, replace:

```typescript
function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
```

With:

```typescript
function arraysEqual(previous: readonly string[], current: readonly string[]): boolean {
  if (previous.length !== current.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index++) {
    if (previous[index] !== current[index]) {
      return false;
    }
  }
  return true;
}
```

**Step 2: Add catch rationale in `discovery.ts`**

At `src/providers/cursor/discovery.ts:74`, replace:

```typescript
    } catch {
      continue;
    }
```

With:

```typescript
    } catch {
      // statSync fails for ENOENT, EACCES, etc. — skip unreachable paths silently;
      // discovery is best-effort and caller handles partial results.
      continue;
    }
```

**Step 3: Add catch rationale in `subscriptions.ts`**

At `src/core/runtime/subscriptions.ts:188`, replace:

```typescript
      } catch {
        /* Recovery path should remain best-effort. */
      }
```

With:

```typescript
      } catch {
        // Subscription close can throw if the underlying watcher was already destroyed.
        // During cleanup we only care that we tried — surfacing this error would mask
        // the real issue that triggered the cleanup.
      }
```

**Step 4: Add catch rationale in `errors.ts`**

At `src/core/errors.ts:10`, replace:

```typescript
  } catch {
    return new Error(String(value));
  }
```

With:

```typescript
  } catch {
    // JSON.stringify fails on circular references or objects with toJSON that throws.
    // Fall back to String() — producing *some* error message is more important than
    // preserving the original shape.
    return new Error(String(value));
  }
```

**Step 5: Add catch rationale in `event-bus.ts`**

At `src/core/runtime/event-bus.ts:46`, replace:

```typescript
    } catch {
      // Handler errors must not crash the bus.
    }
```

With:

```typescript
    } catch {
      // Handler errors must not crash the bus — a failing handler would block all
      // subsequent events in the queue, causing the runtime to silently stop responding.
    }
```

**Step 6: Run tests**

```bash
npm run check
```

Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/providers/cursor/provider.ts src/providers/cursor/discovery.ts \
  src/core/runtime/subscriptions.ts src/core/errors.ts src/core/runtime/event-bus.ts
git commit -m "refactor: improve naming and add rationale to bare catch blocks

Rename arraysEqual params from a/b/i to previous/current/index.
Add why-comments to all bare catch blocks in discovery, subscriptions,
errors, and event-bus."
```

---

## Task 8: Add Missing Test Coverage

**Files:**
- Modify: `tests/lifecycle.test.ts` (add `reset()` test)
- Modify: `tests/core-contracts.test.ts` (add `WATCH_RUNTIME_STATES` test)
- Modify: `tests/cursor-provider.test.ts` (add `normalize` error path tests)

**Step 1: Write failing test for `lifecycle.reset()`**

Add to `tests/lifecycle.test.ts`:

```typescript
it("reset clears previous status tracking so agents re-emit joined", () => {
  const mapper = createLifecycleMapper<{ id: string; status: string }, string>({
    getId: (agent) => agent.id,
    getStatus: (agent) => agent.status,
  });

  // First call — agent joins
  const firstEvents = mapper.map([{ id: "a", status: "running" }], 10);
  expect(firstEvents).toEqual([
    expect.objectContaining({ kind: WATCH_LIFECYCLE_KIND.joined, agentId: "a" }),
  ]);

  // Second call — same agent, heartbeat only
  const secondEvents = mapper.map([{ id: "a", status: "running" }], 20);
  expect(secondEvents).toEqual([
    expect.objectContaining({ kind: WATCH_LIFECYCLE_KIND.heartbeat }),
  ]);

  // Reset — clears tracking
  mapper.reset();

  // Third call — agent "joins" again because tracking was cleared
  const thirdEvents = mapper.map([{ id: "a", status: "running" }], 30);
  expect(thirdEvents).toEqual([
    expect.objectContaining({ kind: WATCH_LIFECYCLE_KIND.joined, agentId: "a" }),
  ]);
});
```

**Step 2: Run test to verify it passes (this tests existing behavior, should pass immediately)**

```bash
npx vitest run tests/lifecycle.test.ts
```

Expected: PASS (the `reset()` function exists, we're just adding coverage).

**Step 3: Write test for `WATCH_RUNTIME_STATES`**

Add to `tests/core-contracts.test.ts`:

```typescript
it("exports correct runtime state constants", () => {
  expect(core.WATCH_RUNTIME_STATES).toEqual({
    stopped: "stopped",
    starting: "starting",
    started: "started",
    stopping: "stopping",
  });
});
```

**Step 4: Run test**

```bash
npx vitest run tests/core-contracts.test.ts
```

Expected: PASS

**Step 5: Add normalize error path tests to `cursor-provider.test.ts`**

```typescript
describe("normalize edge cases", () => {
  it("returns empty agents for null payload", () => {
    const provider = createCursorTranscriptProvider({ workspacePaths: [] });
    const result = provider.normalize(null as unknown);
    expect(result).toEqual({ agents: [] });
  });

  it("returns empty agents for payload missing agents field", () => {
    const provider = createCursorTranscriptProvider({ workspacePaths: [] });
    const result = provider.normalize({ notAgents: [] } as unknown);
    expect(result).toEqual({ agents: [] });
  });
});
```

**Step 6: Run test**

```bash
npx vitest run tests/cursor-provider.test.ts
```

Expected: PASS (the type guard already handles this).

**Step 7: Run full suite**

```bash
npm run check
```

Expected: All tests pass.

**Step 8: Commit**

```bash
git add tests/lifecycle.test.ts tests/core-contracts.test.ts tests/cursor-provider.test.ts
git commit -m "test: add missing coverage for reset(), WATCH_RUNTIME_STATES, and normalize edge cases"
```

---

## Task 9: Refactor `runtime-shared.test.ts`

The audit flagged this file but the deep-dive agent found the tests are actually testing real behavior (resolveWaiters, rejectWaiters, disconnectQuietly). The `emitToListeners` tests were already added in Task 2.

**Files:**
- Review: `tests/runtime-shared.test.ts`

**Step 1: Verify the existing tests test real behavior**

Read `tests/runtime-shared.test.ts`. The deep-dive audit confirmed:
- `resolveWaiters` — tests real resolve behavior
- `rejectWaiters` — tests real reject behavior
- `disconnectQuietly` — tests real cleanup behavior

**Step 2: No changes needed**

The initial audit was a false positive for this file. The tests use spies to observe behavior, which is different from testing *only* mock behavior.

**Step 3: Commit (skip — no changes)**

---

## Task 10: Refactor `runtime-event-bus.test.ts`

Some tests are acceptable (sequential processing, error resilience, clear), but a few test mock behavior.

**Files:**
- Modify: `tests/runtime-event-bus.test.ts`
- Reference: `src/core/runtime/event-bus.ts`

**Step 1: Review and improve the "drops events with stale tokens" test**

The current test (lines 43-57) creates a mock handler and checks it wasn't called for stale tokens. This is borderline — the assertion is that stale-token events don't reach handlers, which IS the real behavior. Keep but improve clarity:

```typescript
it("drops events dispatched with a token that no longer matches getToken()", async () => {
  let currentToken = 1;
  const handledEvents: string[] = [];

  const bus = createEventBus<TestEvent>({
    handlers: {
      a: async (event) => { handledEvents.push(event.type); },
    },
    getToken: () => currentToken,
  });

  bus.dispatch({ type: "a" }, 1);  // token matches
  currentToken = 2;                 // token changes
  bus.dispatch({ type: "a" }, 1);  // stale token — should be dropped

  await waitUntil(() => handledEvents.length >= 1, 200);
  // Only the first dispatch should have been processed
  expect(handledEvents).toEqual(["a"]);
});
```

**Step 2: Run tests**

```bash
npx vitest run tests/runtime-event-bus.test.ts
```

Expected: All tests pass.

**Step 3: Commit**

```bash
git add tests/runtime-event-bus.test.ts
git commit -m "test: improve clarity of stale-token test in event-bus"
```

---

## Task 11: Refactor `runtime-subscriptions.test.ts`

This is the most problematic test file — most tests verify mock/spy call counts rather than real subscription behavior.

**Files:**
- Modify: `tests/runtime-subscriptions.test.ts`
- Reference: `src/core/runtime/subscriptions.ts`

**Step 1: Understand what the subscription module actually does**

The module manages:
1. Path normalization (trim whitespace, deduplicate)
2. Subscription creation (calling `subscribeToChanges` per path)
3. Debouncing (coalescing rapid file change events)
4. Error recovery (resubscribing with exponential backoff)
5. Cleanup (closing all subscriptions)

**Step 2: Rewrite path normalization tests to assert on observable behavior**

The current tests capture mock arguments. Rewrite to verify the subscription module calls `subscribeToChanges` with correct paths and the correct number of times:

```typescript
it("trims whitespace and deduplicates watch paths", () => {
  const subscribedPaths: string[] = [];
  const options = createTestOptions({
    watchPaths: ["  /a  ", "/b", " /a", "/b ", ""],
    subscribeToChanges: (watchPath) => {
      subscribedPaths.push(watchPath);
      return { close: vi.fn() };
    },
  });

  const subs = createRuntimeSubscriptions(options);
  subs.initializeSubscriptions(1);

  expect(subscribedPaths).toEqual(["/a", "/b"]);
});
```

This tests the SAME thing but makes the intent clearer — we care about which paths get subscribed, not about mock internals.

**Step 3: Rewrite debounce tests to verify coalescing**

```typescript
it("debounces rapid watch events into a single onFileChanged call", () => {
  vi.useFakeTimers();
  let fileChangedCount = 0;
  let onWatchEvent: (() => void) | undefined;

  const options = createTestOptions({
    watchPaths: ["/a"],
    debounceMs: 50,
    subscribeToChanges: (_path, onEvent) => {
      onWatchEvent = onEvent;
      return { close: vi.fn() };
    },
  });
  options.onFileChanged = () => { fileChangedCount++; };

  const subs = createRuntimeSubscriptions(options);
  subs.initializeSubscriptions(1);

  // Fire 3 rapid events
  onWatchEvent!();
  onWatchEvent!();
  onWatchEvent!();

  // Before debounce window: no calls yet
  expect(fileChangedCount).toBe(0);

  // After debounce window: exactly 1 coalesced call
  vi.advanceTimersByTime(50);
  expect(fileChangedCount).toBe(1);

  vi.useRealTimers();
});
```

**Step 4: Rewrite close tests to verify cleanup prevents further events**

```typescript
it("closes all subscriptions and prevents further file change events", () => {
  vi.useFakeTimers();
  let fileChangedCount = 0;
  let onWatchEvent: (() => void) | undefined;
  const closeFns: ReturnType<typeof vi.fn>[] = [];

  const options = createTestOptions({
    watchPaths: ["/a", "/b"],
    debounceMs: 50,
    subscribeToChanges: (_path, onEvent) => {
      onWatchEvent = onEvent;
      const close = vi.fn();
      closeFns.push(close);
      return { close };
    },
  });
  options.onFileChanged = () => { fileChangedCount++; };

  const subs = createRuntimeSubscriptions(options);
  subs.initializeSubscriptions(1);
  subs.closeSubscriptions();

  // Verify close was called on each subscription
  for (const close of closeFns) {
    expect(close).toHaveBeenCalled();
  }

  // Verify debounce timer was cleared (no pending file changes fire)
  vi.advanceTimersByTime(1000);
  expect(fileChangedCount).toBe(0);

  vi.useRealTimers();
});
```

**Step 5: Rewrite error recovery test to verify resubscription**

```typescript
it("resubscribes with exponential backoff when watch error callback fires", () => {
  vi.useFakeTimers();
  let subscribeCount = 0;
  let onWatchError: ((error: Error) => void) | undefined;
  const emittedErrors: Error[] = [];

  const options = createTestOptions({
    watchPaths: ["/a"],
    subscribeToChanges: (_path, _onEvent, onError) => {
      subscribeCount++;
      onWatchError = onError;
      return { close: vi.fn() };
    },
  });
  options.emitError = (error) => { emittedErrors.push(error); };

  const subs = createRuntimeSubscriptions(options);
  subs.initializeSubscriptions(1);
  expect(subscribeCount).toBe(1);

  // Trigger watch error
  onWatchError!(new Error("watcher crashed"));
  expect(emittedErrors).toHaveLength(1);
  expect(emittedErrors[0].message).toBe("watcher crashed");

  // First resubscribe: 500ms base delay
  vi.advanceTimersByTime(500);
  expect(subscribeCount).toBe(2);

  vi.useRealTimers();
});
```

**Step 6: Run tests**

```bash
npx vitest run tests/runtime-subscriptions.test.ts
```

Expected: All tests pass.

**Step 7: Run full suite**

```bash
npm run check
```

Expected: All tests pass.

**Step 8: Commit**

```bash
git add tests/runtime-subscriptions.test.ts
git commit -m "test: rewrite subscription tests to verify real behavior

Replace mock-verification tests with behavior-driven tests that assert
on observable outcomes: subscribed paths, debounce coalescing, cleanup,
and error recovery with backoff."
```

---

## Task 12: Tighten Biome Configuration

**Files:**
- Modify: `biome.json`

**Step 1: Update biome.json**

Enable import organization and tighten rules:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.5/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "ignoreUnknown": false
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": {
        "noRestrictedImports": {
          "level": "error",
          "options": {
            "patterns": [
              {
                "group": ["../*"],
                "message": "Use @/* path aliases instead of parent-relative imports."
              }
            ]
          }
        },
        "noParameterAssign": "error"
      },
      "suspicious": {
        "noEmptyCatch": "error"
      }
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always",
      "trailingCommas": "all",
      "bracketSpacing": true,
      "arrowParentheses": "always"
    }
  },
  "assist": {
    "enabled": true,
    "actions": {
      "source": {
        "organizeImports": "on"
      }
    }
  }
}
```

**Step 2: Run Biome to check for new violations**

```bash
npx biome check .
```

If there are import organization changes or `noEmptyCatch` violations (we added rationale comments to catch blocks but Biome's `noEmptyCatch` may still flag them), we need to handle them.

**Important:** Our catch blocks now have comments in them, so they're not "empty" anymore. If Biome still flags them, use `// biome-ignore` with explanation on those specific lines, or adjust the rule to `warn` level. The `noParameterAssign` rule should be clean already.

**Step 3: Fix any violations**

Run `npx biome check --write .` for auto-fixable issues (import sorting).

For catch blocks that need to remain as-is, if Biome flags them despite having comments, the catch blocks already have bound error variables or comments — verify they pass.

**Step 4: Run full suite**

```bash
npm run check
```

Expected: All pass.

**Step 5: Commit**

```bash
git add biome.json src/
git commit -m "config: tighten Biome rules — enable import organization, noParameterAssign, noEmptyCatch"
```

---

## Task 13: Add ESLint with Flat Config

**Files:**
- Create: `eslint.config.js`
- Modify: `package.json` (add devDependencies and scripts)

**Step 1: Install ESLint and plugins**

```bash
npm install --save-dev \
  eslint@^9.0.0 \
  @eslint/js@^9.0.0 \
  typescript-eslint@^8.0.0 \
  eslint-plugin-sonarjs@^1.0.0 \
  eslint-plugin-unicorn@^55.0.0
```

**Step 2: Create `eslint.config.js`**

```javascript
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";

export default [
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "*.config.ts", "*.config.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      sonarjs,
      unicorn,
    },
    rules: {
      // --- Disable rules that overlap with Biome ---
      "indent": "off",
      "quotes": "off",
      "semi": "off",
      "comma-dangle": "off",
      "no-unused-vars": "off",
      "sort-imports": "off",
      "no-multiple-empty-lines": "off",
      "eol-last": "off",

      // --- TypeScript-specific ---
      "@typescript-eslint/explicit-function-return-type": ["error", {
        allowExpressions: true,
        allowTypedFunctionExpressions: true,
        allowHigherOrderFunctions: true,
      }],
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      "@typescript-eslint/naming-convention": ["error",
        { selector: "default", format: ["camelCase"], leadingUnderscore: "allow" },
        { selector: "variable", format: ["camelCase", "UPPER_CASE"], leadingUnderscore: "allow" },
        { selector: "typeLike", format: ["PascalCase"] },
      ],
      "@typescript-eslint/no-magic-numbers": ["error", {
        ignore: [0, 1, -1, 2],
        ignoreEnums: true,
        ignoreNumericLiteralTypes: true,
        ignoreReadonlyClassProperties: true,
      }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // --- Sonarjs (complexity and duplication) ---
      "sonarjs/cognitive-complexity": ["error", 10],
      "sonarjs/no-duplicate-string": ["error", { threshold: 3 }],
      "sonarjs/no-identical-functions": "error",

      // --- Unicorn (patterns) ---
      "unicorn/no-nested-ternary": "error",
      "unicorn/prefer-early-return": "error",
    },
  },
  {
    // Relax rules for test files
    files: ["tests/**/*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-magic-numbers": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/cognitive-complexity": "off",
    },
  },
];
```

**Step 3: Add lint:eslint script to package.json**

Update scripts in `package.json`:

```json
{
  "scripts": {
    "build": "tsup",
    "clean": "rm -rf dist coverage",
    "dev": "tsup --watch",
    "format": "biome format --write .",
    "lint": "biome lint . && eslint .",
    "lint:biome": "biome lint .",
    "lint:eslint": "eslint .",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "check": "biome check . && eslint . && npm run typecheck && npm run test"
  }
}
```

**Step 4: Run ESLint and fix violations**

```bash
npx eslint .
```

This will likely report violations. Fix them iteratively:
- `explicit-function-return-type` on exported functions — add return types
- `no-magic-numbers` — should be clean after Task 6
- `cognitive-complexity` — should be clean after Tasks 3-5
- `naming-convention` — may flag some patterns; adjust config if needed

If violations are extensive, fix them file by file and commit incrementally.

**Step 5: Run full suite**

```bash
npm run check
```

Expected: All pass (may require multiple fix iterations).

**Step 6: Commit**

```bash
git add eslint.config.js package.json package-lock.json src/
git commit -m "config: add ESLint with typescript-eslint, sonarjs, and unicorn plugins

Flat config enforces: cognitive complexity (10), no-magic-numbers,
explicit-function-return-type, naming-convention, no-floating-promises.
Biome-overlapping rules disabled. Test files relaxed."
```

---

## Task 14: Add Pre-commit Hooks (Husky + lint-staged)

**Files:**
- Create: `.husky/pre-commit`
- Create: `lint-staged.config.js`
- Modify: `package.json` (add prepare script)

**Step 1: Install husky and lint-staged**

```bash
npm install --save-dev husky@^9.0.0 lint-staged@^15.0.0
```

**Step 2: Initialize husky**

```bash
npx husky init
```

This creates `.husky/` directory.

**Step 3: Create pre-commit hook**

Write `.husky/pre-commit`:

```bash
npx lint-staged
```

**Step 4: Create lint-staged config**

Write `lint-staged.config.js`:

```javascript
export default {
  "*.{ts,tsx}": ["biome format --write", "eslint --fix"],
  "*.{js,jsx}": ["biome format --write"],
  "*.json": ["biome format --write"],
};
```

**Step 5: Add prepare script to package.json**

```json
{
  "scripts": {
    "prepare": "husky"
  }
}
```

**Step 6: Test the hook**

Make a trivial change and try committing:

```bash
echo "// test" >> src/index.ts
git add src/index.ts
git commit -m "test: verify pre-commit hook"
```

Expected: lint-staged runs Biome format and ESLint on the staged file. If the `// test` comment causes a lint error, the commit should fail — which proves the hook works. Revert:

```bash
git checkout -- src/index.ts
```

**Step 7: Commit the hook setup**

```bash
git add .husky/ lint-staged.config.js package.json package-lock.json
git commit -m "config: add pre-commit hook with husky + lint-staged

Runs Biome format and ESLint --fix on staged .ts files before commit."
```

---

## Task 15: Add GitHub Actions CI Workflow

**Files:**
- Create: `.github/workflows/quality-gate.yml`

**Step 1: Create the workflow file**

```bash
mkdir -p .github/workflows
```

Write `.github/workflows/quality-gate.yml`:

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

      - name: Biome check
        run: npx biome check .

      - name: ESLint
        run: npx eslint . --max-warnings 0

      - name: TypeScript
        run: npm run typecheck

      - name: Tests
        run: npm run test
```

**Step 2: Commit**

```bash
git add .github/workflows/quality-gate.yml
git commit -m "ci: add GitHub Actions quality gate workflow

Runs Biome, ESLint, TypeScript, and tests on Node 20 and 22
for every push to main and every PR."
```

---

## Task 16: Final Verification

**Files:** None — verification only.

**Step 1: Run the complete quality gate**

```bash
npm run check
```

Expected: Zero errors from Biome, ESLint, TypeScript, and all tests pass.

**Step 2: Verify pre-commit hook**

```bash
echo "" >> CLAUDE.md
git add CLAUDE.md
git commit -m "test: verify pre-commit hook works end-to-end"
```

Expected: lint-staged runs, commit succeeds.

**Step 3: Review git log**

```bash
git log --oneline
```

Verify all commits are clean and describe the changes accurately.

**Step 4: Run test coverage check**

```bash
npx vitest run --coverage
```

Verify coverage hasn't decreased from the baseline.

---

## Summary

| Task | Description | Files | Dependency |
|------|-------------|-------|------------|
| 1 | Create project CLAUDE.md | `CLAUDE.md` | None |
| 2 | Extract shared `emitToListeners` | `shared.ts`, `index.ts`, `observer.ts` | None |
| 3 | Decompose `readSnapshot` | `transcripts.ts` | None |
| 4 | Flatten `deriveConversationStatus` | `transcripts.ts` | After Task 3 |
| 5 | Simplify `accumulateLines` | `transcripts.ts` | After Task 4 |
| 6 | Extract magic numbers | `constants.ts`, `transcripts.ts`, `discovery.ts` | After Task 5 |
| 7 | Fix naming and catch blocks | `provider.ts`, `discovery.ts`, `subscriptions.ts`, `errors.ts`, `event-bus.ts` | None |
| 8 | Add missing test coverage | `lifecycle.test.ts`, `core-contracts.test.ts`, `cursor-provider.test.ts` | None |
| 9 | Review `runtime-shared.test.ts` | Review only — no changes | None |
| 10 | Improve `runtime-event-bus.test.ts` | `runtime-event-bus.test.ts` | None |
| 11 | Rewrite `runtime-subscriptions.test.ts` | `runtime-subscriptions.test.ts` | None |
| 12 | Tighten Biome config | `biome.json` | After Tasks 2-7 |
| 13 | Add ESLint | `eslint.config.js`, `package.json` | After Task 12 |
| 14 | Add pre-commit hooks | `.husky/`, `lint-staged.config.js`, `package.json` | After Task 13 |
| 15 | Add GitHub Actions CI | `.github/workflows/quality-gate.yml` | After Task 13 |
| 16 | Final verification | None | After all tasks |

**Parallelizable groups:**
- Tasks 1, 2, 3, 7, 8, 10, 11 can all start independently
- Tasks 4-5-6 are sequential (same file)
- Tasks 12-13-14-15 are sequential (config depends on code fixes)
- Task 16 runs last

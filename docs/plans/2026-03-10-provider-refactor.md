# Provider Refactor: Shared Utilities, Flatten Nesting, SRP Cleanup

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate code duplication between Cursor and Claude Code providers, flatten nested control flow, and enforce single responsibility in master functions.

**Architecture:** Extract shared utilities into `src/providers/shared/`, refactor `readSnapshot` master functions into composable steps, extract `groupBy` helper for composite provider, flatten discovery nesting, and trim the root API surface.

**Tech Stack:** TypeScript, Vitest, Zod, Biome (lint/format)

---

### Task 1: Create shared discovery utilities

Extract 5 identical functions from both discovery files into a shared module.

**Files:**
- Create: `src/providers/shared/discovery-utils.ts`
- Create: `tests/shared-discovery-utils.test.ts`
- Modify: `src/providers/claude-code/discovery.ts`
- Modify: `src/providers/cursor/discovery.ts`

**Step 1: Write the failing tests**

```typescript
// tests/shared-discovery-utils.test.ts
import path from "node:path";
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/shared-discovery-utils.test.ts`
Expected: FAIL — module `@/providers/shared/discovery-utils` does not exist

**Step 3: Write the implementation**

```typescript
// src/providers/shared/discovery-utils.ts
import { statSync, type Stats } from "node:fs";
import path from "node:path";

export function normalizeWorkspacePath(workspacePath: string): string {
  const trimmed = workspacePath.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return stripTrailingSeparators(path.resolve(trimmed));
}

export function stripTrailingSeparators(value: string): string {
  if (value === path.sep) {
    return value;
  }
  return value.replace(new RegExp(`[${escapeForRegExp(path.sep)}]+$`), "");
}

export function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tryStatSync(filePath: string): Stats | undefined {
  try {
    return statSync(filePath);
  } catch {
    return undefined;
  }
}

export function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

export function formatLineWarning(sourcePath: string, lineNumber: number, reason: string): string {
  return `${sourcePath}:${lineNumber} ${reason}`;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/shared-discovery-utils.test.ts`
Expected: PASS

**Step 5: Update Claude Code discovery to import from shared**

In `src/providers/claude-code/discovery.ts`:
- Remove the local `normalizeWorkspacePath`, `stripTrailingSeparators`, `escapeForRegExp`, `tryStatSync`, `dedupePaths` functions
- Add import: `import { normalizeWorkspacePath, stripTrailingSeparators, escapeForRegExp, tryStatSync, dedupePaths } from "@/providers/shared/discovery-utils";`
- Remove the unused `import { statSync, type Stats }` entries (keep `readdirSync`, `statSync` only if still needed for `directoryExists`)
- The `directoryExists` function uses `statSync` directly — keep that import

**Step 6: Update Cursor discovery to import from shared**

In `src/providers/cursor/discovery.ts`:
- Remove the local `normalizeWorkspacePath`, `stripTrailingSeparators`, `escapeForRegExp`, `tryStatSync`, `dedupePaths` functions
- Add import: `import { normalizeWorkspacePath, tryStatSync, dedupePaths } from "@/providers/shared/discovery-utils";`
- `stripTrailingSeparators` and `escapeForRegExp` are only used via `normalizeWorkspacePath`, so they don't need direct import

**Step 7: Run full test suite**

Run: `npm run check`
Expected: All tests pass, no lint errors

**Step 8: Commit**

```bash
git add src/providers/shared/discovery-utils.ts tests/shared-discovery-utils.test.ts src/providers/claude-code/discovery.ts src/providers/cursor/discovery.ts
git commit -m "refactor: extract shared discovery utilities from both providers"
```

---

### Task 2: Create shared provider utilities

Extract `arraysEqual`, `mergeAgents`, `pruneStaleEntries`, and `isAgentPayload` from both providers into a shared module.

**Files:**
- Create: `src/providers/shared/provider-utils.ts`
- Create: `tests/shared-provider-utils.test.ts`
- Modify: `src/providers/claude-code/provider.ts` (remove `arraysEqual`, `isTranscriptSourceResult`)
- Modify: `src/providers/cursor/provider.ts` (remove `arraysEqual`, `isTranscriptSourceResult`)
- Modify: `src/providers/claude-code/transcripts.ts` (remove `mergeAgents`, `pruneStaleEntries`)
- Modify: `src/providers/cursor/transcripts.ts` (remove `mergeAgents`, `pruneStaleEntries`)

**Step 1: Write the failing tests**

```typescript
// tests/shared-provider-utils.test.ts
import { describe, expect, it } from "vitest";
import {
  arraysEqual,
  mergeAgents,
  pruneStaleCache,
  isAgentPayload,
} from "@/providers/shared/provider-utils";
import type { CanonicalAgentSnapshot } from "@/core/model";

describe("shared provider utils", () => {
  it("arraysEqual returns true for identical arrays", () => {
    expect(arraysEqual(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("arraysEqual returns false for different arrays", () => {
    expect(arraysEqual(["a"], ["b"])).toBe(false);
    expect(arraysEqual(["a"], ["a", "b"])).toBe(false);
  });

  it("mergeAgents inserts new and updates existing by updatedAt", () => {
    const orderedIds: string[] = [];
    const latestById = new Map<string, CanonicalAgentSnapshot>();
    const agent1 = { id: "a1", updatedAt: 100 } as CanonicalAgentSnapshot;
    const agent1newer = { id: "a1", updatedAt: 200 } as CanonicalAgentSnapshot;
    const agent2 = { id: "a2", updatedAt: 150 } as CanonicalAgentSnapshot;

    mergeAgents([agent1], orderedIds, latestById);
    expect(orderedIds).toEqual(["a1"]);
    expect(latestById.get("a1")).toBe(agent1);

    mergeAgents([agent1newer, agent2], orderedIds, latestById);
    expect(orderedIds).toEqual(["a1", "a2"]);
    expect(latestById.get("a1")).toBe(agent1newer);
    expect(latestById.get("a2")).toBe(agent2);
  });

  it("pruneStaleCache removes entries not in current paths", () => {
    const cache = new Map<string, unknown>([
      ["/a", {}],
      ["/b", {}],
      ["/c", {}],
    ]);
    pruneStaleCache(cache, ["/a", "/c"]);
    expect([...cache.keys()]).toEqual(["/a", "/c"]);
  });

  it("pruneStaleCache skips when cache size <= paths length", () => {
    const cache = new Map<string, unknown>([
      ["/a", {}],
    ]);
    pruneStaleCache(cache, ["/a", "/b"]);
    expect(cache.size).toBe(1);
  });

  it("isAgentPayload validates object with agents array", () => {
    expect(isAgentPayload({ agents: [], connected: true })).toBe(true);
    expect(isAgentPayload({ agents: "not array" })).toBe(false);
    expect(isAgentPayload(null)).toBe(false);
    expect(isAgentPayload("string")).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/shared-provider-utils.test.ts`
Expected: FAIL — module does not exist

**Step 3: Write the implementation**

```typescript
// src/providers/shared/provider-utils.ts
import type { CanonicalAgentSnapshot } from "@/core/model";

export function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
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

export function mergeAgents(
  agents: CanonicalAgentSnapshot[],
  orderedIds: string[],
  latestById: Map<string, CanonicalAgentSnapshot>,
): void {
  for (const agent of agents) {
    const existing = latestById.get(agent.id);
    if (!existing) {
      latestById.set(agent.id, agent);
      orderedIds.push(agent.id);
    } else if (agent.updatedAt > existing.updatedAt) {
      latestById.set(agent.id, agent);
    }
  }
}

export function pruneStaleCache(
  cache: Map<string, unknown>,
  currentPaths: readonly string[],
): void {
  if (cache.size <= currentPaths.length) {
    return;
  }
  const current = new Set(currentPaths);
  for (const key of cache.keys()) {
    if (!current.has(key)) {
      cache.delete(key);
    }
  }
}

export function isAgentPayload(value: unknown): value is { agents: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "agents" in value &&
    Array.isArray((value as { agents: unknown }).agents)
  );
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/shared-provider-utils.test.ts`
Expected: PASS

**Step 5: Update all consumers**

In `src/providers/claude-code/provider.ts`:
- Remove local `arraysEqual` (lines 139-149) and `isTranscriptSourceResult` (lines 133-137)
- Add import: `import { arraysEqual, isAgentPayload } from "@/providers/shared/provider-utils";`
- Replace `isTranscriptSourceResult(payload)` with `isAgentPayload(payload)` — then cast: `(payload as { agents: CanonicalAgentSnapshot[] }).agents`

In `src/providers/cursor/provider.ts`:
- Remove local `arraysEqual` (lines 133-143) and `isTranscriptSourceResult` (lines 127-131)
- Same import and replacement

In `src/providers/claude-code/transcripts.ts`:
- Remove local `mergeAgents` (lines 451-465) and `pruneStaleEntries` (lines 467-480)
- Add import: `import { mergeAgents, pruneStaleCache } from "@/providers/shared/provider-utils";`
- Replace `pruneStaleEntries(fileCache, sourcePaths)` with `pruneStaleCache(fileCache, sourcePaths)`

In `src/providers/cursor/transcripts.ts`:
- Remove local `mergeAgents` (lines 408-422) and `pruneStaleEntries` (lines 424-437)
- Same import and replacement

**Step 6: Run full test suite**

Run: `npm run check`
Expected: All tests pass, no lint errors

**Step 7: Commit**

```bash
git add src/providers/shared/provider-utils.ts tests/shared-provider-utils.test.ts src/providers/claude-code/provider.ts src/providers/cursor/provider.ts src/providers/claude-code/transcripts.ts src/providers/cursor/transcripts.ts
git commit -m "refactor: extract shared provider utilities (arraysEqual, mergeAgents, pruneStaleCache, isAgentPayload)"
```

---

### Task 3: Create shared barrel and add `formatLineWarning` to Claude Code transcripts

**Files:**
- Create: `src/providers/shared/index.ts`
- Modify: `src/providers/claude-code/transcripts.ts` (use `formatLineWarning` from shared)
- Modify: `src/providers/cursor/transcripts.ts` (use `formatLineWarning` from shared, remove local)

**Step 1: Create barrel**

```typescript
// src/providers/shared/index.ts
export {
  normalizeWorkspacePath,
  stripTrailingSeparators,
  escapeForRegExp,
  tryStatSync,
  dedupePaths,
  formatLineWarning,
} from "./discovery-utils";
export {
  arraysEqual,
  mergeAgents,
  pruneStaleCache,
  isAgentPayload,
} from "./provider-utils";
```

**Step 2: Update Claude Code transcripts**

In `src/providers/claude-code/transcripts.ts`:
- Add import: `import { formatLineWarning } from "@/providers/shared/discovery-utils";`
- Replace the inline warning at line 262:
  - From: `warnings.push(\`${sourcePath}:${i + 1} Invalid JSON line.\`);`
  - To: `warnings.push(formatLineWarning(sourcePath, i + 1, "Invalid JSON line."));`

**Step 3: Update Cursor transcripts**

In `src/providers/cursor/transcripts.ts`:
- Remove local `formatLineWarning` function (lines 478-480)
- Add import: `import { formatLineWarning } from "@/providers/shared/discovery-utils";`

**Step 4: Run full test suite**

Run: `npm run check`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/providers/shared/index.ts src/providers/claude-code/transcripts.ts src/providers/cursor/transcripts.ts
git commit -m "refactor: use shared formatLineWarning, create shared barrel"
```

---

### Task 4: Extract `groupByKey` helper for composite provider

Eliminate the duplicated manual groupBy pattern in `composite.ts`.

**Files:**
- Modify: `src/providers/shared/provider-utils.ts` (add `groupByKey`)
- Modify: `src/providers/shared/index.ts` (re-export)
- Modify: `tests/shared-provider-utils.test.ts` (add tests)
- Modify: `src/core/composite.ts`

**Step 1: Write failing test**

Add to `tests/shared-provider-utils.test.ts`:

```typescript
it("groupByKey groups items by key function", () => {
  const items = [
    { name: "a", group: "x" },
    { name: "b", group: "y" },
    { name: "c", group: "x" },
  ];
  const result = groupByKey(items, (i) => i.group);
  expect(result.get("x")).toEqual([
    { name: "a", group: "x" },
    { name: "c", group: "x" },
  ]);
  expect(result.get("y")).toEqual([{ name: "b", group: "y" }]);
});

it("groupByKey returns empty map for empty input", () => {
  const result = groupByKey([], () => "key");
  expect(result.size).toBe(0);
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/shared-provider-utils.test.ts`
Expected: FAIL — `groupByKey` not exported

**Step 3: Implement groupByKey**

Add to `src/providers/shared/provider-utils.ts`:

```typescript
export function groupByKey<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key) ?? [];
    group.push(item);
    map.set(key, group);
  }
  return map;
}
```

Add re-export in `src/providers/shared/index.ts`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/shared-provider-utils.test.ts`
Expected: PASS

**Step 5: Update composite.ts**

In `src/core/composite.ts`:

Replace the manual groupBy in `read()` (lines 53-59):
```typescript
// Before:
const inputsByProvider = new Map<string, DiscoveryInput[]>();
for (const input of inputs) {
  const providerId = (input.metadata?.providerId as string) ?? "";
  const group = inputsByProvider.get(providerId) ?? [];
  group.push(input);
  inputsByProvider.set(providerId, group);
}

// After:
const inputsByProvider = groupByKey(inputs, (input) => (input.metadata?.providerId as string) ?? "");
```

Replace the manual groupBy in `normalize()` (lines 96-101):
```typescript
// Before:
const recordsByProvider = new Map<string, TranscriptReadResult["records"]>();
for (const record of readResult.records) {
  const group = recordsByProvider.get(record.provider) ?? [];
  group.push(record);
  recordsByProvider.set(record.provider, group);
}

// After:
const recordsByProvider = groupByKey(readResult.records, (record) => record.provider);
```

Add import: `import { groupByKey } from "@/providers/shared/provider-utils";`
Remove unused import: `CanonicalAgentSnapshot` (line 8) — verify it's unused after edits.

**Step 6: Run full test suite**

Run: `npm run check`
Expected: All tests pass

**Step 7: Commit**

```bash
git add src/providers/shared/provider-utils.ts src/providers/shared/index.ts tests/shared-provider-utils.test.ts src/core/composite.ts
git commit -m "refactor: extract groupByKey, eliminate manual groupBy in composite provider"
```

---

### Task 5: Flatten discovery nesting with `collectJsonlFiles` helper

Extract the nested `for > try > for > if` pattern in both discovery files into a shared flat helper.

**Files:**
- Modify: `src/providers/shared/discovery-utils.ts` (add `collectJsonlFiles`)
- Modify: `tests/shared-discovery-utils.test.ts` (add tests)
- Modify: `src/providers/claude-code/discovery.ts` (use shared helper)
- Modify: `src/providers/cursor/discovery.ts` (use shared helper)

**Step 1: Write failing test**

Add to `tests/shared-discovery-utils.test.ts`:

```typescript
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

// ... existing tests ...

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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/shared-discovery-utils.test.ts`
Expected: FAIL — `collectJsonlFiles` not exported

**Step 3: Implement**

Add to `src/providers/shared/discovery-utils.ts`:

```typescript
import { readdirSync } from "node:fs";

export interface DiscoveredFile {
  path: string;
  mtimeMs: number;
}

export interface CollectFilesOptions {
  recursive: boolean;
  extension?: string;
}

export function collectJsonlFiles(
  directories: readonly string[],
  options: CollectFilesOptions = { recursive: false },
): DiscoveredFile[] {
  const extension = options.extension ?? ".jsonl";
  const collected: DiscoveredFile[] = [];

  for (const directory of directories) {
    const entries = readDirectoryEntries(directory, options.recursive);
    for (const relative of entries) {
      if (!relative.endsWith(extension)) {
        continue;
      }
      const absolute = path.join(directory, relative);
      const stats = tryStatSync(absolute);
      if (stats?.isFile()) {
        collected.push({ path: absolute, mtimeMs: Math.round(stats.mtimeMs) });
      }
    }
  }

  return collected;
}

function readDirectoryEntries(directory: string, recursive: boolean): string[] {
  try {
    return readdirSync(directory, { recursive, encoding: "utf-8" });
  } catch {
    return [];
  }
}
```

Update `src/providers/shared/index.ts` to re-export `collectJsonlFiles`, `DiscoveredFile`, `CollectFilesOptions`.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/shared-discovery-utils.test.ts`
Expected: PASS

**Step 5: Update Claude Code discovery**

In `src/providers/claude-code/discovery.ts`:
- Import `collectJsonlFiles` and `DiscoveredFile` from `@/providers/shared/discovery-utils`
- Remove local `DiscoveredSessionFile` interface (replaced by `DiscoveredFile`)
- Replace `collectSessionPaths` function (lines 89-109) with:

```typescript
function collectSessionPaths(inputDirectories: readonly string[]): DiscoveredFile[] {
  return collectJsonlFiles(inputDirectories, { recursive: false });
}
```

- Replace `listSessionFileNames` function body (lines 41-57) with:

```typescript
export function listSessionFileNames(options: SessionDiscoveryOptions): string[] {
  const directories = resolveSessionDirectories(options);
  return dedupePaths(
    collectJsonlFiles(directories, { recursive: false }).map((f) => f.path),
  ).sort();
}
```

- Remove unused `readdirSync` import if no longer needed (check `directoryExists` still uses `statSync`)

**Step 6: Update Cursor discovery**

In `src/providers/cursor/discovery.ts`:
- Import `collectJsonlFiles`, `DiscoveredFile`, `tryStatSync` from `@/providers/shared/discovery-utils`
- Remove local `DiscoveredTranscriptFile` interface (replaced by `DiscoveredFile`)
- Remove local `collectJsonlFilesRecursive` function (lines 93-108)
- Remove local `tryStatSync` function (lines 110-116) — already extracted in Task 1
- Replace `collectTranscriptPaths` function (lines 62-91):

```typescript
function collectTranscriptPaths(inputPaths: readonly string[]): DiscoveredFile[] {
  const collected: DiscoveredFile[] = [];

  for (const inputPath of inputPaths) {
    const normalizedPath = inputPath.trim();
    if (normalizedPath.length === 0) {
      continue;
    }

    const stats = tryStatSync(normalizedPath);
    if (!stats) {
      continue;
    }

    if (stats.isFile() && normalizedPath.endsWith(".jsonl")) {
      collected.push({ path: normalizedPath, mtimeMs: Math.round(stats.mtimeMs) });
      continue;
    }

    if (stats.isDirectory()) {
      collected.push(...collectJsonlFiles([normalizedPath], { recursive: true }));
    }
  }

  return collected;
}
```

Note: Cursor's `collectTranscriptPaths` handles both files and directories, so it can't be fully replaced — only the recursive directory scanning part delegates to shared.

- Replace `listTranscriptFileNames` function body (lines 118-134) with:

```typescript
export function listTranscriptFileNames(options: TranscriptDiscoveryOptions): string[] {
  const directories = resolveTranscriptDirectories(options);
  return dedupePaths(
    collectJsonlFiles(directories, { recursive: true }).map((f) => f.path),
  ).sort();
}
```

- Remove `readdirSync` import if no longer used

**Step 7: Run full test suite**

Run: `npm run check`
Expected: All tests pass

**Step 8: Commit**

```bash
git add src/providers/shared/ tests/shared-discovery-utils.test.ts src/providers/claude-code/discovery.ts src/providers/cursor/discovery.ts
git commit -m "refactor: extract collectJsonlFiles, flatten discovery nesting"
```

---

### Task 6: Split `readSnapshot` into composable steps

Break the 110-line master function in both transcript files into focused helpers.

**Files:**
- Modify: `src/providers/claude-code/transcripts.ts`
- Modify: `src/providers/cursor/transcripts.ts`

**Step 1: Extract `statSourceFile` helper in Claude Code transcripts**

At the bottom of `src/providers/claude-code/transcripts.ts`, add:

```typescript
interface FileStatResult {
  fileUpdatedAt: number;
  fileSizeBytes: number;
}

function statSourceFile(sourcePath: string, fallbackTimestamp: number): Promise<FileStatResult> {
  return stat(sourcePath)
    .then((stats) => ({
      fileUpdatedAt: Math.round(stats.mtimeMs),
      fileSizeBytes: stats.size,
    }))
    .catch(() => ({
      fileUpdatedAt: fallbackTimestamp,
      fileSizeBytes: 0,
    }));
}
```

**Step 2: Extract `readSourceFile` helper**

```typescript
function readSourceFile(sourcePath: string): Promise<string | null> {
  return readFile(sourcePath, "utf8").catch(() => null);
}
```

**Step 3: Extract `resolveParseStrategy` helper**

```typescript
interface ParseStrategy {
  state: SessionParseState;
  startLine: number;
}

function resolveParseStrategy(
  cached: SessionFileCache | undefined,
  fileSizeBytes: number,
  lineCount: number,
): ParseStrategy {
  if (cached && fileSizeBytes >= cached.sizeBytes && lineCount >= cached.lineCount) {
    return { state: cloneParseState(cached.state), startLine: cached.lineCount };
  }
  return { state: createInitialParseState(), startLine: 0 };
}
```

**Step 4: Extract `processSourceFile` — the core per-file logic**

```typescript
interface ProcessFileResult {
  agents: CanonicalAgentSnapshot[];
  success: boolean;
  warnings: string[];
}

async function processSourceFile(
  sourcePath: string,
  now: number,
  fileCache: Map<string, SessionFileCache>,
): Promise<ProcessFileResult> {
  const warnings: string[] = [];
  const { fileUpdatedAt, fileSizeBytes } = await statSourceFile(sourcePath, now);

  const cached = fileCache.get(sourcePath);

  // Cache hit: mtime and size unchanged
  if (cached && cached.mtimeMs === fileUpdatedAt && cached.sizeBytes === fileSizeBytes) {
    return {
      agents: resolveAgentsFromState(cached.state, cached.fileUpdatedAt, now),
      success: true,
      warnings,
    };
  }

  const contentChanged = !cached || fileSizeBytes !== cached.sizeBytes;
  const effectiveUpdatedAt = contentChanged ? fileUpdatedAt : cached.fileUpdatedAt;

  // Mtime changed but size identical: update mtime, reuse state
  if (cached && !contentChanged) {
    fileCache.set(sourcePath, { ...cached, mtimeMs: fileUpdatedAt });
    return {
      agents: resolveAgentsFromState(cached.state, effectiveUpdatedAt, now),
      success: true,
      warnings,
    };
  }

  // Content changed: read and parse
  const contents = await readSourceFile(sourcePath);
  if (contents === null) {
    warnings.push(`Failed to read session path: ${sourcePath}`);
    return { agents: [], success: false, warnings };
  }

  const lines = contents.split(/\r?\n/);
  const { state, startLine } = resolveParseStrategy(cached, fileSizeBytes, lines.length);

  accumulateLines(state, lines, startLine, sourcePath, warnings);

  fileCache.set(sourcePath, {
    mtimeMs: fileUpdatedAt,
    sizeBytes: fileSizeBytes,
    lineCount: lines.length,
    state: cloneParseState(state),
    fileUpdatedAt: effectiveUpdatedAt,
  });

  return {
    agents: resolveAgentsFromState(state, effectiveUpdatedAt, now),
    success: true,
    warnings,
  };
}
```

**Step 5: Simplify `readSnapshot` to use `processSourceFile`**

Replace the current `readSnapshot` loop body (lines 120-190) with:

```typescript
async function readSnapshot(now: number = Date.now()): Promise<ClaudeCodeTranscriptSourceResult> {
  if (!connected) {
    return { agents: [], connected: false, sourceLabel, warnings: ["Claude Code transcript source is disconnected."] };
  }
  if (sourcePaths.length === 0) {
    return { agents: [], connected: false, sourceLabel, warnings: ["No session paths configured."] };
  }

  const orderedIds: string[] = [];
  const latestById = new Map<string, CanonicalAgentSnapshot>();
  const allWarnings: string[] = [];
  let hasReadError = false;
  let successfulReads = 0;

  for (const sourcePath of sourcePaths) {
    const result = await processSourceFile(sourcePath, now, fileCache);
    allWarnings.push(...result.warnings);
    if (result.success) {
      successfulReads += 1;
    } else {
      hasReadError = true;
    }
    mergeAgents(result.agents, orderedIds, latestById);
  }

  pruneStaleCache(fileCache, sourcePaths);

  const agents = orderedIds
    .map((id) => latestById.get(id))
    .filter((agent): agent is CanonicalAgentSnapshot => agent !== undefined);

  return { agents, connected: successfulReads > 0 || !hasReadError, sourceLabel, warnings: allWarnings };
}
```

**Step 6: Apply same pattern to Cursor transcripts**

Apply the identical refactoring pattern to `src/providers/cursor/transcripts.ts`. The helpers will be local to each file since the parse state types differ (SessionParseState vs TranscriptParseState). The key differences:
- Cursor's `statSourceFile` is identical
- Cursor's `readSourceFile` is identical
- Cursor's `resolveParseStrategy` uses `TranscriptParseState` and its own `cloneParseState`
- Cursor's `processSourceFile` calls `resolveAgentsFromState(state, sourcePath, effectiveUpdatedAt, now)` (takes `sourcePath` arg)
- Cursor's cache check only uses `cached.mtimeMs === fileUpdatedAt` (no size in first check)

**Step 7: Run full test suite**

Run: `npm run check`
Expected: All tests pass — this is a pure refactor, no behavior changes

**Step 8: Commit**

```bash
git add src/providers/claude-code/transcripts.ts src/providers/cursor/transcripts.ts
git commit -m "refactor: break readSnapshot into composable steps (processSourceFile, statSourceFile, resolveParseStrategy)"
```

---

### Task 7: Split `accumulateRecord` by record type in Claude Code transcripts

**Files:**
- Modify: `src/providers/claude-code/transcripts.ts`

**Step 1: Extract `extractTextContent` helper**

Replace the nested content extraction (current lines 296-307) with a standalone function:

```typescript
function extractTextContent(
  content: string | Array<{ type: string; text?: string }>,
): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  const joined = content
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text ?? "")
    .join(" ");
  return joined.length > 0 ? joined : undefined;
}
```

**Step 2: Split `accumulateRecord` into type-specific handlers**

Replace the current `accumulateRecord` function with:

```typescript
function accumulateRecord(state: SessionParseState, record: ClaudeCodeSessionRecord): void {
  accumulateBaseFields(state, record);

  if (record.type === "user") {
    accumulateUserRecord(state, record);
    return;
  }
  if (record.type === "assistant") {
    accumulateAssistantRecord(state, record);
    return;
  }
  if (record.type === "progress") {
    accumulateProgressRecord(state, record);
    return;
  }
  state.latestRecordType = "system";
}

function accumulateBaseFields(state: SessionParseState, record: ClaudeCodeSessionRecord): void {
  if (!state.sessionId) {
    state.sessionId = record.sessionId;
  }
  state.gitBranch = record.gitBranch;
  state.cwd = record.cwd;
  state.version = record.version;

  const timestamp = new Date(record.timestamp).getTime();
  if (!state.firstTimestamp || timestamp < state.firstTimestamp) {
    state.firstTimestamp = timestamp;
  }
  if (!state.latestTimestamp || timestamp > state.latestTimestamp) {
    state.latestTimestamp = timestamp;
  }
}

function accumulateUserRecord(state: SessionParseState, record: ClaudeCodeSessionRecord): void {
  state.messageCount += 1;
  state.latestRecordType = "user";
  const extracted = extractTextContent(record.message.content);
  if (extracted) {
    state.latestUserContent = extracted;
  }
  if ("permissionMode" in record && typeof record.permissionMode === "string") {
    state.permissionMode = record.permissionMode;
  }
}

function accumulateAssistantRecord(state: SessionParseState, record: ClaudeCodeSessionRecord): void {
  state.messageCount += 1;
  state.latestRecordType = "assistant";
  if (record.message.model) {
    state.model = record.message.model;
  }
  const toolUseEntries = record.message.content.filter((entry) => entry.type === "tool_use");
  state.lastAssistantHadToolUse = toolUseEntries.length > 0;
  state.toolCallCount += toolUseEntries.length;
}

function accumulateProgressRecord(state: SessionParseState, record: ClaudeCodeSessionRecord): void {
  state.latestRecordType = "progress";
  const agentProgress = parseAgentProgressData(record.data);
  if (agentProgress) {
    const timestamp = new Date(record.timestamp).getTime();
    accumulateSubagent(state, agentProgress.agentId, agentProgress.prompt, timestamp);
  }
}
```

Note: The exact parameter types for `accumulateUserRecord`, `accumulateAssistantRecord`, `accumulateProgressRecord` depend on the discriminated union. If the `record` is `ClaudeCodeSessionRecord` (union type), you may need to narrow via `record.type` check already done in `accumulateRecord`. Alternatively, extract the specific union members:
- `accumulateUserRecord(state, record as UserRecord)` where `UserRecord` is the `type: "user"` variant

Check the Zod schema types in `schemas.ts` to get the exact discriminated type names.

**Step 2: Run full test suite**

Run: `npm run check`
Expected: All tests pass — pure refactor

**Step 3: Commit**

```bash
git add src/providers/claude-code/transcripts.ts
git commit -m "refactor: split accumulateRecord into type-specific handlers, extract extractTextContent"
```

---

### Task 8: Flatten composite watch nesting

**Files:**
- Modify: `src/core/composite.ts`

**Step 1: Extract `subscribeAll` helper**

Replace the inline `subscribe` function body (currently nested `for > try > if`) with:

```typescript
function subscribeAll(
  watchProviders: TranscriptProvider[],
  watchPath: string,
  onEvent: () => void,
  onError: (error: Error) => void,
): { close(): void }[] {
  return watchProviders.flatMap((provider) => {
    try {
      const sub = provider.watch?.subscribe(watchPath, onEvent, onError);
      return sub ? [sub] : [];
    } catch {
      return [];
    }
  });
}
```

**Step 2: Use in composite watch**

```typescript
const compositeWatch =
  watchProviders.length > 0
    ? {
        debounceMs: Math.min(...watchProviders.map((p) => p.watch?.debounceMs ?? 150)),
        subscribe(
          watchPath: string,
          onEvent: () => void,
          onError: (error: Error) => void,
        ): { close(): void } {
          const subs = subscribeAll(watchProviders, watchPath, onEvent, onError);
          return {
            close() {
              for (const sub of subs) {
                sub.close();
              }
            },
          };
        },
      }
    : undefined;
```

Move `subscribeAll` outside `createCompositeProvider` as a module-level function.

**Step 3: Clean up unused imports**

Remove `CanonicalAgentSnapshot` import if unused after Task 4 changes.

**Step 4: Run full test suite**

Run: `npm run check`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/core/composite.ts
git commit -m "refactor: extract subscribeAll, flatten composite watch nesting"
```

---

### Task 9: Trim root API surface

Reduce `src/index.ts` exports to consumer-facing API only. Internal utilities remain accessible via subpath imports.

**Files:**
- Modify: `src/index.ts`
- Verify: `tests/` — ensure no test imports from `src/index.ts` that would break

**Step 1: Check what tests import from root**

Search for `from "@agentprobe/core"` or `from "@/"` patterns in tests that reference removed exports. Most tests import directly from provider modules (`@/providers/claude-code/...`), not from the root.

**Step 2: Trim exports**

Replace the provider export blocks (lines 63-93) with only consumer-facing items:

```typescript
export {
  cursor,
  type CursorOptions,
} from "./providers/cursor";
export {
  claudeCode,
  type ClaudeCodeOptions,
} from "./providers/claude-code";
```

The full set of exports (discovery functions, watch factories, transcript sources, constants) remains accessible via:
- `@agentprobe/core/providers/cursor`
- `@agentprobe/core/providers/claude-code`

Also evaluate removing from the core exports block:
- `toError` — internal error utility
- `WATCH_RUNTIME_ERROR_CODES`, `WATCH_RUNTIME_ERROR_MESSAGES` — implementation detail constants

Keep: `createCompositeProvider` (advanced users need this).

**Step 3: Run full test suite**

Run: `npm run check`
Expected: All tests pass. If any test imports a removed export from root, update that test to import from the subpath instead.

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "refactor: trim root API surface to consumer-facing exports only"
```

---

### Task 10: Add `metadata.providerId` to Cursor discovery inputs

Align Cursor provider with Claude Code provider pattern.

**Files:**
- Modify: `src/providers/cursor/provider.ts`
- Modify: `tests/cursor-provider.test.ts` (if testing input metadata)

**Step 1: Update Cursor discover function**

In `src/providers/cursor/provider.ts`, update the `discover` function's input mapping (line 45-48):

```typescript
const inputs: DiscoveryInput[] = sourcePaths.map((sourcePath) => ({
  uri: sourcePath,
  kind: "file",
  metadata: { providerId: PROVIDER_KINDS.cursor },
}));
```

**Step 2: Run full test suite**

Run: `npm run check`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/providers/cursor/provider.ts tests/cursor-provider.test.ts
git commit -m "fix: add metadata.providerId to Cursor discovery inputs for composite routing consistency"
```

---

### Task 11: Final verification and cleanup

**Step 1: Run full check**

Run: `npm run check`
Expected: All tests pass, zero lint errors/warnings

**Step 2: Verify no unused imports or dead code**

Run: `npx biome check . --max-diagnostics=100`

**Step 3: Verify file structure**

```
src/providers/shared/
  ├── discovery-utils.ts
  ├── provider-utils.ts
  └── index.ts
```

**Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: final cleanup after provider refactor"
```

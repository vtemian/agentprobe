# OpenCode Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an OpenCode transcript provider that reads session data from OpenCode's SQLite database, enabling real-time observation of OpenCode AI coding sessions.

**Architecture:** Unlike the existing JSONL-based providers (Cursor, Claude Code, Codex), the OpenCode provider reads directly from a SQLite database at `~/.local/share/opencode/opencode.db`. Discovery queries the `project` table to match workspace paths, read queries the `session`/`message`/`part` tables, and watch polls `PRAGMA data_version` to detect changes. The provider uses `better-sqlite3` for synchronous read-only access.

**Tech Stack:** TypeScript, better-sqlite3, Zod, Vitest.

---

## Task 1: Install better-sqlite3 dependency

**Files:**
- Modify: `package.json`

**Step 1: Install better-sqlite3 and its type definitions**

Run:
```bash
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

**Step 2: Verify the install succeeded**

Run: `npm run check`
Expected: All 185 tests pass, no type errors

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add better-sqlite3 dependency for OpenCode provider"
```

---

## Task 2: Add constants and register provider kind

**Files:**
- Create: `src/providers/opencode/constants.ts`
- Modify: `src/core/providers.ts:5-9`

**Step 1: Create constants file**

Create `src/providers/opencode/constants.ts`:

```typescript
import { homedir } from "node:os";
import path from "node:path";

export const OPENCODE_SOURCE_KIND = "opencode";
export const OPENCODE_RUNNING_WINDOW_MS = 5_000;
export const OPENCODE_IDLE_WINDOW_MS = 60_000;
export const OPENCODE_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const OPENCODE_WATCH_POLL_INTERVAL_MS = 2_000;
export const OPENCODE_WATCH_DEBOUNCE_MS = 100;
export const OPENCODE_AGENT_NAME_PREFIX_LENGTH = 6;
export const OPENCODE_DB_PATH_DEFAULT = path.join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "opencode.db",
);
```

**Step 2: Add `openCode` to PROVIDER_KINDS**

In `src/core/providers.ts`, add `openCode: "opencode"` to the `PROVIDER_KINDS` object:

```typescript
export const PROVIDER_KINDS = {
  cursor: "cursor",
  codex: "codex",
  claudeCode: "claude-code",
  openCode: "opencode",
} as const;
```

**Step 3: Run quality gate**

Run: `npm run check`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/providers/opencode/constants.ts src/core/providers.ts
git commit -m "feat: add OpenCode provider constants and register provider kind"
```

---

## Task 3: Schema validation for SQLite JSON data

**Files:**
- Create: `src/providers/opencode/schemas.ts`
- Create: `tests/opencode-schemas.test.ts`

**Step 1: Write failing tests for schema parsing**

Create `tests/opencode-schemas.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  parseMessageData,
  parsePartData,
  parseSessionRow,
} from "@/providers/opencode/schemas";

describe("opencode schemas", () => {
  describe("parseSessionRow", () => {
    it("parses a valid session row", () => {
      const row = {
        id: "ses_abc123",
        project_id: "proj_123",
        parent_id: null,
        directory: "/Users/test/project",
        title: "Working on feature",
        version: "1.2.24",
        time_created: 1773334158609,
        time_updated: 1773334839058,
      };
      const result = parseSessionRow(row);
      expect(result).not.toBeNull();
      expect(result!.id).toBe("ses_abc123");
      expect(result!.parentId).toBeNull();
      expect(result!.directory).toBe("/Users/test/project");
      expect(result!.title).toBe("Working on feature");
      expect(result!.timeCreated).toBe(1773334158609);
      expect(result!.timeUpdated).toBe(1773334839058);
    });

    it("parses a subagent session with parent_id", () => {
      const row = {
        id: "ses_child",
        project_id: "proj_123",
        parent_id: "ses_parent",
        directory: "/Users/test/project",
        title: "Bootstrap brainstorm (@bootstrapper subagent)",
        version: "1.2.24",
        time_created: 1773334158609,
        time_updated: 1773334839058,
      };
      const result = parseSessionRow(row);
      expect(result).not.toBeNull();
      expect(result!.parentId).toBe("ses_parent");
    });

    it("returns null for invalid row", () => {
      expect(parseSessionRow(null)).toBeNull();
      expect(parseSessionRow({})).toBeNull();
      expect(parseSessionRow({ id: 123 })).toBeNull();
    });
  });

  describe("parseMessageData", () => {
    it("parses a user message data blob", () => {
      const data = {
        role: "user",
        time: { created: 1773334158640 },
        agent: "commander",
        model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
        summary: { title: "Fix the bug" },
      };
      const result = parseMessageData(data);
      expect(result).not.toBeNull();
      expect(result!.role).toBe("user");
      expect(result!.agent).toBe("commander");
      expect(result!.summary?.title).toBe("Fix the bug");
    });

    it("parses an assistant message data blob", () => {
      const data = {
        role: "assistant",
        time: { created: 1773334158640, completed: 1773334168000 },
        agent: "commander",
        modelID: "claude-opus-4-6",
        providerID: "anthropic",
        tokens: { input: 100, output: 500, reasoning: 0, cache: { read: 5000, write: 200 } },
        cost: 0.05,
        finish: "stop",
      };
      const result = parseMessageData(data);
      expect(result).not.toBeNull();
      expect(result!.role).toBe("assistant");
      expect(result!.tokens?.input).toBe(100);
      expect(result!.cost).toBe(0.05);
    });

    it("returns null for invalid data", () => {
      expect(parseMessageData(null)).toBeNull();
      expect(parseMessageData({})).toBeNull();
      expect(parseMessageData({ role: "unknown" })).toBeNull();
    });
  });

  describe("parsePartData", () => {
    it("parses a tool part", () => {
      const data = {
        type: "tool",
        callID: "toolu_abc",
        tool: "read",
        state: { status: "completed" },
      };
      const result = parsePartData(data);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("tool");
    });

    it("parses a text part", () => {
      const data = {
        type: "text",
        text: "Hello world",
      };
      const result = parsePartData(data);
      expect(result).not.toBeNull();
      expect(result!.type).toBe("text");
    });

    it("parses step-start and step-finish parts", () => {
      expect(parsePartData({ type: "step-start" })).not.toBeNull();
      expect(parsePartData({ type: "step-finish" })).not.toBeNull();
    });

    it("returns null for invalid data", () => {
      expect(parsePartData(null)).toBeNull();
      expect(parsePartData({})).toBeNull();
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/opencode-schemas.test.ts`
Expected: FAIL — module `@/providers/opencode/schemas` does not exist

**Step 3: Implement schemas**

Create `src/providers/opencode/schemas.ts`:

```typescript
import { z } from "zod";

const sessionRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  parent_id: z.string().nullable(),
  directory: z.string(),
  title: z.string(),
  version: z.string(),
  time_created: z.number(),
  time_updated: z.number(),
});

export interface SessionRow {
  id: string;
  projectId: string;
  parentId: string | null;
  directory: string;
  title: string;
  version: string;
  timeCreated: number;
  timeUpdated: number;
}

export function parseSessionRow(value: unknown): SessionRow | null {
  const result = sessionRowSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  const row = result.data;
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    directory: row.directory,
    title: row.title,
    version: row.version,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  };
}

const timeSchema = z.object({
  created: z.number(),
  completed: z.number().optional(),
});

const modelRefSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
});

const tokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number().optional(),
  cache: z
    .object({
      read: z.number(),
      write: z.number(),
    })
    .optional(),
});

const summarySchema = z
  .object({
    title: z.string().optional(),
    diffs: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

const messageDataSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    time: timeSchema,
    agent: z.string().optional(),
    model: modelRefSchema.optional(),
    summary: summarySchema.optional(),
  }),
  z.object({
    role: z.literal("assistant"),
    time: timeSchema,
    agent: z.string().optional(),
    modelID: z.string().optional(),
    providerID: z.string().optional(),
    tokens: tokensSchema.optional(),
    cost: z.number().optional(),
    finish: z.string().optional(),
  }),
]);

export type MessageData = z.infer<typeof messageDataSchema>;

export function parseMessageData(value: unknown): MessageData | null {
  if (typeof value !== "object" || value === null || !("role" in value)) {
    return null;
  }
  const result = messageDataSchema.safeParse(value);
  return result.success ? result.data : null;
}

const partDataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool"), callID: z.string().optional(), tool: z.string().optional(), state: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal("text"), text: z.string().optional() }),
  z.object({ type: z.literal("step-start") }).passthrough(),
  z.object({ type: z.literal("step-finish") }).passthrough(),
  z.object({ type: z.literal("reasoning") }).passthrough(),
  z.object({ type: z.literal("subtask") }).passthrough(),
  z.object({ type: z.literal("patch") }).passthrough(),
  z.object({ type: z.literal("compaction") }).passthrough(),
  z.object({ type: z.literal("file") }).passthrough(),
  z.object({ type: z.literal("agent") }).passthrough(),
  z.object({ type: z.literal("retry") }).passthrough(),
  z.object({ type: z.literal("snapshot") }).passthrough(),
]);

export type PartData = z.infer<typeof partDataSchema>;

export function parsePartData(value: unknown): PartData | null {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return null;
  }
  const result = partDataSchema.safeParse(value);
  return result.success ? result.data : null;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run check`
Expected: All tests pass including new schema tests

**Step 5: Commit**

```bash
git add src/providers/opencode/schemas.ts tests/opencode-schemas.test.ts
git commit -m "feat: add OpenCode schema validation for session, message, and part data"
```

---

## Task 4: Database access layer

**Files:**
- Create: `src/providers/opencode/database.ts`
- Create: `tests/opencode-database.test.ts`

**Step 1: Write failing tests for database queries**

Create `tests/opencode-database.test.ts`:

```typescript
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenCodeDatabase,
  type OpenCodeDatabase,
} from "@/providers/opencode/database";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES project(id)
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session(id)
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES message(id)
    );
  `);
  return db;
}

function seedProject(db: Database.Database, id: string, worktree: string): void {
  db.prepare("INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)").run(id, worktree, Date.now(), Date.now());
}

function seedSession(
  db: Database.Database,
  id: string,
  projectId: string,
  opts: { parentId?: string; title?: string; directory?: string; timeUpdated?: number } = {},
): void {
  db.prepare(
    "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    projectId,
    opts.parentId ?? null,
    "test-slug",
    opts.directory ?? "/test",
    opts.title ?? "Test session",
    "1.2.24",
    Date.now(),
    opts.timeUpdated ?? Date.now(),
  );
}

function seedMessage(
  db: Database.Database,
  id: string,
  sessionId: string,
  data: Record<string, unknown>,
): void {
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  ).run(id, sessionId, Date.now(), Date.now(), JSON.stringify(data));
}

function seedPart(
  db: Database.Database,
  id: string,
  messageId: string,
  sessionId: string,
  data: Record<string, unknown>,
): void {
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, messageId, sessionId, Date.now(), Date.now(), JSON.stringify(data));
}

describe("opencode database", () => {
  let rawDb: Database.Database;
  let ocDb: OpenCodeDatabase;

  beforeEach(() => {
    rawDb = createTestDb();
    ocDb = createOpenCodeDatabase(rawDb);
  });

  afterEach(() => {
    rawDb.close();
  });

  describe("findProjectIds", () => {
    it("returns project IDs matching workspace paths", () => {
      seedProject(rawDb, "p1", "/Users/test/projectA");
      seedProject(rawDb, "p2", "/Users/test/projectB");
      seedProject(rawDb, "p3", "/Users/other/projectC");

      const ids = ocDb.findProjectIds(["/Users/test/projectA"]);
      expect(ids).toEqual(["p1"]);
    });

    it("matches subdirectory workspace paths", () => {
      seedProject(rawDb, "p1", "/Users/test/projectA");

      const ids = ocDb.findProjectIds(["/Users/test"]);
      expect(ids).toEqual(["p1"]);
    });

    it("returns empty array when no projects match", () => {
      seedProject(rawDb, "p1", "/Users/test/projectA");

      const ids = ocDb.findProjectIds(["/other"]);
      expect(ids).toEqual([]);
    });
  });

  describe("findSessions", () => {
    it("returns sessions for given project IDs within time window", () => {
      seedProject(rawDb, "p1", "/test");
      seedSession(rawDb, "s1", "p1", { title: "Session 1", timeUpdated: Date.now() });
      seedSession(rawDb, "s2", "p1", { title: "Session 2", timeUpdated: Date.now() - 86400000 * 30 });

      const sessions = ocDb.findSessions(["p1"], Date.now() - 86400000 * 7);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).toBe("s1");
    });

    it("returns subagent sessions with parentId", () => {
      seedProject(rawDb, "p1", "/test");
      seedSession(rawDb, "s1", "p1");
      seedSession(rawDb, "s2", "p1", { parentId: "s1", title: "Subagent task" });

      const sessions = ocDb.findSessions(["p1"], 0);
      const sub = sessions.find((s) => s.id === "s2");
      expect(sub).toBeDefined();
      expect(sub!.parentId).toBe("s1");
    });
  });

  describe("getSessionStats", () => {
    it("returns message and tool call counts per session", () => {
      seedProject(rawDb, "p1", "/test");
      seedSession(rawDb, "s1", "p1");
      seedMessage(rawDb, "m1", "s1", { role: "user", time: { created: 1 }, agent: "commander" });
      seedMessage(rawDb, "m2", "s1", { role: "assistant", time: { created: 2 }, agent: "commander" });
      seedPart(rawDb, "pt1", "m2", "s1", { type: "tool", tool: "read" });
      seedPart(rawDb, "pt2", "m2", "s1", { type: "tool", tool: "write" });
      seedPart(rawDb, "pt3", "m2", "s1", { type: "text", text: "done" });

      const stats = ocDb.getSessionStats(["s1"]);
      expect(stats.get("s1")).toBeDefined();
      expect(stats.get("s1")!.messageCount).toBe(2);
      expect(stats.get("s1")!.toolCallCount).toBe(2);
    });
  });

  describe("getLatestUserSummary", () => {
    it("returns the title from the latest user message summary", () => {
      seedProject(rawDb, "p1", "/test");
      seedSession(rawDb, "s1", "p1");
      seedMessage(rawDb, "m1", "s1", { role: "user", time: { created: 1 }, summary: { title: "First task" } });
      seedMessage(rawDb, "m2", "s1", { role: "user", time: { created: 2 }, summary: { title: "Latest task" } });

      const summary = ocDb.getLatestUserSummary("s1");
      expect(summary).toBe("Latest task");
    });

    it("returns undefined when no user messages exist", () => {
      seedProject(rawDb, "p1", "/test");
      seedSession(rawDb, "s1", "p1");

      const summary = ocDb.getLatestUserSummary("s1");
      expect(summary).toBeUndefined();
    });
  });

  describe("getDataVersion", () => {
    it("returns a number", () => {
      const version = ocDb.getDataVersion();
      expect(typeof version).toBe("number");
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/opencode-database.test.ts`
Expected: FAIL — module does not exist

**Step 3: Implement database access layer**

Create `src/providers/opencode/database.ts`:

```typescript
import type Database from "better-sqlite3";
import { normalizeWorkspacePath } from "@/providers/shared/discovery";
import { type SessionRow, parseSessionRow } from "./schemas";

export interface SessionStats {
  messageCount: number;
  toolCallCount: number;
  latestAgent: string | undefined;
  latestModel: string | undefined;
}

export interface OpenCodeDatabase {
  findProjectIds(workspacePaths: string[]): string[];
  findSessions(projectIds: string[], updatedAfter: number): SessionRow[];
  getSessionStats(sessionIds: string[]): Map<string, SessionStats>;
  getLatestUserSummary(sessionId: string): string | undefined;
  getDataVersion(): number;
}

export function createOpenCodeDatabase(db: Database.Database): OpenCodeDatabase {
  function findProjectIds(workspacePaths: string[]): string[] {
    const normalizedPaths = workspacePaths
      .map(normalizeWorkspacePath)
      .filter((p) => p.length > 0);

    if (normalizedPaths.length === 0) {
      return [];
    }

    const rows = db
      .prepare("SELECT id, worktree FROM project")
      .all() as Array<{ id: string; worktree: string }>;

    return rows
      .filter((row) => {
        const normalized = normalizeWorkspacePath(row.worktree);
        return normalizedPaths.some(
          (wp) => normalized === wp || normalized.startsWith(`${wp}/`) || wp.startsWith(`${normalized}/`),
        );
      })
      .map((row) => row.id);
  }

  function findSessions(projectIds: string[], updatedAfter: number): SessionRow[] {
    if (projectIds.length === 0) {
      return [];
    }

    const placeholders = projectIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id, project_id, parent_id, directory, title, version, time_created, time_updated
         FROM session
         WHERE project_id IN (${placeholders}) AND time_updated > ?
         ORDER BY time_updated DESC`,
      )
      .all(...projectIds, updatedAfter) as Array<Record<string, unknown>>;

    return rows
      .map(parseSessionRow)
      .filter((row): row is SessionRow => row !== null);
  }

  function getSessionStats(sessionIds: string[]): Map<string, SessionStats> {
    const result = new Map<string, SessionStats>();
    if (sessionIds.length === 0) {
      return result;
    }

    const placeholders = sessionIds.map(() => "?").join(", ");

    const messageCounts = db
      .prepare(
        `SELECT session_id, COUNT(*) as cnt
         FROM message WHERE session_id IN (${placeholders})
         GROUP BY session_id`,
      )
      .all(...sessionIds) as Array<{ session_id: string; cnt: number }>;

    const toolCounts = db
      .prepare(
        `SELECT p.session_id, COUNT(*) as cnt
         FROM part p
         WHERE p.session_id IN (${placeholders})
           AND json_extract(p.data, '$.type') = 'tool'
         GROUP BY p.session_id`,
      )
      .all(...sessionIds) as Array<{ session_id: string; cnt: number }>;

    const latestAssistants = db
      .prepare(
        `SELECT session_id,
                json_extract(data, '$.agent') as agent,
                json_extract(data, '$.modelID') as model
         FROM message
         WHERE session_id IN (${placeholders})
           AND json_extract(data, '$.role') = 'assistant'
         ORDER BY time_created DESC`,
      )
      .all(...sessionIds) as Array<{ session_id: string; agent: string | null; model: string | null }>;

    for (const id of sessionIds) {
      const msgRow = messageCounts.find((r) => r.session_id === id);
      const toolRow = toolCounts.find((r) => r.session_id === id);
      const assistantRow = latestAssistants.find((r) => r.session_id === id);
      result.set(id, {
        messageCount: msgRow?.cnt ?? 0,
        toolCallCount: toolRow?.cnt ?? 0,
        latestAgent: assistantRow?.agent ?? undefined,
        latestModel: assistantRow?.model ?? undefined,
      });
    }

    return result;
  }

  function getLatestUserSummary(sessionId: string): string | undefined {
    const row = db
      .prepare(
        `SELECT data FROM message
         WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
         ORDER BY time_created DESC LIMIT 1`,
      )
      .get(sessionId) as { data: string } | undefined;

    if (!row) {
      return undefined;
    }

    try {
      const data = JSON.parse(row.data) as Record<string, unknown>;
      const summary = data.summary as Record<string, unknown> | undefined;
      return typeof summary?.title === "string" ? summary.title : undefined;
    } catch {
      return undefined;
    }
  }

  function getDataVersion(): number {
    const row = db.prepare("PRAGMA data_version").get() as { data_version: number } | undefined;
    return row?.data_version ?? 0;
  }

  return {
    findProjectIds,
    findSessions,
    getSessionStats,
    getLatestUserSummary,
    getDataVersion,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run check`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/providers/opencode/database.ts tests/opencode-database.test.ts
git commit -m "feat: add OpenCode database access layer with project/session/message queries"
```

---

## Task 5: Watch component with PRAGMA data_version polling

**Files:**
- Create: `src/providers/opencode/watch.ts`
- Create: `tests/opencode-watch.test.ts`

**Step 1: Write failing tests**

Create `tests/opencode-watch.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenCodeWatch, type OpenCodeWatch } from "@/providers/opencode/watch";

describe("opencode watch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onEvent when data version changes", () => {
    let version = 1;
    const onEvent = vi.fn();
    const onError = vi.fn();
    const watch = createOpenCodeWatch({
      pollIntervalMs: 1000,
      getDataVersion: () => version,
    });

    const handle = watch.subscribe("unused", onEvent, onError);

    vi.advanceTimersByTime(1000);
    expect(onEvent).not.toHaveBeenCalled();

    version = 2;
    vi.advanceTimersByTime(1000);
    expect(onEvent).toHaveBeenCalledOnce();

    handle.close();
  });

  it("does not fire onEvent when data version stays the same", () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    const watch = createOpenCodeWatch({
      pollIntervalMs: 500,
      getDataVersion: () => 1,
    });

    const handle = watch.subscribe("unused", onEvent, onError);

    vi.advanceTimersByTime(5000);
    expect(onEvent).not.toHaveBeenCalled();

    handle.close();
  });

  it("calls onError when getDataVersion throws", () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    let shouldThrow = false;
    const watch = createOpenCodeWatch({
      pollIntervalMs: 500,
      getDataVersion: () => {
        if (shouldThrow) {
          throw new Error("db gone");
        }
        return 1;
      },
    });

    const handle = watch.subscribe("unused", onEvent, onError);

    shouldThrow = true;
    vi.advanceTimersByTime(500);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].message).toBe("db gone");

    handle.close();
  });

  it("stops polling after close", () => {
    let callCount = 0;
    const watch = createOpenCodeWatch({
      pollIntervalMs: 100,
      getDataVersion: () => {
        callCount++;
        return 1;
      },
    });

    const handle = watch.subscribe("unused", vi.fn(), vi.fn());
    vi.advanceTimersByTime(300);
    const countBeforeClose = callCount;

    handle.close();
    vi.advanceTimersByTime(1000);
    expect(callCount).toBe(countBeforeClose);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/opencode-watch.test.ts`
Expected: FAIL

**Step 3: Implement watch component**

Create `src/providers/opencode/watch.ts`:

```typescript
import { toError } from "@/core/errors";
import { OPENCODE_WATCH_DEBOUNCE_MS, OPENCODE_WATCH_POLL_INTERVAL_MS } from "./constants";

export interface OpenCodeWatchConfig {
  pollIntervalMs?: number;
  getDataVersion: () => number;
}

export interface OpenCodeWatch {
  readonly debounceMs: number;
  subscribe(
    watchPath: string,
    onEvent: () => void,
    onError: (error: Error) => void,
  ): { close(): void };
}

export function createOpenCodeWatch(config: OpenCodeWatchConfig): OpenCodeWatch {
  const pollIntervalMs = config.pollIntervalMs ?? OPENCODE_WATCH_POLL_INTERVAL_MS;

  function subscribe(
    _watchPath: string,
    onEvent: () => void,
    onError: (error: Error) => void,
  ): { close(): void } {
    let lastVersion: number | undefined;

    try {
      lastVersion = config.getDataVersion();
    } catch (error) {
      onError(toError(error));
    }

    const timer = setInterval(() => {
      try {
        const currentVersion = config.getDataVersion();
        if (lastVersion !== undefined && currentVersion !== lastVersion) {
          onEvent();
        }
        lastVersion = currentVersion;
      } catch (error) {
        onError(toError(error));
      }
    }, pollIntervalMs);

    return {
      close() {
        clearInterval(timer);
      },
    };
  }

  return {
    debounceMs: OPENCODE_WATCH_DEBOUNCE_MS,
    subscribe,
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run check`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/providers/opencode/watch.ts tests/opencode-watch.test.ts
git commit -m "feat: add OpenCode watch with PRAGMA data_version polling"
```

---

## Task 6: Provider factory

**Files:**
- Create: `src/providers/opencode/provider.ts`
- Create: `tests/opencode-provider.test.ts`

**Step 1: Write failing tests**

Create `tests/opencode-provider.test.ts`:

```typescript
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCode, type OpenCodeOptions } from "@/providers/opencode/provider";
import { PROVIDER_KINDS } from "@/core/providers";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY, worktree TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL,
      version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
  `);
  return db;
}

describe("opencode provider", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("discovers projects matching workspace paths", () => {
    db.prepare("INSERT INTO project VALUES (?, ?, ?, ?)").run("p1", "/Users/test/myproject", Date.now(), Date.now());

    const provider = openCode({ _testDb: db });
    const result = provider.discover(["/Users/test/myproject"]);
    expect(result.inputs).toHaveLength(1);
    expect(result.inputs[0].metadata?.providerId).toBe(PROVIDER_KINDS.openCode);
  });

  it("returns empty discovery when no projects match", () => {
    db.prepare("INSERT INTO project VALUES (?, ?, ?, ?)").run("p1", "/Users/test/other", Date.now(), Date.now());

    const provider = openCode({ _testDb: db });
    const result = provider.discover(["/Users/test/myproject"]);
    expect(result.inputs).toHaveLength(0);
  });

  it("reads sessions and produces agent snapshots", async () => {
    const now = Date.now();
    db.prepare("INSERT INTO project VALUES (?, ?, ?, ?)").run("p1", "/test", now, now);
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "ses_abc", "p1", null, "slug", "/test", "Fix the bug", "1.2.24", now, now,
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "m1", "ses_abc", now, now,
      JSON.stringify({ role: "user", time: { created: now }, agent: "commander", summary: { title: "Fix the bug" } }),
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "m2", "ses_abc", now, now,
      JSON.stringify({ role: "assistant", time: { created: now }, agent: "commander", modelID: "claude-opus-4-6", providerID: "anthropic" }),
    );

    const provider = openCode({ _testDb: db });
    provider.connect?.();
    const discovery = provider.discover(["/test"]);
    const readResult = await provider.read(discovery.inputs, now);

    expect(readResult.health.connected).toBe(true);

    const snapshot = provider.normalize(readResult, now);
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0].id).toBe("ses_abc");
    expect(snapshot.agents[0].taskSummary).toBe("Fix the bug");
    expect(snapshot.agents[0].source).toBe("opencode");
    expect(snapshot.agents[0].isSubagent).toBe(false);
  });

  it("marks sessions with parent_id as subagents", async () => {
    const now = Date.now();
    db.prepare("INSERT INTO project VALUES (?, ?, ?, ?)").run("p1", "/test", now, now);
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "ses_parent", "p1", null, "slug", "/test", "Main session", "1.2.24", now, now,
    );
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "ses_child", "p1", "ses_parent", "slug", "/test", "Subagent task", "1.2.24", now, now,
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "m1", "ses_parent", now, now, JSON.stringify({ role: "user", time: { created: now } }),
    );
    db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
      "m2", "ses_child", now, now, JSON.stringify({ role: "user", time: { created: now } }),
    );

    const provider = openCode({ _testDb: db });
    provider.connect?.();
    const discovery = provider.discover(["/test"]);
    const readResult = await provider.read(discovery.inputs, now);
    const snapshot = provider.normalize(readResult, now);

    const parent = snapshot.agents.find((a) => a.id === "ses_parent");
    const child = snapshot.agents.find((a) => a.id === "ses_child");
    expect(parent?.isSubagent).toBe(false);
    expect(child?.isSubagent).toBe(true);
  });

  it("derives status from time_updated age", async () => {
    const now = Date.now();
    db.prepare("INSERT INTO project VALUES (?, ?, ?, ?)").run("p1", "/test", now, now);
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "ses_running", "p1", null, "slug", "/test", "Running", "1.2.24", now, now,
    );
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "ses_idle", "p1", null, "slug", "/test", "Idle", "1.2.24", now, now - 30_000,
    );
    db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "ses_done", "p1", null, "slug", "/test", "Done", "1.2.24", now, now - 120_000,
    );
    for (const sid of ["ses_running", "ses_idle", "ses_done"]) {
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
        `m_${sid}`, sid, now, now, JSON.stringify({ role: "user", time: { created: now } }),
      );
    }

    const provider = openCode({ _testDb: db });
    provider.connect?.();
    const discovery = provider.discover(["/test"]);
    const readResult = await provider.read(discovery.inputs, now);
    const snapshot = provider.normalize(readResult, now);

    const running = snapshot.agents.find((a) => a.id === "ses_running");
    const idle = snapshot.agents.find((a) => a.id === "ses_idle");
    const done = snapshot.agents.find((a) => a.id === "ses_done");
    expect(running?.status).toBe("running");
    expect(idle?.status).toBe("idle");
    expect(done?.status).toBe("completed");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/opencode-provider.test.ts`
Expected: FAIL

**Step 3: Implement provider factory**

Create `src/providers/opencode/provider.ts`:

```typescript
import BetterSqlite3 from "better-sqlite3";
import {
  type CanonicalSnapshot,
  type DiscoveryInput,
  type DiscoveryResult,
  PROVIDER_KINDS,
  type TranscriptProvider,
  type TranscriptReadResult,
} from "@/core";
import {
  CANONICAL_AGENT_KIND,
  CANONICAL_AGENT_STATUS,
  type CanonicalAgentSnapshot,
  type CanonicalAgentStatus,
} from "@/core/model";
import { normalizeFromPayload } from "@/providers/shared/providers";
import {
  OPENCODE_AGENT_NAME_PREFIX_LENGTH,
  OPENCODE_DB_PATH_DEFAULT,
  OPENCODE_IDLE_WINDOW_MS,
  OPENCODE_RUNNING_WINDOW_MS,
  OPENCODE_SESSION_WINDOW_MS,
  OPENCODE_SOURCE_KIND,
} from "./constants";
import { createOpenCodeDatabase, type OpenCodeDatabase } from "./database";
import { type SessionRow } from "./schemas";
import { createOpenCodeWatch } from "./watch";

export interface OpenCodeOptions {
  dbPath?: string;
  sourceLabel?: string;
  sessionWindowMs?: number;
  watch?: false | { pollIntervalMs?: number };
  /** @internal for testing — inject an open database */
  _testDb?: BetterSqlite3.Database;
}

export function openCode(options: OpenCodeOptions = {}): TranscriptProvider {
  const sourceLabel = options.sourceLabel ?? OPENCODE_SOURCE_KIND;
  const sessionWindowMs = options.sessionWindowMs ?? OPENCODE_SESSION_WINDOW_MS;
  let db: BetterSqlite3.Database | undefined = options._testDb;
  let ocDb: OpenCodeDatabase | undefined;
  let connected = false;
  let cachedProjectIds: string[] | undefined;
  let cachedWorkspaceKey: string | undefined;

  function openDb(): void {
    if (db) {
      ocDb = createOpenCodeDatabase(db);
      return;
    }
    const dbPath = options.dbPath ?? OPENCODE_DB_PATH_DEFAULT;
    try {
      db = new BetterSqlite3(dbPath, { readonly: true });
      db.pragma("journal_mode = WAL");
      ocDb = createOpenCodeDatabase(db);
    } catch {
      db = undefined;
      ocDb = undefined;
    }
  }

  function closeDb(): void {
    if (!options._testDb && db) {
      db.close();
    }
    db = undefined;
    ocDb = undefined;
  }

  const watch =
    options.watch === false || options._testDb
      ? undefined
      : createOpenCodeWatch({
          pollIntervalMs: options.watch?.pollIntervalMs,
          getDataVersion: () => {
            if (!ocDb) {
              return 0;
            }
            return ocDb.getDataVersion();
          },
        });

  function connect(): void {
    connected = true;
    openDb();
  }

  function disconnect(): void {
    connected = false;
    closeDb();
    cachedProjectIds = undefined;
    cachedWorkspaceKey = undefined;
  }

  function discover(workspacePaths: string[]): DiscoveryResult {
    if (!ocDb) {
      return { inputs: [], watchPaths: [], warnings: ["OpenCode database not found."] };
    }

    const workspaceKey = workspacePaths.join("\n");
    if (cachedProjectIds && cachedWorkspaceKey === workspaceKey) {
      return buildDiscoveryResult(cachedProjectIds);
    }

    cachedProjectIds = ocDb.findProjectIds(workspacePaths);
    cachedWorkspaceKey = workspaceKey;
    return buildDiscoveryResult(cachedProjectIds);
  }

  function buildDiscoveryResult(projectIds: string[]): DiscoveryResult {
    if (projectIds.length === 0) {
      return { inputs: [], watchPaths: [], warnings: [] };
    }

    const dbPath = options.dbPath ?? OPENCODE_DB_PATH_DEFAULT;
    const inputs: DiscoveryInput[] = [
      {
        uri: `sqlite://${dbPath}`,
        kind: "endpoint",
        metadata: { providerId: PROVIDER_KINDS.openCode, projectIds },
      },
    ];
    return { inputs, watchPaths: [dbPath], warnings: [] };
  }

  function getWatchPaths(): string[] {
    return [options.dbPath ?? OPENCODE_DB_PATH_DEFAULT];
  }

  async function read(
    inputs: DiscoveryInput[],
    now: number = Date.now(),
  ): Promise<TranscriptReadResult> {
    if (!ocDb || inputs.length === 0) {
      return {
        records: [],
        health: { connected: false, sourceLabel, warnings: ["OpenCode database not available."] },
      };
    }

    const projectIds = (inputs[0].metadata?.projectIds as string[]) ?? [];
    const updatedAfter = now - sessionWindowMs;
    const sessions = ocDb.findSessions(projectIds, updatedAfter);

    if (sessions.length === 0) {
      return {
        records: [{ provider: PROVIDER_KINDS.openCode, inputUri: "opencode://sessions", observedAt: now, payload: { agents: [] } }],
        health: { connected: true, sourceLabel, warnings: [] },
      };
    }

    const sessionIds = sessions.map((s) => s.id);
    const stats = ocDb.getSessionStats(sessionIds);
    const agents = buildAgentSnapshots(sessions, stats, ocDb, now);

    return {
      records: [
        {
          provider: PROVIDER_KINDS.openCode,
          inputUri: "opencode://sessions",
          observedAt: now,
          payload: { agents },
        },
      ],
      health: { connected: true, sourceLabel, warnings: [] },
    };
  }

  function normalize(readResult: TranscriptReadResult, _now: number): CanonicalSnapshot {
    return normalizeFromPayload(readResult);
  }

  return {
    id: PROVIDER_KINDS.openCode,
    discover,
    connect,
    disconnect,
    read,
    normalize,
    watch,
    getWatchPaths,
  };
}

function buildAgentSnapshots(
  sessions: SessionRow[],
  stats: Map<string, import("./database").SessionStats>,
  ocDb: OpenCodeDatabase,
  now: number,
): CanonicalAgentSnapshot[] {
  const agents: CanonicalAgentSnapshot[] = [];

  for (const session of sessions) {
    const sessionStats = stats.get(session.id);
    if (!sessionStats || sessionStats.messageCount === 0) {
      continue;
    }

    const taskSummary =
      session.title || ocDb.getLatestUserSummary(session.id) || "Working";

    agents.push({
      id: session.id,
      name: deriveAgentName(session.id, session.parentId !== null),
      kind: CANONICAL_AGENT_KIND.local,
      isSubagent: session.parentId !== null,
      status: deriveStatus(now, session.timeUpdated),
      taskSummary,
      startedAt: session.timeCreated,
      updatedAt: session.timeUpdated,
      source: OPENCODE_SOURCE_KIND,
      metadata: {
        model: sessionStats.latestModel,
        agent: sessionStats.latestAgent,
        directory: session.directory,
        version: session.version,
        messageCount: sessionStats.messageCount,
        toolCallCount: sessionStats.toolCallCount,
        parentSessionId: session.parentId ?? undefined,
      },
    });
  }

  return agents;
}

function deriveStatus(now: number, updatedAt: number): CanonicalAgentStatus {
  const ageMs = Math.max(0, now - updatedAt);
  if (ageMs <= OPENCODE_RUNNING_WINDOW_MS) {
    return CANONICAL_AGENT_STATUS.running;
  }
  if (ageMs <= OPENCODE_IDLE_WINDOW_MS) {
    return CANONICAL_AGENT_STATUS.idle;
  }
  return CANONICAL_AGENT_STATUS.completed;
}

function deriveAgentName(id: string, isSubagent: boolean): string {
  const prefix = isSubagent ? "Subagent" : "OpenCode";
  return `${prefix} ${id.slice(0, OPENCODE_AGENT_NAME_PREFIX_LENGTH)}`;
}
```

**Step 4: Run tests to verify they pass**

Run: `npm run check`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/providers/opencode/provider.ts tests/opencode-provider.test.ts
git commit -m "feat: add OpenCode provider factory with discovery, read, normalize, and watch"
```

---

## Task 7: Public exports and index barrel

**Files:**
- Create: `src/providers/opencode/index.ts`
- Modify: `src/index.ts`

**Step 1: Create index barrel**

Create `src/providers/opencode/index.ts`:

```typescript
export {
  type OpenCodeOptions,
  openCode,
} from "./provider";
export {
  type OpenCodeWatch,
  type OpenCodeWatchConfig,
  createOpenCodeWatch,
} from "./watch";
export {
  type OpenCodeDatabase,
  createOpenCodeDatabase,
} from "./database";
```

**Step 2: Add to default provider list in src/index.ts**

In `src/index.ts`:
- Add import: `import { openCode } from "./providers/opencode";`
- Add re-export: `export { type OpenCodeOptions, openCode } from "./providers/opencode";`
- Add `openCode()` to the default providers array in `createObserver`

**Step 3: Run quality gate**

Run: `npm run check`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/providers/opencode/index.ts src/index.ts
git commit -m "feat: export OpenCode provider and add to default observer"
```

---

## Task 8: Build entry points and package exports

**Files:**
- Modify: `tsup.config.ts`
- Modify: `package.json`

**Step 1: Add tsup entry point**

In `tsup.config.ts`, add to `entry`:
```typescript
"providers/opencode/index": "src/providers/opencode/index.ts",
```

**Step 2: Add package.json exports and typesVersions**

In `package.json`, add to `exports`:
```json
"./providers/opencode": {
  "types": "./dist/providers/opencode/index.d.ts",
  "import": "./dist/providers/opencode/index.js",
  "require": "./dist/providers/opencode/index.cjs",
  "default": "./dist/providers/opencode/index.js"
}
```

Add to `typesVersions`:
```json
"providers/opencode": ["dist/providers/opencode/index.d.ts"]
```

**Step 3: Verify build**

Run: `npm run build`
Expected: `dist/providers/opencode/` directory created with index.js, index.cjs, index.d.ts

**Step 4: Run full quality gate**

Run: `npm run check`
Expected: All tests pass

**Step 5: Commit**

```bash
git add tsup.config.ts package.json
git commit -m "build: add OpenCode provider to entry points and package exports"
```

---

## Execution Summary

| Task | Type | Risk | Files |
|------|------|------|-------|
| 1. Install better-sqlite3 | Config | Low | 2 |
| 2. Constants + provider kind | Feature | Low | 2 |
| 3. Schema validation | Feature | Low | 2 |
| 4. Database access layer | Feature | Medium | 2 |
| 5. Watch component | Feature | Low | 2 |
| 6. Provider factory | Feature | Medium | 2 |
| 7. Public exports | Feature | Low | 2 |
| 8. Build entry points | Config | Low | 2 |

**Batch 1 (sequential, foundation):** Tasks 1, 2
**Batch 2 (parallel, no file overlap):** Tasks 3, 4, 5
**Batch 3 (sequential, depends on 3-5):** Task 6
**Batch 4 (sequential, integration):** Tasks 7, 8

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenCodeDatabase, type OpenCodeDatabase } from "@/providers/opencode/database";

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
  db.prepare(
    "INSERT INTO project (id, worktree, time_created, time_updated) VALUES (?, ?, ?, ?)",
  ).run(id, worktree, Date.now(), Date.now());
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
  timeCreated?: number,
): void {
  const ts = timeCreated ?? Date.now();
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  ).run(id, sessionId, ts, ts, JSON.stringify(data));
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
      seedSession(rawDb, "s2", "p1", {
        title: "Session 2",
        timeUpdated: Date.now() - 86400000 * 30,
      });

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
      expect(sub?.parentId).toBe("s1");
    });
  });

  describe("getSessionStats", () => {
    it("returns message and tool call counts per session", () => {
      seedProject(rawDb, "p1", "/test");
      seedSession(rawDb, "s1", "p1");
      seedMessage(rawDb, "m1", "s1", { role: "user", time: { created: 1 }, agent: "commander" });
      seedMessage(rawDb, "m2", "s1", {
        role: "assistant",
        time: { created: 2 },
        agent: "commander",
        modelID: "claude-opus-4-6",
      });
      seedPart(rawDb, "pt1", "m2", "s1", { type: "tool", tool: "read" });
      seedPart(rawDb, "pt2", "m2", "s1", { type: "tool", tool: "write" });
      seedPart(rawDb, "pt3", "m2", "s1", { type: "text", text: "done" });

      const stats = ocDb.getSessionStats(["s1"]);
      expect(stats.get("s1")).toBeDefined();
      expect(stats.get("s1")?.messageCount).toBe(2);
      expect(stats.get("s1")?.toolCallCount).toBe(2);
      expect(stats.get("s1")?.latestAgent).toBe("commander");
      expect(stats.get("s1")?.latestModel).toBe("claude-opus-4-6");
    });
  });

  describe("getLatestUserSummary", () => {
    it("returns the title from the latest user message summary", () => {
      seedProject(rawDb, "p1", "/test");
      seedSession(rawDb, "s1", "p1");
      seedMessage(
        rawDb,
        "m1",
        "s1",
        { role: "user", time: { created: 1 }, summary: { title: "First task" } },
        1000,
      );
      seedMessage(
        rawDb,
        "m2",
        "s1",
        { role: "user", time: { created: 2 }, summary: { title: "Latest task" } },
        2000,
      );

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

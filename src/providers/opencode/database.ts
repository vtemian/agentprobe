import type Database from "better-sqlite3";
import { normalizeWorkspacePath } from "@/providers/shared/discovery";
import { parseSessionRow, type SessionRow } from "./schemas";

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
    const normalizedPaths = workspacePaths.map(normalizeWorkspacePath).filter((p) => p.length > 0);

    if (normalizedPaths.length === 0) {
      return [];
    }

    const rows = db.prepare("SELECT id, worktree FROM project").all() as Array<{
      id: string;
      worktree: string;
    }>;

    return rows
      .filter((row) => {
        const normalized = normalizeWorkspacePath(row.worktree);
        return normalizedPaths.some(
          (wp) =>
            normalized === wp || normalized.startsWith(`${wp}/`) || wp.startsWith(`${normalized}/`),
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

    return rows.map(parseSessionRow).filter((row): row is SessionRow => row !== null);
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
      .all(...sessionIds) as Array<{
      session_id: string;
      agent: string | null;
      model: string | null;
    }>;

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

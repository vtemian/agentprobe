import type database from "better-sqlite3";
import { z } from "zod";
import { normalizeWorkspacePath } from "@/providers/shared/discovery";
import { parseSessionRow, type SessionRow } from "./schemas";

const projectRowSchema = z.object({ id: z.string(), worktree: z.string() });
const groupedCountRowSchema = z.object({ sessionId: z.string(), cnt: z.number() });
const latestAssistantRowSchema = z.object({
  sessionId: z.string(),
  agent: z.string().nullable(),
  model: z.string().nullable(),
});
const dataVersionRowSchema = z.object({ data_version: z.number() });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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

export function createOpenCodeDatabase(db: database.Database): OpenCodeDatabase {
  function findProjectIds(workspacePaths: string[]): string[] {
    const normalizedPaths = workspacePaths.map(normalizeWorkspacePath).filter((p) => p.length > 0);

    if (normalizedPaths.length === 0) {
      return [];
    }

    const rows = z
      .array(projectRowSchema)
      .parse(db.prepare("SELECT id, worktree FROM project").all());

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
      .all(...projectIds, updatedAfter);

    return rows.map(parseSessionRow).filter((row): row is SessionRow => row !== null);
  }

  function queryGroupedCounts(
    table: string,
    whereClause: string,
    sessionIds: string[],
  ): Map<string, number> {
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = z.array(groupedCountRowSchema).parse(
      db
        .prepare(
          `SELECT session_id as sessionId, COUNT(*) as cnt
         FROM ${table} WHERE session_id IN (${placeholders}) ${whereClause}
         GROUP BY session_id`,
        )
        .all(...sessionIds),
    );
    return new Map(rows.map((r) => [r.sessionId, r.cnt]));
  }

  function queryLatestAssistants(
    sessionIds: string[],
  ): Map<string, { agent: string | null; model: string | null }> {
    const placeholders = sessionIds.map(() => "?").join(", ");
    const rows = z.array(latestAssistantRowSchema).parse(
      db
        .prepare(
          `SELECT sessionId, agent, model FROM (
           SELECT session_id as sessionId,
                  json_extract(data, '$.agent') as agent,
                  json_extract(data, '$.modelID') as model,
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY time_created DESC) as rn
           FROM message
           WHERE session_id IN (${placeholders})
             AND json_extract(data, '$.role') = 'assistant'
         ) WHERE rn = 1`,
        )
        .all(...sessionIds),
    );
    return new Map(rows.map((r) => [r.sessionId, { agent: r.agent, model: r.model }]));
  }

  function getSessionStats(sessionIds: string[]): Map<string, SessionStats> {
    if (sessionIds.length === 0) {
      return new Map();
    }

    const messageCounts = queryGroupedCounts("message", "", sessionIds);
    const toolCounts = queryGroupedCounts(
      "part",
      "AND json_extract(data, '$.type') = 'tool'",
      sessionIds,
    );
    const assistants = queryLatestAssistants(sessionIds);

    const result = new Map<string, SessionStats>();
    for (const id of sessionIds) {
      const assistantRow = assistants.get(id);
      result.set(id, {
        messageCount: messageCounts.get(id) ?? 0,
        toolCallCount: toolCounts.get(id) ?? 0,
        latestAgent: assistantRow?.agent ?? undefined,
        latestModel: assistantRow?.model ?? undefined,
      });
    }
    return result;
  }

  function getLatestUserSummary(sessionId: string): string | undefined {
    const raw = db
      .prepare(
        `SELECT data FROM message
         WHERE session_id = ? AND json_extract(data, '$.role') = 'user'
         ORDER BY time_created DESC LIMIT 1`,
      )
      .get(sessionId);

    if (!isRecord(raw) || typeof raw.data !== "string") {
      return undefined;
    }

    try {
      const parsed: unknown = JSON.parse(raw.data);
      if (!isRecord(parsed)) {
        return undefined;
      }
      const summary = parsed.summary;
      if (!isRecord(summary)) {
        return undefined;
      }
      return typeof summary.title === "string" ? summary.title : undefined;
    } catch {
      return undefined;
    }
  }

  function getDataVersion(): number {
    const result = dataVersionRowSchema.safeParse(db.prepare("PRAGMA data_version").get());
    return result.success ? result.data.data_version : 0;
  }

  return {
    findProjectIds,
    findSessions,
    getSessionStats,
    getLatestUserSummary,
    getDataVersion,
  };
}

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
import type { SessionRow } from "./schemas";
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
  let ocDb: OpenCodeDatabase | undefined = db ? createOpenCodeDatabase(db) : undefined;
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
        records: [
          {
            provider: PROVIDER_KINDS.openCode,
            inputUri: "opencode://sessions",
            observedAt: now,
            payload: { agents: [] },
          },
        ],
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

    const taskSummary = session.title || ocDb.getLatestUserSummary(session.id) || "Working";

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

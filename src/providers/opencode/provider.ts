import betterSqlite3 from "better-sqlite3";
import {
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
import { createOpenCodeDatabase, type OpenCodeDatabase, type SessionStats } from "./database";
import type { SessionRow } from "./schemas";
import { createOpenCodeWatch } from "./watch";

export interface OpenCodeOptions {
  dbPath?: string;
  sourceLabel?: string;
  sessionWindowMs?: number;
  watch?: false | { pollIntervalMs?: number };
  /** @internal for testing — inject an open database */
  _testDb?: betterSqlite3.Database;
}

interface ProviderState {
  db: betterSqlite3.Database | undefined;
  ocDb: OpenCodeDatabase | undefined;
  projectIds: string[] | undefined;
  workspaceKey: string | undefined;
}

export function openCode(options: OpenCodeOptions = {}): TranscriptProvider {
  const sourceLabel = options.sourceLabel ?? OPENCODE_SOURCE_KIND;
  const sessionWindowMs = options.sessionWindowMs ?? OPENCODE_SESSION_WINDOW_MS;
  const state: ProviderState = {
    db: options._testDb,
    ocDb: options._testDb ? createOpenCodeDatabase(options._testDb) : undefined,
    projectIds: undefined,
    workspaceKey: undefined,
  };

  const watch =
    options.watch === false || options._testDb
      ? undefined
      : createOpenCodeWatch({
          pollIntervalMs: options.watch?.pollIntervalMs,
          getDataVersion: () => state.ocDb?.getDataVersion() ?? 0,
        });

  return {
    id: PROVIDER_KINDS.openCode,
    connect: () => openDb(state, options),
    disconnect: () => disconnectState(state, options),
    discover: (workspacePaths) => discoverProjects(state, options, workspacePaths),
    read: (inputs, now = Date.now()) =>
      readSessions(state, inputs, now, sourceLabel, sessionWindowMs),
    normalize: (readResult, _now) => normalizeFromPayload(readResult),
    watch,
  };
}

function openDb(state: ProviderState, options: OpenCodeOptions): void {
  if (state.db && state.ocDb) {
    return;
  }
  if (state.db) {
    state.ocDb = createOpenCodeDatabase(state.db);
    return;
  }
  const dbPath = options.dbPath ?? OPENCODE_DB_PATH_DEFAULT;
  try {
    state.db = new betterSqlite3(dbPath, { readonly: true });
    state.ocDb = createOpenCodeDatabase(state.db);
  } catch {
    state.db = undefined;
    state.ocDb = undefined;
  }
}

function disconnectState(state: ProviderState, options: OpenCodeOptions): void {
  if (!options._testDb && state.db) {
    state.db.close();
  }
  state.db = undefined;
  state.ocDb = undefined;
  state.projectIds = undefined;
  state.workspaceKey = undefined;
}

function discoverProjects(
  state: ProviderState,
  options: OpenCodeOptions,
  workspacePaths: string[],
): DiscoveryResult {
  if (!state.ocDb) {
    return { inputs: [], watchPaths: [], warnings: ["OpenCode database not found."] };
  }

  const workspaceKey = workspacePaths.join("\n");
  if (state.projectIds && state.workspaceKey === workspaceKey) {
    return buildDiscoveryResult(state.projectIds, options);
  }

  state.projectIds = state.ocDb.findProjectIds(workspacePaths);
  state.workspaceKey = workspaceKey;
  return buildDiscoveryResult(state.projectIds, options);
}

function buildDiscoveryResult(projectIds: string[], options: OpenCodeOptions): DiscoveryResult {
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

function readSessions(
  state: ProviderState,
  inputs: DiscoveryInput[],
  now: number,
  sourceLabel: string,
  sessionWindowMs: number,
): TranscriptReadResult {
  if (!state.ocDb || inputs.length === 0) {
    return {
      records: [],
      health: { connected: false, sourceLabel, warnings: ["OpenCode database not available."] },
    };
  }

  const projectIds = extractProjectIds(inputs[0]);
  const sessions = state.ocDb.findSessions(projectIds, now - sessionWindowMs);
  const agents =
    sessions.length > 0
      ? buildAgentSnapshots(
          sessions,
          state.ocDb.getSessionStats(sessions.map((s) => s.id)),
          state.ocDb,
          now,
        )
      : [];

  return buildReadResult(agents, now, sourceLabel);
}

function extractProjectIds(input: DiscoveryInput): string[] {
  const raw = input.metadata?.projectIds;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

function buildReadResult(
  agents: CanonicalAgentSnapshot[],
  now: number,
  sourceLabel: string,
): TranscriptReadResult {
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

function buildAgentSnapshots(
  sessions: SessionRow[],
  stats: Map<string, SessionStats>,
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

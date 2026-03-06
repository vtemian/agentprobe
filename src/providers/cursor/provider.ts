import {
  CANONICAL_AGENT_KIND,
  CANONICAL_AGENT_STATUS,
  PROVIDER_KINDS,
  type CanonicalAgentSnapshot,
  type CanonicalSnapshot,
  type DiscoveryInput,
  type DiscoveryResult,
  type TranscriptProvider,
  type TranscriptReadResult,
} from "@/core";
import type { AgentKind, AgentSourceReadResult, AgentStatus } from "@/domain";
import { AGENT_SOURCE_KIND } from "@/domain";
import { z } from "zod";
import { resolveTranscriptDirectories, resolveTranscriptSourcePaths } from "./discovery";
import { createCursorTranscriptSource, type CursorTranscriptSource } from "./transcripts";

export interface CursorTranscriptProviderOptions {
  sourceLabel?: string;
}

const agentSourceSnapshotSchema = z.object({
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(["local", "remote"]),
      isSubagent: z.boolean(),
      status: z.enum(["running", "idle", "completed", "error"]),
      taskSummary: z.string(),
      startedAt: z.number().optional(),
      updatedAt: z.number(),
      source: z.string(),
    }),
  ),
  connected: z.boolean(),
  sourceLabel: z.string(),
  warnings: z.array(z.string()),
});

export function createCursorTranscriptProvider(
  options: CursorTranscriptProviderOptions = {},
): TranscriptProvider {
  const sourceLabel = options.sourceLabel ?? AGENT_SOURCE_KIND.cursorTranscripts;
  let source: CursorTranscriptSource | undefined;
  let sourcePathKey = "";
  let connected = false;

  function discover(workspacePaths: string[]): DiscoveryResult {
    const watchPaths = resolveTranscriptDirectories({ workspacePaths });
    const sourcePaths = resolveTranscriptSourcePaths({ workspacePaths });
    const inputs: DiscoveryInput[] = sourcePaths.map((sourcePath) => ({
      uri: sourcePath,
      kind: "file",
    }));
    return {
      inputs,
      watchPaths,
      warnings: [],
    };
  }

  function connect(): void {
    connected = true;
    source?.connect();
  }

  function disconnect(): void {
    connected = false;
    source?.disconnect();
  }

  async function read(
    inputs: DiscoveryInput[],
    now: number = Date.now(),
  ): Promise<TranscriptReadResult> {
    const sourcePaths = inputs.map((input) => input.uri);
    const nextSourcePathKey = sourcePaths.join("\n");
    source = ensureSource(source, sourcePaths, sourceLabel, sourcePathKey, nextSourcePathKey);
    sourcePathKey = nextSourcePathKey;
    if (connected) {
      source.connect();
    }
    const snapshot = await source.readSnapshot(now);
    return {
      records: [
        {
          provider: PROVIDER_KINDS.cursor,
          inputUri: "cursor://transcripts",
          observedAt: now,
          payload: snapshot,
        },
      ],
      health: {
        connected: snapshot.connected,
        sourceLabel: snapshot.sourceLabel,
        warnings: snapshot.warnings,
      },
    };
  }

  function normalize(readResult: TranscriptReadResult): CanonicalSnapshot {
    const snapshot = readResult.records
      .map((record) => record.payload)
      .find(
        (payload): payload is AgentSourceReadResult =>
          agentSourceSnapshotSchema.safeParse(payload).success,
      );

    const agents: CanonicalAgentSnapshot[] = (snapshot?.agents ?? []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      kind: normalizeAgentKind(agent.kind),
      isSubagent: agent.isSubagent,
      status: normalizeAgentStatus(agent.status),
      taskSummary: agent.taskSummary,
      startedAt: agent.startedAt,
      updatedAt: agent.updatedAt,
      source: agent.source,
    }));

    return {
      agents,
      health: readResult.health,
    };
  }

  return {
    id: PROVIDER_KINDS.cursor,
    discover,
    connect,
    disconnect,
    read,
    normalize,
  };
}

function ensureSource(
  existing: CursorTranscriptSource | undefined,
  sourcePaths: string[],
  sourceLabel: string,
  previousKey: string,
  nextKey: string,
): CursorTranscriptSource {
  if (existing && nextKey === previousKey) {
    return existing;
  }
  return createCursorTranscriptSource({ sourcePaths, sourceLabel });
}

function normalizeAgentKind(kind: AgentKind): CanonicalAgentSnapshot["kind"] {
  switch (kind) {
    case "remote":
      return CANONICAL_AGENT_KIND.remote;
    case "local":
      return CANONICAL_AGENT_KIND.local;
  }
}

function normalizeAgentStatus(status: AgentStatus): CanonicalAgentSnapshot["status"] {
  switch (status) {
    case "error":
      return CANONICAL_AGENT_STATUS.error;
    case "completed":
      return CANONICAL_AGENT_STATUS.completed;
    case "idle":
      return CANONICAL_AGENT_STATUS.idle;
    case "running":
      return CANONICAL_AGENT_STATUS.running;
  }
}

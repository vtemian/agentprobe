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
import type { AgentSourceReadResult } from "@/domain";
import { AGENT_SOURCE_KIND } from "@/domain";
import { resolveTranscriptDirectories, resolveTranscriptSourcePaths } from "./discovery";
import { createCursorTranscriptSource, type CursorTranscriptSource } from "./transcripts";

export interface CursorTranscriptProviderOptions {
  sourceLabel?: string;
}

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
    source = ensureSource(source, sourcePaths, sourceLabel, sourcePathKey);
    sourcePathKey = buildSourcePathKey(sourcePaths);
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
      .find((payload): payload is AgentSourceReadResult => isAgentSourceReadResult(payload));

    const agents: CanonicalAgentSnapshot[] = (snapshot?.agents ?? []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      kind: agent.kind === "remote" ? CANONICAL_AGENT_KIND.remote : CANONICAL_AGENT_KIND.local,
      isSubagent: agent.isSubagent,
      status:
        agent.status === "error"
          ? CANONICAL_AGENT_STATUS.error
          : agent.status === "completed"
            ? CANONICAL_AGENT_STATUS.completed
            : agent.status === "idle"
              ? CANONICAL_AGENT_STATUS.idle
              : CANONICAL_AGENT_STATUS.running,
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
): CursorTranscriptSource {
  const nextKey = buildSourcePathKey(sourcePaths);
  if (existing && nextKey === previousKey) {
    return existing;
  }
  return createCursorTranscriptSource({ sourcePaths, sourceLabel });
}

function buildSourcePathKey(sourcePaths: string[]): string {
  return sourcePaths.join("\n");
}

function isAgentSourceReadResult(value: unknown): value is AgentSourceReadResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (!hasObjectProperty(value, "agents") || !Array.isArray(value.agents)) {
    return false;
  }
  if (!hasObjectProperty(value, "connected") || typeof value.connected !== "boolean") {
    return false;
  }
  if (!hasObjectProperty(value, "sourceLabel") || typeof value.sourceLabel !== "string") {
    return false;
  }
  if (!hasObjectProperty(value, "warnings") || !Array.isArray(value.warnings)) {
    return false;
  }
  return true;
}

function hasObjectProperty<TKey extends string>(
  value: unknown,
  key: TKey,
): value is Record<TKey, unknown> {
  return typeof value === "object" && value !== null && key in value;
}

import {
  PROVIDER_KINDS,
  type CanonicalSnapshot,
  type DiscoveryInput,
  type DiscoveryResult,
  type TranscriptProvider,
  type TranscriptReadResult,
} from "@/core";
import { arraysEqual, normalizeFromPayload } from "@/providers/shared/providers";
import {
  listSessionFileNames,
  resolveSessionDirectories,
  resolveSessionSourcePaths,
} from "./discovery";
import { createClaudeCodeTranscriptSource, type ClaudeCodeTranscriptSource } from "./transcripts";
import { createClaudeCodeWatch, type ClaudeCodeWatchOptions } from "./watch";
import { CLAUDE_CODE_SOURCE_KIND } from "./constants";

export interface ClaudeCodeOptions {
  claudeHomePath?: string;
  sourceLabel?: string;
  watch?: ClaudeCodeWatchOptions | false;
  maxFiles?: number;
}

export function claudeCode(options: ClaudeCodeOptions = {}): TranscriptProvider {
  const sourceLabel = options.sourceLabel ?? CLAUDE_CODE_SOURCE_KIND;
  const claudeHomePath = options.claudeHomePath;
  const maxFiles = options.maxFiles;
  const watch = options.watch === false ? undefined : createClaudeCodeWatch(options.watch);
  let source: ClaudeCodeTranscriptSource | undefined;
  let sourcePathKey = "";
  let connected = false;
  let cachedDiscovery: DiscoveryResult | undefined;
  let cachedFileList: string[] | undefined;
  let cachedWorkspacePaths: string[] | undefined;

  function discover(workspacePaths: string[]): DiscoveryResult {
    const discoveryOptions = { workspacePaths, claudeHomePath, maxFiles };
    const currentFileList = listSessionFileNames(discoveryOptions);
    if (
      cachedDiscovery &&
      cachedFileList &&
      cachedWorkspacePaths &&
      arraysEqual(currentFileList, cachedFileList) &&
      arraysEqual(workspacePaths, cachedWorkspacePaths)
    ) {
      return cachedDiscovery;
    }

    const watchPaths = resolveSessionDirectories(discoveryOptions);
    const sourcePaths = resolveSessionSourcePaths(discoveryOptions);
    const inputs: DiscoveryInput[] = sourcePaths.map((sourcePath) => ({
      uri: sourcePath,
      kind: "file",
      metadata: { providerId: PROVIDER_KINDS.claudeCode },
    }));
    cachedDiscovery = { inputs, watchPaths, warnings: [] };
    cachedFileList = currentFileList;
    cachedWorkspacePaths = [...workspacePaths];
    return cachedDiscovery;
  }

  function connect(): void {
    connected = true;
    source?.connect();
  }

  function disconnect(): void {
    connected = false;
    source?.disconnect();
    cachedDiscovery = undefined;
    cachedFileList = undefined;
    cachedWorkspacePaths = undefined;
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
          provider: PROVIDER_KINDS.claudeCode,
          inputUri: "claude-code://sessions",
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

  function normalize(readResult: TranscriptReadResult, _now: number): CanonicalSnapshot {
    return normalizeFromPayload(readResult);
  }

  return {
    id: PROVIDER_KINDS.claudeCode,
    discover,
    connect,
    disconnect,
    read,
    normalize,
    watch,
  };
}

function ensureSource(
  existing: ClaudeCodeTranscriptSource | undefined,
  sourcePaths: string[],
  sourceLabel: string,
  previousKey: string,
  nextKey: string,
): ClaudeCodeTranscriptSource {
  if (existing && nextKey === previousKey) {
    return existing;
  }
  return createClaudeCodeTranscriptSource({ sourcePaths, sourceLabel });
}

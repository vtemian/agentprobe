import {
  type CanonicalSnapshot,
  type DiscoveryInput,
  type DiscoveryResult,
  PROVIDER_KINDS,
  type TranscriptProvider,
  type TranscriptReadResult,
} from "@/core";
import { arraysEqual, normalizeFromPayload } from "@/providers/shared/providers";
import { CODEX_SOURCE_KIND } from "./constants";
import {
  listSessionFileNames,
  resolveSessionSourcePaths,
  resolveSessionsDirectory,
} from "./discovery";
import { type CodexTranscriptSource, createCodexTranscriptSource } from "./transcripts";
import { type CodexWatchOptions, createCodexWatch } from "./watch";

export interface CodexOptions {
  codexHomePath?: string;
  sourceLabel?: string;
  watch?: CodexWatchOptions | false;
  maxFiles?: number;
}

export function codex(options: CodexOptions = {}): TranscriptProvider {
  const sourceLabel = options.sourceLabel ?? CODEX_SOURCE_KIND;
  const codexHomePath = options.codexHomePath;
  const maxFiles = options.maxFiles;
  const watch = options.watch === false ? undefined : createCodexWatch(options.watch);
  let source: CodexTranscriptSource | undefined;
  let sourcePathKey = "";
  let connected = false;
  let cachedDiscovery: DiscoveryResult | undefined;
  let cachedFileList: string[] | undefined;
  let cachedWorkspacePaths: string[] | undefined;

  function discover(workspacePaths: string[]): DiscoveryResult {
    const discoveryOptions = { workspacePaths, codexHomePath, maxFiles };
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

    const sessionsDir = resolveSessionsDirectory(discoveryOptions);
    const sourcePaths = resolveSessionSourcePaths(discoveryOptions);
    const inputs: DiscoveryInput[] = sourcePaths.map((sourcePath) => ({
      uri: sourcePath,
      kind: "file",
      metadata: { providerId: PROVIDER_KINDS.codex },
    }));
    cachedDiscovery = { inputs, watchPaths: [sessionsDir], warnings: [] };
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
          provider: PROVIDER_KINDS.codex,
          inputUri: "codex://sessions",
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
    id: PROVIDER_KINDS.codex,
    discover,
    connect,
    disconnect,
    read,
    normalize,
    watch,
  };
}

function ensureSource(
  existing: CodexTranscriptSource | undefined,
  sourcePaths: string[],
  sourceLabel: string,
  previousKey: string,
  nextKey: string,
): CodexTranscriptSource {
  if (existing && nextKey === previousKey) {
    return existing;
  }
  return createCodexTranscriptSource({ sourcePaths, sourceLabel });
}

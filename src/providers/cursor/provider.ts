import {
  type CanonicalAgentSnapshot,
  type CanonicalSnapshot,
  type DiscoveryInput,
  type DiscoveryResult,
  PROVIDER_KINDS,
  type TranscriptProvider,
  type TranscriptReadResult,
} from "@/core";
import { CURSOR_SOURCE_KIND } from "./constants";
import {
  listTranscriptFileNames,
  resolveTranscriptDirectories,
  resolveTranscriptSourcePaths,
} from "./discovery";
import {
  type CursorTranscriptSource,
  createCursorTranscriptSource,
  type TranscriptSourceResult,
} from "./transcripts";
import { type CursorWatchOptions, createCursorWatch } from "./watch";

export interface CursorTranscriptProviderOptions {
  sourceLabel?: string;
  watch?: CursorWatchOptions | false;
}

export function createCursorTranscriptProvider(
  options: CursorTranscriptProviderOptions = {},
): TranscriptProvider {
  const sourceLabel = options.sourceLabel ?? CURSOR_SOURCE_KIND;
  const watch = options.watch === false ? undefined : createCursorWatch(options.watch);
  let source: CursorTranscriptSource | undefined;
  let sourcePathKey = "";
  let connected = false;
  let cachedDiscovery: DiscoveryResult | undefined;
  let cachedFileList: string[] | undefined;

  function discover(workspacePaths: string[]): DiscoveryResult {
    const currentFileList = listTranscriptFileNames({ workspacePaths });
    if (cachedDiscovery && cachedFileList && arraysEqual(currentFileList, cachedFileList)) {
      return cachedDiscovery;
    }

    const watchPaths = resolveTranscriptDirectories({ workspacePaths });
    const sourcePaths = resolveTranscriptSourcePaths({ workspacePaths });
    const inputs: DiscoveryInput[] = sourcePaths.map((sourcePath) => ({
      uri: sourcePath,
      kind: "file",
    }));
    cachedDiscovery = { inputs, watchPaths, warnings: [] };
    cachedFileList = currentFileList;
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
    const payload = readResult.records[0]?.payload;
    const agents: CanonicalAgentSnapshot[] = isTranscriptSourceResult(payload)
      ? payload.agents
      : [];
    return { agents, health: readResult.health };
  }

  return {
    id: PROVIDER_KINDS.cursor,
    discover,
    connect,
    disconnect,
    read,
    normalize,
    watch,
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

function isTranscriptSourceResult(value: unknown): value is TranscriptSourceResult {
  return (
    typeof value === "object" && value !== null && "agents" in value && Array.isArray(value.agents)
  );
}

function arraysEqual(previous: readonly string[], current: readonly string[]): boolean {
  if (previous.length !== current.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index++) {
    if (previous[index] !== current[index]) {
      return false;
    }
  }
  return true;
}

import {
  type CanonicalSnapshot,
  type DiscoveryInput,
  type DiscoveryResult,
  PROVIDER_KINDS,
  type TranscriptProvider,
  type TranscriptReadResult,
} from "@/core";
import { arraysEqual, normalizeFromPayload } from "@/providers/shared/providers";
import { CURSOR_SOURCE_KIND } from "./constants";
import {
  listTranscriptFileNames,
  resolveTranscriptDirectories,
  resolveTranscriptSourcePaths,
} from "./discovery";
import { type CursorTranscriptSource, createCursorTranscriptSource } from "./transcripts";
import { type CursorWatchOptions, createCursorWatch } from "./watch";

export interface CursorOptions {
  sourceLabel?: string;
  watch?: CursorWatchOptions | false;
}

export function cursor(options: CursorOptions = {}): TranscriptProvider {
  const sourceLabel = options.sourceLabel ?? CURSOR_SOURCE_KIND;
  const watch = options.watch === false ? undefined : createCursorWatch(options.watch);
  let source: CursorTranscriptSource | undefined;
  let sourcePathKey = "";
  let connected = false;
  let cachedDiscovery: DiscoveryResult | undefined;
  let cachedFileList: string[] | undefined;
  let cachedWorkspacePaths: string[] | undefined;

  function discover(workspacePaths: string[]): DiscoveryResult {
    const currentFileList = listTranscriptFileNames({ workspacePaths });
    if (
      cachedDiscovery &&
      cachedFileList &&
      cachedWorkspacePaths &&
      arraysEqual(currentFileList, cachedFileList) &&
      arraysEqual(workspacePaths, cachedWorkspacePaths)
    ) {
      return cachedDiscovery;
    }

    const watchPaths = resolveTranscriptDirectories({ workspacePaths });
    const sourcePaths = resolveTranscriptSourcePaths({ workspacePaths });
    const inputs: DiscoveryInput[] = sourcePaths.map((sourcePath) => ({
      uri: sourcePath,
      kind: "file",
      metadata: { providerId: PROVIDER_KINDS.cursor },
    }));
    cachedDiscovery = { inputs, watchPaths, warnings: [] };
    cachedFileList = currentFileList;
    cachedWorkspacePaths = [...workspacePaths];
    return cachedDiscovery;
  }

  function connect(): void {
    connected = true;
    void source?.connect();
  }

  function disconnect(): void {
    connected = false;
    void source?.disconnect();
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
      void source.connect();
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

  function normalize(readResult: TranscriptReadResult, _now: number): CanonicalSnapshot {
    return normalizeFromPayload(readResult);
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

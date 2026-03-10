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
  listTranscriptFileNames,
  resolveTranscriptDirectories,
  resolveTranscriptSourcePaths,
} from "./discovery";
import { createCursorTranscriptSource, type CursorTranscriptSource } from "./transcripts";
import { createCursorWatch, type CursorWatchOptions } from "./watch";
import { CURSOR_SOURCE_KIND } from "./constants";

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
      metadata: { providerId: PROVIDER_KINDS.cursor },
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

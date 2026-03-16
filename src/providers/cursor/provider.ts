import type {
  CanonicalSnapshot,
  DiscoveryInput,
  DiscoveryResult,
  TranscriptProvider,
  TranscriptReadResult,
} from "@/core";
import { PROVIDER_KINDS } from "@/core";
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

interface CursorProviderState {
  source: CursorTranscriptSource | undefined;
  sourcePathKey: string;
  connected: boolean;
  discovery: DiscoveryResult | undefined;
  files: string[] | undefined;
  workspaces: string[] | undefined;
}

export function cursor(options: CursorOptions = {}): TranscriptProvider {
  const sourceLabel = options.sourceLabel ?? CURSOR_SOURCE_KIND;
  const watch = options.watch === false ? undefined : createCursorWatch(options.watch);
  const state: CursorProviderState = {
    source: undefined,
    sourcePathKey: "",
    connected: false,
    discovery: undefined,
    files: undefined,
    workspaces: undefined,
  };

  return {
    id: PROVIDER_KINDS.cursor,
    discover: (workspacePaths: string[]) => discoverTranscripts(state, workspacePaths),
    connect: () => connectProvider(state),
    disconnect: () => disconnectProvider(state),
    read: (inputs: DiscoveryInput[], now: number = Date.now()) =>
      readTranscripts(state, sourceLabel, inputs, now),
    normalize: (readResult: TranscriptReadResult, _now: number): CanonicalSnapshot =>
      normalizeFromPayload(readResult),
    watch,
  };
}

function discoverTranscripts(
  state: CursorProviderState,
  workspacePaths: string[],
): DiscoveryResult {
  const files = listTranscriptFileNames({ workspacePaths });
  if (
    state.discovery &&
    state.files &&
    state.workspaces &&
    arraysEqual(files, state.files) &&
    arraysEqual(workspacePaths, state.workspaces)
  ) {
    return state.discovery;
  }

  const watchPaths = resolveTranscriptDirectories({ workspacePaths });
  const sourcePaths = resolveTranscriptSourcePaths({ workspacePaths });
  const inputs: DiscoveryInput[] = sourcePaths.map((sourcePath) => ({
    uri: sourcePath,
    kind: "file",
    metadata: { providerId: PROVIDER_KINDS.cursor },
  }));
  state.discovery = { inputs, watchPaths, warnings: [] };
  state.files = files;
  state.workspaces = [...workspacePaths];
  return state.discovery;
}

function connectProvider(state: CursorProviderState): void {
  state.connected = true;
  void state.source?.connect();
}

function disconnectProvider(state: CursorProviderState): void {
  state.connected = false;
  void state.source?.disconnect();
  state.discovery = undefined;
  state.files = undefined;
  state.workspaces = undefined;
}

async function readTranscripts(
  state: CursorProviderState,
  sourceLabel: string,
  inputs: DiscoveryInput[],
  now: number,
): Promise<TranscriptReadResult> {
  const sourcePaths = inputs.map((input) => input.uri);
  const nextSourcePathKey = sourcePaths.join("\n");
  state.source = ensureSource(
    state.source,
    sourcePaths,
    sourceLabel,
    state.sourcePathKey,
    nextSourcePathKey,
  );
  state.sourcePathKey = nextSourcePathKey;
  if (state.connected) {
    void state.source.connect();
  }
  const snapshot = await state.source.readSnapshot(now);
  return buildReadResult(snapshot, now);
}

function buildReadResult(
  snapshot: { connected: boolean; sourceLabel: string; warnings: string[] },
  now: number,
): TranscriptReadResult {
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

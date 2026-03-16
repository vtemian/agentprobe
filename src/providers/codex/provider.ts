import {
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
import {
  type CodexTranscriptSource,
  type CodexTranscriptSourceResult,
  createCodexTranscriptSource,
} from "./transcripts";
import { type CodexWatchOptions, createCodexWatch } from "./watch";

export interface CodexOptions {
  codexHomePath?: string;
  sourceLabel?: string;
  watch?: CodexWatchOptions | false;
  maxFiles?: number;
}

interface CodexState {
  source: CodexTranscriptSource | undefined;
  sourcePathKey: string;
  connected: boolean;
  discovery: DiscoveryResult | undefined;
  files: string[] | undefined;
  workspaces: string[] | undefined;
}

export function codex(options: CodexOptions = {}): TranscriptProvider {
  const sourceLabel = options.sourceLabel ?? CODEX_SOURCE_KIND;
  const codexHomePath = options.codexHomePath;
  const maxFiles = options.maxFiles;
  const watch = options.watch === false ? undefined : createCodexWatch(options.watch);
  const state: CodexState = {
    source: undefined,
    sourcePathKey: "",
    connected: false,
    discovery: undefined,
    files: undefined,
    workspaces: undefined,
  };

  return {
    id: PROVIDER_KINDS.codex,
    discover: (workspacePaths) =>
      discoverSessions(workspacePaths, state, { codexHomePath, maxFiles }),
    connect: () => {
      state.connected = true;
      state.source?.connect();
    },
    disconnect: () => disconnectState(state),
    read: (inputs, now = Date.now()) => readSessions(inputs, now, state, sourceLabel),
    normalize: (readResult) => normalizeFromPayload(readResult),
    watch,
  };
}

function discoverSessions(
  workspacePaths: string[],
  state: CodexState,
  opts: { codexHomePath?: string; maxFiles?: number },
): DiscoveryResult {
  const discoveryOptions = {
    workspacePaths,
    codexHomePath: opts.codexHomePath,
    maxFiles: opts.maxFiles,
  };
  const files = listSessionFileNames(discoveryOptions);
  if (
    state.discovery &&
    state.files &&
    state.workspaces &&
    arraysEqual(files, state.files) &&
    arraysEqual(workspacePaths, state.workspaces)
  ) {
    return state.discovery;
  }

  const sessionsDir = resolveSessionsDirectory(discoveryOptions);
  const sourcePaths = resolveSessionSourcePaths(discoveryOptions);
  const inputs: DiscoveryInput[] = sourcePaths.map((sourcePath) => ({
    uri: sourcePath,
    kind: "file",
    metadata: { providerId: PROVIDER_KINDS.codex },
  }));
  state.discovery = { inputs, watchPaths: [sessionsDir], warnings: [] };
  state.files = files;
  state.workspaces = [...workspacePaths];
  return state.discovery;
}

function disconnectState(state: CodexState): void {
  state.connected = false;
  state.source?.disconnect();
  state.discovery = undefined;
  state.files = undefined;
  state.workspaces = undefined;
}

async function readSessions(
  inputs: DiscoveryInput[],
  now: number,
  state: CodexState,
  sourceLabel: string,
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
    state.source.connect();
  }
  const snapshot = await state.source.readSnapshot(now);
  return buildReadResult(snapshot, now);
}

function buildReadResult(snapshot: CodexTranscriptSourceResult, now: number): TranscriptReadResult {
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

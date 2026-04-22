import {
  type CanonicalSnapshot,
  type DiscoveryInput,
  type DiscoveryResult,
  PROVIDER_KINDS,
  type TranscriptProvider,
  type TranscriptReadResult,
} from "@/core";
import { arraysEqual, normalizeFromPayload } from "@/providers/shared/providers";
import { CORTEX_CODE_SOURCE_KIND } from "./constants";
import {
  listSessionFileNames,
  resolveConversationsDirectory,
  resolveSessionSourcePaths,
} from "./discovery";
import {
  type CortexCodeTranscriptSource,
  type CortexCodeTranscriptSourceResult,
  createCortexCodeTranscriptSource,
} from "./transcripts";
import { type CortexCodeWatchOptions, createCortexCodeWatch } from "./watch";

export interface CortexCodeOptions {
  cortexHomePath?: string;
  sourceLabel?: string;
  watch?: CortexCodeWatchOptions | false;
  maxFiles?: number;
}

interface ProviderState {
  source: CortexCodeTranscriptSource | undefined;
  sourcePathKey: string;
  connected: boolean;
  discovery: DiscoveryResult | undefined;
  files: string[] | undefined;
  workspaces: string[] | undefined;
}

export function cortexCode(options: CortexCodeOptions = {}): TranscriptProvider {
  const sourceLabel = options.sourceLabel ?? CORTEX_CODE_SOURCE_KIND;
  const cortexHomePath = options.cortexHomePath;
  const maxFiles = options.maxFiles;
  const watch = options.watch === false ? undefined : createCortexCodeWatch(options.watch);
  const state: ProviderState = {
    source: undefined,
    sourcePathKey: "",
    connected: false,
    discovery: undefined,
    files: undefined,
    workspaces: undefined,
  };

  return {
    id: PROVIDER_KINDS.cortexCode,
    discover: (workspacePaths) =>
      discoverSessions(workspacePaths, state, { cortexHomePath, maxFiles }),
    connect: () => {
      state.connected = true;
      state.source?.connect();
    },
    disconnect: () => disconnectState(state),
    read: (inputs, now = Date.now()) => readSessions(inputs, now, state, sourceLabel),
    normalize: (readResult): CanonicalSnapshot => normalizeFromPayload(readResult),
    watch,
  };
}

async function discoverSessions(
  workspacePaths: string[],
  state: ProviderState,
  opts: { cortexHomePath?: string; maxFiles?: number },
): Promise<DiscoveryResult> {
  const discoveryOptions = {
    workspacePaths,
    cortexHomePath: opts.cortexHomePath,
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

  const conversationsDir = resolveConversationsDirectory(discoveryOptions);
  const sourcePaths = await resolveSessionSourcePaths(discoveryOptions);
  const inputs: DiscoveryInput[] = sourcePaths.map((sourcePath) => ({
    uri: sourcePath,
    kind: "file",
    metadata: { providerId: PROVIDER_KINDS.cortexCode },
  }));
  state.discovery = { inputs, watchPaths: [conversationsDir], warnings: [] };
  state.files = files;
  state.workspaces = [...workspacePaths];
  return state.discovery;
}

function disconnectState(state: ProviderState): void {
  state.connected = false;
  state.source?.disconnect();
  state.discovery = undefined;
  state.files = undefined;
  state.workspaces = undefined;
}

async function readSessions(
  inputs: DiscoveryInput[],
  now: number,
  state: ProviderState,
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

function buildReadResult(
  snapshot: CortexCodeTranscriptSourceResult,
  now: number,
): TranscriptReadResult {
  return {
    records: [
      {
        provider: PROVIDER_KINDS.cortexCode,
        inputUri: "cortex-code://sessions",
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
  existing: CortexCodeTranscriptSource | undefined,
  sourcePaths: string[],
  sourceLabel: string,
  previousKey: string,
  nextKey: string,
): CortexCodeTranscriptSource {
  if (existing && nextKey === previousKey) {
    return existing;
  }
  return createCortexCodeTranscriptSource({ sourcePaths, sourceLabel });
}

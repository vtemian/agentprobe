import path from "node:path";
import {
  CANONICAL_AGENT_KIND,
  CANONICAL_AGENT_STATUS,
  type CanonicalAgentSnapshot,
  type CanonicalAgentStatus,
} from "@/core/model";
import { formatLineWarning } from "@/providers/shared/discovery";
import {
  mergeAgents,
  type ProcessFileResult,
  parseTimestampMs,
  pruneStaleCache,
  readSourceFile,
  statSourceFile,
} from "@/providers/shared/providers";
import {
  AGENT_NAME_PREFIX_LENGTH,
  CODEX_IDLE_WINDOW_MS,
  CODEX_RUNNING_WINDOW_MS,
  CODEX_SOURCE_KIND,
} from "./constants";
import {
  type CodexRecord,
  parseCodexRecord,
  type ResponseItem,
  type SessionMeta,
  type TurnContext,
} from "./schemas";

export interface CodexTranscriptSourceResult {
  agents: CanonicalAgentSnapshot[];
  connected: boolean;
  sourceLabel: string;
  warnings: string[];
}

export interface CodexTranscriptSourceOptions {
  sourcePaths: string[];
  sourceLabel?: string;
}

export interface CodexTranscriptSource {
  readonly sourceKind: typeof CODEX_SOURCE_KIND;
  connect(): void;
  disconnect(): void;
  readSnapshot(now?: number): Promise<CodexTranscriptSourceResult>;
}

interface SessionParseState {
  sessionId: string | undefined;
  model: string | undefined;
  gitBranch: string | undefined;
  cwd: string | undefined;
  cliVersion: string | undefined;
  source: string | undefined;
  latestUserContent: string | undefined;
  latestTimestamp: number | undefined;
  firstTimestamp: number | undefined;
  latestRecordType: string | undefined;
  messageCount: number;
  toolCallCount: number;
}

interface SessionFileCache {
  mtimeMs: number;
  sizeBytes: number;
  lineCount: number;
  state: SessionParseState;
  fileUpdatedAt: number;
}

interface ParseStrategy {
  state: SessionParseState;
  startLine: number;
}

interface SourceState {
  connected: boolean;
  readonly sourcePaths: string[];
  readonly sourceLabel: string;
  readonly fileCache: Map<string, SessionFileCache>;
}

export function createCodexTranscriptSource(
  options: CodexTranscriptSourceOptions,
): CodexTranscriptSource {
  const state: SourceState = {
    connected: false,
    sourcePaths: Array.isArray(options.sourcePaths) ? [...options.sourcePaths] : [],
    sourceLabel: options.sourceLabel ?? CODEX_SOURCE_KIND,
    fileCache: new Map(),
  };

  return {
    sourceKind: CODEX_SOURCE_KIND,
    connect: () => {
      state.connected = true;
    },
    disconnect: () => {
      state.connected = false;
      state.fileCache.clear();
    },
    readSnapshot: (now = Date.now()) => readSnapshot(state, now),
  };
}

async function readSnapshot(state: SourceState, now: number): Promise<CodexTranscriptSourceResult> {
  if (!state.connected) {
    return {
      agents: [],
      connected: false,
      sourceLabel: state.sourceLabel,
      warnings: ["Codex transcript source is disconnected."],
    };
  }
  if (state.sourcePaths.length === 0) {
    return {
      agents: [],
      connected: false,
      sourceLabel: state.sourceLabel,
      warnings: ["No session paths configured."],
    };
  }

  const { agents, hasReadError, successfulReads, warnings } = await collectSourceResults(
    state.sourcePaths,
    now,
    state.fileCache,
  );
  return {
    agents,
    connected: successfulReads > 0 || !hasReadError,
    sourceLabel: state.sourceLabel,
    warnings,
  };
}

async function collectSourceResults(
  sourcePaths: readonly string[],
  now: number,
  fileCache: Map<string, SessionFileCache>,
): Promise<{
  agents: CanonicalAgentSnapshot[];
  hasReadError: boolean;
  successfulReads: number;
  warnings: string[];
}> {
  const orderedIds: string[] = [];
  const latestById = new Map<string, CanonicalAgentSnapshot>();
  const warnings: string[] = [];
  let hasReadError = false;
  let successfulReads = 0;

  for (const sourcePath of sourcePaths) {
    const result = await processSourceFile(sourcePath, now, fileCache);
    warnings.push(...result.warnings);
    if (result.success) {
      successfulReads += 1;
    } else {
      hasReadError = true;
    }
    mergeAgents(result.agents, orderedIds, latestById);
  }

  pruneStaleCache(fileCache, sourcePaths);

  const agents = orderedIds
    .map((id) => latestById.get(id))
    .filter((agent): agent is CanonicalAgentSnapshot => agent !== undefined);

  return { agents, hasReadError, successfulReads, warnings };
}

function resolveParseStrategy(
  cached: SessionFileCache | undefined,
  fileSizeBytes: number,
  lineCount: number,
): ParseStrategy {
  if (cached && fileSizeBytes >= cached.sizeBytes && lineCount >= cached.lineCount) {
    return { state: cloneParseState(cached.state), startLine: cached.lineCount };
  }
  return { state: createInitialParseState(), startLine: 0 };
}

async function processSourceFile(
  sourcePath: string,
  now: number,
  fileCache: Map<string, SessionFileCache>,
): Promise<ProcessFileResult> {
  const { fileUpdatedAt, fileSizeBytes } = await statSourceFile(sourcePath, now);
  const cached = fileCache.get(sourcePath);

  if (cached && cached.mtimeMs === fileUpdatedAt && cached.sizeBytes === fileSizeBytes) {
    return cachedResult(cached.state, cached.fileUpdatedAt, now);
  }

  const contentChanged = !cached || fileSizeBytes !== cached.sizeBytes;
  const effectiveUpdatedAt = contentChanged ? fileUpdatedAt : cached.fileUpdatedAt;

  if (cached && !contentChanged) {
    fileCache.set(sourcePath, { ...cached, mtimeMs: fileUpdatedAt });
    return cachedResult(cached.state, effectiveUpdatedAt, now);
  }

  return parseAndCacheFile(
    sourcePath,
    fileCache,
    cached,
    fileSizeBytes,
    fileUpdatedAt,
    effectiveUpdatedAt,
    now,
  );
}

function cachedResult(state: SessionParseState, updatedAt: number, now: number): ProcessFileResult {
  return { agents: resolveAgentsFromState(state, updatedAt, now), success: true, warnings: [] };
}

async function parseAndCacheFile(
  sourcePath: string,
  fileCache: Map<string, SessionFileCache>,
  cached: SessionFileCache | undefined,
  fileSizeBytes: number,
  fileUpdatedAt: number,
  effectiveUpdatedAt: number,
  now: number,
): Promise<ProcessFileResult> {
  const contents = await readSourceFile(sourcePath);
  if (contents === null) {
    return { agents: [], success: false, warnings: [`Failed to read session path: ${sourcePath}`] };
  }

  const warnings: string[] = [];
  const lines = contents.split(/\r?\n/);
  const { state, startLine } = resolveParseStrategy(cached, fileSizeBytes, lines.length);
  accumulateLines(state, lines, startLine, sourcePath, warnings);

  fileCache.set(sourcePath, {
    mtimeMs: fileUpdatedAt,
    sizeBytes: fileSizeBytes,
    lineCount: lines.length,
    state: cloneParseState(state),
    fileUpdatedAt: effectiveUpdatedAt,
  });

  return {
    agents: resolveAgentsFromState(state, effectiveUpdatedAt, now),
    success: true,
    warnings,
  };
}

function createInitialParseState(): SessionParseState {
  return {
    sessionId: undefined,
    model: undefined,
    gitBranch: undefined,
    cwd: undefined,
    cliVersion: undefined,
    source: undefined,
    latestUserContent: undefined,
    latestTimestamp: undefined,
    firstTimestamp: undefined,
    latestRecordType: undefined,
    messageCount: 0,
    toolCallCount: 0,
  };
}

function cloneParseState(state: SessionParseState): SessionParseState {
  return { ...state };
}

function accumulateLines(
  state: SessionParseState,
  lines: string[],
  startIndex: number,
  sourcePath: string,
  warnings: string[],
): void {
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      warnings.push(formatLineWarning(sourcePath, i + 1, "Invalid JSON line."));
      continue;
    }

    const record = parseCodexRecord(parsed);
    if (record === null) {
      continue;
    }

    accumulateRecord(state, record);
  }
}

function accumulateRecord(state: SessionParseState, record: CodexRecord): void {
  const timestamp = parseTimestampMs(record.timestamp);
  if (timestamp === undefined) {
    return;
  }
  if (!state.firstTimestamp || timestamp < state.firstTimestamp) {
    state.firstTimestamp = timestamp;
  }
  if (!state.latestTimestamp || timestamp > state.latestTimestamp) {
    state.latestTimestamp = timestamp;
  }

  if (record.type === "session_meta") {
    accumulateSessionMeta(state, record);
    return;
  }
  if (record.type === "response_item") {
    accumulateResponseItem(state, record);
    return;
  }
  if (record.type === "turn_context") {
    accumulateTurnContext(state, record);
    return;
  }
}

function accumulateSessionMeta(state: SessionParseState, record: SessionMeta): void {
  state.latestRecordType = "session_meta";
  state.sessionId = record.payload.id;
  state.cwd = record.payload.cwd;
  state.source = record.payload.source;
  state.cliVersion = record.payload.cli_version;
  if (record.payload.git?.branch) {
    state.gitBranch = record.payload.git.branch;
  }
}

function accumulateResponseItem(state: SessionParseState, record: ResponseItem): void {
  const { payload } = record;

  if (payload.type === "message" && payload.role === "user") {
    state.messageCount += 1;
    state.latestRecordType = "user";
    state.latestUserContent = extractUserText(payload.content) ?? state.latestUserContent;
    return;
  }
  if (payload.type === "message" && payload.role === "assistant") {
    state.messageCount += 1;
    state.latestRecordType = "assistant";
    return;
  }
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    state.toolCallCount += 1;
    state.latestRecordType = payload.type;
    return;
  }
}

function accumulateTurnContext(state: SessionParseState, record: TurnContext): void {
  state.latestRecordType = "turn_context";
  if (record.payload.model) {
    state.model = record.payload.model;
  }
}

function extractUserText(content: string | Array<Record<string, unknown>>): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  const joined = content
    .filter(
      (entry): entry is Record<string, unknown> & { text: string } =>
        entry.type === "input_text" && typeof entry.text === "string",
    )
    .map((entry) => entry.text)
    .join(" ");
  return joined.length > 0 ? joined : undefined;
}

function resolveAgentsFromState(
  state: SessionParseState,
  fileUpdatedAt: number,
  now: number,
): CanonicalAgentSnapshot[] {
  if (!state.sessionId || state.messageCount === 0) {
    return [];
  }

  const agentId = deriveAgentId(state.sessionId);
  const agent: CanonicalAgentSnapshot = {
    id: agentId,
    name: deriveAgentName(agentId),
    kind: CANONICAL_AGENT_KIND.local,
    isSubagent: false,
    status: deriveStatus(now, fileUpdatedAt),
    taskSummary: state.latestUserContent ?? "Working",
    startedAt: state.firstTimestamp,
    updatedAt: fileUpdatedAt,
    source: CODEX_SOURCE_KIND,
    metadata: {
      model: state.model,
      gitBranch: state.gitBranch,
      cwd: state.cwd,
      cliVersion: state.cliVersion,
      source: state.source,
      messageCount: state.messageCount,
      toolCallCount: state.toolCallCount,
    },
  };

  return [agent];
}

function deriveStatus(now: number, updatedAt: number): CanonicalAgentStatus {
  const ageMs = Math.max(0, now - updatedAt);
  if (ageMs <= CODEX_RUNNING_WINDOW_MS) {
    return CANONICAL_AGENT_STATUS.running;
  }
  if (ageMs <= CODEX_IDLE_WINDOW_MS) {
    return CANONICAL_AGENT_STATUS.idle;
  }
  return CANONICAL_AGENT_STATUS.completed;
}

function deriveAgentId(sessionId: string): string {
  return path.basename(sessionId, ".jsonl") || sessionId;
}

function deriveAgentName(id: string): string {
  return `Codex ${id.slice(0, AGENT_NAME_PREFIX_LENGTH)}`;
}

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

export function createCodexTranscriptSource(
  options: CodexTranscriptSourceOptions,
): CodexTranscriptSource {
  const sourcePaths = Array.isArray(options.sourcePaths) ? [...options.sourcePaths] : [];
  const sourceLabel = options.sourceLabel ?? CODEX_SOURCE_KIND;
  let connected = false;
  const fileCache = new Map<string, SessionFileCache>();

  function connect(): void {
    connected = true;
  }

  function disconnect(): void {
    connected = false;
    fileCache.clear();
  }

  async function readSnapshot(now: number = Date.now()): Promise<CodexTranscriptSourceResult> {
    if (!connected) {
      return {
        agents: [],
        connected: false,
        sourceLabel,
        warnings: ["Codex transcript source is disconnected."],
      };
    }

    if (sourcePaths.length === 0) {
      return {
        agents: [],
        connected: false,
        sourceLabel,
        warnings: ["No session paths configured."],
      };
    }

    const orderedIds: string[] = [];
    const latestById = new Map<string, CanonicalAgentSnapshot>();
    const allWarnings: string[] = [];
    let hasReadError = false;
    let successfulReads = 0;

    for (const sourcePath of sourcePaths) {
      const result = await processSourceFile(sourcePath, now, fileCache);
      allWarnings.push(...result.warnings);
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

    return {
      agents,
      connected: successfulReads > 0 || !hasReadError,
      sourceLabel,
      warnings: allWarnings,
    };
  }

  return {
    sourceKind: CODEX_SOURCE_KIND,
    connect,
    disconnect,
    readSnapshot,
  };
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
  const warnings: string[] = [];
  const { fileUpdatedAt, fileSizeBytes } = await statSourceFile(sourcePath, now);

  const cached = fileCache.get(sourcePath);

  if (cached && cached.mtimeMs === fileUpdatedAt && cached.sizeBytes === fileSizeBytes) {
    return {
      agents: resolveAgentsFromState(cached.state, cached.fileUpdatedAt, now),
      success: true,
      warnings,
    };
  }

  const contentChanged = !cached || fileSizeBytes !== cached.sizeBytes;
  const effectiveUpdatedAt = contentChanged ? fileUpdatedAt : cached.fileUpdatedAt;

  if (cached && !contentChanged) {
    fileCache.set(sourcePath, { ...cached, mtimeMs: fileUpdatedAt });
    return {
      agents: resolveAgentsFromState(cached.state, effectiveUpdatedAt, now),
      success: true,
      warnings,
    };
  }

  const contents = await readSourceFile(sourcePath);
  if (contents === null) {
    warnings.push(`Failed to read session path: ${sourcePath}`);
    return { agents: [], success: false, warnings };
  }

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

  if (payload.type === "message") {
    if (payload.role === "user") {
      state.messageCount += 1;
      state.latestRecordType = "user";
      const extracted = extractUserText(payload.content);
      if (extracted) {
        state.latestUserContent = extracted;
      }
      return;
    }
    if (payload.role === "assistant") {
      state.messageCount += 1;
      state.latestRecordType = "assistant";
      return;
    }
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
    .filter((entry) => entry.type === "input_text" && typeof entry.text === "string")
    .map((entry) => entry.text as string)
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

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
  CLAUDE_CODE_IDLE_WINDOW_MS,
  CLAUDE_CODE_RUNNING_WINDOW_MS,
  CLAUDE_CODE_SOURCE_KIND,
} from "./constants";
import {
  type AssistantRecord,
  type ClaudeCodeSessionRecord,
  type ProgressRecord,
  parseAgentProgressData,
  parseSessionRecord,
  type UserRecord,
} from "./schemas";

export interface ClaudeCodeTranscriptSourceResult {
  agents: CanonicalAgentSnapshot[];
  connected: boolean;
  sourceLabel: string;
  warnings: string[];
}

export interface ClaudeCodeTranscriptSourceOptions {
  sourcePaths: string[];
  sourceLabel?: string;
}

export interface ClaudeCodeTranscriptSource {
  readonly sourceKind: typeof CLAUDE_CODE_SOURCE_KIND;
  connect(): void;
  disconnect(): void;
  readSnapshot(now?: number): Promise<ClaudeCodeTranscriptSourceResult>;
}

interface SubagentParseState {
  agentId: string;
  prompt: string | undefined;
  firstSeenAt: number;
  lastSeenAt: number;
  progressCount: number;
}

interface SessionParseState {
  sessionId: string | undefined;
  model: string | undefined;
  gitBranch: string | undefined;
  cwd: string | undefined;
  version: string | undefined;
  permissionMode: string | undefined;
  latestUserContent: string | undefined;
  latestTimestamp: number | undefined;
  firstTimestamp: number | undefined;
  latestRecordType: string | undefined;
  lastAssistantHadToolUse: boolean;
  messageCount: number;
  toolCallCount: number;
  subagents: Map<string, SubagentParseState>;
}

interface SessionFileCache {
  mtimeMs: number;
  sizeBytes: number;
  lineCount: number;
  state: SessionParseState;
  fileUpdatedAt: number;
}

interface SourceState {
  connected: boolean;
  fileCache: Map<string, SessionFileCache>;
}

export function createClaudeCodeTranscriptSource(
  options: ClaudeCodeTranscriptSourceOptions,
): ClaudeCodeTranscriptSource {
  const sourcePaths = Array.isArray(options.sourcePaths) ? [...options.sourcePaths] : [];
  const sourceLabel = options.sourceLabel ?? CLAUDE_CODE_SOURCE_KIND;
  const state: SourceState = {
    connected: false,
    fileCache: new Map(),
  };

  return {
    sourceKind: CLAUDE_CODE_SOURCE_KIND,
    connect(): void {
      state.connected = true;
    },
    disconnect(): void {
      state.connected = false;
      state.fileCache.clear();
    },
    readSnapshot: (now: number = Date.now()) =>
      performReadSnapshot(state, sourcePaths, sourceLabel, now),
  };
}

function performReadSnapshot(
  state: SourceState,
  sourcePaths: readonly string[],
  sourceLabel: string,
  now: number,
): Promise<ClaudeCodeTranscriptSourceResult> {
  if (!state.connected) {
    return Promise.resolve({
      agents: [],
      connected: false,
      sourceLabel,
      warnings: ["Claude Code transcript source is disconnected."],
    });
  }

  if (sourcePaths.length === 0) {
    return Promise.resolve({
      agents: [],
      connected: false,
      sourceLabel,
      warnings: ["No session paths configured."],
    });
  }

  return collectSourceResults(state, sourcePaths, sourceLabel, now);
}

async function collectSourceResults(
  state: SourceState,
  sourcePaths: readonly string[],
  sourceLabel: string,
  now: number,
): Promise<ClaudeCodeTranscriptSourceResult> {
  const orderedIds: string[] = [];
  const latestById = new Map<string, CanonicalAgentSnapshot>();
  const warnings: string[] = [];
  let hasReadError = false;
  let successfulReads = 0;

  for (const sourcePath of sourcePaths) {
    const result = await processSourceFile(sourcePath, now, state.fileCache);
    warnings.push(...result.warnings);
    if (result.success) {
      successfulReads += 1;
    } else {
      hasReadError = true;
    }
    mergeAgents(result.agents, orderedIds, latestById);
  }

  pruneStaleCache(state.fileCache, sourcePaths);

  const agents = orderedIds
    .map((id) => latestById.get(id))
    .filter((agent): agent is CanonicalAgentSnapshot => agent !== undefined);

  return {
    agents,
    connected: successfulReads > 0 || !hasReadError,
    sourceLabel,
    warnings,
  };
}

interface ParseStrategy {
  state: SessionParseState;
  startLine: number;
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

  const cacheHit = tryCacheHit(cached, fileUpdatedAt, fileSizeBytes, now, fileCache, sourcePath);
  if (cacheHit) {
    return cacheHit;
  }

  return parseAndCacheFile(sourcePath, now, fileCache, cached, fileUpdatedAt, fileSizeBytes);
}

function tryCacheHit(
  cached: SessionFileCache | undefined,
  fileUpdatedAt: number,
  fileSizeBytes: number,
  now: number,
  fileCache: Map<string, SessionFileCache>,
  sourcePath: string,
): ProcessFileResult | undefined {
  if (!cached) {
    return undefined;
  }

  if (cached.mtimeMs === fileUpdatedAt && cached.sizeBytes === fileSizeBytes) {
    return {
      agents: resolveAgentsFromState(cached.state, cached.fileUpdatedAt, now),
      success: true,
      warnings: [],
    };
  }

  const contentChanged = fileSizeBytes !== cached.sizeBytes;
  if (!contentChanged) {
    fileCache.set(sourcePath, { ...cached, mtimeMs: fileUpdatedAt });
    return {
      agents: resolveAgentsFromState(cached.state, cached.fileUpdatedAt, now),
      success: true,
      warnings: [],
    };
  }

  return undefined;
}

async function parseAndCacheFile(
  sourcePath: string,
  now: number,
  fileCache: Map<string, SessionFileCache>,
  cached: SessionFileCache | undefined,
  fileUpdatedAt: number,
  fileSizeBytes: number,
): Promise<ProcessFileResult> {
  const contents = await readSourceFile(sourcePath);
  if (contents === null) {
    return {
      agents: [],
      success: false,
      warnings: [`Failed to read session path: ${sourcePath}`],
    };
  }

  const lines = contents.split(/\r?\n/);
  const { state, startLine } = resolveParseStrategy(cached, fileSizeBytes, lines.length);
  const warnings: string[] = [];

  accumulateLines(state, lines, startLine, sourcePath, warnings);

  fileCache.set(sourcePath, {
    mtimeMs: fileUpdatedAt,
    sizeBytes: fileSizeBytes,
    lineCount: lines.length,
    state: cloneParseState(state),
    fileUpdatedAt,
  });

  return {
    agents: resolveAgentsFromState(state, fileUpdatedAt, now),
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
    version: undefined,
    permissionMode: undefined,
    latestUserContent: undefined,
    latestTimestamp: undefined,
    firstTimestamp: undefined,
    latestRecordType: undefined,
    lastAssistantHadToolUse: false,
    messageCount: 0,
    toolCallCount: 0,
    subagents: new Map(),
  };
}

function cloneParseState(state: SessionParseState): SessionParseState {
  const clonedSubagents = new Map<string, SubagentParseState>();
  for (const [key, value] of state.subagents) {
    clonedSubagents.set(key, { ...value });
  }
  return { ...state, subagents: clonedSubagents };
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

    const record = parseSessionRecord(parsed);
    if (record === null) {
      continue;
    }

    accumulateRecord(state, record);
  }
}

function extractTextContent(
  content: string | Array<{ type: string; text?: string }>,
): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  const joined = content
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text ?? "")
    .join(" ");
  return joined.length > 0 ? joined : undefined;
}

function accumulateRecord(state: SessionParseState, record: ClaudeCodeSessionRecord): void {
  if (!accumulateBaseFields(state, record)) {
    return;
  }

  if (record.type === "user") {
    accumulateUserRecord(state, record);
    return;
  }
  if (record.type === "assistant") {
    accumulateAssistantRecord(state, record);
    return;
  }
  if (record.type === "progress") {
    accumulateProgressRecord(state, record);
    return;
  }
  state.latestRecordType = "system";
}

function accumulateBaseFields(state: SessionParseState, record: ClaudeCodeSessionRecord): boolean {
  if (!state.sessionId) {
    state.sessionId = record.sessionId;
  }
  state.gitBranch = record.gitBranch;
  state.cwd = record.cwd;
  state.version = record.version;

  const timestamp = parseTimestampMs(record.timestamp);
  if (timestamp === undefined) {
    return false;
  }
  if (!state.firstTimestamp || timestamp < state.firstTimestamp) {
    state.firstTimestamp = timestamp;
  }
  if (!state.latestTimestamp || timestamp > state.latestTimestamp) {
    state.latestTimestamp = timestamp;
  }
  return true;
}

function accumulateUserRecord(state: SessionParseState, record: UserRecord): void {
  state.messageCount += 1;
  state.latestRecordType = "user";
  const extracted = extractTextContent(record.message.content);
  if (extracted) {
    state.latestUserContent = extracted;
  }
  if ("permissionMode" in record && typeof record.permissionMode === "string") {
    state.permissionMode = record.permissionMode;
  }
}

function accumulateAssistantRecord(state: SessionParseState, record: AssistantRecord): void {
  state.messageCount += 1;
  state.latestRecordType = "assistant";
  if (record.message.model) {
    state.model = record.message.model;
  }
  const toolUseEntries = record.message.content.filter((entry) => entry.type === "tool_use");
  state.lastAssistantHadToolUse = toolUseEntries.length > 0;
  state.toolCallCount += toolUseEntries.length;
}

function accumulateProgressRecord(state: SessionParseState, record: ProgressRecord): void {
  state.latestRecordType = "progress";
  const agentProgress = parseAgentProgressData(record.data);
  if (agentProgress) {
    const timestamp = parseTimestampMs(record.timestamp);
    if (timestamp !== undefined) {
      accumulateSubagent(state, agentProgress.agentId, agentProgress.prompt, timestamp);
    }
  }
}

function accumulateSubagent(
  state: SessionParseState,
  agentId: string,
  prompt: string | undefined,
  timestamp: number,
): void {
  const existing = state.subagents.get(agentId);
  if (existing) {
    existing.lastSeenAt = timestamp;
    existing.progressCount += 1;
  } else {
    state.subagents.set(agentId, {
      agentId,
      prompt,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      progressCount: 1,
    });
  }
}

function resolveAgentsFromState(
  state: SessionParseState,
  fileUpdatedAt: number,
  now: number,
): CanonicalAgentSnapshot[] {
  if (!state.sessionId || state.messageCount === 0) {
    return [];
  }

  const sessionId = state.sessionId;
  const parentAgent = buildParentAgent(state, sessionId, fileUpdatedAt, now);
  const subagentSnapshots = buildSubagents(state, sessionId, now);
  return [parentAgent, ...subagentSnapshots];
}

function buildParentAgent(
  state: SessionParseState,
  sessionId: string,
  fileUpdatedAt: number,
  now: number,
): CanonicalAgentSnapshot {
  const parentId = deriveAgentId(sessionId);
  const parentUpdatedAt = state.latestTimestamp ?? fileUpdatedAt;
  return {
    id: parentId,
    name: deriveAgentName(parentId, false),
    kind: CANONICAL_AGENT_KIND.local,
    isSubagent: false,
    status: deriveStatus(now, parentUpdatedAt),
    taskSummary: state.latestUserContent ?? "Working",
    startedAt: state.firstTimestamp,
    updatedAt: fileUpdatedAt,
    source: CLAUDE_CODE_SOURCE_KIND,
    metadata: {
      model: state.model,
      gitBranch: state.gitBranch,
      version: state.version,
      cwd: state.cwd,
      permissionMode: state.permissionMode,
      messageCount: state.messageCount,
      toolCallCount: state.toolCallCount,
    },
  };
}

function buildSubagents(
  state: SessionParseState,
  sessionId: string,
  now: number,
): CanonicalAgentSnapshot[] {
  const agents: CanonicalAgentSnapshot[] = [];
  for (const [agentId, sub] of state.subagents) {
    const subId = `${sessionId}:${agentId}`;
    agents.push({
      id: subId,
      name: deriveAgentName(agentId, true),
      kind: CANONICAL_AGENT_KIND.local,
      isSubagent: true,
      status: deriveStatus(now, sub.lastSeenAt),
      taskSummary: sub.prompt ?? "Working",
      startedAt: sub.firstSeenAt,
      updatedAt: sub.lastSeenAt,
      source: CLAUDE_CODE_SOURCE_KIND,
      metadata: {
        model: state.model,
        gitBranch: state.gitBranch,
        parentSessionId: sessionId,
        progressCount: sub.progressCount,
      },
    });
  }
  return agents;
}

function deriveStatus(now: number, updatedAt: number): CanonicalAgentStatus {
  const ageMs = Math.max(0, now - updatedAt);
  if (ageMs <= CLAUDE_CODE_RUNNING_WINDOW_MS) {
    return CANONICAL_AGENT_STATUS.running;
  }
  if (ageMs <= CLAUDE_CODE_IDLE_WINDOW_MS) {
    return CANONICAL_AGENT_STATUS.idle;
  }
  return CANONICAL_AGENT_STATUS.completed;
}

function deriveAgentId(sessionId: string): string {
  return path.basename(sessionId, ".jsonl") || sessionId;
}

function deriveAgentName(id: string, isSubagent: boolean): string {
  const prefix = isSubagent ? "Subagent" : "Session";
  return `${prefix} ${id.slice(0, AGENT_NAME_PREFIX_LENGTH)}`;
}

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  CANONICAL_AGENT_KIND,
  CANONICAL_AGENT_STATUS,
  type CanonicalAgentSnapshot,
  type CanonicalAgentStatus,
} from "@/core/model";
import { formatLineWarning } from "@/providers/shared/discovery-utils";
import { mergeAgents, pruneStaleCache } from "@/providers/shared/provider-utils";
import {
  parseSessionRecord,
  parseAgentProgressData,
  type ClaudeCodeSessionRecord,
  type UserRecord,
  type AssistantRecord,
  type ProgressRecord,
} from "./schemas";
import {
  CLAUDE_CODE_SOURCE_KIND,
  CLAUDE_CODE_RUNNING_WINDOW_MS,
  CLAUDE_CODE_IDLE_WINDOW_MS,
} from "./constants";

// --- Types ---

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

// --- Parse state ---

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

// --- Factory ---

export function createClaudeCodeTranscriptSource(
  options: ClaudeCodeTranscriptSourceOptions,
): ClaudeCodeTranscriptSource {
  const sourcePaths = Array.isArray(options.sourcePaths) ? [...options.sourcePaths] : [];
  const sourceLabel = options.sourceLabel ?? CLAUDE_CODE_SOURCE_KIND;
  let connected = false;
  const fileCache = new Map<string, SessionFileCache>();

  function connect(): void {
    connected = true;
  }

  function disconnect(): void {
    connected = false;
    fileCache.clear();
  }

  async function readSnapshot(now: number = Date.now()): Promise<ClaudeCodeTranscriptSourceResult> {
    if (!connected) {
      return {
        agents: [],
        connected: false,
        sourceLabel,
        warnings: ["Claude Code transcript source is disconnected."],
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
    sourceKind: CLAUDE_CODE_SOURCE_KIND,
    connect,
    disconnect,
    readSnapshot,
  };
}

// --- Per-file processing ---

interface FileStatResult {
  fileUpdatedAt: number;
  fileSizeBytes: number;
}

function statSourceFile(sourcePath: string, fallbackTimestamp: number): Promise<FileStatResult> {
  return stat(sourcePath)
    .then((stats) => ({
      fileUpdatedAt: Math.round(stats.mtimeMs),
      fileSizeBytes: stats.size,
    }))
    .catch(() => ({
      fileUpdatedAt: fallbackTimestamp,
      fileSizeBytes: 0,
    }));
}

function readSourceFile(sourcePath: string): Promise<string | null> {
  return readFile(sourcePath, "utf8").catch(() => null);
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

interface ProcessFileResult {
  agents: CanonicalAgentSnapshot[];
  success: boolean;
  warnings: string[];
}

async function processSourceFile(
  sourcePath: string,
  now: number,
  fileCache: Map<string, SessionFileCache>,
): Promise<ProcessFileResult> {
  const warnings: string[] = [];
  const { fileUpdatedAt, fileSizeBytes } = await statSourceFile(sourcePath, now);

  const cached = fileCache.get(sourcePath);

  // Cache hit: mtime and size unchanged
  if (cached && cached.mtimeMs === fileUpdatedAt && cached.sizeBytes === fileSizeBytes) {
    return {
      agents: resolveAgentsFromState(cached.state, cached.fileUpdatedAt, now),
      success: true,
      warnings,
    };
  }

  const contentChanged = !cached || fileSizeBytes !== cached.sizeBytes;
  const effectiveUpdatedAt = contentChanged ? fileUpdatedAt : cached.fileUpdatedAt;

  // Mtime changed but size identical: update mtime, reuse state
  if (cached && !contentChanged) {
    fileCache.set(sourcePath, { ...cached, mtimeMs: fileUpdatedAt });
    return {
      agents: resolveAgentsFromState(cached.state, effectiveUpdatedAt, now),
      success: true,
      warnings,
    };
  }

  // Content changed: read and parse
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

// --- Parse state management ---

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

// --- Line accumulator ---

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
      // Silently skip file-history-snapshot, queue-operation, and unknown records
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
  accumulateBaseFields(state, record);

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

function accumulateBaseFields(state: SessionParseState, record: ClaudeCodeSessionRecord): void {
  if (!state.sessionId) {
    state.sessionId = record.sessionId;
  }
  state.gitBranch = record.gitBranch;
  state.cwd = record.cwd;
  state.version = record.version;

  const timestamp = new Date(record.timestamp).getTime();
  if (!state.firstTimestamp || timestamp < state.firstTimestamp) {
    state.firstTimestamp = timestamp;
  }
  if (!state.latestTimestamp || timestamp > state.latestTimestamp) {
    state.latestTimestamp = timestamp;
  }
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
    const timestamp = new Date(record.timestamp).getTime();
    accumulateSubagent(state, agentProgress.agentId, agentProgress.prompt, timestamp);
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

// --- Agent resolution ---

function resolveAgentsFromState(
  state: SessionParseState,
  fileUpdatedAt: number,
  now: number,
): CanonicalAgentSnapshot[] {
  if (!state.sessionId || state.messageCount === 0) {
    return [];
  }

  const agents: CanonicalAgentSnapshot[] = [];

  // Parent agent
  const parentId = deriveAgentId(state.sessionId);
  const parentUpdatedAt = state.latestTimestamp ?? fileUpdatedAt;
  agents.push({
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
  });

  // Subagents
  for (const [agentId, sub] of state.subagents) {
    const subId = `${state.sessionId}:${agentId}`;
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
        parentSessionId: state.sessionId,
        progressCount: sub.progressCount,
      },
    });
  }

  return agents;
}

// --- Status inference (conservative, time-window based) ---

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

// --- Helpers ---

function deriveAgentId(sessionId: string): string {
  // Use the session filename (without extension) as the ID
  return path.basename(sessionId, ".jsonl") || sessionId;
}

function deriveAgentName(id: string, isSubagent: boolean): string {
  const prefix = isSubagent ? "Subagent" : "Session";
  return `${prefix} ${id.slice(0, 6)}`;
}

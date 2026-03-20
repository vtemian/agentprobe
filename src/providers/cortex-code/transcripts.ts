import {
  CANONICAL_AGENT_KIND,
  CANONICAL_AGENT_STATUS,
  type CanonicalAgentSnapshot,
  type CanonicalAgentStatus,
} from "@/core/model";
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
  CORTEX_CODE_IDLE_WINDOW_MS,
  CORTEX_CODE_RUNNING_WINDOW_MS,
  CORTEX_CODE_SOURCE_KIND,
} from "./constants";
import {
  type ContentBlock,
  type CortexCodeConversation,
  extractUserTaskSummary,
  type HistoryMessage,
  parseConversation,
} from "./schemas";

export interface CortexCodeTranscriptSourceResult {
  agents: CanonicalAgentSnapshot[];
  connected: boolean;
  sourceLabel: string;
  warnings: string[];
}

export interface CortexCodeTranscriptSourceOptions {
  sourcePaths: string[];
  sourceLabel?: string;
}

export interface CortexCodeTranscriptSource {
  readonly sourceKind: typeof CORTEX_CODE_SOURCE_KIND;
  connect(): void;
  disconnect(): void;
  readSnapshot(now?: number): Promise<CortexCodeTranscriptSourceResult>;
}

interface SessionFileCache {
  mtimeMs: number;
  sizeBytes: number;
  agent: CanonicalAgentSnapshot;
  fileUpdatedAt: number;
}

interface SourceState {
  connected: boolean;
  fileCache: Map<string, SessionFileCache>;
}

export function createCortexCodeTranscriptSource(
  options: CortexCodeTranscriptSourceOptions,
): CortexCodeTranscriptSource {
  const sourcePaths = Array.isArray(options.sourcePaths) ? [...options.sourcePaths] : [];
  const sourceLabel = options.sourceLabel ?? CORTEX_CODE_SOURCE_KIND;
  const state: SourceState = {
    connected: false,
    fileCache: new Map(),
  };

  return {
    sourceKind: CORTEX_CODE_SOURCE_KIND,
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
): Promise<CortexCodeTranscriptSourceResult> {
  if (!state.connected) {
    return Promise.resolve({
      agents: [],
      connected: false,
      sourceLabel,
      warnings: ["Cortex Code transcript source is disconnected."],
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
): Promise<CortexCodeTranscriptSourceResult> {
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

async function processSourceFile(
  sourcePath: string,
  now: number,
  fileCache: Map<string, SessionFileCache>,
): Promise<ProcessFileResult> {
  const { fileUpdatedAt, fileSizeBytes } = await statSourceFile(sourcePath, now);
  const cached = fileCache.get(sourcePath);

  if (cached && cached.mtimeMs === fileUpdatedAt && cached.sizeBytes === fileSizeBytes) {
    return {
      agents: [recalculateStatus(cached.agent, cached.fileUpdatedAt, now)],
      success: true,
      warnings: [],
    };
  }

  return parseAndCacheFile(sourcePath, now, fileCache, fileUpdatedAt, fileSizeBytes);
}

function failedResult(warning: string): ProcessFileResult {
  return { agents: [], success: false, warnings: [warning] };
}

function parseJsonConversation(contents: string): CortexCodeConversation | null {
  try {
    return parseConversation(JSON.parse(contents));
  } catch {
    return null;
  }
}

async function parseAndCacheFile(
  sourcePath: string,
  now: number,
  fileCache: Map<string, SessionFileCache>,
  fileUpdatedAt: number,
  fileSizeBytes: number,
): Promise<ProcessFileResult> {
  const contents = await readSourceFile(sourcePath);
  if (contents === null) {
    return failedResult(`Failed to read conversation: ${sourcePath}`);
  }

  const conversation = parseJsonConversation(contents);
  if (!conversation) {
    return failedResult(`Failed to parse conversation: ${sourcePath}`);
  }

  const agent = conversationToAgent(conversation, fileUpdatedAt, now);
  fileCache.set(sourcePath, {
    mtimeMs: fileUpdatedAt,
    sizeBytes: fileSizeBytes,
    agent,
    fileUpdatedAt,
  });

  return { agents: [agent], success: true, warnings: [] };
}

function conversationToAgent(
  conversation: CortexCodeConversation,
  fileUpdatedAt: number,
  now: number,
): CanonicalAgentSnapshot {
  const sessionId = conversation.session_id;
  const title = conversation.title ?? "";
  const isSubagent = conversation.session_type === "subagent";
  const taskSummary = extractUserTaskSummary(conversation.history);

  const startedAt = parseTimestampMs(conversation.created_at ?? "");
  const updatedAt = parseTimestampMs(conversation.last_updated ?? "") ?? fileUpdatedAt;

  const status = resolveStatus(conversation.history, updatedAt, now);
  const metadata = extractMetadata(conversation);

  const name =
    title.length > 0 && !title.startsWith("Chat for session:")
      ? title
      : sessionId.slice(0, AGENT_NAME_PREFIX_LENGTH);

  return {
    id: sessionId,
    name,
    kind: CANONICAL_AGENT_KIND.local,
    isSubagent,
    status,
    taskSummary,
    startedAt,
    updatedAt,
    source: CORTEX_CODE_SOURCE_KIND,
    metadata,
  };
}

function resolveStatus(
  history: readonly HistoryMessage[],
  updatedAt: number,
  now: number,
): CanonicalAgentStatus {
  const elapsed = now - updatedAt;

  if (elapsed > CORTEX_CODE_IDLE_WINDOW_MS) {
    return CANONICAL_AGENT_STATUS.completed;
  }

  if (elapsed <= CORTEX_CODE_RUNNING_WINDOW_MS) {
    const lastMessage = findLastNonEmptyMessage(history);
    if (!lastMessage) {
      return CANONICAL_AGENT_STATUS.running;
    }
    if (isActivelyWorking(lastMessage)) {
      return CANONICAL_AGENT_STATUS.running;
    }
  }

  return CANONICAL_AGENT_STATUS.idle;
}

function findLastNonEmptyMessage(history: readonly HistoryMessage[]): HistoryMessage | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].content.length > 0) {
      return history[i];
    }
  }
  return undefined;
}

function isActivelyWorking(message: HistoryMessage): boolean {
  if (message.role === "user") {
    return hasToolResults(message.content);
  }
  return hasToolUseCalls(message.content);
}

function hasToolResults(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((block) => block.type === "tool_result");
}

function hasToolUseCalls(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((block) => block.type === "tool_use");
}

function recalculateStatus(
  agent: CanonicalAgentSnapshot,
  _fileUpdatedAt: number,
  now: number,
): CanonicalAgentSnapshot {
  const elapsed = now - agent.updatedAt;

  if (elapsed > CORTEX_CODE_IDLE_WINDOW_MS) {
    return agent.status === CANONICAL_AGENT_STATUS.completed
      ? agent
      : { ...agent, status: CANONICAL_AGENT_STATUS.completed };
  }

  if (elapsed > CORTEX_CODE_RUNNING_WINDOW_MS && agent.status === CANONICAL_AGENT_STATUS.running) {
    return { ...agent, status: CANONICAL_AGENT_STATUS.idle };
  }

  return agent;
}

interface ConversationMetadata extends Record<string, unknown> {
  connectionName?: string;
  messageCount: number;
  toolCallCount: number;
  sessionType?: string;
}

function countToolUseCalls(messages: readonly HistoryMessage[]): number {
  return messages.flatMap((m) => m.content).filter((b) => b.type === "tool_use").length;
}

function extractMetadata(conversation: CortexCodeConversation): ConversationMetadata {
  let messageCount = 0;

  for (const message of conversation.history) {
    if (message.role === "user" && hasNonInternalContent(message)) {
      messageCount += 1;
    }
  }

  return {
    connectionName: conversation.connection_name,
    messageCount,
    toolCallCount: countToolUseCalls(conversation.history),
    sessionType: conversation.session_type,
  };
}

function hasNonInternalContent(message: HistoryMessage): boolean {
  return message.content.some(
    (block) =>
      block.type === "text" &&
      !block.internalOnly &&
      block.text !== undefined &&
      block.text.trim().length > 0 &&
      !block.text.startsWith("<system-reminder>"),
  );
}

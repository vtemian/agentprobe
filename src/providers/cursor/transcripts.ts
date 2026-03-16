import path from "node:path";
import { z } from "zod";
import {
  CANONICAL_AGENT_KIND,
  CANONICAL_AGENT_STATUS,
  type CanonicalAgentKind,
  type CanonicalAgentSnapshot,
  type CanonicalAgentStatus,
} from "@/core/model";
import { formatLineWarning } from "@/providers/shared/discovery";
import {
  mergeAgents,
  type ProcessFileResult,
  pruneStaleCache,
  readSourceFile,
  statSourceFile,
} from "@/providers/shared/providers";
import {
  AGENT_COMPLETION_QUIET_WINDOW_MS,
  AGENT_NAME_PREFIX_LENGTH,
  CURSOR_IDLE_WINDOW_MS,
  CURSOR_RUNNING_WINDOW_MS,
  CURSOR_SOURCE_KIND,
  STREAMING_QUIET_WINDOW_MS,
} from "./constants";

interface CursorTranscriptRecord {
  agentId: string;
  agentName: string;
  kind?: string;
  status: string;
  task: string;
  startedAt?: number;
  updatedAt: number;
}

interface ConversationTranscriptRecord {
  role: string;
  text?: string;
}

type ConversationSignal = "active" | "completed" | "error";

const nonEmptyStringSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

const finiteNumberSchema = z.number().refine(Number.isFinite);
const agentStatusSchema = z.nativeEnum(CANONICAL_AGENT_STATUS);
const agentKindSchema = z.nativeEnum(CANONICAL_AGENT_KIND);

const flatTranscriptRecordSchema = z.object({
  agentId: nonEmptyStringSchema,
  agentName: nonEmptyStringSchema,
  kind: nonEmptyStringSchema.optional(),
  status: nonEmptyStringSchema,
  task: nonEmptyStringSchema,
  startedAt: finiteNumberSchema.optional(),
  updatedAt: finiteNumberSchema,
});

const conversationContentEntrySchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});

interface TranscriptParseState {
  latestUserTask: string | undefined;
  sawConversationRecord: boolean;
  latestConversationSignal: ConversationSignal | undefined;
  latestConversationRole: string | undefined;
  sawUserTurn: boolean;
  hasAssistantReplyAfterLatestUser: boolean;
  flatAgents: CanonicalAgentSnapshot[];
}

interface TranscriptFileCache {
  mtimeMs: number;
  sizeBytes: number;
  lineCount: number;
  state: TranscriptParseState;
  fileUpdatedAt: number;
}

const conversationLineSchema = z.object({
  role: nonEmptyStringSchema,
  message: z
    .object({
      content: z.array(conversationContentEntrySchema),
    })
    .optional(),
});

export interface CursorTranscriptSourceResult {
  agents: CanonicalAgentSnapshot[];
  connected: boolean;
  sourceLabel: string;
  warnings: string[];
}

export interface CursorTranscriptSourceOptions {
  sourcePaths: string[];
  sourceLabel?: string;
}

export interface CursorTranscriptSource {
  readonly sourceKind: typeof CURSOR_SOURCE_KIND;
  connect(): void;
  disconnect(): void;
  readSnapshot(now?: number): Promise<CursorTranscriptSourceResult>;
}

interface TranscriptSourceState {
  readonly sourcePaths: readonly string[];
  readonly sourceLabel: string;
  connected: boolean;
  readonly fileCache: Map<string, TranscriptFileCache>;
}

export function createCursorTranscriptSource(
  options: CursorTranscriptSourceOptions,
): CursorTranscriptSource {
  const state: TranscriptSourceState = {
    sourcePaths: Array.isArray(options.sourcePaths) ? [...options.sourcePaths] : [],
    sourceLabel: options.sourceLabel ?? CURSOR_SOURCE_KIND,
    connected: false,
    fileCache: new Map(),
  };

  return {
    sourceKind: CURSOR_SOURCE_KIND,
    connect: () => {
      state.connected = true;
    },
    disconnect: () => {
      state.connected = false;
      state.fileCache.clear();
    },
    readSnapshot: (now: number = Date.now()) => readSnapshot(state, now),
  };
}

async function readSnapshot(
  state: TranscriptSourceState,
  now: number,
): Promise<CursorTranscriptSourceResult> {
  if (!state.connected) {
    return disconnectedResult(state.sourceLabel, "Cursor transcript source is disconnected.");
  }

  if (state.sourcePaths.length === 0) {
    return disconnectedResult(state.sourceLabel, "No transcript paths configured.");
  }

  const { agents, warnings, successfulReads, hasReadError } = await aggregateSourceFiles(
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

function disconnectedResult(sourceLabel: string, warning: string): CursorTranscriptSourceResult {
  return { agents: [], connected: false, sourceLabel, warnings: [warning] };
}

interface AggregateResult {
  agents: CanonicalAgentSnapshot[];
  warnings: string[];
  successfulReads: number;
  hasReadError: boolean;
}

async function aggregateSourceFiles(
  sourcePaths: readonly string[],
  now: number,
  fileCache: Map<string, TranscriptFileCache>,
): Promise<AggregateResult> {
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

  pruneStaleCache(fileCache, [...sourcePaths]);

  const agents = orderedIds
    .map((id) => latestById.get(id))
    .filter((agent): agent is CanonicalAgentSnapshot => agent !== undefined);

  return { agents, warnings, successfulReads, hasReadError };
}

interface ParseStrategy {
  state: TranscriptParseState;
  startLine: number;
}

function resolveParseStrategy(
  cached: TranscriptFileCache | undefined,
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
  fileCache: Map<string, TranscriptFileCache>,
): Promise<ProcessFileResult> {
  const { fileUpdatedAt, fileSizeBytes } = await statSourceFile(sourcePath, now);
  const cached = fileCache.get(sourcePath);

  const cacheHit = tryCacheHit(cached, fileUpdatedAt, fileSizeBytes, sourcePath, now);
  if (cacheHit) {
    if (cacheHit.updatedCache) {
      fileCache.set(sourcePath, cacheHit.updatedCache);
    }
    return cacheHit.result;
  }

  return parseAndCacheFile(sourcePath, now, fileCache, fileSizeBytes, fileUpdatedAt, cached);
}

interface CacheHitResult {
  result: ProcessFileResult;
  updatedCache?: TranscriptFileCache;
}

function tryCacheHit(
  cached: TranscriptFileCache | undefined,
  fileUpdatedAt: number,
  fileSizeBytes: number,
  sourcePath: string,
  now: number,
): CacheHitResult | null {
  if (!cached) {
    return null;
  }

  if (cached.mtimeMs === fileUpdatedAt && cached.sizeBytes === fileSizeBytes) {
    return {
      result: {
        agents: resolveAgentsFromState(cached.state, sourcePath, cached.fileUpdatedAt, now),
        success: true,
        warnings: [],
      },
    };
  }

  const contentChanged = fileSizeBytes !== cached.sizeBytes;
  if (!contentChanged) {
    return {
      result: {
        agents: resolveAgentsFromState(cached.state, sourcePath, cached.fileUpdatedAt, now),
        success: true,
        warnings: [],
      },
      updatedCache: { ...cached, mtimeMs: fileUpdatedAt },
    };
  }

  return null;
}

async function parseAndCacheFile(
  sourcePath: string,
  now: number,
  fileCache: Map<string, TranscriptFileCache>,
  fileSizeBytes: number,
  fileUpdatedAt: number,
  cached: TranscriptFileCache | undefined,
): Promise<ProcessFileResult> {
  const warnings: string[] = [];
  const contents = await readSourceFile(sourcePath);
  if (contents === null) {
    warnings.push(`Failed to read transcript path: ${sourcePath}`);
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
    fileUpdatedAt,
  });

  return {
    agents: resolveAgentsFromState(state, sourcePath, fileUpdatedAt, now),
    success: true,
    warnings,
  };
}

function createInitialParseState(): TranscriptParseState {
  return {
    latestUserTask: undefined,
    sawConversationRecord: false,
    latestConversationSignal: undefined,
    latestConversationRole: undefined,
    sawUserTurn: false,
    hasAssistantReplyAfterLatestUser: false,
    flatAgents: [],
  };
}

function cloneParseState(state: TranscriptParseState): TranscriptParseState {
  return { ...state, flatAgents: [...state.flatAgents] };
}

function accumulateLines(
  state: TranscriptParseState,
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

    const record = parseFlatRecord(parsed);
    if (!record) {
      accumulateConversationLine(state, parsed, sourcePath, warnings, i);
      continue;
    }

    accumulateFlatRecord(state, record, sourcePath, warnings, i);
  }
}

function accumulateConversationLine(
  state: TranscriptParseState,
  parsed: unknown,
  sourcePath: string,
  warnings: string[],
  lineIndex: number,
): void {
  const conversationRecord = parseConversationRecord(parsed);
  if (!conversationRecord) {
    warnings.push(formatLineWarning(sourcePath, lineIndex + 1, "Unrecognized transcript record."));
    return;
  }

  state.sawConversationRecord = true;
  state.latestConversationRole = conversationRecord.role;

  if (conversationRecord.role === "user" && conversationRecord.text) {
    state.latestUserTask = sanitizeTaskSummary(conversationRecord.text);
    state.latestConversationSignal = "active";
    state.sawUserTurn = true;
    state.hasAssistantReplyAfterLatestUser = false;
  }

  if (conversationRecord.text && isAssistantRole(conversationRecord.role)) {
    if (state.sawUserTurn) {
      state.hasAssistantReplyAfterLatestUser = true;
    }
    const signal = deriveConversationSignal(conversationRecord.text);
    if (signal) {
      state.latestConversationSignal = signal;
    }
  }
}

function accumulateFlatRecord(
  state: TranscriptParseState,
  record: CursorTranscriptRecord,
  sourcePath: string,
  warnings: string[],
  lineIndex: number,
): void {
  const statusResult = agentStatusSchema.safeParse(record.status);
  if (!statusResult.success) {
    warnings.push(formatLineWarning(sourcePath, lineIndex + 1, "Invalid agent status."));
    return;
  }

  const kindResult = parseAgentKind(record.kind);
  if (!kindResult.success) {
    warnings.push(formatLineWarning(sourcePath, lineIndex + 1, "Invalid agent kind."));
    return;
  }

  const snapshot: CanonicalAgentSnapshot = {
    id: record.agentId,
    name: record.agentName,
    kind: kindResult.value,
    isSubagent: isSubagentPath(sourcePath),
    status: statusResult.data,
    taskSummary: record.task,
    updatedAt: record.updatedAt,
    source: CURSOR_SOURCE_KIND,
  };

  if (typeof record.startedAt === "number") {
    snapshot.startedAt = record.startedAt;
  }

  state.flatAgents.push(snapshot);
}

function resolveAgentsFromState(
  state: TranscriptParseState,
  sourcePath: string,
  fileUpdatedAt: number,
  now: number,
): CanonicalAgentSnapshot[] {
  if (state.flatAgents.length > 0 || !state.sawConversationRecord) {
    return state.flatAgents;
  }

  const agentId = deriveAgentId(sourcePath);
  return [
    {
      id: agentId,
      name: deriveAgentName(agentId, sourcePath),
      kind: CANONICAL_AGENT_KIND.local,
      isSubagent: isSubagentPath(sourcePath),
      status: deriveConversationStatus(
        now,
        fileUpdatedAt,
        state.latestConversationSignal,
        state.latestConversationRole,
        state.hasAssistantReplyAfterLatestUser,
      ),
      taskSummary: state.latestUserTask ?? "Working",
      updatedAt: fileUpdatedAt,
      source: CURSOR_SOURCE_KIND,
    },
  ];
}

function parseFlatRecord(value: unknown): CursorTranscriptRecord | null {
  const parsed = flatTranscriptRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseAgentKind(
  value: string | undefined,
): { success: true; value: CanonicalAgentKind } | { success: false } {
  if (value === undefined) {
    return { success: true, value: CANONICAL_AGENT_KIND.local };
  }
  const parsed = agentKindSchema.safeParse(value);
  return parsed.success ? { success: true, value: parsed.data } : { success: false };
}

function parseConversationRecord(value: unknown): ConversationTranscriptRecord | null {
  const parsed = conversationLineSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const { role } = parsed.data;
  const text = (parsed.data.message?.content ?? [])
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("\n");
  return text.length > 0 ? { role, text } : { role };
}

function sanitizeTaskSummary(value: string): string {
  const match = value.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  const query = match ? match[1] : value;
  return query.replace(/\s+/g, " ").trim();
}

function hasErrorMarker(value: string): boolean {
  return /(error|failed|exception|traceback)/i.test(value);
}

function statusAfterAssistantReply(ageMs: number): CanonicalAgentStatus {
  if (ageMs <= STREAMING_QUIET_WINDOW_MS) return CANONICAL_AGENT_STATUS.running;
  if (ageMs <= AGENT_COMPLETION_QUIET_WINDOW_MS) return CANONICAL_AGENT_STATUS.idle;
  return CANONICAL_AGENT_STATUS.completed;
}

function statusWhileAwaitingAssistant(ageMs: number): CanonicalAgentStatus {
  if (ageMs <= CURSOR_IDLE_WINDOW_MS) return CANONICAL_AGENT_STATUS.idle;
  return CANONICAL_AGENT_STATUS.completed;
}

function deriveConversationStatus(
  now: number,
  updatedAt: number,
  latestSignal: ConversationSignal | undefined,
  latestRole: string | undefined,
  hasAssistantReplyAfterLatestUser: boolean,
): CanonicalAgentStatus {
  if (latestSignal === "error") return CANONICAL_AGENT_STATUS.error;
  if (latestSignal === "completed") return CANONICAL_AGENT_STATUS.completed;

  const ageMs = Math.max(0, now - updatedAt);
  const assistantDone =
    hasAssistantReplyAfterLatestUser &&
    isAssistantRole(latestRole ?? "") &&
    latestSignal !== "active";

  if (assistantDone) return statusAfterAssistantReply(ageMs);
  if (ageMs <= CURSOR_RUNNING_WINDOW_MS) return CANONICAL_AGENT_STATUS.running;
  if (latestSignal === "active" && !hasAssistantReplyAfterLatestUser) {
    return statusWhileAwaitingAssistant(ageMs);
  }
  if (ageMs <= CURSOR_IDLE_WINDOW_MS) return CANONICAL_AGENT_STATUS.idle;
  return CANONICAL_AGENT_STATUS.completed;
}

function deriveAgentId(sourcePath: string): string {
  const fileName = path.basename(sourcePath, ".jsonl");
  return fileName.length > 0 ? fileName : sourcePath;
}

function deriveAgentName(agentId: string, sourcePath: string): string {
  const prefix = isSubagentPath(sourcePath) ? "Subagent" : "Agent";
  return `${prefix} ${agentId.slice(0, AGENT_NAME_PREFIX_LENGTH)}`;
}

function isSubagentPath(sourcePath: string): boolean {
  return sourcePath.replaceAll("\\", "/").includes("/subagents/");
}

function isAssistantRole(role: string): boolean {
  return role === "assistant";
}

function deriveConversationSignal(value: string): ConversationSignal | undefined {
  const normalized = value.toLowerCase();
  if (hasInProgressMarker(normalized)) {
    return "active";
  }
  if (hasErrorMarker(value)) {
    return "error";
  }
  if (hasCompletionMarker(value)) {
    return "completed";
  }
  return undefined;
}

function hasCompletionMarker(value: string): boolean {
  const normalized = value.toLowerCase();
  if (hasInProgressMarker(normalized)) {
    return false;
  }
  const hasNegativeCompletion =
    /\b(not done|not completed|still working|in progress|wip|nu este gata|inca lucrez)\b/.test(
      normalized,
    );
  if (hasNegativeCompletion) {
    return false;
  }
  return /\b(done|complete|completed|implemented|finished|all set|ready to test|ready for testing|gata|terminat|finalizat|cu succes)\b/.test(
    normalized,
  );
}

function hasInProgressMarker(normalizedValue: string): boolean {
  return /\b(running command|executing command|sleep\(|task start|still running)\b/.test(
    normalizedValue,
  );
}

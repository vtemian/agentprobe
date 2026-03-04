import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_KIND,
  AGENT_SOURCE_KIND,
  AGENT_STATUS,
  type AgentKind,
  type AgentSnapshot,
  type AgentSourceReadResult,
  type AgentStatus,
} from "@shared/types";
import { z } from "zod";

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
const agentStatusSchema = z.nativeEnum(AGENT_STATUS);
const agentKindSchema = z.nativeEnum(AGENT_KIND);

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

const RUNNING_WINDOW_MS = 60_000;
const IDLE_WINDOW_MS = 5 * 60_000;

const conversationLineSchema = z.object({
  role: nonEmptyStringSchema,
  message: z
    .object({
      content: z.array(conversationContentEntrySchema),
    })
    .optional(),
});

export interface CursorTranscriptSourceOptions {
  sourcePaths: string[];
  sourceLabel?: string;
}

export interface CursorTranscriptSource {
  readonly sourceKind: typeof AGENT_SOURCE_KIND.cursorTranscripts;
  connect(): Promise<void> | void;
  disconnect(): Promise<void> | void;
  readSnapshot(now?: number): Promise<AgentSourceReadResult> | AgentSourceReadResult;
  getWatchPaths?(): string[];
}

export function createCursorTranscriptSource(
  options: CursorTranscriptSourceOptions,
): CursorTranscriptSource {
  const sourcePaths = Array.isArray(options.sourcePaths) ? [...options.sourcePaths] : [];
  const sourceLabel = options.sourceLabel ?? AGENT_SOURCE_KIND.cursorTranscripts;
  let connected = false;

  function connect(): void {
    connected = true;
  }

  function disconnect(): void {
    connected = false;
  }

  async function readSnapshot(now: number = Date.now()): Promise<AgentSourceReadResult> {
    if (!connected) {
      return {
        agents: [],
        connected: false,
        sourceLabel,
        warnings: ["Cursor transcript source is disconnected."],
      };
    }

    if (sourcePaths.length === 0) {
      return {
        agents: [],
        connected: false,
        sourceLabel,
        warnings: ["No transcript paths configured."],
      };
    }

    const warnings: string[] = [];
    const orderedIds: string[] = [];
    const latestById = new Map<string, AgentSnapshot>();
    let hasReadError = false;
    let successfulReads = 0;

    for (const sourcePath of sourcePaths) {
      let contents: string;
      let fileUpdatedAt = now;
      try {
        const stats = await stat(sourcePath);
        fileUpdatedAt = Math.round(stats.mtimeMs);
      } catch {
        // Keep default now timestamp when stat access fails.
      }
      try {
        contents = await readFile(sourcePath, "utf8");
        successfulReads += 1;
      } catch {
        hasReadError = true;
        warnings.push(`Failed to read transcript path: ${sourcePath}`);
        continue;
      }

      const parsedAgents = parseTranscriptFile(contents, sourcePath, warnings, fileUpdatedAt, now);
      for (const parsedAgent of parsedAgents) {
        const existing = latestById.get(parsedAgent.id);
        if (!existing) {
          latestById.set(parsedAgent.id, parsedAgent);
          orderedIds.push(parsedAgent.id);
          continue;
        }

        if (parsedAgent.updatedAt > existing.updatedAt) {
          latestById.set(parsedAgent.id, parsedAgent);
        }
      }
    }

    const agents = orderedIds
      .map((id) => latestById.get(id))
      .filter((agent): agent is AgentSnapshot => Boolean(agent));

    return {
      agents,
      connected: successfulReads > 0 || !hasReadError,
      sourceLabel,
      warnings,
    };
  }

  function parseTranscriptFile(
    contents: string,
    sourcePath: string,
    warnings: string[],
    fileUpdatedAt: number,
    now: number,
  ): AgentSnapshot[] {
    const lines = contents.split(/\r?\n/);
    const agents: AgentSnapshot[] = [];
    let latestUserTask: string | undefined;
    let sawConversationRecord = false;
    let latestConversationSignal: ConversationSignal | undefined;

    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
      const rawLine = lines[lineNumber];
      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        warnings.push(formatLineWarning(sourcePath, lineNumber + 1, "Invalid JSON line."));
        continue;
      }

      const record = parseFlatRecord(parsed);
      if (!record) {
        const conversationRecord = parseConversationRecord(parsed);
        if (!conversationRecord) {
          continue;
        }
        sawConversationRecord = true;
        if (conversationRecord.role === "user" && conversationRecord.text) {
          latestUserTask = sanitizeTaskSummary(conversationRecord.text);
          latestConversationSignal = "active";
        }
        if (conversationRecord.text) {
          if (isAssistantRole(conversationRecord.role)) {
            const signal = deriveConversationSignal(conversationRecord.text);
            if (signal) {
              latestConversationSignal = signal;
            }
          }
        }
        continue;
      }

      const statusResult = agentStatusSchema.safeParse(record.status);
      if (!statusResult.success) {
        warnings.push(formatLineWarning(sourcePath, lineNumber + 1, "Invalid agent status."));
        continue;
      }

      const kindResult = parseAgentKind(record.kind);
      if (!kindResult.success) {
        warnings.push(formatLineWarning(sourcePath, lineNumber + 1, "Invalid agent kind."));
        continue;
      }

      const snapshot: AgentSnapshot = {
        id: record.agentId,
        name: record.agentName,
        kind: kindResult.value,
        status: statusResult.data,
        taskSummary: record.task,
        updatedAt: record.updatedAt,
        source: AGENT_SOURCE_KIND.cursorTranscripts,
      };

      if (typeof record.startedAt === "number") {
        snapshot.startedAt = record.startedAt;
      }

      agents.push(snapshot);
    }

    if (agents.length > 0 || !sawConversationRecord) {
      return agents;
    }

    const agentId = deriveAgentId(sourcePath);
    return [
      {
        id: agentId,
        name: deriveAgentName(agentId, sourcePath),
        kind: AGENT_KIND.local,
        status: deriveConversationStatus(now, fileUpdatedAt, latestConversationSignal),
        taskSummary: latestUserTask ?? "Working",
        updatedAt: fileUpdatedAt,
        source: AGENT_SOURCE_KIND.cursorTranscripts,
      },
    ];
  }

  function formatLineWarning(sourcePath: string, lineNumber: number, reason: string): string {
    return `${sourcePath}:${lineNumber} ${reason}`;
  }

  return {
    sourceKind: AGENT_SOURCE_KIND.cursorTranscripts,
    connect,
    disconnect,
    readSnapshot,
    getWatchPaths(): string[] {
      return [...sourcePaths];
    },
  };
}

function parseFlatRecord(value: unknown): CursorTranscriptRecord | null {
  const parsed = flatTranscriptRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseAgentKind(value: string | undefined): { success: true; value: AgentKind } | { success: false } {
  if (value === undefined) {
    return { success: true, value: AGENT_KIND.local };
  }
  const parsed = agentKindSchema.safeParse(value);
  return parsed.success ? { success: true, value: parsed.data } : { success: false };
}

function parseConversationRecord(value: unknown): ConversationTranscriptRecord | null {
  const parsed = conversationLineSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const role = parsed.data.role;
  const entries = parsed.data.message?.content ?? [];
  const textParts: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "text" || typeof entry.text !== "string") {
      continue;
    }
    const text = entry.text.trim();
    if (text.length > 0) {
      textParts.push(text);
    }
  }
  if (textParts.length > 0) {
    return { role, text: textParts.join("\n") };
  }
  return { role };
}

function sanitizeTaskSummary(value: string): string {
  const match = value.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  const query = match ? match[1] : value;
  return query.replace(/\s+/g, " ").trim();
}

function hasErrorMarker(value: string): boolean {
  return /(error|failed|exception|traceback)/i.test(value);
}

function deriveConversationStatus(
  now: number,
  updatedAt: number,
  latestSignal: ConversationSignal | undefined,
): AgentStatus {
  if (latestSignal === "error") {
    return AGENT_STATUS.error;
  }
  if (latestSignal === "completed") {
    return AGENT_STATUS.completed;
  }
  const ageMs = Math.max(0, now - updatedAt);
  if (ageMs <= RUNNING_WINDOW_MS) {
    return AGENT_STATUS.running;
  }
  if (ageMs <= IDLE_WINDOW_MS) {
    return AGENT_STATUS.idle;
  }
  return AGENT_STATUS.completed;
}

function deriveAgentId(sourcePath: string): string {
  const fileName = path.basename(sourcePath, ".jsonl");
  return fileName.length > 0 ? fileName : sourcePath;
}

function deriveAgentName(agentId: string, sourcePath: string): string {
  const prefix = sourcePath.includes("/subagents/") ? "Subagent" : "Agent";
  return `${prefix} ${agentId.slice(0, 6)}`;
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
  return /\b(done|completed|implemented|finished|all set|ready to test|ready for testing|gata|terminat|finalizat|cu succes)\b/.test(
    normalized,
  );
}

function hasInProgressMarker(normalizedValue: string): boolean {
  return /\b(running command|processing|batch|step\s+\d+|in execut|executing|sleep\(|task start|still running)\b/.test(
    normalizedValue,
  );
}

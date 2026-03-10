import { z } from "zod";

// --- Shared base for structured records (user, assistant, progress, system) ---

const structuredRecordBaseSchema = z.object({
  parentUuid: z.string().nullable(),
  isSidechain: z.boolean(),
  userType: z.string(),
  cwd: z.string(),
  sessionId: z.string(),
  version: z.string(),
  gitBranch: z.string(),
  timestamp: z.string(),
  uuid: z.string(),
  slug: z.string().optional(),
});

// --- Content entries in assistant messages ---

const contentEntrySchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
});

// --- User record ---

const userRecordSchema = structuredRecordBaseSchema.extend({
  type: z.literal("user"),
  message: z.object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(contentEntrySchema)]),
  }),
  permissionMode: z.string().optional(),
});
export type UserRecord = z.infer<typeof userRecordSchema>;

// --- Assistant record ---

const assistantRecordSchema = structuredRecordBaseSchema.extend({
  type: z.literal("assistant"),
  requestId: z.string().optional(),
  message: z.object({
    model: z.string().optional(),
    role: z.literal("assistant"),
    content: z.array(contentEntrySchema),
    stop_reason: z.string().nullable().optional(),
  }),
});
export type AssistantRecord = z.infer<typeof assistantRecordSchema>;

// --- Progress record ---

const progressDataSchema = z.object({
  type: z.string(),
}).passthrough();

const progressRecordSchema = structuredRecordBaseSchema.extend({
  type: z.literal("progress"),
  data: progressDataSchema,
  toolUseID: z.string().optional(),
  parentToolUseID: z.string().optional(),
});
export type ProgressRecord = z.infer<typeof progressRecordSchema>;

// --- Agent progress refinement (used to extract subagent data) ---

const agentProgressDataSchema = z.object({
  type: z.literal("agent_progress"),
  agentId: z.string(),
  prompt: z.string().optional(),
  message: z.unknown().optional(),
});
export type AgentProgressData = z.infer<typeof agentProgressDataSchema>;

export function parseAgentProgressData(data: unknown): AgentProgressData | null {
  const result = agentProgressDataSchema.safeParse(data);
  return result.success ? result.data : null;
}

// --- System record ---

const systemRecordSchema = structuredRecordBaseSchema.extend({
  type: z.literal("system"),
  subtype: z.string(),
});
export type SystemRecord = z.infer<typeof systemRecordSchema>;

// --- Discriminated union of all structured records ---

export type ClaudeCodeSessionRecord =
  | (UserRecord & { type: "user" })
  | (AssistantRecord & { type: "assistant" })
  | (ProgressRecord & { type: "progress" })
  | (SystemRecord & { type: "system" });

// --- Record type discriminator for skippable records ---

const skippableTypeSchema = z.object({
  type: z.enum(["file-history-snapshot", "queue-operation"]),
});

// --- Public parse function ---

export function parseSessionRecord(value: unknown): ClaudeCodeSessionRecord | null {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return null;
  }

  // Skip known non-agent record types
  if (skippableTypeSchema.safeParse(value).success) {
    return null;
  }

  const type = (value as Record<string, unknown>).type;

  if (type === "user") {
    const result = userRecordSchema.safeParse(value);
    return result.success ? result.data : null;
  }
  if (type === "assistant") {
    const result = assistantRecordSchema.safeParse(value);
    return result.success ? result.data : null;
  }
  if (type === "progress") {
    const result = progressRecordSchema.safeParse(value);
    return result.success ? result.data : null;
  }
  if (type === "system") {
    const result = systemRecordSchema.safeParse(value);
    return result.success ? result.data : null;
  }

  return null;
}

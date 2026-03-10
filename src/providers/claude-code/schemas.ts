import { z } from "zod";

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

const contentEntrySchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  thinking: z.string().optional(),
  signature: z.string().optional(),
});

const userRecordSchema = structuredRecordBaseSchema.extend({
  type: z.literal("user"),
  message: z.object({
    role: z.literal("user"),
    content: z.union([z.string(), z.array(contentEntrySchema)]),
  }),
  permissionMode: z.string().optional(),
});
export type UserRecord = z.infer<typeof userRecordSchema>;

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

const progressDataSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

const progressRecordSchema = structuredRecordBaseSchema.extend({
  type: z.literal("progress"),
  data: progressDataSchema,
  toolUseID: z.string().optional(),
  parentToolUseID: z.string().optional(),
});
export type ProgressRecord = z.infer<typeof progressRecordSchema>;

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

const systemRecordSchema = structuredRecordBaseSchema.extend({
  type: z.literal("system"),
  subtype: z.string(),
});
export type SystemRecord = z.infer<typeof systemRecordSchema>;

export type ClaudeCodeSessionRecord =
  | (UserRecord & { type: "user" })
  | (AssistantRecord & { type: "assistant" })
  | (ProgressRecord & { type: "progress" })
  | (SystemRecord & { type: "system" });

const skippableTypeSchema = z.object({
  type: z.enum(["file-history-snapshot", "queue-operation"]),
});

export function parseSessionRecord(value: unknown): ClaudeCodeSessionRecord | null {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return null;
  }

  if (skippableTypeSchema.safeParse(value).success) {
    return null;
  }

  const { type } = value;

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

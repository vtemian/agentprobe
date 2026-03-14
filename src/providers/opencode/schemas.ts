import { z } from "zod";

const sessionRowSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  parent_id: z.string().nullable(),
  directory: z.string(),
  title: z.string(),
  version: z.string(),
  time_created: z.number(),
  time_updated: z.number(),
});

export interface SessionRow {
  id: string;
  projectId: string;
  parentId: string | null;
  directory: string;
  title: string;
  version: string;
  timeCreated: number;
  timeUpdated: number;
}

export function parseSessionRow(value: unknown): SessionRow | null {
  const result = sessionRowSchema.safeParse(value);
  if (!result.success) {
    return null;
  }
  const row = result.data;
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    directory: row.directory,
    title: row.title,
    version: row.version,
    timeCreated: row.time_created,
    timeUpdated: row.time_updated,
  };
}

const timeSchema = z.object({
  created: z.number(),
  completed: z.number().optional(),
});

const modelRefSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
});

const tokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number().optional(),
  cache: z
    .object({
      read: z.number(),
      write: z.number(),
    })
    .optional(),
});

const summarySchema = z
  .object({
    title: z.string().optional(),
    diffs: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

const messageDataSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    time: timeSchema,
    agent: z.string().optional(),
    model: modelRefSchema.optional(),
    summary: summarySchema.optional(),
  }),
  z.object({
    role: z.literal("assistant"),
    time: timeSchema,
    agent: z.string().optional(),
    modelID: z.string().optional(),
    providerID: z.string().optional(),
    tokens: tokensSchema.optional(),
    cost: z.number().optional(),
    finish: z.string().optional(),
  }),
]);

export type MessageData = z.infer<typeof messageDataSchema>;

export function parseMessageData(value: unknown): MessageData | null {
  if (typeof value !== "object" || value === null || !("role" in value)) {
    return null;
  }
  const result = messageDataSchema.safeParse(value);
  return result.success ? result.data : null;
}

const partDataSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool"),
    callID: z.string().optional(),
    tool: z.string().optional(),
    state: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ type: z.literal("text"), text: z.string().optional() }),
  z.object({ type: z.literal("step-start") }).passthrough(),
  z.object({ type: z.literal("step-finish") }).passthrough(),
  z.object({ type: z.literal("reasoning") }).passthrough(),
  z.object({ type: z.literal("subtask") }).passthrough(),
  z.object({ type: z.literal("patch") }).passthrough(),
  z.object({ type: z.literal("compaction") }).passthrough(),
  z.object({ type: z.literal("file") }).passthrough(),
  z.object({ type: z.literal("agent") }).passthrough(),
  z.object({ type: z.literal("retry") }).passthrough(),
  z.object({ type: z.literal("snapshot") }).passthrough(),
]);

export type PartData = z.infer<typeof partDataSchema>;

export function parsePartData(value: unknown): PartData | null {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return null;
  }
  const result = partDataSchema.safeParse(value);
  return result.success ? result.data : null;
}

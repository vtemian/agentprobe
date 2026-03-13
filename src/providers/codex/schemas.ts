import { z } from "zod";

const gitInfoSchema = z
  .object({
    branch: z.string(),
    commit_hash: z.string(),
    repository_url: z.string(),
  })
  .partial();

export const sessionMetaSchema = z.object({
  type: z.literal("session_meta"),
  timestamp: z.string(),
  payload: z.object({
    id: z.string(),
    cwd: z.string(),
    source: z.string().optional(),
    model_provider: z.string().optional(),
    cli_version: z.string().optional(),
    originator: z.string().optional(),
    git: gitInfoSchema.optional(),
  }),
});
export type SessionMeta = z.infer<typeof sessionMetaSchema>;

const messagePayloadSchema = z.object({
  type: z.literal("message"),
  role: z.enum(["user", "assistant", "developer"]),
  content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
});

const functionCallPayloadSchema = z.object({
  type: z.literal("function_call"),
  name: z.string().optional(),
  arguments: z.string().optional(),
  call_id: z.string().optional(),
});

const functionCallOutputPayloadSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string().optional(),
  output: z.string().optional(),
});

const customToolCallPayloadSchema = z.object({
  type: z.literal("custom_tool_call"),
  name: z.string().optional(),
  call_id: z.string().optional(),
});

const customToolCallOutputPayloadSchema = z.object({
  type: z.literal("custom_tool_call_output"),
  call_id: z.string().optional(),
  output: z.string().optional(),
});

const reasoningPayloadSchema = z.object({
  type: z.literal("reasoning"),
});

const responseItemPayloadSchema = z.discriminatedUnion("type", [
  messagePayloadSchema,
  functionCallPayloadSchema,
  functionCallOutputPayloadSchema,
  customToolCallPayloadSchema,
  customToolCallOutputPayloadSchema,
  reasoningPayloadSchema,
]);

export const responseItemSchema = z.object({
  type: z.literal("response_item"),
  timestamp: z.string(),
  payload: responseItemPayloadSchema,
});
export type ResponseItem = z.infer<typeof responseItemSchema>;

export const turnContextSchema = z.object({
  type: z.literal("turn_context"),
  timestamp: z.string(),
  payload: z
    .object({
      cwd: z.string().optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
    })
    .passthrough(),
});
export type TurnContext = z.infer<typeof turnContextSchema>;

export const eventMsgSchema = z.object({
  type: z.literal("event_msg"),
  timestamp: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventMsg = z.infer<typeof eventMsgSchema>;

export type CodexRecord = SessionMeta | ResponseItem | TurnContext | EventMsg;

const codexRecordSchemaByType: Record<string, z.ZodType<CodexRecord>> = {
  session_meta: sessionMetaSchema as z.ZodType<CodexRecord>,
  response_item: responseItemSchema as z.ZodType<CodexRecord>,
  turn_context: turnContextSchema as z.ZodType<CodexRecord>,
  event_msg: eventMsgSchema as z.ZodType<CodexRecord>,
};

export function parseCodexRecord(value: unknown): CodexRecord | null {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return null;
  }

  const schema = codexRecordSchemaByType[value.type as string];
  if (!schema) {
    return null;
  }

  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseSessionMeta(value: unknown): SessionMeta["payload"] | null {
  const result = sessionMetaSchema.safeParse(value);
  return result.success ? result.data.payload : null;
}

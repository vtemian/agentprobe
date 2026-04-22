import { z } from "zod";

const toolUsePayloadSchema = z.object({
  tool_use_id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const toolResultPayloadSchema = z.object({
  name: z.string().optional(),
  tool_use_id: z.string(),
  content: z.unknown(),
  status: z.string().optional(),
});

const contentBlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string().optional(),
    is_user_prompt: z.boolean().optional(),
    internalOnly: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("thinking"),
    thinking: z.string().optional(),
  }),
  z.object({
    type: z.literal("tool_use"),
    tool_use: toolUsePayloadSchema,
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_result: toolResultPayloadSchema.optional(),
    name: z.string().optional(),
    tool_use_id: z.string().optional(),
    content: z.unknown().optional(),
    status: z.string().optional(),
  }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

const historyMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  id: z.string().optional(),
  content: z.array(contentBlockSchema),
});
export type HistoryMessage = z.infer<typeof historyMessageSchema>;

const conversationSchema = z.object({
  session_id: z.string(),
  title: z.string().optional(),
  working_directory: z.string().optional(),
  session_type: z.string().optional(),
  created_at: z.string().optional(),
  last_updated: z.string().optional(),
  connection_name: z.string().optional(),
  history: z.array(historyMessageSchema),
});
export type CortexCodeConversation = z.infer<typeof conversationSchema>;

export function parseConversation(value: unknown): CortexCodeConversation | null {
  const result = conversationSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function isToolResultError(block: ContentBlock): boolean {
  if (block.type !== "tool_result") {
    return false;
  }
  const status = block.tool_result?.status ?? block.status;
  return status === "error";
}

const MAX_SUMMARY_LENGTH = 120;
const TRUNCATED_PREFIX_LENGTH = 117;

function isVisibleUserText(block: ContentBlock): boolean {
  if (block.type !== "text") return false;
  if (block.internalOnly || block.is_user_prompt === false) return false;
  const text = block.text?.trim();
  return text !== undefined && text.length > 0 && !text.startsWith("<system-reminder>");
}

function findFirstVisibleText(blocks: readonly ContentBlock[]): string | undefined {
  const match = blocks.find(isVisibleUserText);
  if (match?.type === "text") {
    return match.text?.trim();
  }
  return undefined;
}

function truncateSummary(text: string): string {
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, TRUNCATED_PREFIX_LENGTH)}...` : text;
}

export function extractUserTaskSummary(history: readonly HistoryMessage[]): string {
  for (const message of history) {
    if (message.role !== "user") continue;
    const text = findFirstVisibleText(message.content);
    if (text) return truncateSummary(text);
  }
  return "";
}

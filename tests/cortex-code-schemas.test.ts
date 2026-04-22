import { describe, expect, it } from "vitest";
import {
  type ContentBlock,
  extractUserTaskSummary,
  isToolResultError,
  parseConversation,
} from "@/providers/cortex-code/schemas";

describe("cortex-code schemas", () => {
  describe("parseConversation", () => {
    it("returns parsed conversation for valid input", () => {
      const raw = {
        session_id: "abc-123",
        title: "Test session",
        working_directory: "/projects/foo",
        session_type: "main",
        created_at: "2026-03-10T07:00:00.000Z",
        last_updated: "2026-03-10T07:05:00.000Z",
        connection_name: "devrel",
        history: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
          },
        ],
      };

      const result = parseConversation(raw);
      expect(result).not.toBeNull();
      expect(result?.session_id).toBe("abc-123");
      expect(result?.working_directory).toBe("/projects/foo");
      expect(result?.connection_name).toBe("devrel");
      expect(result?.history).toHaveLength(1);
    });

    it("returns null for missing session_id", () => {
      const result = parseConversation({
        history: [],
      });
      expect(result).toBeNull();
    });

    it("returns null for non-object input", () => {
      expect(parseConversation("hello")).toBeNull();
      expect(parseConversation(42)).toBeNull();
      expect(parseConversation(null)).toBeNull();
      expect(parseConversation(undefined)).toBeNull();
    });

    it("accepts minimal conversation with only session_id and history", () => {
      const result = parseConversation({
        session_id: "minimal",
        history: [],
      });
      expect(result).not.toBeNull();
      expect(result?.session_id).toBe("minimal");
      expect(result?.history).toHaveLength(0);
    });

    it("parses all content block types", () => {
      const result = parseConversation({
        session_id: "blocks",
        history: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "some output" },
              { type: "thinking", thinking: "reasoning" },
              {
                type: "tool_use",
                tool_use: {
                  tool_use_id: "tu-1",
                  name: "bash",
                  input: { command: "ls" },
                },
              },
              {
                type: "tool_result",
                tool_result: {
                  tool_use_id: "tu-1",
                  name: "bash",
                  content: "file.txt",
                  status: "success",
                },
              },
            ],
          },
        ],
      });

      expect(result).not.toBeNull();
      expect(result?.history[0].content).toHaveLength(4);
    });
  });

  describe("isToolResultError", () => {
    it("returns true for tool_result with error status in nested payload", () => {
      const block: ContentBlock = {
        type: "tool_result",
        tool_result: {
          tool_use_id: "tu-1",
          content: "something failed",
          status: "error",
        },
      };
      expect(isToolResultError(block)).toBe(true);
    });

    it("returns true for tool_result with error status at top level", () => {
      const block: ContentBlock = {
        type: "tool_result",
        tool_use_id: "tu-1",
        status: "error",
      };
      expect(isToolResultError(block)).toBe(true);
    });

    it("returns false for tool_result with success status", () => {
      const block: ContentBlock = {
        type: "tool_result",
        tool_result: {
          tool_use_id: "tu-1",
          content: "ok",
          status: "success",
        },
      };
      expect(isToolResultError(block)).toBe(false);
    });

    it("returns false for non-tool_result blocks", () => {
      const block: ContentBlock = {
        type: "text",
        text: "hello",
      };
      expect(isToolResultError(block)).toBe(false);
    });
  });

  describe("extractUserTaskSummary", () => {
    it("returns first non-internal user text", () => {
      const summary = extractUserTaskSummary([
        {
          role: "user",
          content: [{ type: "text", text: "fix the build" }],
        },
      ]);
      expect(summary).toBe("fix the build");
    });

    it("skips internalOnly text blocks", () => {
      const summary = extractUserTaskSummary([
        {
          role: "user",
          content: [
            { type: "text", text: "system stuff", internalOnly: true },
            { type: "text", text: "real task" },
          ],
        },
      ]);
      expect(summary).toBe("real task");
    });

    it("skips system-reminder blocks", () => {
      const summary = extractUserTaskSummary([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "<system-reminder>reminder content</system-reminder>",
            },
            { type: "text", text: "actual question" },
          ],
        },
      ]);
      expect(summary).toBe("actual question");
    });

    it("skips is_user_prompt=false blocks", () => {
      const summary = extractUserTaskSummary([
        {
          role: "user",
          content: [
            { type: "text", text: "injected prompt", is_user_prompt: false },
            { type: "text", text: "my real question" },
          ],
        },
      ]);
      expect(summary).toBe("my real question");
    });

    it("truncates long summaries to 120 chars", () => {
      const longText = "a".repeat(200);
      const summary = extractUserTaskSummary([
        {
          role: "user",
          content: [{ type: "text", text: longText }],
        },
      ]);
      expect(summary).toHaveLength(120);
      expect(summary).toBe(`${"a".repeat(117)}...`);
    });

    it("returns empty string when no user messages exist", () => {
      const summary = extractUserTaskSummary([
        {
          role: "assistant",
          content: [{ type: "text", text: "I can help" }],
        },
      ]);
      expect(summary).toBe("");
    });

    it("returns empty string for empty history", () => {
      expect(extractUserTaskSummary([])).toBe("");
    });
  });
});

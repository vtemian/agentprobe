import { describe, expect, it } from "vitest";
import { parseCodexRecord, parseSessionMeta } from "@/providers/codex/schemas";

describe("codex schemas", () => {
  describe("parseSessionMeta", () => {
    it("returns payload for valid session_meta", () => {
      const raw = {
        type: "session_meta",
        timestamp: "2026-03-10T07:35:50.757Z",
        payload: {
          id: "sess-001",
          cwd: "/projects/foo",
          source: "codex",
          model_provider: "openai",
          cli_version: "0.1.0",
        },
      };

      const result = parseSessionMeta(raw);
      expect(result).not.toBeNull();
      expect(result?.id).toBe("sess-001");
      expect(result?.cwd).toBe("/projects/foo");
    });

    it("returns null for invalid session_meta", () => {
      const result = parseSessionMeta({ type: "session_meta" });
      expect(result).toBeNull();
    });

    it("returns null for old format without type field", () => {
      const result = parseSessionMeta({
        id: "sess-001",
        cwd: "/projects/foo",
      });
      expect(result).toBeNull();
    });
  });

  describe("parseCodexRecord", () => {
    it("parses session_meta", () => {
      const raw = {
        type: "session_meta",
        timestamp: "2026-03-10T07:35:50.757Z",
        payload: {
          id: "sess-001",
          cwd: "/projects/foo",
        },
      };

      const result = parseCodexRecord(raw);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("session_meta");
    });

    it("parses response_item with message/user and string content", () => {
      const raw = {
        type: "response_item",
        timestamp: "2026-03-10T07:36:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: "hello world",
        },
      };

      const result = parseCodexRecord(raw);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("response_item");
    });

    it("parses response_item with message/assistant", () => {
      const raw = {
        type: "response_item",
        timestamp: "2026-03-10T07:36:05.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Here is the answer." }],
        },
      };

      const result = parseCodexRecord(raw);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("response_item");
    });

    it("parses response_item with function_call", () => {
      const raw = {
        type: "response_item",
        timestamp: "2026-03-10T07:36:10.000Z",
        payload: {
          type: "function_call",
          name: "readFile",
          arguments: '{"path": "/foo.ts"}',
          call_id: "call-001",
        },
      };

      const result = parseCodexRecord(raw);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("response_item");
    });

    it("parses response_item with reasoning", () => {
      const raw = {
        type: "response_item",
        timestamp: "2026-03-10T07:36:15.000Z",
        payload: {
          type: "reasoning",
        },
      };

      const result = parseCodexRecord(raw);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("response_item");
    });

    it("parses turn_context with model", () => {
      const raw = {
        type: "turn_context",
        timestamp: "2026-03-10T07:37:00.000Z",
        payload: {
          cwd: "/projects/foo",
          model: "o4-mini",
          effort: "high",
        },
      };

      const result = parseCodexRecord(raw);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("turn_context");
    });

    it("parses event_msg", () => {
      const raw = {
        type: "event_msg",
        timestamp: "2026-03-10T07:38:00.000Z",
        payload: {
          event: "task_started",
          details: "some details",
        },
      };

      const result = parseCodexRecord(raw);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("event_msg");
    });

    it("returns null for unknown type", () => {
      const raw = {
        type: "unknown_thing",
        timestamp: "2026-03-10T07:39:00.000Z",
      };

      const result = parseCodexRecord(raw);
      expect(result).toBeNull();
    });

    it("returns null for non-object input", () => {
      expect(parseCodexRecord("hello")).toBeNull();
      expect(parseCodexRecord(42)).toBeNull();
      expect(parseCodexRecord(null)).toBeNull();
      expect(parseCodexRecord(undefined)).toBeNull();
    });

    it("returns null for old format without type field", () => {
      const raw = {
        id: "sess-001",
        cwd: "/projects/foo",
        timestamp: "2026-03-10T07:35:50.757Z",
      };

      const result = parseCodexRecord(raw);
      expect(result).toBeNull();
    });
  });
});

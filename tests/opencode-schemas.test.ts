import { describe, expect, it } from "vitest";
import { parseMessageData, parsePartData, parseSessionRow } from "@/providers/opencode/schemas";

describe("opencode schemas", () => {
  describe("parseSessionRow", () => {
    it("parses a valid session row", () => {
      const row = {
        id: "ses_abc123",
        project_id: "proj_123",
        parent_id: null,
        directory: "/Users/test/project",
        title: "Working on feature",
        version: "1.2.24",
        time_created: 1773334158609,
        time_updated: 1773334839058,
      };
      const result = parseSessionRow(row);
      expect(result).not.toBeNull();
      expect(result?.id).toBe("ses_abc123");
      expect(result?.parentId).toBeNull();
      expect(result?.directory).toBe("/Users/test/project");
      expect(result?.title).toBe("Working on feature");
      expect(result?.timeCreated).toBe(1773334158609);
      expect(result?.timeUpdated).toBe(1773334839058);
    });

    it("parses a subagent session with parent_id", () => {
      const row = {
        id: "ses_child",
        project_id: "proj_123",
        parent_id: "ses_parent",
        directory: "/Users/test/project",
        title: "Bootstrap brainstorm (@bootstrapper subagent)",
        version: "1.2.24",
        time_created: 1773334158609,
        time_updated: 1773334839058,
      };
      const result = parseSessionRow(row);
      expect(result).not.toBeNull();
      expect(result?.parentId).toBe("ses_parent");
    });

    it("returns null for invalid row", () => {
      expect(parseSessionRow(null)).toBeNull();
      expect(parseSessionRow({})).toBeNull();
      expect(parseSessionRow({ id: 123 })).toBeNull();
    });
  });

  describe("parseMessageData", () => {
    it("parses a user message data blob", () => {
      const data = {
        role: "user",
        time: { created: 1773334158640 },
        agent: "commander",
        model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
        summary: { title: "Fix the bug" },
      };
      const result = parseMessageData(data);
      expect(result).not.toBeNull();
      expect(result?.role).toBe("user");
      expect(result?.agent).toBe("commander");
      expect(result?.summary?.title).toBe("Fix the bug");
    });

    it("parses an assistant message data blob", () => {
      const data = {
        role: "assistant",
        time: { created: 1773334158640, completed: 1773334168000 },
        agent: "commander",
        modelID: "claude-opus-4-6",
        providerID: "anthropic",
        tokens: { input: 100, output: 500, reasoning: 0, cache: { read: 5000, write: 200 } },
        cost: 0.05,
        finish: "stop",
      };
      const result = parseMessageData(data);
      expect(result).not.toBeNull();
      expect(result?.role).toBe("assistant");
      expect(result?.tokens?.input).toBe(100);
      expect(result?.cost).toBe(0.05);
    });

    it("returns null for invalid data", () => {
      expect(parseMessageData(null)).toBeNull();
      expect(parseMessageData({})).toBeNull();
      expect(parseMessageData({ role: "unknown" })).toBeNull();
    });
  });

  describe("parsePartData", () => {
    it("parses a tool part", () => {
      const data = {
        type: "tool",
        callID: "toolu_abc",
        tool: "read",
        state: { status: "completed" },
      };
      const result = parsePartData(data);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("tool");
    });

    it("parses a text part", () => {
      const data = {
        type: "text",
        text: "Hello world",
      };
      const result = parsePartData(data);
      expect(result).not.toBeNull();
      expect(result?.type).toBe("text");
    });

    it("parses step-start and step-finish parts", () => {
      expect(parsePartData({ type: "step-start" })).not.toBeNull();
      expect(parsePartData({ type: "step-finish" })).not.toBeNull();
    });

    it("returns null for invalid data", () => {
      expect(parsePartData(null)).toBeNull();
      expect(parsePartData({})).toBeNull();
    });
  });
});

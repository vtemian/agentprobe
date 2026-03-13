import { describe, expect, it } from "vitest";
import * as core from "@/core/index";

describe("core provider contracts", () => {
  it("exports correct runtime state constants", () => {
    expect(core.WATCH_RUNTIME_STATES).toEqual({
      started: "started",
      stopped: "stopped",
    });
  });

  it("exports canonical status and provider kind constants", () => {
    expect(core.CANONICAL_AGENT_STATUS.running).toBe("running");
    expect(core.PROVIDER_KINDS.cursor).toBe("cursor");
    expect(core.PROVIDER_KINDS.codex).toBe("codex");
    expect(core.PROVIDER_KINDS.claudeCode).toBe("claude-code");
    expect(core.PROVIDER_KINDS.opencode).toBe("opencode");
  });
});

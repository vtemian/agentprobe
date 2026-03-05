import * as core from "../src/core/index";
import { describe, expect, it } from "vitest";

describe("core provider contracts", () => {
  it("exports canonical status and provider kind constants", () => {
    expect(core.CANONICAL_AGENT_STATUS.running).toBe("running");
    expect(core.PROVIDER_KINDS.cursor).toBe("cursor");
    expect(core.PROVIDER_KINDS.codex).toBe("codex");
    expect(core.PROVIDER_KINDS.claudeCode).toBe("claude-code");
    expect(core.PROVIDER_KINDS.opencode).toBe("opencode");
  });
});

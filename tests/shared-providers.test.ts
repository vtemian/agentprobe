import { describe, expect, it } from "vitest";
import type { CanonicalAgentSnapshot } from "@/core/model";
import {
  arraysEqual,
  isAgentPayload,
  mergeAgents,
  pruneStaleCache,
} from "@/providers/shared/providers";

describe("shared provider utils", () => {
  it("arraysEqual returns true for identical arrays", () => {
    expect(arraysEqual(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("arraysEqual returns false for different arrays", () => {
    expect(arraysEqual(["a"], ["b"])).toBe(false);
    expect(arraysEqual(["a"], ["a", "b"])).toBe(false);
  });

  it("mergeAgents inserts new and updates existing by updatedAt", () => {
    const orderedIds: string[] = [];
    const latestById = new Map<string, CanonicalAgentSnapshot>();
    const base: CanonicalAgentSnapshot = {
      id: "",
      name: "",
      kind: "local",
      isSubagent: false,
      status: "running",
      taskSummary: "",
      updatedAt: 0,
      source: "test",
    };
    const agent1: CanonicalAgentSnapshot = { ...base, id: "a1", updatedAt: 100 };
    const agent1newer: CanonicalAgentSnapshot = { ...base, id: "a1", updatedAt: 200 };
    const agent2: CanonicalAgentSnapshot = { ...base, id: "a2", updatedAt: 150 };

    mergeAgents([agent1], orderedIds, latestById);
    expect(orderedIds).toEqual(["a1"]);
    expect(latestById.get("a1")).toBe(agent1);

    mergeAgents([agent1newer, agent2], orderedIds, latestById);
    expect(orderedIds).toEqual(["a1", "a2"]);
    expect(latestById.get("a1")).toBe(agent1newer);
    expect(latestById.get("a2")).toBe(agent2);
  });

  it("pruneStaleCache removes entries not in current paths", () => {
    const cache = new Map<string, unknown>([
      ["/a", {}],
      ["/b", {}],
      ["/c", {}],
    ]);
    pruneStaleCache(cache, ["/a", "/c"]);
    expect([...cache.keys()]).toEqual(["/a", "/c"]);
  });

  it("pruneStaleCache skips when cache size <= paths length", () => {
    const cache = new Map<string, unknown>([["/a", {}]]);
    pruneStaleCache(cache, ["/a", "/b"]);
    expect(cache.size).toBe(1);
  });

  it("isAgentPayload validates object with agents array", () => {
    expect(isAgentPayload({ agents: [], connected: true })).toBe(true);
    expect(isAgentPayload({ agents: "not array" })).toBe(false);
    expect(isAgentPayload(null)).toBe(false);
    expect(isAgentPayload("string")).toBe(false);
  });
});

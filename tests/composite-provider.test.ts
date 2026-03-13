import { describe, expect, it } from "vitest";
import { createCompositeProvider } from "@/core/composite";
import type { CanonicalAgentSnapshot } from "@/core/model";
import type { TranscriptProvider } from "@/core/providers";

describe("composite provider", () => {
  function mockProvider(id: string, agents: { id: string; status: string }[]): TranscriptProvider {
    return {
      id,
      discover: () => ({
        inputs: [{ uri: `${id}://source`, kind: "file" as const, metadata: { providerId: id } }],
        watchPaths: [`/tmp/${id}`],
        warnings: [],
      }),
      read: (_inputs, now) => ({
        records: [
          {
            provider: id,
            inputUri: `${id}://source`,
            observedAt: now ?? Date.now(),
            payload: {
              agents: agents.map((a) => ({
                id: a.id,
                name: `Agent ${a.id}`,
                kind: "local",
                isSubagent: false,
                status: a.status,
                taskSummary: "Test task",
                updatedAt: now ?? Date.now(),
                source: id,
              })),
              connected: true,
              sourceLabel: id,
              warnings: [],
            },
          },
        ],
        health: { connected: true, sourceLabel: id, warnings: [] },
      }),
      normalize: (readResult) => {
        const payload = readResult.records[0]?.payload as
          | { agents: CanonicalAgentSnapshot[]; connected: boolean }
          | undefined;
        return {
          agents: payload?.agents ?? [],
          health: readResult.health,
        };
      },
    };
  }

  it("merges agents from multiple providers", async () => {
    const cursorProvider = mockProvider("cursor", [{ id: "cursor-agent-1", status: "running" }]);
    const claudeProvider = mockProvider("claude-code", [{ id: "claude-agent-1", status: "idle" }]);

    const composite = createCompositeProvider([cursorProvider, claudeProvider]);
    const discovery = await composite.discover(["/workspace"]);
    expect(discovery.inputs).toHaveLength(2);
    expect(discovery.watchPaths).toHaveLength(2);

    const readResult = await composite.read(discovery.inputs, Date.now());
    expect(readResult.records).toHaveLength(2);
    expect(readResult.health.connected).toBe(true);

    const normalized = await composite.normalize(readResult, Date.now());
    expect(normalized.agents).toHaveLength(2);
    expect(normalized.agents.map((a) => a.id).sort()).toEqual(["claude-agent-1", "cursor-agent-1"]);
  });

  it("routes inputs to correct provider during read", async () => {
    let cursorReadCalled = false;
    let claudeReadCalled = false;

    const cursorProvider: TranscriptProvider = {
      ...mockProvider("cursor", []),
      read: (inputs, _now) => {
        cursorReadCalled = true;
        expect(inputs.every((i) => i.metadata?.providerId === "cursor")).toBe(true);
        return {
          records: [],
          health: { connected: true, sourceLabel: "cursor", warnings: [] },
        };
      },
    };

    const claudeProvider: TranscriptProvider = {
      ...mockProvider("claude-code", []),
      read: (inputs, _now) => {
        claudeReadCalled = true;
        expect(inputs.every((i) => i.metadata?.providerId === "claude-code")).toBe(true);
        return {
          records: [],
          health: { connected: true, sourceLabel: "claude-code", warnings: [] },
        };
      },
    };

    const composite = createCompositeProvider([cursorProvider, claudeProvider]);
    const discovery = await composite.discover(["/workspace"]);
    await composite.read(discovery.inputs, Date.now());

    expect(cursorReadCalled).toBe(true);
    expect(claudeReadCalled).toBe(true);
  });

  it("connects and disconnects all providers", async () => {
    let cursorConnected = false;
    let claudeConnected = false;

    const cursorProvider: TranscriptProvider = {
      ...mockProvider("cursor", []),
      connect: () => {
        cursorConnected = true;
      },
      disconnect: () => {
        cursorConnected = false;
      },
    };
    const claudeProvider: TranscriptProvider = {
      ...mockProvider("claude-code", []),
      connect: () => {
        claudeConnected = true;
      },
      disconnect: () => {
        claudeConnected = false;
      },
    };

    const composite = createCompositeProvider([cursorProvider, claudeProvider]);
    await composite.connect?.();
    expect(cursorConnected).toBe(true);
    expect(claudeConnected).toBe(true);

    await composite.disconnect?.();
    expect(cursorConnected).toBe(false);
    expect(claudeConnected).toBe(false);
  });

  it("merges watch subscriptions from all providers", () => {
    const cursorProvider: TranscriptProvider = {
      ...mockProvider("cursor", []),
      watch: {
        debounceMs: 100,
        subscribe: (_path, _onEvent) => {
          return { close: () => {} };
        },
      },
    };
    const claudeProvider: TranscriptProvider = {
      ...mockProvider("claude-code", []),
      watch: {
        debounceMs: 200,
        subscribe: (_path, _onEvent) => {
          return { close: () => {} };
        },
      },
    };

    const composite = createCompositeProvider([cursorProvider, claudeProvider]);
    expect(composite.watch).toBeDefined();
    expect(composite.watch?.debounceMs).toBe(100); // uses minimum
  });

  it("returns results from healthy providers when one provider discover() throws", async () => {
    const healthyProvider = mockProvider("healthy", [{ id: "h1", status: "running" }]);
    const failingProvider: TranscriptProvider = {
      ...mockProvider("broken", []),
      discover: () => {
        throw new Error("discover exploded");
      },
    };

    const composite = createCompositeProvider([failingProvider, healthyProvider]);
    const discovery = await composite.discover(["/workspace"]);

    expect(discovery.inputs).toHaveLength(1);
    expect(discovery.inputs[0]?.metadata?.providerId).toBe("healthy");
    expect(discovery.warnings).toContain("[broken] discover exploded");
  });

  it("returns results from healthy providers when one provider read() throws", async () => {
    const healthyProvider = mockProvider("healthy", [{ id: "h1", status: "running" }]);
    const failingProvider: TranscriptProvider = {
      ...mockProvider("broken", []),
      read: () => {
        throw new Error("read exploded");
      },
    };

    const composite = createCompositeProvider([failingProvider, healthyProvider]);
    const discovery = await composite.discover(["/workspace"]);
    const readResult = await composite.read(discovery.inputs, Date.now());

    expect(readResult.records).toHaveLength(1);
    expect(readResult.records[0]?.provider).toBe("healthy");
    expect(readResult.health.connected).toBe(true);
    expect(readResult.health.warnings).toContain("[broken] read exploded");
  });

  it("connects remaining providers when one provider connect() throws", async () => {
    let healthyConnected = false;
    const healthyProvider: TranscriptProvider = {
      ...mockProvider("healthy", []),
      connect: () => {
        healthyConnected = true;
      },
    };
    const failingProvider: TranscriptProvider = {
      ...mockProvider("broken", []),
      connect: () => {
        throw new Error("connect exploded");
      },
    };

    const composite = createCompositeProvider([failingProvider, healthyProvider]);
    await composite.connect?.();

    expect(healthyConnected).toBe(true);
  });

  it("health is connected when any provider is connected", async () => {
    const okProvider = mockProvider("ok", [{ id: "a1", status: "running" }]);
    const failProvider: TranscriptProvider = {
      ...mockProvider("fail", []),
      read: () => ({
        records: [],
        health: { connected: false, sourceLabel: "fail", warnings: ["error"] },
      }),
      normalize: (readResult) => ({
        agents: [],
        health: readResult.health,
      }),
    };

    const composite = createCompositeProvider([okProvider, failProvider]);
    const discovery = await composite.discover(["/workspace"]);
    const readResult = await composite.read(discovery.inputs, Date.now());
    const normalized = await composite.normalize(readResult, Date.now());

    expect(normalized.health.connected).toBe(true);
    expect(normalized.agents).toHaveLength(1);
  });
});

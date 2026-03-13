import { readFile, stat } from "node:fs/promises";
import type { CanonicalAgentSnapshot } from "@/core/model";
import type { CanonicalSnapshot, TranscriptReadResult } from "@/core/providers";

export function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function mergeAgents(
  agents: CanonicalAgentSnapshot[],
  orderedIds: string[],
  latestById: Map<string, CanonicalAgentSnapshot>,
): void {
  for (const agent of agents) {
    const existing = latestById.get(agent.id);
    if (!existing) {
      latestById.set(agent.id, agent);
      orderedIds.push(agent.id);
    } else if (agent.updatedAt > existing.updatedAt) {
      latestById.set(agent.id, agent);
    }
  }
}

export function pruneStaleCache(
  cache: Map<string, unknown>,
  currentPaths: readonly string[],
): void {
  if (cache.size <= currentPaths.length) {
    return;
  }
  const current = new Set(currentPaths);
  for (const key of cache.keys()) {
    if (!current.has(key)) {
      cache.delete(key);
    }
  }
}

export function isAgentPayload(value: unknown): value is { agents: CanonicalAgentSnapshot[] } {
  return (
    typeof value === "object" && value !== null && "agents" in value && Array.isArray(value.agents)
  );
}

export function normalizeFromPayload(readResult: TranscriptReadResult): CanonicalSnapshot {
  const payload = readResult.records[0]?.payload;
  const agents = isAgentPayload(payload) ? payload.agents : [];
  return { agents, health: readResult.health };
}

export interface FileStatResult {
  fileUpdatedAt: number;
  fileSizeBytes: number;
}

export function statSourceFile(
  sourcePath: string,
  fallbackTimestamp: number,
): Promise<FileStatResult> {
  return stat(sourcePath)
    .then((stats) => ({
      fileUpdatedAt: Math.round(stats.mtimeMs),
      fileSizeBytes: stats.size,
    }))
    .catch(() => ({
      fileUpdatedAt: fallbackTimestamp,
      fileSizeBytes: 0,
    }));
}

export function readSourceFile(sourcePath: string): Promise<string | null> {
  return readFile(sourcePath, "utf8").catch(() => null);
}

export function parseTimestampMs(value: string): number | undefined {
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

export interface ProcessFileResult {
  agents: CanonicalAgentSnapshot[];
  success: boolean;
  warnings: string[];
}

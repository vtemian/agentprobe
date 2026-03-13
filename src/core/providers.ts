import type { CanonicalAgentSnapshot } from "./model";
import type { WatchHealth, WatchSnapshot } from "./types";

export const PROVIDER_KINDS = {
  cursor: "cursor",
  codex: "codex",
  claudeCode: "claude-code",
  opencode: "opencode",
} as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[keyof typeof PROVIDER_KINDS];

export interface DiscoveryInput {
  uri: string;
  kind: "file" | "directory" | "stream" | "endpoint";
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface DiscoveryResult {
  inputs: DiscoveryInput[];
  watchPaths: string[];
  warnings: string[];
}

export interface RawTranscriptRecord {
  provider: string;
  inputUri: string;
  observedAt: number;
  payload: unknown;
  cursor?: string | number;
}

export interface TranscriptReadResult {
  records: RawTranscriptRecord[];
  health: WatchHealth;
}

export type CanonicalSnapshot = WatchSnapshot<CanonicalAgentSnapshot>;

export interface TranscriptProvider {
  id: string;
  discover(workspacePaths: string[]): Promise<DiscoveryResult> | DiscoveryResult;
  connect?(): Promise<void> | void;
  disconnect?(): Promise<void> | void;
  read(
    inputs: DiscoveryInput[],
    now?: number,
  ): Promise<TranscriptReadResult> | TranscriptReadResult;
  normalize(
    readResult: TranscriptReadResult,
    now: number,
  ): Promise<CanonicalSnapshot> | CanonicalSnapshot;
  watch?: {
    debounceMs?: number;
    subscribe(
      watchPath: string,
      onEvent: () => void,
      onError: (error: Error) => void,
    ): { close(): void };
  };
}

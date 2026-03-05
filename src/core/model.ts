export const CANONICAL_AGENT_STATUS = {
  running: "running",
  idle: "idle",
  completed: "completed",
  error: "error",
} as const;
export type CanonicalAgentStatus =
  (typeof CANONICAL_AGENT_STATUS)[keyof typeof CANONICAL_AGENT_STATUS];

export const CANONICAL_AGENT_KIND = {
  local: "local",
  remote: "remote",
} as const;
export type CanonicalAgentKind = (typeof CANONICAL_AGENT_KIND)[keyof typeof CANONICAL_AGENT_KIND];

export interface CanonicalAgentSnapshot {
  id: string;
  name: string;
  kind: CanonicalAgentKind;
  isSubagent: boolean;
  status: CanonicalAgentStatus;
  taskSummary: string;
  startedAt?: number;
  updatedAt: number;
  source: string;
  metadata?: Record<string, unknown>;
}

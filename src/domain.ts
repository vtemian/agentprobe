export const AGENT_STATUS = {
  running: "running",
  idle: "idle",
  completed: "completed",
  error: "error",
} as const;
export type AgentStatus = (typeof AGENT_STATUS)[keyof typeof AGENT_STATUS];

export const AGENT_KIND = {
  local: "local",
  remote: "remote",
} as const;
export type AgentKind = (typeof AGENT_KIND)[keyof typeof AGENT_KIND];

export const AGENT_SOURCE_KIND = {
  cursorTranscripts: "cursor-transcripts",
  mock: "mock",
} as const;
export type AgentSourceKind =
  | (typeof AGENT_SOURCE_KIND)[keyof typeof AGENT_SOURCE_KIND]
  | (string & {});

export interface AgentSnapshot {
  id: string;
  name: string;
  kind: AgentKind;
  isSubagent: boolean;
  status: AgentStatus;
  taskSummary: string;
  startedAt?: number;
  updatedAt: number;
  source: AgentSourceKind;
}

export interface AgentSourceReadResult {
  agents: AgentSnapshot[];
  connected: boolean;
  sourceLabel: string;
  warnings: string[];
}

export const AGENT_LIFECYCLE_EVENT_KIND = {
  joined: "joined",
  left: "left",
  statusChanged: "statusChanged",
  heartbeat: "heartbeat",
} as const;
export type AgentLifecycleEventType =
  (typeof AGENT_LIFECYCLE_EVENT_KIND)[keyof typeof AGENT_LIFECYCLE_EVENT_KIND];

export interface AgentLifecycleEvent {
  kind: AgentLifecycleEventType;
  agentId: string;
  at: number;
  fromStatus: AgentStatus | null;
  toStatus: AgentStatus | null;
}

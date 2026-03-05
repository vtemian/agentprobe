export * from "./core/types";

export const AGENT_SUBSCRIPTION_EVENT_TYPES = {
  snapshot: "snapshot",
  updated: "updated",
  errored: "errored",
  started: "started",
  stopped: "stopped",
} as const;

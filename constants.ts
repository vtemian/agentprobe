import { AGENT_STATUS, type AgentStatus } from "./types";

export const EXTENSION_CONFIG_SECTION = "cursorCafe";
export const REFRESH_MS_CONFIG_KEY = "refreshMs";

export const DEFAULT_REFRESH_MS = 1000;
export const MIN_REFRESH_MS = 250;
export const MAX_REFRESH_MS = 10_000;

export const DEFAULT_SEAT_COUNT = 6;

export const POLLING_BACKOFF_MULTIPLIER = 2;
export const POLLING_MAX_BACKOFF_MS = 10_000;

export const STATUS_CYCLE: readonly AgentStatus[] = [
  AGENT_STATUS.running,
  AGENT_STATUS.idle,
  AGENT_STATUS.completed,
  AGENT_STATUS.error,
];

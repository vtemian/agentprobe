import { homedir } from "node:os";
import path from "node:path";

export const CODEX_SOURCE_KIND = "codex";
export const CODEX_RUNNING_WINDOW_MS = 3_000;
export const CODEX_IDLE_WINDOW_MS = 60_000;
export const MAX_DISCOVERED_SESSION_FILES = 400;
export const CODEX_HOME_DEFAULT = path.join(homedir(), ".codex");
export const CODEX_SESSIONS_DIR = "sessions";
export const CODEX_WATCH_DEBOUNCE_MS = 150;
export const AGENT_NAME_PREFIX_LENGTH = 6;

import {
  createProviderWatch,
  type ProviderWatch,
  type ProviderWatchOptions,
} from "@/providers/shared/watch";
import { CLAUDE_CODE_WATCH_DEBOUNCE_MS } from "./constants";

export { CLAUDE_CODE_WATCH_DEBOUNCE_MS };

export type ClaudeCodeWatchOptions = ProviderWatchOptions;

export type ClaudeCodeWatch = ProviderWatch;

export function createClaudeCodeWatch(options: ClaudeCodeWatchOptions = {}): ClaudeCodeWatch {
  return createProviderWatch({ defaultDebounceMs: CLAUDE_CODE_WATCH_DEBOUNCE_MS }, options);
}

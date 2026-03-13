import {
  createProviderWatch,
  type ProviderWatch,
  type ProviderWatchOptions,
} from "@/providers/shared/watch";
import { CODEX_WATCH_DEBOUNCE_MS } from "./constants";

export { CODEX_WATCH_DEBOUNCE_MS };

export type CodexWatchOptions = ProviderWatchOptions;

export type CodexWatch = ProviderWatch;

export function createCodexWatch(options: CodexWatchOptions = {}): CodexWatch {
  return createProviderWatch(
    {
      defaultDebounceMs: CODEX_WATCH_DEBOUNCE_MS,
      shouldEmitForFilename: (f) => f.endsWith(".jsonl"),
    },
    options,
  );
}

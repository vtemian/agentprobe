import { watch as fsWatch, type FSWatcher } from "node:fs";
import { toError } from "@/core/errors";
import { CLAUDE_CODE_WATCH_DEBOUNCE_MS } from "./constants";

export { CLAUDE_CODE_WATCH_DEBOUNCE_MS };

export interface ClaudeCodeWatchOptions {
  debounceMs?: number;
}

export interface ClaudeCodeWatch {
  readonly debounceMs: number;
  subscribe(
    watchPath: string,
    onEvent: () => void,
    onError: (error: Error) => void,
  ): { close(): void };
}

export function createClaudeCodeWatch(options: ClaudeCodeWatchOptions = {}): ClaudeCodeWatch {
  const debounceMs = options.debounceMs ?? CLAUDE_CODE_WATCH_DEBOUNCE_MS;

  function subscribe(
    watchPath: string,
    onEvent: () => void,
    onError: (error: Error) => void,
  ): { close(): void } {
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(watchPath, { recursive: true }, () => {
        onEvent();
      });
    } catch (error) {
      throw toError(error);
    }

    watcher.on("error", (error) => {
      onError(toError(error));
    });

    return {
      close() {
        watcher.close();
      },
    };
  }

  return {
    debounceMs,
    subscribe,
  };
}

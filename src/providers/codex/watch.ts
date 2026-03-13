import { type FSWatcher, watch as fsWatch } from "node:fs";
import { toError } from "@/core/errors";
import { CODEX_WATCH_DEBOUNCE_MS } from "./constants";

export { CODEX_WATCH_DEBOUNCE_MS };

export interface CodexWatchOptions {
  debounceMs?: number;
}

export interface CodexWatch {
  readonly debounceMs: number;
  subscribe(
    watchPath: string,
    onEvent: () => void,
    onError: (error: Error) => void,
  ): { close(): void };
}

export function createCodexWatch(options: CodexWatchOptions = {}): CodexWatch {
  const debounceMs = options.debounceMs ?? CODEX_WATCH_DEBOUNCE_MS;

  function subscribe(
    watchPath: string,
    onEvent: () => void,
    onError: (error: Error) => void,
  ): { close(): void } {
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(watchPath, { recursive: true }, (_event, filename) => {
        if (typeof filename === "string" && !filename.endsWith(".jsonl")) {
          return;
        }
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

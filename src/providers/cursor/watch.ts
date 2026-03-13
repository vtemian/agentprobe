import { type FSWatcher, watch as fsWatch } from "node:fs";
import { toError } from "@/core/errors";
import { CURSOR_WATCH_DEBOUNCE_MS } from "./constants";

export { CURSOR_WATCH_DEBOUNCE_MS };

export interface CursorWatchOptions {
  debounceMs?: number;
}

export interface CursorWatch {
  readonly debounceMs: number;
  subscribe(
    watchPath: string,
    onEvent: () => void,
    onError: (error: Error) => void,
  ): { close(): void };
}

export function createCursorWatch(options: CursorWatchOptions = {}): CursorWatch {
  const debounceMs = options.debounceMs ?? CURSOR_WATCH_DEBOUNCE_MS;

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

import { type FSWatcher, watch as fsWatch } from "node:fs";
import { toError } from "@/core/errors";

export interface ProviderWatchOptions {
  debounceMs?: number;
}

export interface ProviderWatch {
  readonly debounceMs: number;
  subscribe(
    watchPath: string,
    onEvent: () => void,
    onError: (error: Error) => void,
  ): { close(): void };
}

export interface ProviderWatchConfig {
  defaultDebounceMs: number;
  shouldEmitForFilename?: (filename: string) => boolean;
}

export function createProviderWatch(
  config: ProviderWatchConfig,
  options: ProviderWatchOptions = {},
): ProviderWatch {
  const debounceMs = options.debounceMs ?? config.defaultDebounceMs;
  const shouldEmit = config.shouldEmitForFilename;

  function subscribe(
    watchPath: string,
    onEvent: () => void,
    onError: (error: Error) => void,
  ): { close(): void } {
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(watchPath, { recursive: true }, (_event, filename) => {
        if (shouldEmit && typeof filename === "string" && !shouldEmit(filename)) {
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

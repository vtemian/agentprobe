import {
  createProviderWatch,
  type ProviderWatch,
  type ProviderWatchOptions,
} from "@/providers/shared/watch";
import { CORTEX_CODE_WATCH_DEBOUNCE_MS } from "./constants";

export { CORTEX_CODE_WATCH_DEBOUNCE_MS };

export type CortexCodeWatchOptions = ProviderWatchOptions;

export type CortexCodeWatch = ProviderWatch;

export function createCortexCodeWatch(options: CortexCodeWatchOptions = {}): CortexCodeWatch {
  return createProviderWatch(
    {
      defaultDebounceMs: CORTEX_CODE_WATCH_DEBOUNCE_MS,
      shouldEmitForFilename: (filename) => filename.endsWith(".json"),
    },
    options,
  );
}

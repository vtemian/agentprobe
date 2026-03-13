import {
  createProviderWatch,
  type ProviderWatch,
  type ProviderWatchOptions,
} from "@/providers/shared/watch";
import { CURSOR_WATCH_DEBOUNCE_MS } from "./constants";

export { CURSOR_WATCH_DEBOUNCE_MS };

export type CursorWatchOptions = ProviderWatchOptions;

export type CursorWatch = ProviderWatch;

export function createCursorWatch(options: CursorWatchOptions = {}): CursorWatch {
  return createProviderWatch({ defaultDebounceMs: CURSOR_WATCH_DEBOUNCE_MS }, options);
}

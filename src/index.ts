import {
  createObserver as createCoreObserver,
  type Observer,
  type ObserverOptions,
  type TranscriptProvider,
} from "./core";
import { cursor } from "./providers/cursor";

export {
  createLifecycleMapper,
  createWatchRuntime,
  type Observer,
  type ObserverChangeEvent,
  type ObserverOptions,
  type ObserverSnapshot,
} from "./core";
export {
  toError,
  isWatchRuntimeError,
  WatchRuntimeError,
  WATCH_RUNTIME_ERROR_CODES,
  WATCH_RUNTIME_ERROR_MESSAGES,
  type WatchRuntimeErrorCode,
} from "./core/errors";
export {
  CANONICAL_AGENT_STATUS,
  CANONICAL_AGENT_KIND,
  type CanonicalAgentStatus,
  type CanonicalAgentKind,
  type CanonicalAgentSnapshot,
} from "./core/model";
export {
  PROVIDER_KINDS,
  type ProviderKind,
  type DiscoveryInput,
  type DiscoveryResult,
  type RawTranscriptRecord,
  type TranscriptReadResult,
  type CanonicalSnapshot,
  type TranscriptProvider,
} from "./core/providers";
export {
  WATCH_LIFECYCLE_KIND,
  WATCH_RUNTIME_EVENT_TYPES,
  WATCH_RUNTIME_STATES,
  type WatchHealth,
  type WatchSnapshot,
  type WatchSource,
  type WatchLifecycleKind,
  type WatchLifecycleEvent,
  type LifecycleSnapshot,
  type WatchRuntimeOptions,
  type WatchRuntimeSnapshotEvent,
  type WatchRuntimeLifecycleEvent,
  type WatchRuntimeStateEvent,
  type WatchRuntimeErrorEvent,
  type WatchRuntimeEvent,
  type WatchRuntime,
} from "./core/types";
export {
  resolveTranscriptDirectories,
  resolveTranscriptSourcePaths,
  cursor,
  createCursorTranscriptSource,
  createCursorWatch,
  CURSOR_WATCH_DEBOUNCE_MS,
  type CursorOptions,
  type CursorTranscriptSource,
  type CursorTranscriptSourceOptions,
  type TranscriptSourceResult,
  type CursorWatch,
  type CursorWatchOptions,
  type TranscriptDiscoveryOptions,
} from "./providers/cursor";

export interface CreateObserverOptions extends Omit<ObserverOptions, "provider"> {
  provider?: TranscriptProvider;
}

export function createObserver(options: CreateObserverOptions): Observer {
  return createCoreObserver({
    ...options,
    provider: options.provider ?? cursor(),
  });
}

import {
  createObserver as createCoreObserver,
  type Observer,
  type ObserverOptions,
  type TranscriptProvider,
} from "./core";
import { createCursorTranscriptProvider } from "./providers/cursor";

export {
  createLifecycleMapper,
  createWatchRuntime,
  type Observer,
  type ObserverChangeEvent,
  type ObserverOptions,
  type ObserverSnapshot,
} from "./core";
export {
  isWatchRuntimeError,
  toError,
  WATCH_RUNTIME_ERROR_CODES,
  WATCH_RUNTIME_ERROR_MESSAGES,
  WatchRuntimeError,
  type WatchRuntimeErrorCode,
} from "./core/errors";
export {
  CANONICAL_AGENT_KIND,
  CANONICAL_AGENT_STATUS,
  type CanonicalAgentKind,
  type CanonicalAgentSnapshot,
  type CanonicalAgentStatus,
} from "./core/model";
export {
  type CanonicalSnapshot,
  type DiscoveryInput,
  type DiscoveryResult,
  PROVIDER_KINDS,
  type ProviderKind,
  type RawTranscriptRecord,
  type TranscriptProvider,
  type TranscriptReadResult,
} from "./core/providers";
export {
  type LifecycleSnapshot,
  WATCH_LIFECYCLE_KIND,
  WATCH_RUNTIME_EVENT_TYPES,
  WATCH_RUNTIME_STATES,
  type WatchHealth,
  type WatchLifecycleEvent,
  type WatchLifecycleKind,
  type WatchRuntime,
  type WatchRuntimeErrorEvent,
  type WatchRuntimeEvent,
  type WatchRuntimeLifecycleEvent,
  type WatchRuntimeOptions,
  type WatchRuntimeSnapshotEvent,
  type WatchRuntimeStateEvent,
  type WatchSnapshot,
  type WatchSource,
} from "./core/types";
export {
  CURSOR_WATCH_DEBOUNCE_MS,
  type CursorTranscriptProviderOptions,
  type CursorTranscriptSource,
  type CursorTranscriptSourceOptions,
  type CursorWatch,
  type CursorWatchOptions,
  createCursorTranscriptProvider,
  createCursorTranscriptSource,
  createCursorWatch,
  resolveTranscriptDirectories,
  resolveTranscriptSourcePaths,
  type TranscriptDiscoveryOptions,
  type TranscriptSourceResult,
} from "./providers/cursor";

export interface CreateObserverOptions extends Omit<ObserverOptions, "provider"> {
  provider?: TranscriptProvider;
}

export function createObserver(options: CreateObserverOptions): Observer {
  return createCoreObserver({
    ...options,
    provider: options.provider ?? createCursorTranscriptProvider(),
  });
}

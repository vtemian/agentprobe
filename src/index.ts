import {
  createObserver as createCoreObserver,
  type Observer,
  type ObserverOptions,
  type TranscriptProvider,
} from "./core";
import { createCompositeProvider } from "./core/composite";
import { claudeCode } from "./providers/claude-code";
import { cursor } from "./providers/cursor";

export {
  createLifecycleMapper,
  createWatchRuntime,
  createCompositeProvider,
  type Observer,
  type ObserverChangeEvent,
  type ObserverOptions,
  type ObserverSnapshot,
} from "./core";

export {
  isWatchRuntimeError,
  WatchRuntimeError,
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
  cursor,
  type CursorOptions,
} from "./providers/cursor";
export {
  claudeCode,
  type ClaudeCodeOptions,
} from "./providers/claude-code";

export interface CreateObserverOptions extends Omit<ObserverOptions, "provider"> {
  providers?: TranscriptProvider[];
}

export function createObserver(options: CreateObserverOptions): Observer {
  const providers = options.providers ?? [cursor(), claudeCode()];
  const provider = providers.length === 1 ? providers[0] : createCompositeProvider(providers);

  return createCoreObserver({
    ...options,
    provider,
  });
}

import {
  createObserver as createCoreObserver,
  type Observer,
  type ObserverOptions,
  type TranscriptProvider,
} from "./core";
import { createCompositeProvider } from "./core/composite";
import { claudeCode } from "./providers/claude-code";
import { codex } from "./providers/codex";
import { cursor } from "./providers/cursor";
import { openCode } from "./providers/opencode";

export {
  createCompositeProvider,
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
  type ClaudeCodeOptions,
  claudeCode,
} from "./providers/claude-code";
export {
  type CodexOptions,
  codex,
} from "./providers/codex";
export {
  type CursorOptions,
  cursor,
} from "./providers/cursor";
export {
  type OpenCodeOptions,
  openCode,
} from "./providers/opencode";

export interface CreateObserverOptions extends Omit<ObserverOptions, "provider"> {
  providers?: TranscriptProvider[];
}

export function createObserver(options: CreateObserverOptions): Observer {
  const providers = options.providers ?? [cursor(), claudeCode(), codex(), openCode()];
  const provider = providers.length === 1 ? providers[0] : createCompositeProvider(providers);

  return createCoreObserver({
    ...options,
    provider,
  });
}

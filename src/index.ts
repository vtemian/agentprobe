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
  isObserverUpdatedEvent,
  OBSERVER_EVENT_TYPES,
  toError,
} from "./core";
export * from "./core/model";
export * from "./core/providers";
export * from "./core/types";
export * from "./providers/cursor";
export {
  AGENT_KIND,
  AGENT_LIFECYCLE_EVENT_KIND,
  AGENT_SOURCE_KIND,
  AGENT_STATUS,
  type AgentKind,
  type AgentLifecycleEvent,
  type AgentLifecycleEventType,
  type AgentSnapshot,
  type AgentSourceKind,
  type AgentSourceReadResult,
  type AgentStatus,
} from "./domain";

export interface CreateObserverOptions extends Omit<ObserverOptions, "provider"> {
  provider?: TranscriptProvider;
}

export function createObserver(options: CreateObserverOptions): Observer {
  return createCoreObserver({
    ...options,
    provider: options.provider ?? createCursorTranscriptProvider(),
  });
}

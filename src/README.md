# Shared Watch Integration

`@shared/watch` exposes an agent-centric subscription API.

## Public API

Import from:

- `@shared/watch`

Create a subscription:

- `createAgentSubscription(options)`

Methods:

- `start()`
- `stop()`
- `refreshNow()`
- `getLatestSnapshot()`
- `subscribe(listener)`
- `subscribeToAgentChanges(listener)` (updated events only)
- `subscribeToSnapshots(listener)` (snapshot events only)

Events:

- `snapshot` (one event per successful snapshot refresh)
  - includes `snapshot` with the latest full state
- `updated` (one event per agent change: joined/statusChanged/heartbeat/left)
  - includes `agent` (always present, including `left`)
- `errored` (runtime/source error, `agent` may be `undefined`)
- `started` (runtime state event, `agent` may be `undefined`)
- `stopped` (runtime state event, `agent` may be `undefined`)

Runtime errors are typed:

- `WatchRuntimeError` with stable `code` values (for example `NOT_RUNNING`)
- use `isWatchRuntimeError(error)` to branch safely on runtime error codes

## Quick Start

```ts
import { createAgentSubscription } from "@shared/watch";

const subscription = createAgentSubscription({
  projectPath: "/Users/me/my-project",
});

const disposeSnapshots = subscription.subscribeToSnapshots((event) => {
  // event.snapshot has the latest full state (agents + health)
});

const disposeUpdates = subscription.subscribeToAgentChanges((event) => {
  // event.change has: kind, fromStatus, toStatus, agentId, at
  // event.agent is always present
  // consume event.change and event.snapshot
});

await subscription.start();
```

## Integration Requirements

1. Provide a project path (`projectPath`) as input.
2. The library resolves transcript paths and reads transcript snapshots internally.
3. Optionally override source/watch adapters for testing.
4. Prefer `subscribeToSnapshots` for full-frame state updates.
5. Use `subscribeToAgentChanges` for per-agent lifecycle reactions.

## Notes

- Transcript discovery and parsing live inside `shared/watch`.
- Internal queue/debounce/watch mechanics are intentionally hidden from consumer API.

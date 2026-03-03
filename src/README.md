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

Events:

- `updated` (one event per agent change: joined/statusChanged/heartbeat/left)
  - includes `agent` (always present, including `left`)
- `errored` (runtime/source error, `agent` may be `undefined`)
- `started` (runtime state event, `agent` may be `undefined`)
- `stopped` (runtime state event, `agent` may be `undefined`)

## Quick Start

```ts
import { createAgentSubscription } from "@shared/watch";

const subscription = createAgentSubscription({
  projectPath: "/Users/me/my-project",
});

const dispose = subscription.subscribeToAgentChanges((event) => {
  // event.change has: kind, fromStatus, toStatus, agentId, at
  // event.agent is always present
  // consume event.change and event.snapshot
});

await subscription.start();
```

## Integration Requirements

1. Provide a project path (`projectPath`) as input.
2. The library resolves transcript paths from that project path and reads snapshots internally.
3. Optionally override source/watch adapters for testing.
4. Prefer `subscribeToAgentChanges` for UI/state updates.

## Notes

- Source parsing/discovery stays outside this module.
- Internal queue/debounce/watch mechanics are intentionally hidden from consumer API.

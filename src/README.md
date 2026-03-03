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

Events:

- `updated` (one event per agent change: joined/statusChanged/heartbeat/left)
  - includes `agent` (always present, including `left`)
- `errored`
- `started`
- `stopped`

## Quick Start

```ts
import { createAgentSubscription } from "@shared/watch";

const subscription = createAgentSubscription({
  projectPath: "/Users/me/my-project",
});

const dispose = subscription.subscribe((event) => {
  if (event.type === "updated") {
    // event.change has: kind, fromStatus, toStatus, agentId, at
    // consume event.change and event.snapshot
  }
});

await subscription.start();
```

## Integration Requirements

1. Provide a project path (`projectPath`) as input.
2. The library resolves transcript paths from that project path and reads snapshots internally.
3. Optionally override source/watch adapters for testing.
4. Consume `updated` events in your state/UI layer.

## Notes

- Source parsing/discovery stays outside this module.
- Internal queue/debounce/watch mechanics are intentionally hidden from consumer API.

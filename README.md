# @agenti-io/observer

`@agenti-io/observer` is a TypeScript library for observing agent/session activity from transcript-like sources.

It is designed in layers:

- `core`: generic runtime + lifecycle diffing (tool-agnostic)
- `providers/cursor`: Cursor transcript discovery + parsing adapter

The current provider implementation is Cursor-focused, while the runtime API is generic and ready for additional providers (Claude Code, Codex, OpenCode, custom systems).

## Install

```bash
npm install @agenti-io/observer
```

## Quick Start

```ts
import { createAgentSubscription } from "@agenti-io/observer";

const subscription = createAgentSubscription({
  projectPath: "/Users/me/my-project",
});

const disposeSnapshots = subscription.subscribeToSnapshots((event) => {
  console.log(event.snapshot.at, event.snapshot.agents.length);
});

const disposeUpdates = subscription.subscribeToAgentChanges((event) => {
  console.log(event.change.kind, event.agent.id);
});

await subscription.start();

// later
disposeSnapshots();
disposeUpdates();
await subscription.stop();
```

## Public Entry Points

- Root package:
  - `@agenti-io/observer`
- Core only:
  - `@agenti-io/observer/core`
- Cursor provider only:
  - `@agenti-io/observer/providers/cursor`

## Development

```bash
npm install
npm run check
npm run build
```

### Scripts

- `npm run format` - format code with Biome
- `npm run lint` - lint code with Biome
- `npm run typecheck` - run TypeScript checking
- `npm run test` - run Vitest suite
- `npm run build` - produce dist bundles with tsup
- `npm run check` - biome check + typecheck + test

## Examples

See `examples/basic-subscription.ts`.

## Roadmap

- Add provider contract abstraction for non-Cursor transcript systems
- Add built-in providers for Claude Code, Codex, and OpenCode
- Add normalization layer with canonical event model

## License

MIT. See `LICENSE`.

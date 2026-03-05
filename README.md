# shared-watch

`shared-watch` is a TypeScript library for observing agent/session activity from transcript-like sources.

It is designed in layers:

- `core`: generic runtime + lifecycle diffing (tool-agnostic)
- `providers/cursor`: Cursor transcript discovery + parsing adapter

The current provider implementation is Cursor-focused, while the runtime API is generic and ready for additional providers (Claude Code, Codex, OpenCode, custom systems).

## Install

```bash
npm install @agent-watch/shared-watch
```

## Quick Start

```ts
import { createAgentSubscription } from "@agent-watch/shared-watch";

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
  - `@agent-watch/shared-watch`
- Core only:
  - `@agent-watch/shared-watch/core`
- Cursor provider only:
  - `@agent-watch/shared-watch/providers/cursor`

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

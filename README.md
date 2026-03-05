# @agent-io/core

`@agent-io/core` is a TypeScript library for observing agent/session activity from transcript-like sources.

It is designed in layers:

- `core`: generic runtime + lifecycle diffing (tool-agnostic)
- `providers/cursor`: Cursor transcript discovery + parsing adapter

The core observer API is provider-injected and tool-agnostic. Cursor is currently the built-in provider, with support planned for Claude Code, Codex, OpenCode, and custom systems.

## Install

```bash
npm install @agent-io/core
```

## Quick Start (Provider-Agnostic)

```ts
import { createObserver } from "@agent-io/core";

const observer = createObserver({
  workspacePaths: ["/Users/me/my-project"],
});

const disposeSnapshots = observer.subscribeToSnapshots((event) => {
  console.log(event.snapshot.at, event.snapshot.agents.length);
});

const disposeUpdates = observer.subscribeToAgentChanges((event) => {
  console.log(event.change.kind, event.agent.id);
});

await observer.start();

// later
disposeSnapshots();
disposeUpdates();
await observer.stop();
```

`createObserver` defaults to the built-in Cursor provider. You can still pass a custom `provider` if needed.

## Public Entry Points

- Root package:
  - `@agent-io/core`
- Cursor provider only:
  - `@agent-io/core/providers/cursor`

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

See:

- `examples/provider-observer.ts` (provider-injected API)

## Roadmap

- Add provider contract abstraction for non-Cursor transcript systems
- Add built-in providers for Claude Code, Codex, and OpenCode
- Add normalization layer with canonical event model

## License

MIT. See `LICENSE`.

# Simple Observer

The minimal agentprobe example. Prints every agent lifecycle event to stdout.

## Prerequisites

- Node.js 20+
- `@agentprobe/core` built locally (`npm run build` from the repo root)

## Run

```bash
npx tsx examples/simple/simple-observer.ts [workspace-path]
```

If no workspace path is provided, it defaults to the current working directory.

## What it does

Watches all detected coding agents (Cursor, Claude Code, Codex, OpenCode) in the given workspace and logs every lifecycle event (joined, status changes, and left) with the agent ID, status, and task summary.

## Demo

<!-- TODO: Add demo video -->

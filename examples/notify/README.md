# macOS Notifications

Desktop notifications when coding agents complete or error out. Uses native `osascript` and `@agentprobe/core`, zero dependencies.

## Prerequisites

- macOS (uses native Notification Center via `osascript`)
- Node.js 20+
- `@agentprobe/core` built locally (`npm run build` from the repo root)

## Run

```bash
npx tsx notify.ts [workspace-path]
```

If no workspace path is provided, it defaults to the current working directory.

## What it does

Watches the given workspace for agent activity (Cursor, Claude Code, Codex, OpenCode) and logs every change event to stdout. When an agent transitions to `completed` or `error`, it fires a native macOS notification with the agent source and task summary.

## Demo

<!-- TODO: Add demo video -->

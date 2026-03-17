# Glimpse

A floating, always-on-top overlay that shows active coding agents in real time. Built with [GlimpseUI](https://github.com/hazat/glimpse) and `@agentprobe/core`.

## Prerequisites

- macOS (GlimpseUI uses a native Swift backend)
- Node.js 20+
- `@agentprobe/core` built locally (`npm run build` from the repo root)

## Setup

```bash
cd examples/glimpse
npm install
```

## Run

```bash
npx tsx glimpse.ts [workspace-path]
```

For a click-through HUD that passes clicks to whatever is underneath:

```bash
npx tsx glimpse.ts --click-through [workspace-path]
```

If no workspace path is provided, it defaults to the current working directory.

## What it does

Displays every active coding agent (Cursor, Claude Code, Codex, OpenCode) detected in the given workspace as a compact floating overlay:

- Colored status dot (green = running, yellow = idle, gray = completed, red = error)
- Source label and current task summary
- Time since last update and total duration ("3s / 2m")
- Auto-resizes based on agent count
- Fades agents in/out as they join or leave
- Hides completed/error agents after 5 minutes

## Demo

<!-- TODO: Add demo video -->

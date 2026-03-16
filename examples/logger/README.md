# Event Logger

Logs all agent events to a JSONL file for later analysis. Built with `@agentprobe/core`.

## Prerequisites

- Node.js 20+
- `@agentprobe/core` built locally (`npm run build` from the repo root)

## Setup

```bash
cd examples/logger
```

## Run

```bash
npx tsx logger.ts [workspace-path]
```

If no workspace path is provided, it defaults to the current working directory.

To write events to a custom file:

```bash
npx tsx logger.ts --output my-events.jsonl [workspace-path]
```

## What it does

Watches the given workspace for coding agent activity (Cursor, Claude Code, Codex, OpenCode) and appends one JSON record per event to the output file (defaults to `agent-events.jsonl`).

Each JSONL record contains:

- `timestamp`: ISO 8601 timestamp of the event
- `kind`: the event type (e.g. status change, discovery)
- `agentId` / `source`: which agent produced the event
- `status`, `fromStatus`, `toStatus`: current and transitioning states
- `taskSummary`: the agent's current task description

While running, every event is also printed to stdout as a single-line summary with timestamp, event kind, source label, and a truncated task summary.

On `Ctrl+C` (SIGINT), the logger prints a summary with total events captured, unique agents seen, and session duration before exiting.

## Demo

<!-- TODO: Add demo video -->

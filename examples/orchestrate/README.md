# Agent Orchestrator

Chains agents together so that when one completes (or errors), the next action triggers automatically. Define pipelines in a JSON config and let the orchestrator watch your workspaces for matching agent events.

## Prerequisites

- Node.js 20+
- `@agentprobe/core` built locally (`npm run build` from the repo root)

## Setup

```bash
cd examples/orchestrate
```

## Run

```bash
npx tsx orchestrate.ts pipeline.example.json [workspace-path]
```

If no workspace path is provided, it defaults to the current working directory.

## What it does

Reads a pipeline config file and watches one or more workspaces for agent lifecycle events. Each pipeline has a **trigger** and an **action**:

- **Trigger**: matches against agent snapshots using any combination of:
  - `status`: the agent's canonical status (`running`, `idle`, `completed`, `error`)
  - `source`: the agent's provider (e.g., `cursor-transcripts`, `claude-code`)
  - `taskSummary`: a regex tested against the agent's task summary (case-insensitive)
- **Action**: a shell command to execute when the trigger matches, with an optional `cwd`
- **Deduplication**: each agent + status pair fires at most once, preventing duplicate triggers on heartbeats

Example pipeline config (`pipeline.example.json`):

```json
{
  "pipelines": [
    {
      "name": "test-after-refactor",
      "trigger": { "status": "completed", "source": "cursor-transcripts" },
      "action": { "command": "npm test", "cwd": "/path/to/project" }
    },
    {
      "name": "notify-on-error",
      "trigger": { "status": "error" },
      "action": { "command": "say 'Agent session failed'" }
    },
    {
      "name": "lint-on-complete",
      "trigger": { "status": "completed", "taskSummary": "refactor|lint|format" },
      "action": { "command": "npm run lint" }
    }
  ]
}
```

## Demo

<!-- TODO: Add demo video -->

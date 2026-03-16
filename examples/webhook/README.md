# Slack / Discord Webhook

Posts agent lifecycle events (joined, completed, error, left) to a Slack or Discord webhook in real time. Built with `@agentprobe/core`.

## Prerequisites

- Node.js 20+
- `@agentprobe/core` built locally (`npm run build` from the repo root)
- A Slack [Incoming Webhook](https://api.slack.com/messaging/webhooks) or Discord [Webhook](https://support.discord.com/hc/en-us/articles/228383668) URL

## Setup

```bash
cd examples/webhook
```

## Run

```bash
WEBHOOK_URL=https://hooks.slack.com/services/T.../B.../xxx npx tsx webhook.ts [workspace-path]
```

If no workspace path is provided, it defaults to the current working directory.

## What it does

Monitors all detected coding agents (Cursor, Claude Code, Codex, OpenCode) in the given workspace and fires a webhook on lifecycle transitions:

- **Slack**: sends Block Kit messages with a status emoji, source label, task summary, and a context line with the agent ID and timestamp.
- **Discord**: sends rich embeds with a colored sidebar (blue = joined, green = completed, red = error, gray = left), the task summary as description, and an ISO timestamp in the footer.

Idle status changes are ignored to keep the channel quiet.

## Demo

<!-- TODO: Add demo video -->

# Examples

Each example lives in its own directory with a README and setup instructions. All examples use `@agentprobe/core` and watch for Cursor, Claude Code, Codex, and OpenCode agents by default.

## Getting started

Build the core library first:

```bash
# from the repo root
npm install
npm run build
```

Then pick an example and follow its README.

## Examples

| Example | Description |
|---------|-------------|
| [simple](simple/) | Minimal observer that prints every lifecycle event to stdout |
| [status-tracker](status-tracker/) | Tracks active agents and prints live status counts |
| [notify](notify/) | macOS desktop notifications on agent completion or error |
| [sounds](sounds/) | macOS system sounds on agent lifecycle events |
| [webhook](webhook/) | Posts events to a Slack or Discord webhook |
| [logger](logger/) | Logs all events to a JSONL file for later analysis |
| [dashboard](dashboard/) | Full-screen terminal TUI with agent table and event log |
| [orchestrate](orchestrate/) | Pipeline-driven command execution on agent events |
| [glimpse](glimpse/) | Floating macOS overlay with real-time agent status |

import { CANONICAL_AGENT_STATUS, createObserver, WATCH_LIFECYCLE_KIND } from "@agentprobe/core";
import notifier from "node-notifier";

const SOURCE_LABELS: Record<string, string> = {
  "cursor-transcripts": "Cursor",
  "claude-code-sessions": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const MAX_SUMMARY_LENGTH = 80;
const NOTIFY_STATUSES: Set<string> = new Set([
  CANONICAL_AGENT_STATUS.completed,
  CANONICAL_AGENT_STATUS.error,
]);

const workspacePaths = process.argv.slice(2);
if (workspacePaths.length === 0) workspacePaths.push(process.cwd());

const isoNow = (): string => new Date().toISOString();
const observer = createObserver({ workspacePaths });

observer.subscribe((event) => {
  const { change, agent } = event;
  const label = SOURCE_LABELS[agent.source] ?? agent.source;
  const summary = agent.taskSummary.slice(0, MAX_SUMMARY_LENGTH);

  console.log(`[${isoNow()}] ${change.kind} | ${label} → ${agent.status} | ${summary}`);

  if (change.kind === WATCH_LIFECYCLE_KIND.statusChanged && NOTIFY_STATUSES.has(agent.status)) {
    const verb = agent.status === CANONICAL_AGENT_STATUS.completed ? "Completed" : "Error";
    notifier.notify({ title: `${label} Agent ${verb}`, message: summary });
  }
});

await observer.start();
console.log(`[${isoNow()}] Watching ${workspacePaths.join(", ")}... (Ctrl+C to stop)`);

process.on("SIGINT", async () => {
  await observer.stop();
  process.exit(0);
});

import { execFile } from "node:child_process";
import { CANONICAL_AGENT_STATUS, createObserver } from "@agentprobe/core";

const SOURCE_LABELS: Record<string, string> = {
  "cursor-transcripts": "Cursor",
  "claude-code-sessions": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const MAX_SUMMARY_LENGTH = 80;

const STATUS_VERBS: Record<string, string> = {
  [CANONICAL_AGENT_STATUS.running]: "Running",
  [CANONICAL_AGENT_STATUS.idle]: "Idle",
  [CANONICAL_AGENT_STATUS.completed]: "Completed",
  [CANONICAL_AGENT_STATUS.error]: "Error",
};

const workspacePaths = process.argv.slice(2);
if (workspacePaths.length === 0) workspacePaths.push(process.cwd());

const isoNow = (): string => new Date().toISOString();
const notified = new Set<string>();
const observer = createObserver({ workspacePaths });

observer.subscribe((event) => {
  const { change, agent } = event;
  const label = SOURCE_LABELS[agent.source] ?? agent.source;
  const summary = agent.taskSummary.slice(0, MAX_SUMMARY_LENGTH);

  console.log(`[${isoNow()}] ${change.kind} | ${label} → ${agent.status} | ${summary}`);

  const verb = STATUS_VERBS[agent.status];
  if (!verb) return;

  const key = `${agent.id}:${agent.status}`;
  if (notified.has(key)) return;
  notified.add(key);

  const title = `${label} Agent ${verb}`;
  const escapeAppleScript = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `display notification "${escapeAppleScript(summary)}" with title "${escapeAppleScript(title)}"`;
  execFile("osascript", ["-e", script], (err) => {
    if (err) console.error("Notification failed:", err.message);
  });
});

await observer.start();
console.log(`[${isoNow()}] Watching ${workspacePaths.join(", ")}... (Ctrl+C to stop)`);

process.on("SIGINT", async () => {
  await observer.stop();
  process.exit(0);
});

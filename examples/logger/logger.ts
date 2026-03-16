import { appendFileSync, writeFileSync } from "node:fs";
import { createObserver } from "@agentprobe/core";

const SOURCE_LABELS: Record<string, string> = {
  "cursor-transcripts": "Cursor",
  "claude-code-sessions": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const MAX_SUMMARY_LENGTH = 80;

const parsedArgs = process.argv.slice(2);
const outputIdx = parsedArgs.indexOf("--output");
let outputFile = "agent-events.jsonl";
if (outputIdx !== -1) {
  const value = parsedArgs[outputIdx + 1];
  if (!value || value.startsWith("-")) {
    console.error("--output requires a file path");
    process.exit(1);
  }
  outputFile = value;
  parsedArgs.splice(outputIdx, 2);
}
const workspacePaths = parsedArgs.length ? parsedArgs : [process.cwd()];

writeFileSync(outputFile, "");
let eventCount = 0;
const agentsSeen = new Set<string>();
const startTime = Date.now();
const observer = createObserver({ workspacePaths });

observer.subscribe((event) => {
  const { change, agent } = event;
  const label = SOURCE_LABELS[agent.source] ?? agent.source;
  const record = {
    timestamp: new Date(change.at).toISOString(),
    kind: change.kind,
    agentId: agent.id,
    source: label,
    status: agent.status,
    fromStatus: change.fromStatus,
    toStatus: change.toStatus,
    taskSummary: agent.taskSummary,
  };
  appendFileSync(outputFile, `${JSON.stringify(record)}\n`);
  eventCount++;
  agentsSeen.add(agent.id);
  const summary = (agent.taskSummary ?? "").slice(0, MAX_SUMMARY_LENGTH);
  console.log(`[${record.timestamp}] ${record.kind} | ${label} (${agent.status}) | ${summary}`);
});

await observer.start();
console.log(`Logging to ${outputFile}, watching ${workspacePaths.join(", ")}... (Ctrl+C to stop)`);

process.on("SIGINT", async () => {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n--- Summary ---");
  console.log(
    `Total events: ${eventCount} | Agents seen: ${agentsSeen.size} | Duration: ${elapsed}s`,
  );
  await observer.stop();
  process.exit(0);
});

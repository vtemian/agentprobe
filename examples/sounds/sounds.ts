import { execFile } from "node:child_process";
import { createObserver, WATCH_LIFECYCLE_KIND } from "@agentprobe/core";

const LABELS: Record<string, string> = {
  "cursor-transcripts": "Cursor",
  "claude-code-sessions": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};
const SOUNDS: Record<string, string> = {
  joined: "/System/Library/Sounds/Pop.aiff",
  completed: "/System/Library/Sounds/Glass.aiff",
  error: "/System/Library/Sounds/Basso.aiff",
};
const MAX_SUMMARY_LENGTH = 80;

const workspacePaths = process.argv.slice(2);
if (workspacePaths.length === 0) workspacePaths.push(process.cwd());

const isoNow = (): string => new Date().toISOString();
const play = (file: string): void => {
  execFile("afplay", [file], (err) => {
    if (err) console.error(`[sounds] Failed to play ${file}: ${err.message}`);
  });
};
const observer = createObserver({ workspacePaths });

observer.subscribe((event) => {
  const { change, agent } = event;
  if (change.kind === WATCH_LIFECYCLE_KIND.statusChanged && agent.status === "idle") return;

  const label = LABELS[agent.source] ?? agent.source;
  console.log(
    `[${isoNow()}] ${change.kind} | ${label} → ${agent.status} | ${agent.taskSummary.slice(0, MAX_SUMMARY_LENGTH)}`,
  );

  const sound = SOUNDS[change.kind] ?? SOUNDS[agent.status];
  if (sound) play(sound);
});

await observer.start();
console.log(`[${isoNow()}] Watching ${workspacePaths.join(", ")}... (Ctrl+C to stop)`);

process.on("SIGINT", async () => {
  await observer.stop();
  process.exit(0);
});

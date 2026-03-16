import { type ChildProcess, exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  type CanonicalAgentSnapshot,
  type CanonicalAgentStatus,
  createObserver,
  WATCH_LIFECYCLE_KIND,
} from "@agentprobe/core";

interface PipelineTrigger {
  status?: CanonicalAgentStatus;
  source?: string;
  taskSummary?: string;
}

interface PipelineAction {
  command: string;
  cwd?: string;
}

interface Pipeline {
  name: string;
  trigger: PipelineTrigger;
  action: PipelineAction;
}

interface PipelineConfig {
  pipelines: Pipeline[];
}

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: npx tsx orchestrate.ts <pipeline.json> [workspace...]");
  process.exit(1);
}
if (!existsSync(configPath)) {
  console.error(`Config file not found: ${configPath}`);
  process.exit(1);
}

let pipelines: Pipeline[];
try {
  const config: PipelineConfig = JSON.parse(readFileSync(configPath, "utf-8"));
  pipelines = config.pipelines;
} catch (err) {
  console.error(`Failed to parse config: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const workspacePaths = process.argv.slice(3);
if (workspacePaths.length === 0) workspacePaths.push(process.cwd());

const isoNow = (): string => new Date().toISOString();
const log = (msg: string): void => console.log(`[${isoNow()}] ${msg}`);
const seen = new Map<string, number>();
const children = new Set<ChildProcess>();

const DEDUPE_TTL_MS = 60_000;

function pruneSeen(): void {
  const now = Date.now();
  for (const [key, timestamp] of seen) {
    if (now - timestamp > DEDUPE_TTL_MS) seen.delete(key);
  }
}

function matches(trigger: PipelineTrigger, agent: CanonicalAgentSnapshot): boolean {
  if (trigger.status && agent.status !== trigger.status) return false;
  if (trigger.source && agent.source !== trigger.source) return false;
  if (trigger.taskSummary && !new RegExp(trigger.taskSummary, "i").test(agent.taskSummary)) {
    return false;
  }
  return true;
}

function runAction(name: string, action: PipelineAction): void {
  log(`[${name}] exec: ${action.command}`);
  const child = exec(action.command, { cwd: action.cwd }, (err, stdout, stderr) => {
    children.delete(child);
    if (err) {
      const exitInfo = err.code != null ? `code ${err.code}` : `signal ${err.signal ?? "unknown"}`;
      log(`[${name}] error (${exitInfo}): ${stderr.trim() || err.message}`);
      return;
    }
    if (stdout.trim()) log(`[${name}] stdout: ${stdout.trim()}`);
    if (stderr.trim()) log(`[${name}] stderr: ${stderr.trim()}`);
  });
  children.add(child);
}

const observer = createObserver({ workspacePaths });

observer.subscribe((event) => {
  const { change, agent } = event;
  if (
    change.kind !== WATCH_LIFECYCLE_KIND.statusChanged &&
    change.kind !== WATCH_LIFECYCLE_KIND.joined
  ) {
    return;
  }

  const dedupeKey = `${agent.id}:${agent.status}:${change.at}`;
  if (seen.has(dedupeKey)) return;
  pruneSeen();
  seen.set(dedupeKey, Date.now());

  for (const pipeline of pipelines) {
    if (matches(pipeline.trigger, agent)) {
      log(
        `[${pipeline.name}] triggered by ${agent.source} (${agent.id.slice(0, 8)}) -> ${agent.status}`,
      );
      runAction(pipeline.name, pipeline.action);
    }
  }
});

await observer.start();
log(
  `Watching ${workspacePaths.join(", ")} with ${pipelines.length} pipeline(s)... (Ctrl+C to stop)`,
);

process.on("SIGINT", async () => {
  log("Shutting down...");
  for (const child of children) child.kill();
  await observer.stop();
  process.exit(0);
});

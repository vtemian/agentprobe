import {
  CANONICAL_AGENT_STATUS,
  type CanonicalAgentSnapshot,
  createObserver,
  WATCH_LIFECYCLE_KIND,
} from "@agentprobe/core";

const STATUS_ICON: Record<string, string> = { running: "\u25B6", idle: "\u25E6" };

const activeAgents = new Map<string, CanonicalAgentSnapshot>();

const observer = createObserver({
  workspacePaths: [process.argv[2] ?? process.cwd()],
});

const isoNow = (): string => new Date().toISOString().slice(11, 23);

observer.subscribe((event) => {
  const { change, agent } = event;

  if (
    change.kind === WATCH_LIFECYCLE_KIND.left ||
    agent.status === CANONICAL_AGENT_STATUS.completed ||
    agent.status === CANONICAL_AGENT_STATUS.error
  ) {
    activeAgents.delete(agent.id);
  } else {
    activeAgents.set(agent.id, agent);
  }

  if (activeAgents.size === 0) {
    console.log(`[${isoNow()}] ${event.snapshot.agents.length} agents, none active`);
    return;
  }

  const counts = new Map<string, number>();
  for (const a of activeAgents.values()) {
    counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([s, n]) => `${n} ${s}`).join(", ");
  console.log(`[${isoNow()}] ${summary} / ${event.snapshot.agents.length} total:`);
  for (const a of activeAgents.values()) {
    console.log(
      `  ${STATUS_ICON[a.status] ?? "?"} ${a.id.slice(0, 8)} | ${a.taskSummary.slice(0, 80)}`,
    );
  }
});

await observer.start();
console.log("Watching... (Ctrl+C to stop)");

process.on("SIGINT", async () => {
  await observer.stop();
  process.exit(0);
});

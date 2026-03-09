import type { CanonicalAgentSnapshot } from "../src/core/model";
import { createObserver } from "../src/index";

const DURATION_MS = 2 * 60 * 1000;

const activeAgents = new Map<string, CanonicalAgentSnapshot>();

async function main(): Promise<void> {
  const observer = createObserver({
    workspacePaths: [process.argv[2] ?? process.cwd()],
  });

  observer.subscribe((event) => {
    const { change, agent } = event;

    if (change.kind === "left" || agent.status === "completed" || agent.status === "error") {
      activeAgents.delete(agent.id);
    } else {
      activeAgents.set(agent.id, agent);
    }

    const running = [...activeAgents.values()].filter((a) => a.status === "running");
    const idle = [...activeAgents.values()].filter((a) => a.status === "idle");

    if (running.length === 0 && idle.length === 0) {
      console.log(`[${ts()}] ${event.snapshot.agents.length} agents, none active`);
      return;
    }

    const parts = [
      running.length > 0 ? `${running.length} running` : "",
      idle.length > 0 ? `${idle.length} idle` : "",
    ]
      .filter(Boolean)
      .join(", ");
    console.log(`[${ts()}] ${parts} / ${event.snapshot.agents.length} total:`);
    for (const a of running) {
      console.log(`  ▶ ${a.id.slice(0, 8)} | ${a.taskSummary.slice(0, 80)}`);
    }
    for (const a of idle) {
      console.log(`  ◦ ${a.id.slice(0, 8)} | ${a.taskSummary.slice(0, 80)}`);
    }
  });

  await observer.start();
  console.log(`Observer started. Watching for ${DURATION_MS / 1000}s...`);

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));

  await observer.stop();
  console.log("Observer stopped.");
}

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

void main();

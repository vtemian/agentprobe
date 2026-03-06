import { createObserver, OBSERVER_EVENT_TYPES } from "@agentprobe/core";

async function main(): Promise<void> {
  const projectPath = process.argv[2];
  if (!projectPath) {
    throw new Error("Usage: tsx examples/provider-observer.ts <project-path>");
  }

  const observer = createObserver({
    workspacePaths: [projectPath],
  });

  observer.subscribe((event) => {
    if (event.type === OBSERVER_EVENT_TYPES.snapshot) {
      console.log(
        `[snapshot] at=${event.at} connected=${event.snapshot.health.connected} agents=${event.snapshot.agents.length}`,
      );
      return;
    }
    if (event.type === OBSERVER_EVENT_TYPES.updated) {
      console.log(
        `[updated] kind=${event.change.kind} id=${event.agent.id} status=${event.agent.status}`,
      );
    }
  });

  await observer.start();
  console.log("Observer started. Press Ctrl+C to stop.");
}

void main();

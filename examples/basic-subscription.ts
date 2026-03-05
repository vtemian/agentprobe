import { createAgentSubscription } from "../src/index";

async function main(): Promise<void> {
  const projectPath = process.argv[2];
  if (!projectPath) {
    throw new Error("Usage: tsx examples/basic-subscription.ts <project-path>");
  }

  const subscription = createAgentSubscription({ projectPath });

  subscription.subscribeToSnapshots((event) => {
    console.log(
      `[snapshot] at=${event.at} connected=${event.snapshot.health.connected} agents=${event.snapshot.agents.length}`,
    );
  });

  subscription.subscribeToAgentChanges((event) => {
    console.log(
      `[updated] kind=${event.change.kind} id=${event.agent.id} status=${event.agent.status}`,
    );
  });

  await subscription.start();
  console.log("Started. Press Ctrl+C to stop.");
}

void main();

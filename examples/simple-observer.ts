import { createObserver } from "../src/index";

async function main(): Promise<void> {
  const observer = createObserver({
    workspacePaths: [process.argv[2] ?? process.cwd()],
  });

  observer.subscribe((event) => {
    const { change, agent } = event;
    console.log(
      `[${change.kind}] ${agent.id.slice(0, 8)} → ${agent.status} | ${agent.taskSummary.slice(0, 60)}`,
    );
  });

  await observer.start();
  console.log("Watching... (Ctrl+C to stop)");

  process.on("SIGINT", async () => {
    await observer.stop();
    process.exit(0);
  });
}

void main();

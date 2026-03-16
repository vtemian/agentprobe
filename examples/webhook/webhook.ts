import {
  type CanonicalAgentSnapshot,
  createObserver,
  WATCH_LIFECYCLE_KIND,
} from "@agentprobe/core";

type AgentInfo = Pick<CanonicalAgentSnapshot, "source" | "taskSummary" | "id" | "updatedAt">;

const WEBHOOK_URL_RAW = process.env.WEBHOOK_URL;
if (!WEBHOOK_URL_RAW) {
  console.error("Missing WEBHOOK_URL env var");
  process.exit(1);
}
const WEBHOOK_URL: string = WEBHOOK_URL_RAW;

const SOURCE_LABELS: Record<string, string> = {
  "cursor-transcripts": "Cursor",
  "claude-code-sessions": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const isSlack = WEBHOOK_URL.includes("hooks.slack.com");
const isDiscord = WEBHOOK_URL.includes("discord.com");
if (!isSlack && !isDiscord) {
  console.error("WEBHOOK_URL must be a Slack or Discord webhook");
  process.exit(1);
}

const STATUS_EMOJI: Record<string, string> = {
  joined: "\u{1F7E2}",
  completed: "\u2705",
  error: "\u274C",
  left: "\u{1F44B}",
};
const DISCORD_COLORS: Record<string, number> = {
  joined: 0x3498db,
  completed: 0x2ecc71,
  error: 0xe74c3c,
  left: 0x95a5a6,
};

function slackPayload(kind: string, agent: AgentInfo) {
  const emoji = STATUS_EMOJI[kind] ?? "\u2753";
  const source = SOURCE_LABELS[agent.source] ?? agent.source;
  const ts = new Date(agent.updatedAt).toLocaleTimeString();
  return {
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${emoji} *${kind}* — ${source}` } },
      { type: "section", text: { type: "mrkdwn", text: agent.taskSummary || "_no summary_" } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Agent \`${agent.id.slice(0, 8)}\` • ${ts}` }],
      },
    ],
  };
}

function discordPayload(kind: string, agent: AgentInfo) {
  const source = SOURCE_LABELS[agent.source] ?? agent.source;
  return {
    embeds: [
      {
        title: `${kind} — ${source}`,
        description: agent.taskSummary || "_no summary_",
        color: DISCORD_COLORS[kind] ?? 0x95a5a6,
        footer: { text: `Agent ${agent.id.slice(0, 8)}` },
        timestamp: new Date(agent.updatedAt).toISOString(),
      },
    ],
  };
}

async function post(kind: string, agent: AgentInfo): Promise<void> {
  const body = isSlack ? slackPayload(kind, agent) : discordPayload(kind, agent);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error(`Webhook ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error("Webhook request failed:", err);
  }
}

const paths = process.argv.slice(2);
const observer = createObserver({
  workspacePaths: paths.length ? paths : [process.cwd()],
});

observer.subscribe((event) => {
  const { kind } = event.change;
  if (kind === WATCH_LIFECYCLE_KIND.statusChanged && event.agent.status === "idle") return;
  const shouldPost =
    kind === WATCH_LIFECYCLE_KIND.joined ||
    kind === WATCH_LIFECYCLE_KIND.left ||
    (kind === WATCH_LIFECYCLE_KIND.statusChanged &&
      (event.agent.status === "completed" || event.agent.status === "error"));
  if (shouldPost)
    post(kind === WATCH_LIFECYCLE_KIND.statusChanged ? event.agent.status : kind, event.agent);
});

await observer.start();
console.log("Webhook relay running... (Ctrl+C to stop)");

process.on("SIGINT", async () => {
  await observer.stop();
  process.exit(0);
});

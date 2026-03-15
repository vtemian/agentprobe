import {
  type CanonicalAgentSnapshot,
  type CanonicalAgentStatus,
  createObserver,
} from "@agentprobe/core";
import { type GlimpseWindow, open } from "glimpseui";

const WINDOW_WIDTH = 320;
const WINDOW_HEIGHT = 400;
const WINDOW_X = 20;
const WINDOW_Y = 100;
const TICK_MS = 1000;
const FADE_MS = 200;

const SOURCE_LABELS: Record<string, string> = {
  "cursor-transcripts": "Cursor",
  "claude-code-sessions": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: rgba(24, 24, 27, 0.85);
    --border: rgba(255, 255, 255, 0.08);
    --border-subtle: rgba(255, 255, 255, 0.06);
    --border-faint: rgba(255, 255, 255, 0.04);
    --text: #e4e4e7;
    --text-bright: #fafafa;
    --text-muted: #a1a1aa;
    --text-dim: #71717a;
    --text-ghost: #52525b;
    --status-running: #4ade80;
    --status-idle: #facc15;
    --status-completed: #9ca3af;
    --status-error: #f87171;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "SF Mono", "Menlo", "Monaco", monospace;
    font-size: 12px;
    color: var(--text);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    -webkit-user-select: none;
    user-select: none;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 14px 8px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .title { font-weight: 600; font-size: 13px; color: var(--text-bright); }
  .count { font-size: 11px; color: var(--text-dim); }
  #agents {
    overflow-y: auto;
    max-height: calc(100vh - 44px);
  }
  .agent {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-faint);
  }
  .agent.entering { animation: fadeIn ${FADE_MS}ms ease-out; }
  .agent.leaving { animation: fadeOut ${FADE_MS}ms ease-in forwards; }
  .agent:last-child { border-bottom: none; }
  .agent-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
  }
  .agent-source {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
    font-size: 12px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }
  .dot.running {
    background: var(--status-running);
    animation: pulse 2s ease-in-out infinite;
  }
  .dot.idle { background: var(--status-idle); }
  .dot.completed { background: var(--status-completed); }
  .dot.error { background: var(--status-error); }
  .time-ago {
    font-size: 10px;
    color: var(--text-dim);
  }
  .task-summary {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .empty {
    padding: 32px 14px;
    text-align: center;
    color: var(--text-ghost);
    font-size: 12px;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeOut {
    from { opacity: 1; transform: translateY(0); }
    to { opacity: 0; transform: translateY(4px); }
  }
</style></head><body>
  <header>
    <span class="title">agentprobe</span>
    <span class="count" id="count">0 active</span>
  </header>
  <div id="agents">
    <div class="empty">No active agents</div>
  </div>
  <script>
    var knownKeys = "";
    var knownIds = {};

    function formatTimeAgo(updatedAt, now) {
      var delta = Math.max(0, Math.floor((now - updatedAt) / 1000));
      if (delta < 60) return delta + "s ago";
      if (delta < 3600) return Math.floor(delta / 60) + "m ago";
      return Math.floor(delta / 3600) + "h ago";
    }

    function escapeHtml(str) {
      var el = document.createElement("span");
      el.textContent = str;
      return el.innerHTML;
    }

    function escapeAttr(str) {
      return str.replace(/[^a-z0-9-]/gi, "");
    }

    function buildAgentCard(a, now, isNew) {
      var cls = "agent";
      if (a.leaving) cls += " leaving";
      else if (isNew) cls += " entering";

      var time = formatTimeAgo(a.updatedAt, now);
      return '<div class="' + cls + '">'
        + '<div class="agent-header">'
        + '<span class="agent-source">'
        + '<span class="dot ' + escapeAttr(a.status) + '"></span>'
        + escapeHtml(a.sourceLabel)
        + '</span>'
        + '<span class="time-ago">' + time + '</span>'
        + '</div>'
        + '<div class="task-summary">' + escapeHtml(a.taskSummary) + '</div>'
        + '</div>';
    }

    function updateTimestamps(agents, now) {
      var els = document.querySelectorAll(".agent .time-ago");
      for (var i = 0; i < els.length && i < agents.length; i++) {
        els[i].textContent = formatTimeAgo(agents[i].updatedAt, now);
      }
    }

    function render(agents, now) {
      var activeCount = agents.filter(function(a) { return !a.leaving; }).length;
      document.getElementById("count").textContent = activeCount + " active";

      var container = document.getElementById("agents");

      if (agents.length === 0) {
        container.innerHTML = '<div class="empty">No active agents</div>';
        knownKeys = "";
        knownIds = {};
        return;
      }

      var newKeys = agents.map(function(a) {
        return a.id + ":" + a.status + (a.leaving ? ":L" : "");
      }).join(",");

      if (newKeys === knownKeys) {
        updateTimestamps(agents, now);
        return;
      }

      var prevIds = knownIds;
      knownIds = {};
      agents.forEach(function(a) { knownIds[a.id] = true; });

      knownKeys = newKeys;
      container.innerHTML = agents.map(function(a) {
        var isNew = !prevIds[a.id];
        return buildAgentCard(a, now, isNew);
      }).join("");
    }
  </script>
</body></html>`;

interface AgentView {
  readonly id: string;
  readonly status: CanonicalAgentStatus;
  readonly sourceLabel: string;
  readonly taskSummary: string;
  readonly updatedAt: number;
  readonly leaving: boolean;
}

function toView(agent: CanonicalAgentSnapshot): AgentView {
  return {
    id: agent.id,
    status: agent.status,
    sourceLabel: SOURCE_LABELS[agent.source] ?? agent.source,
    taskSummary: agent.taskSummary,
    updatedAt: agent.updatedAt,
    leaving: false,
  };
}

function parseWorkspacePaths(): string[] {
  return process.argv.length > 2 ? process.argv.slice(2) : [process.cwd()];
}

function setupShutdown(
  win: GlimpseWindow,
  observer: { stop(): Promise<void> },
  ticker: ReturnType<typeof setInterval>,
  unsubscribe: () => void,
): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(ticker);
    unsubscribe();
    try {
      win.close();
    } catch (error: unknown) {
      console.debug("Window close skipped:", error);
    }
    try {
      await observer.stop();
    } catch (error: unknown) {
      console.debug("Observer stop failed:", error);
    }
  };

  process.on("SIGINT", () => void shutdown());
  win.on("closed", () => void shutdown());
}

async function main(): Promise<void> {
  const workspacePaths = parseWorkspacePaths();
  const activeAgents = new Map<string, AgentView>();
  const observer = createObserver({ workspacePaths });

  const win = open(html, {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    frameless: true,
    transparent: true,
    floating: true,
    x: WINDOW_X,
    y: WINDOW_Y,
  });

  win.on("error", (err: unknown) => console.error("Glimpse:", err));

  const sendUpdate = (): void => {
    const payload = JSON.stringify([...activeAgents.values()]);
    win.send(`render(${payload}, ${Date.now()})`);
  };

  const scheduleFadeRemoval = (agentId: string): void => {
    setTimeout(() => {
      const current = activeAgents.get(agentId);
      if (current?.leaving) {
        activeAgents.delete(agentId);
        sendUpdate();
      }
    }, FADE_MS);
  };

  const unsubscribe = observer.subscribe((event) => {
    if (event.change.kind === "left") {
      const existing = activeAgents.get(event.agent.id);
      if (existing) {
        activeAgents.set(event.agent.id, { ...existing, leaving: true });
        scheduleFadeRemoval(event.agent.id);
      }
    } else {
      activeAgents.set(event.agent.id, toView(event.agent));
    }
    sendUpdate();
  });

  win.on("ready", sendUpdate);
  await observer.start();

  const ticker = setInterval(sendUpdate, TICK_MS);
  console.log(`Watching ${workspacePaths.join(", ")}...`);

  setupShutdown(win, observer, ticker, unsubscribe);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

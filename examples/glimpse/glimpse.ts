import {
  type CanonicalAgentSnapshot,
  type CanonicalAgentStatus,
  createObserver,
} from "@agentprobe/core";
import { type GlimpseWindow, open } from "glimpseui";

const WIDTH = 300;
const HEADER_HEIGHT = 40;
const MAX_HEIGHT = 500;
const TICK_MS = 1000;
const FADE_MS = 200;
const STALE_MS = 5 * 60 * 1000;

const SOURCE_LABELS: Record<string, string> = {
  "cursor-transcripts": "Cursor",
  "claude-code-sessions": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const SOURCE_COLORS: Record<string, string> = {
  "cursor-transcripts": "#a78bfa",
  "claude-code-sessions": "#fb923c",
  codex: "#22d3ee",
  opencode: "#60a5fa",
};

const clickThrough = process.argv.includes("--click-through");
const paths = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const workspaces = paths.length > 0 ? paths : [process.cwd()];

const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    --bg: rgb(24, 24, 27);
    --border: rgba(255, 255, 255, 0.07);
    --border-faint: rgba(255, 255, 255, 0.03);
    --text: #e4e4e7;
    --bright: #fafafa;
    --muted: #a1a1aa;
    --dim: #71717a;
    --ghost: #52525b;
    --running: #4ade80;
    --idle: #facc15;
    --completed: #9ca3af;
    --error: #f87171;
    --cursor: #a78bfa;
    --claude: #fb923c;
    --codex: #22d3ee;
    --opencode: #60a5fa;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font: 13px/1.4 "SF Mono", Menlo, Monaco, monospace;
    color: var(--text);
    background: var(--bg);
    -webkit-user-select: none;
    user-select: none;
    overflow: hidden;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 10px 6px;
    border-bottom: 1px solid var(--border);
  }
  .title { font-weight: 600; color: var(--bright); }
  .badge {
    font-size: 11px; color: var(--dim);
    background: rgba(255,255,255,0.05);
    padding: 1px 6px; border-radius: 8px;
  }
  #agents { overflow-y: auto; max-height: ${MAX_HEIGHT - HEADER_HEIGHT}px; }
  .agent {
    padding: 7px 10px 7px 12px;
    border-bottom: 1px solid var(--border-faint);
    border-left: 3px solid transparent;
  }
  .agent.entering { animation: fadeIn ${FADE_MS}ms ease-out; }
  .agent.leaving  { animation: fadeOut ${FADE_MS}ms ease-in forwards; }
  .agent:last-child { border-bottom: none; }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .source { display: flex; align-items: center; gap: 6px; font-weight: 500; }
  .provider {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    padding: 1px 5px;
    border-radius: 3px;
    background: rgba(255,255,255,0.06);
  }
  .status-pill {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 500;
    padding: 1px 6px 1px 4px;
    border-radius: 8px;
  }
  .status-pill.running  { color: var(--running); background: rgba(74,222,128,0.1); }
  .status-pill.idle     { color: var(--idle); background: rgba(250,204,21,0.1); }
  .status-pill.completed { color: var(--completed); background: rgba(156,163,175,0.1); }
  .status-pill.error    { color: var(--error); background: rgba(248,113,113,0.1); }
  .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .dot.running  { background: var(--running); box-shadow: 0 0 6px var(--running); animation: pulse 2s ease-in-out infinite; }
  .dot.idle     { background: var(--idle); box-shadow: 0 0 4px rgba(250,204,21,0.4); }
  .dot.completed { background: var(--completed); }
  .dot.error    { background: var(--error); box-shadow: 0 0 6px var(--error); }
  .meta { font-size: 11px; color: var(--dim); }
  .task {
    font-size: 12px; color: var(--muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-top: 3px;
  }
  .empty {
    padding: 20px 10px; text-align: center; color: var(--ghost);
  }
  .empty .pulse { animation: pulse 3s ease-in-out infinite; }
  @keyframes pulse  { 0%,100% { opacity:1; } 50% { opacity:0.35; } }
  @keyframes fadeIn  { from { opacity:0; transform:translateY(-3px); } to { opacity:1; } }
  @keyframes fadeOut { from { opacity:1; } to { opacity:0; transform:translateY(3px); } }
</style></head><body>
  <header>
    <span class="title">agentprobe</span>
    <span class="badge" id="badge">0</span>
  </header>
  <div id="agents"><div class="empty"><span class="pulse">watching...</span></div></div>
  <script>
    var prev = "";
    var ids = {};
    function ago(ts, now) {
      var s = Math.max(0, Math.floor((now - ts) / 1000));
      return s < 60 ? s + "s" : s < 3600 ? Math.floor(s / 60) + "m" : Math.floor(s / 3600) + "h";
    }
    function dur(started, now) {
      if (!started) return "";
      var s = Math.max(0, Math.floor((now - started) / 1000));
      if (s < 60) return s + "s";
      var m = Math.floor(s / 60);
      return m < 60 ? m + "m" : Math.floor(m / 60) + "h" + (m % 60) + "m";
    }
    function meta(a, now) { var d = dur(a.startedAt, now); return ago(a.updatedAt, now) + (d ? " / " + d : ""); }
    function esc(s) { var e = document.createElement("span"); e.textContent = s; return e.innerHTML; }
    function safe(s) { return s.replace(/[^a-z0-9-]/gi, ""); }
    function card(a, now, fresh) {
      var cls = "agent" + (a.leaving ? " leaving" : fresh ? " entering" : "");
      var border = a.color ? "border-left-color:" + a.color : "";
      var provStyle = a.color ? "color:" + a.color : "";
      return '<div class="' + cls + '" style="' + border + '">'
        + '<div class="row"><span class="source">'
        + '<span class="provider" style="' + provStyle + '">' + esc(a.label) + '</span>'
        + '</span>'
        + '<span class="status-pill ' + safe(a.status) + '"><span class="dot ' + safe(a.status) + '"></span>' + safe(a.status) + '</span></div>'
        + '<div class="row"><div class="task">' + esc(a.task) + '</div>'
        + '<span class="meta">' + meta(a, now) + '</span></div></div>';
    }
    document.addEventListener("keydown", function(e) {
      if (!e.metaKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        var size = parseFloat(getComputedStyle(document.body).fontSize) + 1;
        document.body.style.fontSize = size + "px";
      } else if (e.key === "-") {
        e.preventDefault();
        var size = Math.max(8, parseFloat(getComputedStyle(document.body).fontSize) - 1);
        document.body.style.fontSize = size + "px";
      } else if (e.key === "0") {
        e.preventDefault();
        document.body.style.fontSize = "";
      }
    });
    function render(agents, now) {
      var active = agents.filter(function(a) { return !a.leaving; }).length;
      document.getElementById("badge").textContent = active;
      var c = document.getElementById("agents");
      if (!agents.length) { c.innerHTML = '<div class="empty"><span class="pulse">watching...</span></div>'; prev = ""; ids = {}; return; }
      var k = agents.map(function(a) { return a.id + ":" + a.status + (a.leaving ? ":L" : ""); }).join(",");
      if (k === prev) { c.querySelectorAll(".meta").forEach(function(el, i) { if (agents[i]) el.textContent = meta(agents[i], now); }); return; }
      var old = ids; ids = {}; agents.forEach(function(a) { ids[a.id] = 1; });
      prev = k;
      c.innerHTML = agents.map(function(a) { return card(a, now, !old[a.id]); }).join("");
    }
  </script>
</body></html>`;

interface AgentView {
  readonly id: string;
  readonly status: CanonicalAgentStatus;
  readonly label: string;
  readonly color: string;
  readonly task: string;
  readonly updatedAt: number;
  readonly startedAt: number | undefined;
  readonly leaving: boolean;
}

function toView(agent: CanonicalAgentSnapshot): AgentView {
  return {
    id: agent.id,
    status: agent.status,
    label: SOURCE_LABELS[agent.source] ?? agent.source,
    color: SOURCE_COLORS[agent.source] ?? "#a1a1aa",
    task: agent.taskSummary,
    updatedAt: agent.updatedAt,
    startedAt: agent.startedAt,
    leaving: false,
  };
}

function isStale(agent: CanonicalAgentSnapshot): boolean {
  if (agent.status !== "completed" && agent.status !== "error") return false;
  return Date.now() - agent.updatedAt > STALE_MS;
}

async function main(): Promise<void> {
  const agents = new Map<string, AgentView>();
  const observer = createObserver({ workspacePaths: workspaces });

  const win: GlimpseWindow = open(html, {
    width: WIDTH,
    height: MAX_HEIGHT,
    title: "agentprobe",
    floating: true,
    clickThrough,
  });

  win.on("error", (err: unknown) => console.error("glimpse:", err));

  const send = (): void => {
    const visible = [...agents.values()];
    win.send(`render(${JSON.stringify(visible)}, ${Date.now()})`);
  };

  const unsubscribe = observer.subscribe((event) => {
    if (isStale(event.agent)) return;

    if (event.change.kind === "left") {
      const existing = agents.get(event.agent.id);
      if (existing) {
        agents.set(event.agent.id, { ...existing, leaving: true });
        setTimeout(() => {
          if (agents.get(event.agent.id)?.leaving) {
            agents.delete(event.agent.id);
            send();
          }
        }, FADE_MS);
      }
    } else {
      agents.set(event.agent.id, toView(event.agent));
    }
    send();
  });

  win.on("ready", send);
  await observer.start();

  const ticker = setInterval(send, TICK_MS);

  console.log(
    `glimpse ${clickThrough ? "(click-through) " : ""}watching ${workspaces.join(", ")}...`,
  );

  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(ticker);
    unsubscribe();
    try {
      win.close();
    } catch (_e: unknown) {
      /* already closed */
    }
    try {
      await observer.stop();
    } catch (_e: unknown) {
      /* best effort */
    }
  };

  process.on("SIGINT", () => void shutdown());
  win.on("closed", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

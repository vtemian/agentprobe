import { closeSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  collectJsonlFiles,
  dedupePaths,
  directoryExists,
  normalizeWorkspacePath,
} from "@/providers/shared/discovery";
import { MAX_DISCOVERED_SESSION_FILES } from "./constants";

export interface CodexDiscoveryOptions {
  workspacePaths: string[];
  codexHomePath?: string;
  maxFiles?: number;
}

interface SessionHeader {
  mtimeMs: number;
  cwd: string;
  sessionId: string;
}

const headerCache = new Map<string, SessionHeader>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const FIRST_LINE_BUFFER_SIZE = 4096;

function readFirstLine(filePath: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const buf = Buffer.alloc(FIRST_LINE_BUFFER_SIZE);
    const bytesRead = readSync(fd, buf, 0, FIRST_LINE_BUFFER_SIZE, 0);
    const chunk = buf.toString("utf-8", 0, bytesRead);
    const newlineIndex = chunk.indexOf("\n");
    return newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function parseSessionHeader(filePath: string, mtimeMs: number): SessionHeader | undefined {
  const line = readFirstLine(filePath);
  if (!line || line.length === 0) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
      return undefined;
    }
    if (parsed.type !== "session_meta") {
      return undefined;
    }
    const payload = isRecord(parsed.payload) ? parsed.payload : undefined;
    const cwd = payload?.cwd;
    const sessionId = typeof payload?.id === "string" ? payload.id : "";
    if (typeof cwd !== "string" || cwd.length === 0) {
      return undefined;
    }
    return { mtimeMs, cwd, sessionId };
  } catch {
    return undefined;
  }
}

function resolveCodexHome(options: CodexDiscoveryOptions): string {
  return options.codexHomePath ?? path.join(homedir(), ".codex");
}

function getSessionHeader(filePath: string, mtimeMs: number): SessionHeader | undefined {
  const cached = headerCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached;
  }

  const header = parseSessionHeader(filePath, mtimeMs);
  if (header) {
    headerCache.set(filePath, header);
  } else {
    headerCache.delete(filePath);
  }
  return header;
}

function matchesWorkspace(cwd: string, normalizedPaths: string[]): boolean {
  const normalizedCwd = normalizeWorkspacePath(cwd);
  return normalizedPaths.some((wp) => normalizedCwd === wp || normalizedCwd.startsWith(`${wp}/`));
}

export function resolveSessionsDirectory(options: CodexDiscoveryOptions): string {
  return path.join(resolveCodexHome(options), "sessions");
}

export function resolveSessionSourcePaths(options: CodexDiscoveryOptions): string[] {
  const maxFiles = options.maxFiles ?? MAX_DISCOVERED_SESSION_FILES;
  const sessionsDir = resolveSessionsDirectory(options);

  if (!directoryExists(sessionsDir)) {
    return [];
  }

  const normalizedPaths = options.workspacePaths
    .map(normalizeWorkspacePath)
    .filter((p) => p.length > 0);

  if (normalizedPaths.length === 0) {
    return [];
  }

  const allFiles = collectJsonlFiles([sessionsDir], { recursive: true });

  const matching: { path: string; mtimeMs: number }[] = [];

  for (const file of allFiles) {
    const header = getSessionHeader(file.path, file.mtimeMs);
    if (!header) {
      continue;
    }
    if (matchesWorkspace(header.cwd, normalizedPaths)) {
      matching.push({ path: file.path, mtimeMs: file.mtimeMs });
    }
  }

  return matching
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, maxFiles)
    .map((entry) => entry.path);
}

export function listSessionFileNames(options: CodexDiscoveryOptions): string[] {
  const sessionsDir = resolveSessionsDirectory(options);

  if (!directoryExists(sessionsDir)) {
    return [];
  }

  return dedupePaths(
    collectJsonlFiles([sessionsDir], { recursive: true }).map((f) => f.path),
  ).sort();
}

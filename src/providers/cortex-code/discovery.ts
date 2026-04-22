import { homedir } from "node:os";
import path from "node:path";
import {
  collectJsonlFiles,
  dedupePaths,
  directoryExists,
  normalizeWorkspacePath,
} from "@/providers/shared/discovery";
import { readSourceFile } from "@/providers/shared/providers";
import { CORTEX_CODE_HOME_SUBPATH, MAX_DISCOVERED_SESSION_FILES } from "./constants";

export interface SessionDiscoveryOptions {
  workspacePaths: string[];
  cortexHomePath?: string;
  maxFiles?: number;
}

function resolveCortexHome(options: SessionDiscoveryOptions): string {
  return options.cortexHomePath ?? path.join(homedir(), CORTEX_CODE_HOME_SUBPATH);
}

export function resolveConversationsDirectory(options: SessionDiscoveryOptions): string {
  return path.join(resolveCortexHome(options), "conversations");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function matchesWorkspace(cwd: string, normalizedPaths: readonly string[]): boolean {
  const normalizedCwd = normalizeWorkspacePath(cwd);
  return normalizedPaths.some((wp) => normalizedCwd === wp || normalizedCwd.startsWith(`${wp}/`));
}

interface ConversationHeader {
  mtimeMs: number;
  workingDirectory: string;
  sessionId: string;
}

const headerCache = new Map<string, ConversationHeader>();

function parseConversationHeader(
  contents: string,
  mtimeMs: number,
): ConversationHeader | undefined {
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed)) {
      return undefined;
    }
    const workingDirectory = parsed.working_directory;
    const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : "";
    if (typeof workingDirectory !== "string" || workingDirectory.length === 0) {
      return undefined;
    }
    return { mtimeMs, workingDirectory, sessionId };
  } catch {
    return undefined;
  }
}

async function getConversationHeader(
  filePath: string,
  mtimeMs: number,
): Promise<ConversationHeader | undefined> {
  const cached = headerCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached;
  }

  const contents = await readSourceFile(filePath);
  if (contents === null) {
    headerCache.delete(filePath);
    return undefined;
  }

  const header = parseConversationHeader(contents, mtimeMs);
  if (header) {
    headerCache.set(filePath, header);
  } else {
    headerCache.delete(filePath);
  }
  return header;
}

export async function resolveSessionSourcePaths(
  options: SessionDiscoveryOptions,
): Promise<string[]> {
  const maxFiles = options.maxFiles ?? MAX_DISCOVERED_SESSION_FILES;
  const conversationsDir = resolveConversationsDirectory(options);

  if (!directoryExists(conversationsDir)) {
    return [];
  }

  const normalizedPaths = options.workspacePaths
    .map(normalizeWorkspacePath)
    .filter((p) => p.length > 0);

  if (normalizedPaths.length === 0) {
    return [];
  }

  const allFiles = collectJsonlFiles([conversationsDir], {
    recursive: false,
    extension: ".json",
  });

  const matching: { path: string; mtimeMs: number }[] = [];

  for (const file of allFiles) {
    const header = await getConversationHeader(file.path, file.mtimeMs);
    if (!header) {
      continue;
    }
    if (matchesWorkspace(header.workingDirectory, normalizedPaths)) {
      matching.push({ path: file.path, mtimeMs: file.mtimeMs });
    }
  }

  return matching
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, maxFiles)
    .map((entry) => entry.path);
}

export function listSessionFileNames(options: SessionDiscoveryOptions): string[] {
  const conversationsDir = resolveConversationsDirectory(options);

  if (!directoryExists(conversationsDir)) {
    return [];
  }

  return dedupePaths(
    collectJsonlFiles([conversationsDir], { recursive: false, extension: ".json" }).map(
      (f) => f.path,
    ),
  ).sort();
}

import { readdirSync, statSync, type Dirent, type Stats } from "node:fs";
import { homedir } from "node:os";
import uniq from "lodash.uniq";
import path from "node:path";

export interface TranscriptDiscoveryOptions {
  workspacePaths: string[];
}

const TRANSCRIPT_FILE_EXTENSION = ".jsonl";
const MAX_DISCOVERED_TRANSCRIPT_FILES = 400;

interface DiscoveredTranscriptFile {
  path: string;
  mtimeMs: number;
}

export function resolveTranscriptSourcePaths(options: TranscriptDiscoveryOptions): string[] {
  const workspaceTranscriptDirectories = resolveTranscriptDirectories(options);
  const discoveredPaths = collectTranscriptPaths(workspaceTranscriptDirectories)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, MAX_DISCOVERED_TRANSCRIPT_FILES)
    .map((entry) => entry.path);
  return dedupePaths(discoveredPaths);
}

export function resolveTranscriptDirectories(options: TranscriptDiscoveryOptions): string[] {
  const directories = options.workspacePaths
    .map((workspacePath) => toTranscriptDirectory(workspacePath))
    .filter((entry) => entry.length > 0);
  return dedupePaths(directories);
}

function toTranscriptDirectory(workspacePath: string): string {
  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  const workspaceId = normalizedWorkspacePath.replace(/^\/+/, "").split("/").join("-");
  if (workspaceId.length === 0) {
    return "";
  }
  return path.join(homedir(), ".cursor", "projects", workspaceId, "agent-transcripts");
}

function normalizeWorkspacePath(workspacePath: string): string {
  const trimmed = workspacePath.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const resolved = path.resolve(trimmed);
  return stripTrailingSeparators(resolved);
}

function stripTrailingSeparators(value: string): string {
  if (value === path.sep) {
    return value;
  }
  return value.replace(new RegExp(`[${escapeForRegExp(path.sep)}]+$`), "");
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectTranscriptPaths(inputPaths: readonly string[]): DiscoveredTranscriptFile[] {
  const collected: DiscoveredTranscriptFile[] = [];

  for (const inputPath of inputPaths) {
    const normalizedPath = inputPath.trim();
    if (normalizedPath.length === 0) {
      continue;
    }

    let stats: Stats;
    try {
      stats = statSync(normalizedPath);
    } catch {
      continue;
    }

    if (stats.isFile() && normalizedPath.endsWith(TRANSCRIPT_FILE_EXTENSION)) {
      collected.push({ path: normalizedPath, mtimeMs: Math.round(stats.mtimeMs) });
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    collected.push(...collectJsonlFilesRecursive(normalizedPath));
  }

  return collected;
}

function collectJsonlFilesRecursive(directory: string): DiscoveredTranscriptFile[] {
  const collected: DiscoveredTranscriptFile[] = [];
  const stack = [directory];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(TRANSCRIPT_FILE_EXTENSION)) {
        const fileStats = readStats(entryPath);
        if (!fileStats) {
          continue;
        }
        collected.push({
          path: entryPath,
          mtimeMs: Math.round(fileStats.mtimeMs),
        });
      }
    }
  }

  return collected;
}

function readStats(entryPath: string): Stats | undefined {
  try {
    return statSync(entryPath);
  } catch {
    return undefined;
  }
}

function dedupePaths(paths: readonly string[]): string[] {
  return uniq(paths);
}

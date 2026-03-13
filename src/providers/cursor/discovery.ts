import { readdirSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
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
  const workspaceId = normalizedWorkspacePath.replace(/^\/+/, "").split(/[\\/]/).join("-");
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
      // statSync fails for ENOENT, EACCES, etc. — skip unreachable paths silently;
      // discovery is best-effort and caller handles partial results.
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
  let entries: string[];
  try {
    entries = readdirSync(directory, { recursive: true, encoding: "utf-8" });
  } catch {
    return [];
  }

  return entries
    .filter((relative) => relative.endsWith(TRANSCRIPT_FILE_EXTENSION))
    .flatMap((relative) => {
      const absolute = path.join(directory, relative);
      const stats = tryStatSync(absolute);
      return stats?.isFile() ? [{ path: absolute, mtimeMs: Math.round(stats.mtimeMs) }] : [];
    });
}

function tryStatSync(filePath: string): Stats | undefined {
  try {
    return statSync(filePath);
  } catch {
    return undefined;
  }
}

export function listTranscriptFileNames(options: TranscriptDiscoveryOptions): string[] {
  const directories = resolveTranscriptDirectories(options);
  const collected: string[] = [];
  for (const directory of directories) {
    try {
      const entries = readdirSync(directory, { recursive: true, encoding: "utf-8" });
      for (const entry of entries) {
        if (entry.endsWith(TRANSCRIPT_FILE_EXTENSION)) {
          collected.push(path.join(directory, entry));
        }
      }
    } catch {
      // Directory might not exist yet.
    }
  }
  return dedupePaths(collected).sort();
}

function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

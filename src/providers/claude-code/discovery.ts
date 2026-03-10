import { readdirSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { MAX_DISCOVERED_SESSION_FILES } from "./constants";

const SESSION_FILE_EXTENSION = ".jsonl";

export interface SessionDiscoveryOptions {
  workspacePaths: string[];
  claudeHomePath?: string;
  maxFiles?: number;
}

interface DiscoveredSessionFile {
  path: string;
  mtimeMs: number;
}

export function encodeWorkspacePath(workspacePath: string): string {
  return workspacePath.replace(/\//g, "-");
}

export function resolveSessionDirectories(options: SessionDiscoveryOptions): string[] {
  const claudeHome = options.claudeHomePath ?? path.join(homedir(), ".claude");
  const directories = options.workspacePaths
    .map((workspacePath) => toSessionDirectory(workspacePath, claudeHome))
    .filter((entry) => entry.length > 0);
  return dedupePaths(directories);
}

export function resolveSessionSourcePaths(options: SessionDiscoveryOptions): string[] {
  const maxFiles = options.maxFiles ?? MAX_DISCOVERED_SESSION_FILES;
  const directories = resolveSessionDirectories(options);
  const discoveredPaths = collectSessionPaths(directories)
    .sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path))
    .slice(0, maxFiles)
    .map((entry) => entry.path);
  return dedupePaths(discoveredPaths);
}

export function listSessionFileNames(options: SessionDiscoveryOptions): string[] {
  const directories = resolveSessionDirectories(options);
  const collected: string[] = [];
  for (const directory of directories) {
    try {
      const entries = readdirSync(directory, { encoding: "utf-8" });
      for (const entry of entries) {
        if (entry.endsWith(SESSION_FILE_EXTENSION)) {
          collected.push(path.join(directory, entry));
        }
      }
    } catch {
      // Directory might not exist yet.
    }
  }
  return dedupePaths(collected).sort();
}

function toSessionDirectory(workspacePath: string, claudeHome: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (normalized.length === 0) {
    return "";
  }
  const encoded = encodeWorkspacePath(normalized);
  const projectDir = path.join(claudeHome, "projects", encoded);
  return directoryExists(projectDir) ? projectDir : "";
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

function collectSessionPaths(inputDirectories: readonly string[]): DiscoveredSessionFile[] {
  const collected: DiscoveredSessionFile[] = [];
  for (const directory of inputDirectories) {
    try {
      const entries = readdirSync(directory, { encoding: "utf-8" });
      for (const entry of entries) {
        if (!entry.endsWith(SESSION_FILE_EXTENSION)) {
          continue;
        }
        const absolute = path.join(directory, entry);
        const stats = tryStatSync(absolute);
        if (stats?.isFile()) {
          collected.push({ path: absolute, mtimeMs: Math.round(stats.mtimeMs) });
        }
      }
    } catch {
      // Directory might not exist.
    }
  }
  return collected;
}

function directoryExists(dirPath: string): boolean {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function tryStatSync(filePath: string): Stats | undefined {
  try {
    return statSync(filePath);
  } catch {
    return undefined;
  }
}

function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

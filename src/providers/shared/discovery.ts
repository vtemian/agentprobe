import { readdirSync, type Stats, statSync } from "node:fs";
import path from "node:path";

export function normalizeWorkspacePath(workspacePath: string): string {
  const trimmed = workspacePath.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return stripTrailingSeparators(path.resolve(trimmed));
}

export function stripTrailingSeparators(value: string): string {
  if (value === path.sep) {
    return value;
  }
  return value.replace(new RegExp(`[${escapeForRegExp(path.sep)}]+$`), "");
}

export function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tryStatSync(filePath: string): Stats | undefined {
  try {
    return statSync(filePath);
  } catch {
    return undefined;
  }
}

export function dedupePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

export function formatLineWarning(sourcePath: string, lineNumber: number, reason: string): string {
  return `${sourcePath}:${lineNumber} ${reason}`;
}

export interface DiscoveredFile {
  path: string;
  mtimeMs: number;
}

export interface CollectFilesOptions {
  recursive: boolean;
  extension?: string;
}

export function collectJsonlFiles(
  directories: readonly string[],
  options: CollectFilesOptions = { recursive: false },
): DiscoveredFile[] {
  const extension = options.extension ?? ".jsonl";
  const collected: DiscoveredFile[] = [];

  for (const directory of directories) {
    const entries = readDirectoryEntries(directory, options.recursive);
    for (const relative of entries) {
      if (!relative.endsWith(extension)) {
        continue;
      }
      const absolute = path.join(directory, relative);
      const stats = tryStatSync(absolute);
      if (stats?.isFile()) {
        collected.push({ path: absolute, mtimeMs: Math.round(stats.mtimeMs) });
      }
    }
  }

  return collected;
}

function readDirectoryEntries(directory: string, recursive: boolean): string[] {
  try {
    return readdirSync(directory, { recursive, encoding: "utf-8" });
  } catch {
    return [];
  }
}

export function directoryExists(dirPath: string): boolean {
  return tryStatSync(dirPath)?.isDirectory() ?? false;
}

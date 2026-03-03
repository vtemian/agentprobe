import { readdirSync, statSync, type Dirent, type Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface TranscriptDiscoveryOptions {
  workspacePaths: string[];
}

export function resolveTranscriptSourcePaths(options: TranscriptDiscoveryOptions): string[] {
  const workspaceTranscriptDirectories = options.workspacePaths.map((workspacePath) =>
    toTranscriptDirectory(workspacePath),
  );
  const discoveredPaths = collectTranscriptPaths(workspaceTranscriptDirectories);
  return dedupePaths(discoveredPaths);
}

function toTranscriptDirectory(workspacePath: string): string {
  const workspaceId = workspacePath.trim().replace(/^\/+/, "").split("/").join("-");
  return path.join(homedir(), ".cursor", "projects", workspaceId, "agent-transcripts");
}

function collectTranscriptPaths(inputPaths: readonly string[]): string[] {
  const collected: string[] = [];

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

    if (stats.isFile() && normalizedPath.endsWith(".jsonl")) {
      collected.push(normalizedPath);
      continue;
    }

    if (!stats.isDirectory()) {
      continue;
    }

    collected.push(...collectJsonlFilesRecursive(normalizedPath));
  }

  return collected;
}

function collectJsonlFilesRecursive(directory: string): string[] {
  const collected: string[] = [];
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
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        collected.push(entryPath);
      }
    }
  }

  return collected.sort((left, right) => left.localeCompare(right));
}

function dedupePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const entry of paths) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    unique.push(entry);
  }

  return unique;
}

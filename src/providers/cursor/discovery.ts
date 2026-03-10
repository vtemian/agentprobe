import { homedir } from "node:os";
import path from "node:path";
import {
  normalizeWorkspacePath,
  tryStatSync,
  dedupePaths,
  collectJsonlFiles,
  type DiscoveredFile,
} from "@/providers/shared/discovery-utils";

export interface TranscriptDiscoveryOptions {
  workspacePaths: string[];
}

const MAX_DISCOVERED_TRANSCRIPT_FILES = 400;

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

function collectTranscriptPaths(inputPaths: readonly string[]): DiscoveredFile[] {
  const collected: DiscoveredFile[] = [];

  for (const inputPath of inputPaths) {
    const normalizedPath = inputPath.trim();
    if (normalizedPath.length === 0) {
      continue;
    }

    const stats = tryStatSync(normalizedPath);
    if (!stats) {
      continue;
    }

    if (stats.isFile() && normalizedPath.endsWith(".jsonl")) {
      collected.push({ path: normalizedPath, mtimeMs: Math.round(stats.mtimeMs) });
      continue;
    }

    if (stats.isDirectory()) {
      collected.push(...collectJsonlFiles([normalizedPath], { recursive: true }));
    }
  }

  return collected;
}

export function listTranscriptFileNames(options: TranscriptDiscoveryOptions): string[] {
  const directories = resolveTranscriptDirectories(options);
  return dedupePaths(collectJsonlFiles(directories, { recursive: true }).map((f) => f.path)).sort();
}

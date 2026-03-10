import { homedir } from "node:os";
import path from "node:path";
import {
  normalizeWorkspacePath,
  dedupePaths,
  collectJsonlFiles,
  directoryExists,
  type DiscoveredFile,
} from "@/providers/shared/discovery";
import { MAX_DISCOVERED_SESSION_FILES } from "./constants";

export interface SessionDiscoveryOptions {
  workspacePaths: string[];
  claudeHomePath?: string;
  maxFiles?: number;
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
  return dedupePaths(
    collectJsonlFiles(directories, { recursive: false }).map((f) => f.path),
  ).sort();
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

function collectSessionPaths(inputDirectories: readonly string[]): DiscoveredFile[] {
  return collectJsonlFiles(inputDirectories, { recursive: false });
}

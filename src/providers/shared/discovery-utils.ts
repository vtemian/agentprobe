import { statSync, type Stats } from "node:fs";
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

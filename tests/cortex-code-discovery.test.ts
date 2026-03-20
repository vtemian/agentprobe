import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listSessionFileNames,
  resolveConversationsDirectory,
  resolveSessionSourcePaths,
} from "@/providers/cortex-code/discovery";

describe("cortex-code discovery", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      rmSync(p, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  function createTempCortexHome(label: string): string {
    const dir = path.join(
      "/tmp",
      `cortex-home-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    cleanupPaths.push(dir);
    return dir;
  }

  function writeConversationFile(
    conversationsDir: string,
    filename: string,
    overrides: Record<string, unknown> = {},
  ): string {
    mkdirSync(conversationsDir, { recursive: true });
    const filePath = path.join(conversationsDir, filename);
    const data = {
      session_id: filename.replace(".json", ""),
      title: "Test session",
      working_directory: "/workspace/project-a",
      session_type: "main",
      created_at: "2026-03-10T07:00:00.000Z",
      last_updated: "2026-03-10T07:05:00.000Z",
      history: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
      ...overrides,
    };
    writeFileSync(filePath, JSON.stringify(data), "utf8");
    return filePath;
  }

  it("discovers files matching workspace working_directory", async () => {
    const cortexHome = createTempCortexHome("match");
    const conversationsDir = path.join(cortexHome, "conversations");

    const matchFile = writeConversationFile(conversationsDir, "sess-001.json", {
      working_directory: "/workspace/project-a",
    });
    writeConversationFile(conversationsDir, "sess-002.json", {
      working_directory: "/workspace/project-b",
    });

    const paths = await resolveSessionSourcePaths({
      workspacePaths: ["/workspace/project-a"],
      cortexHomePath: cortexHome,
    });

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(matchFile);
  });

  it("returns empty for non-existent conversations dir", async () => {
    const cortexHome = createTempCortexHome("nodir");

    const paths = await resolveSessionSourcePaths({
      workspacePaths: ["/workspace/project-a"],
      cortexHomePath: cortexHome,
    });

    expect(paths).toEqual([]);
  });

  it("returns empty for empty workspace paths", async () => {
    const cortexHome = createTempCortexHome("empty-ws");
    const conversationsDir = path.join(cortexHome, "conversations");
    writeConversationFile(conversationsDir, "sess-001.json");

    const paths = await resolveSessionSourcePaths({
      workspacePaths: [],
      cortexHomePath: cortexHome,
    });

    expect(paths).toEqual([]);
  });

  it("skips files without working_directory", async () => {
    const cortexHome = createTempCortexHome("no-wd");
    const conversationsDir = path.join(cortexHome, "conversations");

    writeConversationFile(conversationsDir, "no-wd.json", {
      working_directory: undefined,
    });
    const validFile = writeConversationFile(conversationsDir, "valid.json", {
      working_directory: "/workspace/project-a",
    });

    const paths = await resolveSessionSourcePaths({
      workspacePaths: ["/workspace/project-a"],
      cortexHomePath: cortexHome,
    });

    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe(validFile);
  });

  it("respects maxFiles cap", async () => {
    const cortexHome = createTempCortexHome("cap");
    const conversationsDir = path.join(cortexHome, "conversations");

    const now = Date.now() / 1000;
    for (let i = 0; i < 5; i++) {
      const filePath = writeConversationFile(conversationsDir, `session-${i}.json`, {
        working_directory: "/workspace/capped",
      });
      utimesSync(filePath, now - i, now - i);
    }

    const paths = await resolveSessionSourcePaths({
      workspacePaths: ["/workspace/capped"],
      cortexHomePath: cortexHome,
      maxFiles: 3,
    });

    expect(paths).toHaveLength(3);
  });

  it("resolveConversationsDirectory returns correct path", () => {
    const cortexHome = createTempCortexHome("dir");

    const result = resolveConversationsDirectory({
      workspacePaths: [],
      cortexHomePath: cortexHome,
    });

    expect(result).toBe(path.join(cortexHome, "conversations"));
  });

  it("listSessionFileNames returns sorted file paths", () => {
    const cortexHome = createTempCortexHome("list");
    const conversationsDir = path.join(cortexHome, "conversations");

    const fileB = writeConversationFile(conversationsDir, "beta.json");
    const fileA = writeConversationFile(conversationsDir, "alpha.json");

    const names = listSessionFileNames({
      workspacePaths: [],
      cortexHomePath: cortexHome,
    });

    expect(names).toHaveLength(2);
    expect(names[0]).toBe(fileA);
    expect(names[1]).toBe(fileB);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("package exports map", () => {
  it("includes legacy compatibility subpaths", () => {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      exports: Record<string, unknown>;
    };

    expect(packageJson.exports["./agents"]).toBeDefined();
    expect(packageJson.exports["./discovery"]).toBeDefined();
    expect(packageJson.exports["./transcripts"]).toBeDefined();
    expect(packageJson.exports["./types"]).toBeDefined();
  });
});

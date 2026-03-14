import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "core/index": "src/core/index.ts",
    "providers/cursor/index": "src/providers/cursor/index.ts",
    "providers/claude-code/index": "src/providers/claude-code/index.ts",
    "providers/codex/index": "src/providers/codex/index.ts",
    "providers/opencode/index": "src/providers/opencode/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  target: "node20",
});

import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    agents: "src/agents.ts",
    discovery: "src/discovery.ts",
    transcripts: "src/transcripts.ts",
    types: "src/types.ts",
    "core/index": "src/core/index.ts",
    "providers/cursor/index": "src/providers/cursor/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "node20",
});

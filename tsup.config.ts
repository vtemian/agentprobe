import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "core/index": "src/core/index.ts",
    "providers/cursor/index": "src/providers/cursor/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  target: "node20",
});

import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

const editorVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
  .version;

export default defineConfig({
  // The build puts the same value in (rollup.config.js).
  define: { SPARCOON_EDITOR_VERSION: JSON.stringify(editorVersion) },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html"],
    },
  },
});

import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
export default defineConfig({
  resolve: {
    alias: {
      "@aurelia/core": resolve("packages/core/src/index.ts"),
      "@aurelia/music": resolve("packages/music/src/index.ts"),
      "@aurelia/player": resolve("packages/player/src/index.ts"),
      "@aurelia/database": resolve("packages/database/src/index.ts"),
      "@aurelia/auth": resolve("packages/auth/src/index.ts"),
      "@aurelia/recommendations": resolve(
        "packages/recommendations/src/index.ts",
      ),
      "@aurelia/integrations": resolve("packages/integrations/src/index.ts"),
    },
  },
  // Each service suite starts its own WASM PostgreSQL instance. Bound parallel
  // instances so database startup does not exhaust CPU and time out its hooks.
  test: { include: ["tests/**/*.test.ts"], testTimeout: 20000, maxWorkers: 2 },
});

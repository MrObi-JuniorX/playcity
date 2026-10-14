import { defineConfig } from "vitest/config";

// Plain Node tests for the browser game code: determinism, rollback, cost of a tick.
export default defineConfig({ test: { include: ["test/game/**/*.test.mjs"], environment: "node", testTimeout: 30000 } });

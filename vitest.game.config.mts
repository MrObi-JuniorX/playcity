import { defineConfig } from "vitest/config";

// Plain Node tests for the browser game code (determinism, rollback, cost of a tick) and the cup engine.
export default defineConfig({ test: { include: ["test/game/**/*.test.mjs", "test/cup/**/*.test.ts"], environment: "node", testTimeout: 30000 } });

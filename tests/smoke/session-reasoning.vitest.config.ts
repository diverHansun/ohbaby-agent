import { defineConfig } from "vitest/config";
import base from "../../vitest.e2e.config.js";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      process.env.OHBABY_REAL_REASONING_UNKNOWN === "1"
        ? "tests/smoke/unknown-reasoning.real.e2e.test.ts"
        : "tests/smoke/session-reasoning.real.e2e.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 600_000,
  },
});

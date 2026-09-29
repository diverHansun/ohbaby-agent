import { defineConfig } from "vitest/config";
import base from "../../vitest.e2e.config.js";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/smoke/execution-progress-harness.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 3600000,
    reporters: ["dot"],
  },
});

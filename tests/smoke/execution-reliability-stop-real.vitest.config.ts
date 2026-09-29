import { defineConfig } from "vitest/config";
import base from "../../vitest.e2e.config.js";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/smoke/execution-reliability-stop.real.e2e.test.ts"],
    fileParallelism: false,
    retry: 0,
    testTimeout: 600000,
  },
});

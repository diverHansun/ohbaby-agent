import { defineConfig } from "vitest/config";
import e2eConfig from "./vitest.e2e.config.js";

export default defineConfig({
  ...e2eConfig,
  test: {
    ...e2eConfig.test,
    include: ["tests/smoke/responses-migration.real.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
  },
});

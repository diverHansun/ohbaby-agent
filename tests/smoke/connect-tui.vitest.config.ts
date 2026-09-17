import { defineConfig } from "vitest/config";
import base from "../../vitest.e2e.config.js";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/smoke/connect-tui.real.e2e.test.tsx"],
    fileParallelism: false,
    testTimeout: 600_000,
  },
});

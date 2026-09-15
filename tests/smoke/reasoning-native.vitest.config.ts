import { defineConfig } from "vitest/config";
import base from "../../vitest.e2e.config.js";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/smoke/reasoning-native.real.e2e.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    fileParallelism: false,
    testTimeout: 390000,
  },
});

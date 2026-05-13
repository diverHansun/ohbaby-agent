import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
      exclude: [
        "node_modules/",
        "**/dist/",
        "packages/**/*.test.ts",
        "packages/**/*.test.tsx",
        "packages/**/__tests__/",
        "packages/*/src/index.ts",
      ],
    },
    setupFiles: [],
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      "ohbaby-agent": resolve(
        __dirname,
        "./packages/ohbaby-agent/src/index.ts",
      ),
      "ohbaby-sdk": resolve(__dirname, "./packages/ohbaby-sdk/src/index.ts"),
      "ohbaby-tui": resolve(__dirname, "./packages/ohbaby-tui/src/index.tsx"),
    },
  },
});

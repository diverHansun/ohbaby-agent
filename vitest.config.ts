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
    alias: [
      {
        find: "react/jsx-dev-runtime",
        replacement: resolve(
          __dirname,
          "./packages/ohbaby-tui/node_modules/react/jsx-dev-runtime.js",
        ),
      },
      {
        find: "react/jsx-runtime",
        replacement: resolve(
          __dirname,
          "./packages/ohbaby-tui/node_modules/react/jsx-runtime.js",
        ),
      },
      {
        find: "react",
        replacement: resolve(
          __dirname,
          "./packages/ohbaby-tui/node_modules/react/index.js",
        ),
      },
      {
        find: "ohbaby-agent",
        replacement: resolve(
          __dirname,
          "./packages/ohbaby-agent/src/index.ts",
        ),
      },
      {
        find: "ohbaby-sdk",
        replacement: resolve(__dirname, "./packages/ohbaby-sdk/src/index.ts"),
      },
      {
        find: "ohbaby-tui",
        replacement: resolve(__dirname, "./packages/ohbaby-tui/src/index.tsx"),
      },
    ],
  },
});

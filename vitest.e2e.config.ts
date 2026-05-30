import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**"],
    globals: true,
    include: ["packages/*/src/**/*.e2e.test.ts"],
    testTimeout: 180_000,
  },
  resolve: {
    alias: [
      {
        find: "react/jsx-dev-runtime",
        replacement: resolve(
          __dirname,
          "./packages/ohbaby-cli/node_modules/react/jsx-dev-runtime.js",
        ),
      },
      {
        find: "react/jsx-runtime",
        replacement: resolve(
          __dirname,
          "./packages/ohbaby-cli/node_modules/react/jsx-runtime.js",
        ),
      },
      {
        find: "react",
        replacement: resolve(
          __dirname,
          "./packages/ohbaby-cli/node_modules/react/index.js",
        ),
      },
      {
        find: "ohbaby-agent",
        replacement: resolve(__dirname, "./packages/ohbaby-agent/src/index.ts"),
      },
      {
        find: "ohbaby-sdk",
        replacement: resolve(__dirname, "./packages/ohbaby-sdk/src/index.ts"),
      },
      {
        find: "ohbaby-cli",
        replacement: resolve(__dirname, "./packages/ohbaby-cli/src/index.ts"),
      },
    ],
  },
});

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { loadRootDotenv } from "./real-cache-runner.mjs";

// Explicit opt-in runner; normal tests never load real credentials.
const child = spawn(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "vitest.responses-migration.config.ts",
    "tests/smoke/responses-migration.real.e2e.test.ts",
    ...process.argv.slice(2),
  ],
  {
    env: { ...loadRootDotenv(), OHBABY_RUN_REAL_RESPONSES_MIGRATION: "1" },
    stdio: "inherit",
  },
);
child.on("error", () => {
  console.error("Unable to start the cache accounting test process.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});

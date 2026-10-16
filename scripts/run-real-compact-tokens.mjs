#!/usr/bin/env node
import { spawn } from "node:child_process";
import { loadRootDotenv } from "./real-cache-runner.mjs";

const args = process.argv.slice(2);
const profile = args.find((arg) => arg.startsWith("--profile="))?.slice(10);
if (!args.includes("--run") || !profile) {
  console.log(
    "Explicit opt-in: node scripts/run-real-compact-tokens.mjs --run --profile=<id>",
  );
  console.log(
    "Profiles: tests/smoke/compact-token-profiles.ts (15 model/protocol combinations).",
  );
  console.log(
    "At most 12 HTTP requests per profile; evidence in .ohbaby/test-evidence/compact-token-flow.",
  );
} else {
  const child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "tests/smoke/compact-token-flow.vitest.config.ts",
    ],
    {
      env: {
        ...loadRootDotenv(),
        OHBABY_RUN_COMPACT_TOKEN_E2E: "1",
        OHBABY_COMPACT_TOKEN_PROFILE: profile,
      },
      stdio: "inherit",
    },
  );
  child.on("error", () => {
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { loadRootDotenv } from "./real-cache-runner.mjs";

const profiles = [
  "zenmux-gpt56-luna-chat",
  "zenmux-gpt56-luna-responses",
  "zenmux-claude-sonnet5-anthropic",
];
const args = process.argv.slice(2);
const selected = args
  .find((value) => value.startsWith("--profile="))
  ?.slice("--profile=".length);
if (!args.includes("--run")) {
  console.info(
    JSON.stringify(
      {
        profiles,
        command:
          "node scripts/run-real-session-reasoning.mjs --run --profile=<id>",
        maxRequestsPerProfile: 20,
      },
      null,
      2,
    ),
  );
} else if (!profiles.includes(selected)) {
  console.error("Select one supported --profile. No requests made.");
  process.exitCode = 1;
} else {
  const child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "tests/smoke/session-reasoning.vitest.config.ts",
    ],
    {
      env: {
        ...loadRootDotenv(),
        OHBABY_RUN_REAL_SESSION_REASONING: "1",
        OHBABY_REAL_REASONING_PROFILE: selected,
        OHBABY_REAL_REASONING_UNKNOWN: args.includes("--unknown") ? "1" : "0",
      },
      stdio: "inherit",
    },
  );
  child.on("error", () => {
    console.error("Unable to start Stage C E2E process.");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

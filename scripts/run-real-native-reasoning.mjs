#!/usr/bin/env node
import { spawn } from "node:child_process";
import { loadRootDotenv } from "./real-cache-runner.mjs";

const profiles = [
  "zenmux-deepseek-v4-chat",
  "zenmux-gpt56-luna-responses",
  "zenmux-claude-sonnet5-anthropic",
  "zenmux-gpt56-luna-chat",
  "zenmux-gpt56-luna-chat-native",
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
          "node scripts/run-real-native-reasoning.mjs --run --profile=<id>",
        limits: {
          totalRequestsPerProfile: 4,
          sdkRetries: 0,
          requestTimeoutMs: 90000,
        },
        paidRequests:
          "Requires --run and one explicit profile. No credentials loaded in list mode.",
      },
      null,
      2,
    ),
  );
} else if (!profiles.includes(selected)) {
  console.error("Select one supported --profile. No requests made.");
  process.exitCode = 1;
} else {
  const env = loadRootDotenv();
  const child = spawn(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "tests/smoke/reasoning-native.vitest.config.ts",
    ],
    {
      env: {
        ...env,
        OHBABY_RUN_REAL_NATIVE_REASONING: "1",
        OHBABY_NATIVE_REASONING_PROFILE: selected,
        OHBABY_NATIVE_REASONING_DIAGNOSTIC: args.includes("--diagnose")
          ? "1"
          : "0",
      },
      stdio: "inherit",
    },
  );
  child.on("error", () => {
    console.error("Unable to start native reasoning E2E process.");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

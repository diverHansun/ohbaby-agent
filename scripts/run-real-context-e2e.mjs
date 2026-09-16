#!/usr/bin/env node
import { spawn } from "node:child_process";
import { loadRootDotenv } from "./real-cache-runner.mjs";

const profiles = [
  "zenmux-deepseek-v41-chat",
  "zenmux-gpt56-luna-responses-context",
  "zenmux-claude-sonnet5-anthropic-context",
];
const args = process.argv.slice(2);
const selected = args.find((arg) => arg.startsWith("--profile="))?.slice(10);
const mode = args.find((arg) => arg.startsWith("--mode="))?.slice(7);
if (!args.includes("--run")) {
  process.stdout.write(
    JSON.stringify(
      {
        profiles,
        modes: ["baseline", "compaction"],
        command:
          "node scripts/run-real-context-e2e.mjs --run --profile=<id> --mode=baseline",
        totalHttpRequestsPerRun: 20,
        paidRequests: "Requires --run, one profile, and one mode",
      },
      null,
      2,
    ) + "\n",
  );
} else if (
  !profiles.includes(selected) ||
  !["baseline", "compaction"].includes(mode)
) {
  process.stderr.write(
    "Select one supported --profile and --mode; no requests made.\n",
  );
  process.exitCode = 1;
} else {
  const env = loadRootDotenv();
  if (!env.ZENMUX_API_KEY?.trim()) {
    process.stderr.write("ZENMUX_API_KEY missing; no requests made.\n");
    process.exitCode = 1;
  } else {
    const child = spawn(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "tests/smoke/formal-cache-live-context.vitest.config.ts",
      ],
      {
        env: {
          ...env,
          OHBABY_RUN_REAL_CONTEXT_E2E: "1",
          OHBABY_REAL_CONTEXT_PROFILE: selected,
          OHBABY_REAL_CONTEXT_MODE: mode,
        },
        stdio: "inherit",
      },
    );
    child.on("error", () => {
      process.stderr.write("Unable to start live context E2E process.\n");
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  }
}

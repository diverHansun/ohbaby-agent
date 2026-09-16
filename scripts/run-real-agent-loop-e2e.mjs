#!/usr/bin/env node
import { spawn } from "node:child_process";
import { loadRootDotenv } from "./real-cache-runner.mjs";
const profiles = [
  "zenmux-deepseek-v41-chat",
  "zenmux-gpt56-luna-responses-context",
  "zenmux-claude-sonnet5-anthropic-context",
];
const modes = [
  "stage-a",
  "e1",
  "length",
  "length-terminal",
  "transport",
  "cancel",
  "compaction",
];
const arg = (name) =>
  process.argv
    .slice(2)
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const profile = arg("profile") ?? process.env.OHBABY_REAL_AGENT_LOOP_PROFILE;
const mode = arg("mode") ?? process.env.OHBABY_REAL_AGENT_LOOP_MODE;
if (
  !profiles.includes(profile) ||
  !modes.includes(mode) ||
  ((mode === "length" || mode === "length-terminal") && profile !== profiles[1])
) {
  console.error(
    "Select --profile=" +
      profiles.join("|") +
      " and --mode=" +
      modes.join("|") +
      ". length and length-terminal require Responses.",
  );
  process.exit(2);
}
const child = spawn(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "tests/smoke/agent-loop-real.vitest.config.ts",
  ],
  {
    env: {
      ...loadRootDotenv(),
      OHBABY_RUN_REAL_AGENT_LOOP: "1",
      OHBABY_REAL_AGENT_LOOP_PROFILE: profile,
      OHBABY_REAL_AGENT_LOOP_MODE: mode,
    },
    stdio: "inherit",
  },
);
child.on("error", () => {
  console.error("Unable to start agent-loop E2E.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});

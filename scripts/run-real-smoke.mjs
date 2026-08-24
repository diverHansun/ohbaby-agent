#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const envPath = path.join(root, ".env");

function stripOptionalQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadDotenvIntoProcessEnv() {
  if (!existsSync(envPath)) {
    return;
  }

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match || line.trimStart().startsWith("#")) {
      continue;
    }
    const [, key, rawValue] = match;
    if (process.env[key] === undefined) {
      process.env[key] = stripOptionalQuotes(rawValue);
    }
  }
}

function hasModelKey() {
  return Boolean(
    process.env.ZAI_API_KEY?.trim() || process.env.ZHIPU_API_KEY?.trim(),
  );
}

loadDotenvIntoProcessEnv();

const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
let tuiExitCode = 0;
if (!hasModelKey()) {
  console.log("[real-smoke] tui: skip (missing ZAI_API_KEY or ZHIPU_API_KEY)");
} else {
  process.env.OHBABY_RUN_REAL_TUI_SMOKE = "1";
  const result = spawnSync(
    process.execPath,
    [
      vitestEntry,
      "run",
      "tests/smoke/tui-real-provider.smoke.test.tsx",
      "-t",
      "submits a prompt through the rendered TUI|interrupts a real rendered TUI run|lets a real model call the read tool",
    ],
    {
      env: process.env,
      shell: false,
      stdio: "inherit",
    },
  );
  if (result.error) {
    console.error(result.error);
  }
  tuiExitCode = result.status ?? 1;
  console.log(`[real-smoke] tui: ${tuiExitCode === 0 ? "pass" : "fail"}`);
}

const cacheResult = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "run-real-cache-smoke.mjs")],
  {
    env: process.env,
    shell: false,
    stdio: "inherit",
  },
);
if (cacheResult.error) {
  console.error(cacheResult.error);
}
const cacheExitCode = cacheResult.status ?? 1;
process.exit(tuiExitCode === 0 && cacheExitCode === 0 ? 0 : 1);

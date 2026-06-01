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
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
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

if (!hasModelKey()) {
  console.error(
    "Real smoke requires ZAI_API_KEY or ZHIPU_API_KEY in the environment or root .env.",
  );
  process.exit(1);
}

process.env.OHBABY_RUN_REAL_TUI_SMOKE = "1";

const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(
  process.execPath,
  [
    vitestEntry,
    "run",
    "tests/smoke/tui-real-provider.smoke.test.tsx",
    "-t",
    "submits a prompt through the rendered TUI|lets a real model call the read tool",
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

process.exit(result.status ?? 1);

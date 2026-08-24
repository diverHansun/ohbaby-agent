import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const REAL_CACHE_GATES = Object.freeze([
  Object.freeze({
    credentialEnvNames: Object.freeze([
      "ZENMUX_API_KEY",
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "ZAI_API_KEY",
      "ZHIPU_API_KEY",
    ]),
    flagEnvName: "OHBABY_RUN_REAL_CACHE_OPENAI_COMPAT",
    id: "openai-compatible",
    spec: "tests/smoke/cache-real-openai-compatible.smoke.test.ts",
    testName: "records a real OpenAI-compatible cache read",
  }),
  Object.freeze({
    credentialEnvNames: Object.freeze(["ZENMUX_API_KEY", "ANTHROPIC_API_KEY"]),
    flagEnvName: "OHBABY_RUN_REAL_CACHE_ANTHROPIC",
    id: "anthropic",
    spec: "tests/smoke/cache-real-anthropic.smoke.test.ts",
    testName: "records real Anthropic cache read usage",
  }),
  Object.freeze({
    credentialEnvNames: Object.freeze([
      "ZENMUX_API_KEY",
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "ZAI_API_KEY",
      "ZHIPU_API_KEY",
    ]),
    flagEnvName: "OHBABY_RUN_REAL_CACHE_M13",
    id: "m13",
    spec: "tests/smoke/cache-real-openai-compatible.smoke.test.ts",
    testName: "M13 restores cache reads after one tool epoch transition",
  }),
]);

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

export function loadRootDotenv(
  env = process.env,
  envPath = path.join(process.cwd(), ".env"),
) {
  const resolved = { ...env };
  if (!existsSync(envPath)) {
    return resolved;
  }

  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u.exec(line);
    if (!match || line.trimStart().startsWith("#")) {
      continue;
    }
    const [, key, rawValue] = match;
    if (resolved[key] === undefined) {
      resolved[key] = stripOptionalQuotes(rawValue);
    }
  }
  return resolved;
}

export function hasGateCredential(gate, env) {
  return gate.credentialEnvNames.some((name) => Boolean(env[name]?.trim()));
}

export async function runCacheGates({ gates, env, executeGate }) {
  const results = [];
  for (const gate of gates) {
    if (!hasGateCredential(gate, env)) {
      results.push({
        id: gate.id,
        reason: `missing ${gate.credentialEnvNames.join(" or ")}`,
        status: "skip",
      });
      continue;
    }

    try {
      const exitCode = await executeGate(gate, env);
      results.push(
        exitCode === 0
          ? { id: gate.id, status: "pass" }
          : {
              id: gate.id,
              reason: `test process exited with code ${String(exitCode)}`,
              status: "fail",
            },
      );
    } catch (error) {
      results.push({
        id: gate.id,
        reason: error instanceof Error ? error.message : String(error),
        status: "fail",
      });
    }
  }
  return results;
}

export function aggregateCacheGateResults(results) {
  if (results.some((result) => result.status === "fail")) {
    return "fail";
  }
  if (
    results.length > 0 &&
    results.every((result) => result.status === "pass")
  ) {
    return "pass";
  }
  return "skip";
}

export function formatCacheGateResult(result) {
  const detail = result.reason ? ` (${result.reason})` : "";
  return `[real-cache] ${result.id}: ${result.status}${detail}`;
}

export function formatCacheGateAggregate(status) {
  return status === "skip" ? "skip (partial evidence)" : status;
}

export function exitCodeForCacheGateAggregate(status) {
  return status === "fail" ? 1 : 0;
}

export function executeVitestGate(gate, env, root = process.cwd()) {
  const vitestEntry = path.join(root, "node_modules", "vitest", "vitest.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        vitestEntry,
        "run",
        gate.spec,
        "-t",
        gate.testName,
        "--no-file-parallelism",
      ],
      {
        cwd: root,
        env: { ...env, [gate.flagEnvName]: "1" },
        shell: false,
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`test process terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

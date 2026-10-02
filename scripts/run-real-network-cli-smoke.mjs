#!/usr/bin/env node
// Run after pnpm build. Opt in with OHBABY_REAL_NETWORK_TEST=1.
// Three real CLI runs (plus any normal session-title requests), isolated from
// the user's profile/database. Only redacted result metadata is printed.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (process.env.OHBABY_REAL_NETWORK_TEST !== "1") {
  throw new Error(
    "Set OHBABY_REAL_NETWORK_TEST=1 to authorize real CLI requests",
  );
}
const require = createRequire(
  new URL("../packages/ohbaby-agent/package.json", import.meta.url),
);
const local = require("dotenv").parse(
  await readFile(new URL("../.env", import.meta.url)),
);
const cases = [
  [
    "zenmux",
    "ZENMUX_API_KEY",
    "https://zenmux.ai/api/v1",
    "deepseek/deepseek-v4.1-flash",
  ],
  [
    "zhipu",
    "ZAI_API_KEY",
    "https://open.bigmodel.cn/api/paas/v4",
    "glm-5.3-flash",
  ],
  [
    "dashscope",
    "DASHSCOPE_API_KEY",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwen3.8-flash",
  ],
];
const results = [];
for (const [provider, keyName, baseUrl, model] of cases) {
  const apiKey = process.env[keyName] || local[keyName];
  if (!apiKey) {
    results.push({ provider, model, ok: false, failure: "missing-key" });
    continue;
  }
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-network-cli-"));
  const profile = join(directory, "profile");
  const workspace = join(directory, "workspace");
  await mkdir(profile);
  await mkdir(workspace);
  await writeFile(
    join(profile, "model.json"),
    JSON.stringify({
      provider,
      defaultModel: model,
      apiConfig: {
        apiKeyEnv: keyName,
        baseUrl,
        interfaceProvider: "openai-compatible",
      },
      models: [
        {
          model,
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
      llmParams: { maxTokens: 512 },
    }),
    { mode: 0o600 },
  );
  const started = performance.now();
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--no-warnings",
        fileURLToPath(
          new URL("../packages/ohbaby-cli/dist/bin.js", import.meta.url),
        ),
        "run",
        "Reply with exactly OK. Do not call tools.",
      ],
      {
        cwd: workspace,
        env: {
          ...process.env,
          OHBABY_HOME: profile,
          OHBABY_DB_PATH: join(directory, "state.db"),
          [keyName]: apiKey,
          NO_COLOR: "1",
        },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    results.push({
      provider,
      model,
      baseUrl,
      ok: /^OK[.!]?$/u.test(stdout.trim()),
      elapsedMs: Math.round(performance.now() - started),
      outputCharacters: stdout.trim().length,
      networkStatus: stderr
        .split("\n")
        .filter((line) => line.startsWith("Network:")),
    });
  } catch (error) {
    results.push({
      provider,
      model,
      baseUrl,
      ok: false,
      elapsedMs: Math.round(performance.now() - started),
      failure: "cli-request-failed",
      exitCode: typeof error?.code === "number" ? error.code : undefined,
      killed: error?.killed === true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    {
      at: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      results,
    },
    null,
    2,
  ),
);
if (results.some((result) => !result.ok)) process.exitCode = 1;

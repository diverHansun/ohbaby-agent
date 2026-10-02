#!/usr/bin/env node
// Explicitly opt in: OHBABY_REAL_NETWORK_TEST=1 node --import tsx scripts/run-real-network-smoke.mjs
// Sends five tiny paid requests. Credentials are read locally and never printed.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { channel } from "node:diagnostics_channel";
import { createInterfaceProvider } from "../packages/ohbaby-agent/src/services/interface-providers/index.ts";
import { installSystemProxy } from "../packages/ohbaby-agent/src/utils/network-proxy/index.ts";

if (process.env.OHBABY_REAL_NETWORK_TEST !== "1") {
  throw new Error(
    "Set OHBABY_REAL_NETWORK_TEST=1 to authorize five real provider requests",
  );
}
const require = createRequire(
  new URL("../packages/ohbaby-agent/package.json", import.meta.url),
);
const { parse } = require("dotenv");
const local = parse(await readFile(new URL("../.env", import.meta.url)));
const cases = [
  [
    "zenmux",
    "ZENMUX_API_KEY",
    "https://zenmux.ai/api/v1",
    "deepseek/deepseek-v4.1-flash",
    "openai-compatible",
  ],
  [
    "zhipu",
    "ZAI_API_KEY",
    "https://open.bigmodel.cn/api/paas/v4",
    "glm-5.3-flash",
    "openai-compatible",
  ],
  [
    "zenmux",
    "ZENMUX_API_KEY",
    "https://zenmux.ai/api/v1",
    "openai/gpt-5.6-luna",
    "openai-responses",
  ],
  [
    "zenmux",
    "ZENMUX_API_KEY",
    "https://zenmux.ai/api/anthropic",
    "anthropic/claude-sonnet-5",
    "anthropic",
  ],
  [
    "dashscope",
    "DASHSCOPE_API_KEY",
    "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwen3.8-flash",
    "openai-compatible",
  ],
];
const statuses = [];
const results = [];
const installation = await installSystemProxy({
  onStatus: (status) => statuses.push(status),
});
let peers = [];
const diagnostic = channel("undici:client:sendHeaders");
const recordPeer = ({ socket }) => {
  if (socket)
    peers.push({ address: socket.remoteAddress, port: socket.remotePort });
};
diagnostic.subscribe(recordPeer);
try {
  for (const [provider, keyName, baseUrl, model, interfaceProvider] of cases) {
    const apiKey = process.env[keyName] || local[keyName];
    if (!apiKey) {
      results.push({ provider, model, ok: false, failure: "missing-key" });
      continue;
    }
    const client = createInterfaceProvider({
      id: provider,
      apiKey,
      baseUrl,
      interfaceProvider,
    });
    peers = [];
    const started = performance.now();
    let text = "";
    let finishReason;
    let usage;
    try {
      const stream = await client.streamResponse({
        model,
        messages: [{ role: "user", content: "Reply with exactly OK." }],
        maxTokens: 256,
        signal: AbortSignal.timeout(45_000),
        promptCache: { strategy: "observe-only", reason: "network-smoke" },
      });
      for await (const event of stream) {
        text += event.textDelta ?? "";
        finishReason = event.finishReason ?? finishReason;
        usage = event.tokenUsage ?? usage;
      }
      results.push({
        provider,
        model,
        interfaceProvider,
        baseUrl,
        ok: text.trim().length > 0 && finishReason !== undefined,
        elapsedMs: Math.round(performance.now() - started),
        textCharacters: text.length,
        finishReason,
        usage,
        peers,
      });
    } catch (error) {
      // Deliberately omit raw SDK errors, request objects and response bodies.
      const safeCode =
        typeof error?.code === "string" && /^[A-Z_]{2,50}$/.test(error.code)
          ? error.code
          : undefined;
      results.push({
        provider,
        model,
        interfaceProvider,
        baseUrl,
        ok: false,
        elapsedMs: Math.round(performance.now() - started),
        failure: "provider-request-failed",
        code: safeCode,
        status: typeof error?.status === "number" ? error.status : undefined,
        peers,
      });
    }
  }
} finally {
  diagnostic.unsubscribe(recordPeer);
  await installation.dispose();
}
console.log(
  JSON.stringify(
    {
      at: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      statuses,
      results,
    },
    null,
    2,
  ),
);
if (results.some((result) => !result.ok)) process.exitCode = 1;

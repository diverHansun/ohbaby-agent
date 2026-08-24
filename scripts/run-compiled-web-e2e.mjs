#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const TITLE_MARKER =
  "Generate a concise title for a coding-agent chat session.";
const TOOL_CALL_ID = "call_compiled_web_read";
const TOOL_FINAL = "OHBABY_COMPILED_WEB_TOOL_OK";
const FOLLOWUP_FINAL = "OHBABY_COMPILED_WEB_FOLLOWUP_OK";
const FIXTURE_SENTINEL = "OHBABY_COMPILED_WEB_FIXTURE_5";
const UI_EVIDENCE_EXPECTED = Object.freeze({
  activeSessionStable: true,
  followupFinalAfterRefresh: 1,
  followupFinalBeforeRefresh: 1,
  followupUserAfterRefresh: 1,
  runtimeMarkersVisible: false,
  titleContainsRuntimeMarker: false,
  toolFinalAfterRefresh: 1,
  toolFinalBeforeRefresh: 1,
  toolPanelCompleted: true,
});

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function countMarker(value, marker) {
  return JSON.stringify(value).split(marker).length - 1;
}

function isPrefix(left, right) {
  if (left.length > right.length) {
    return false;
  }
  return JSON.stringify(right.slice(0, left.length)) === JSON.stringify(left);
}

function sendUsage(response, requestIndex) {
  const promptTokens = 2_100 + requestIndex * 100;
  const cachedTokens = requestIndex === 0 ? 0 : 1_900;
  writeSse(response, {
    choices: [],
    created: 0,
    id: `chatcmpl_e2e_usage_${String(requestIndex)}`,
    model: "fake-model",
    object: "chat.completion.chunk",
    usage: {
      completion_tokens: 8,
      prompt_tokens: promptTokens,
      prompt_tokens_details: { cached_tokens: cachedTokens },
      total_tokens: promptTokens + 8,
    },
  });
}

async function sendTextResponse(response, text, requestIndex) {
  const splitAt = Math.max(1, Math.floor(text.length / 2));
  for (const content of [text.slice(0, splitAt), text.slice(splitAt)]) {
    writeSse(response, {
      choices: [
        {
          delta: { content },
          finish_reason: null,
          index: 0,
        },
      ],
      created: 0,
      id: `chatcmpl_e2e_${String(requestIndex)}`,
      model: "fake-model",
      object: "chat.completion.chunk",
    });
    await delay(75);
  }
  writeSse(response, {
    choices: [
      {
        delta: {},
        finish_reason: "stop",
        index: 0,
      },
    ],
    created: 0,
    id: `chatcmpl_e2e_${String(requestIndex)}`,
    model: "fake-model",
    object: "chat.completion.chunk",
  });
  sendUsage(response, requestIndex);
  response.end("data: [DONE]\n\n");
}

function assertMainRequest(requests, body, requestIndex) {
  const messages = asArray(body.messages);
  const tools = asArray(body.tools);
  const serialized = JSON.stringify(body);
  if (body.stream !== true || body.stream_options?.include_usage !== true) {
    throw new Error("compiled Web request did not enable streaming usage");
  }
  if (typeof body.prompt_cache_key !== "string") {
    throw new Error("compiled Web agent-step omitted scoped prompt cache key");
  }
  if (!tools.some((tool) => tool?.function?.name === "read")) {
    throw new Error("compiled Web request omitted the production read tool");
  }
  if (serialized.includes("Available tools")) {
    throw new Error("compiled Web request reintroduced Available tools text");
  }
  const expectedRuntimeParts = requestIndex === 2 ? 2 : 1;
  if (countMarker(messages, "<environment_context>") !== expectedRuntimeParts) {
    throw new Error("compiled Web request has an invalid runtime part count");
  }
  const systemMessages = messages.filter(
    (message) => message?.role === "system",
  );
  if (JSON.stringify(systemMessages).includes("<environment_context>")) {
    throw new Error("compiled Web runtime context leaked into system prompt");
  }
  if (requestIndex > 0) {
    const first = requests[0];
    const previous = requests[requestIndex - 1];
    if (!first || !previous) {
      throw new Error("compiled Web fixture lost prior request evidence");
    }
    if (body.prompt_cache_key !== first.prompt_cache_key) {
      throw new Error("compiled Web scoped prompt cache key changed");
    }
    if (!isPrefix(asArray(previous.messages), messages)) {
      throw new Error("compiled Web message history is not append-only");
    }
    if (JSON.stringify(previous.tools) !== JSON.stringify(tools)) {
      throw new Error("compiled Web ordered tools changed inside one epoch");
    }
  }

  if (requestIndex === 1) {
    if (
      !serialized.includes(TOOL_CALL_ID) ||
      !serialized.includes(FIXTURE_SENTINEL)
    ) {
      throw new Error(
        "production read tool result did not reach model request",
      );
    }
  }
  if (requestIndex === 2) {
    if (!serialized.includes(TOOL_FINAL)) {
      throw new Error("follow-up request omitted the first assistant result");
    }
    const lastUser = messages.findLast((message) => message?.role === "user");
    if (!JSON.stringify(lastUser).includes("OHBABY_COMPILED_WEB_FOLLOWUP")) {
      throw new Error("compiled Web follow-up user suffix was not preserved");
    }
  }
}

async function startScriptedProvider() {
  const mainRequests = [];
  let titleRequests = 0;
  let failure;
  const server = createHttpServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const authorization = request.headers.authorization;
      if (authorization !== "Bearer compiled-web-e2e-key") {
        throw new Error(
          "compiled Web fixture received an unexpected credential",
        );
      }
      if (JSON.stringify(body).includes(TITLE_MARKER)) {
        titleRequests += 1;
        if (body.prompt_cache_key !== undefined) {
          throw new Error(
            "auxiliary title request unexpectedly sent a cache key",
          );
        }
        response.writeHead(200, {
          "cache-control": "no-cache",
          "content-type": "text/event-stream; charset=utf-8",
        });
        await sendTextResponse(response, "Compiled E2E fixture", 90);
        return;
      }

      const requestIndex = mainRequests.length;
      if (requestIndex > 2) {
        throw new Error(
          "compiled Web fixture exceeded three agent-step requests",
        );
      }
      assertMainRequest(mainRequests, body, requestIndex);
      mainRequests.push(body);
      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
      });
      if (requestIndex === 0) {
        writeSse(response, {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: {
                      arguments: '{"file_path":"fixture.txt"}',
                      name: "read",
                    },
                    id: TOOL_CALL_ID,
                    index: 0,
                    type: "function",
                  },
                ],
              },
              finish_reason: null,
              index: 0,
            },
          ],
          created: 0,
          id: "chatcmpl_e2e_tool",
          model: "fake-model",
          object: "chat.completion.chunk",
        });
        writeSse(response, {
          choices: [
            {
              delta: {},
              finish_reason: "tool_calls",
              index: 0,
            },
          ],
          created: 0,
          id: "chatcmpl_e2e_tool",
          model: "fake-model",
          object: "chat.completion.chunk",
        });
        sendUsage(response, requestIndex);
        response.end("data: [DONE]\n\n");
        return;
      }
      await sendTextResponse(
        response,
        requestIndex === 1 ? TOOL_FINAL : FOLLOWUP_FINAL,
        requestIndex,
      );
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
      }
      response.end(JSON.stringify({ error: { message: "fixture failure" } }));
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("scripted provider did not bind a TCP port");
  }
  return {
    assertEvidence() {
      if (failure) {
        throw failure;
      }
      if (mainRequests.length !== 3) {
        throw new Error(
          `expected three agent-step requests, received ${String(mainRequests.length)}`,
        );
      }
      if (titleRequests < 1) {
        throw new Error("compiled Web flow did not complete title generation");
      }
      return {
        keyPresent: typeof mainRequests[0]?.prompt_cache_key === "string",
        keyStable: mainRequests.every(
          (request) =>
            request.prompt_cache_key === mainRequests[0]?.prompt_cache_key,
        ),
        requestCount: mainRequests.length,
        runtimePartCounts: mainRequests.map((request) =>
          countMarker(request.messages, "<environment_context>"),
        ),
        titleRequests,
        toolResultConsumed: JSON.stringify(mainRequests[1]).includes(
          FIXTURE_SENTINEL,
        ),
      };
    },
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      }),
  };
}

function runCli(binPath, args, options) {
  const child = spawn(process.execPath, ["--no-warnings", binPath, ...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolveRun, rejectRun) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(new Error("compiled CLI command timed out"));
    }, options.timeoutMs ?? 20_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolveRun({ code, stderr, stdout });
    });
  });
}

function waitForReady(child, timeoutMs = 30_000) {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      rejectReady(new Error("compiled serve did not report readiness"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /ohbaby web ready: (http:\/\/127\.0\.0\.1:\d+[^\s]*)/u.exec(
        stdout,
      );
      if (match?.[1]) {
        clearTimeout(timeout);
        resolveReady(match[1]);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `compiled serve exited before readiness (code ${String(code)}; stderr bytes ${String(stderr.length)})`,
        ),
      );
    });
    child.once("error", rejectReady);
  });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function readJsonWithRetry(path, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await delay(100);
    }
  }
}

async function verifyCompiledAssets(url, compiledIndexPath) {
  const compiledIndex = await readFile(compiledIndexPath, "utf8");
  const assetPaths = [
    ...compiledIndex.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/gu),
  ].map((match) => match[1]);
  if (assetPaths.length === 0) {
    throw new Error("compiled Web index does not reference built assets");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `compiled Web root returned HTTP ${String(response.status)}`,
    );
  }
  const servedHtml = await response.text();
  for (const assetPath of assetPaths) {
    if (!servedHtml.includes(basename(assetPath))) {
      throw new Error("served Web HTML does not match the compiled asset set");
    }
    const assetResponse = await fetch(new URL(assetPath, url));
    if (!assetResponse.ok) {
      throw new Error("compiled Web asset was not served successfully");
    }
  }
}

async function waitForPidExit(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`compiled daemon PID ${String(pid)} remained alive`);
}

async function assertPortReleased(port) {
  const probe = createNetServer();
  await new Promise((resolveBind, rejectBind) => {
    probe.once("error", rejectBind);
    probe.listen(port, "127.0.0.1", resolveBind);
  });
  await new Promise((resolveClose, rejectClose) => {
    probe.close((error) => {
      if (error) {
        rejectClose(error);
        return;
      }
      resolveClose();
    });
  });
}

function assertBrowserEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("compiled Web UI evidence must be a JSON object");
  }
  for (const [key, expectedValue] of Object.entries(UI_EVIDENCE_EXPECTED)) {
    if (value[key] !== expectedValue) {
      throw new Error(
        `compiled Web UI evidence ${key} must equal ${JSON.stringify(expectedValue)}`,
      );
    }
  }
  return UI_EVIDENCE_EXPECTED;
}

async function waitForBrowserEvidence() {
  process.stdin.resume();
  const raw = await new Promise((resolveSignal, rejectSignal) => {
    const onData = (chunk) => {
      process.removeListener("SIGINT", onInterrupt);
      resolveSignal(String(chunk).trim());
    };
    const onInterrupt = () => {
      process.stdin.removeListener("data", onData);
      rejectSignal(new Error("compiled Web browser evidence was interrupted"));
    };
    process.stdin.once("data", onData);
    process.once("SIGINT", onInterrupt);
  });
  return assertBrowserEvidence(JSON.parse(raw));
}

async function cleanupCompiledRuntime(input) {
  const failures = [];
  let finalStatus = "not-started";
  let pid = input.capturedPid ?? input.serveChild?.pid;
  let port = input.capturedPort;
  let portReleased = !Number.isInteger(port) || port <= 0;

  if (input.serveChild) {
    const state = await readJsonWithRetry(input.statePath, 2_000).catch(
      () => undefined,
    );
    if (Number.isInteger(state?.pid)) {
      pid = state.pid;
    }
    if (Number.isInteger(state?.port) && state.port > 0) {
      port = state.port;
    }

    if (input.env) {
      try {
        const stop = await runCli(input.cliBin, ["serve", "stop"], {
          cwd: input.workspace,
          env: input.env,
        });
        if (
          stop.code !== 0 ||
          !/daemon (stopped|not-running)/u.test(stop.stdout)
        ) {
          throw new Error("compiled serve stop command failed");
        }
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    if (Number.isInteger(pid) && processIsAlive(pid)) {
      try {
        await waitForPidExit(pid);
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error)),
        );
        try {
          process.kill(pid, "SIGTERM");
          await waitForPidExit(pid, 5_000);
        } catch {
          if (processIsAlive(pid)) {
            process.kill(pid, "SIGKILL");
            await waitForPidExit(pid, 5_000);
          }
        }
      }
    }

    if (input.env) {
      try {
        const status = await runCli(input.cliBin, ["serve", "status"], {
          cwd: input.workspace,
          env: input.env,
        });
        const match = /daemon status: (stopped|not-running)/u.exec(
          status.stdout,
        );
        if (status.code !== 0 || !match?.[1]) {
          throw new Error(
            "compiled serve status did not reach a terminal state",
          );
        }
        finalStatus = match[1];
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    if (Number.isInteger(pid) && processIsAlive(pid)) {
      failures.push(new Error("compiled daemon PID remained alive after stop"));
    }
    try {
      await access(input.pidPath);
      failures.push(new Error("compiled daemon pid lock was not released"));
    } catch (error) {
      if (error?.code !== "ENOENT") {
        failures.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    if (Number.isInteger(port) && port > 0) {
      try {
        await assertPortReleased(port);
        portReleased = true;
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  try {
    await input.provider?.close();
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)));
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "compiled Web cleanup failed");
  }
  return {
    finalStatus,
    pidReleased: !Number.isInteger(pid) || !processIsAlive(pid),
    portReleased,
  };
}

const repositoryRoot = resolve(process.cwd());
const cliBin = join(repositoryRoot, "packages", "ohbaby-cli", "dist", "bin.js");
const compiledIndex = join(
  repositoryRoot,
  "packages",
  "ohbaby-cli",
  "dist",
  "web",
  "index.html",
);
await access(cliBin);
await access(compiledIndex);

const root = await mkdtemp(join(tmpdir(), "ohbaby-compiled-web-e2e-"));
const profile = join(root, "profile");
const workspace = join(root, "workspace");
const osHome = join(root, "os-home");
const dbPath = join(profile, "ohbaby-e2e.db");
const statePath = join(profile, "server", "daemon-state.json");
const pidPath = join(profile, "server", "daemon.pid");
let provider;
let serveChild;
let capturedPid;
let capturedPort;
let isolatedEnv;
let failure;
let cleanupEvidence;

try {
  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(osHome, { recursive: true }),
    mkdir(join(root, "xdg-data"), { recursive: true }),
    mkdir(join(root, "xdg-config"), { recursive: true }),
    mkdir(join(root, "appdata"), { recursive: true }),
    mkdir(join(root, "localappdata"), { recursive: true }),
  ]);
  await writeFile(join(profile, ".skip-auto-migrate"), "\n", "utf8");
  await writeFile(
    join(profile, ".env"),
    "OHBABY_E2E_FAKE_API_KEY=compiled-web-e2e-key\n",
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(
    join(workspace, "fixture.txt"),
    `${FIXTURE_SENTINEL}\n`,
    "utf8",
  );
  provider = await startScriptedProvider();
  await writeFile(
    join(profile, "model.json"),
    JSON.stringify(
      {
        apiConfig: {
          apiKeyEnv: "OHBABY_E2E_FAKE_API_KEY",
          baseUrl: provider.baseUrl,
          interfaceProvider: "openai-compatible",
          promptCache: "enabled",
        },
        defaultModel: "fake-model",
        llmParams: {
          contextWindowTokens: 32_768,
          maxTokens: 256,
          temperature: 0,
        },
        provider: "fake-openai",
      },
      null,
      2,
    ),
    "utf8",
  );

  const env = {
    ...process.env,
    APPDATA: join(root, "appdata"),
    HOME: osHome,
    LOCALAPPDATA: join(root, "localappdata"),
    NO_COLOR: "1",
    OHBABY_DB_PATH: dbPath,
    OHBABY_HOME: profile,
    OHBABY_STORAGE_ROOT: join(root, "storage"),
    USERPROFILE: osHome,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
  };
  delete env.OHBABY_E2E_FAKE_API_KEY;
  isolatedEnv = env;
  serveChild = spawn(
    process.execPath,
    ["--no-warnings", cliBin, "serve", "--port", "0", "--no-open"],
    {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const url = await waitForReady(serveChild);
  const state = await readJsonWithRetry(statePath);
  capturedPid = state.pid;
  capturedPort = state.port;
  if (
    !Number.isInteger(capturedPid) ||
    !Number.isInteger(capturedPort) ||
    capturedPort <= 0 ||
    capturedPid !== serveChild.pid
  ) {
    throw new Error(
      "compiled daemon state did not match the isolated serve process",
    );
  }
  await verifyCompiledAssets(url, compiledIndex);
  console.log(`E2E_READY ${JSON.stringify({ pid: capturedPid, url })}`);
  console.log(
    "E2E_UI_PENDING Complete E01-E05 in the browser, then submit one JSON evidence line.",
  );
  console.log(`E2E_UI_EVIDENCE_SCHEMA ${JSON.stringify(UI_EVIDENCE_EXPECTED)}`);
  const browserEvidence = await waitForBrowserEvidence();
  console.log(`E2E_UI_EVIDENCE_PASS ${JSON.stringify(browserEvidence)}`);

  const backendEvidence = provider.assertEvidence();
  console.log(`E2E_BACKEND_PASS ${JSON.stringify(backendEvidence)}`);
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  try {
    cleanupEvidence = await cleanupCompiledRuntime({
      capturedPid,
      capturedPort,
      cliBin,
      env: isolatedEnv,
      pidPath,
      provider,
      serveChild,
      statePath,
      workspace,
    });
  } catch (error) {
    const cleanupFailure =
      error instanceof Error ? error : new Error(String(error));
    failure = failure
      ? new AggregateError(
          [failure, cleanupFailure],
          "compiled Web flow and cleanup failed",
        )
      : cleanupFailure;
  }
  process.stdin.pause();
}

if (cleanupEvidence) {
  console.log(`E2E_CLEANUP_PASS ${JSON.stringify(cleanupEvidence)}`);
}
if (failure) {
  console.error(
    `E2E_FAIL ${failure.message}; isolated root retained at ${root}`,
  );
  process.exitCode = 1;
} else {
  await rm(root, { force: true, recursive: true });
}

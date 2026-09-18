import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireCliPackageBuildLock } from "./cli/package-build-lock.js";

// T7/T9: consume only package roots and compiled output. No source aliases,
// SDK method spies, user configuration, or real provider endpoints.
const repoRoot = process.cwd();
const protocols = [
  "openai-compatible",
  "openai-responses",
  "anthropic",
] as const;
type Protocol = (typeof protocols)[number];
const argumentsJson = '{ "value": "fixture" }';
const schema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
};
let consumerDirectory: string | undefined;
let releaseBuildLock: (() => Promise<void>) | undefined;

interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// Async spawn is required: a blocking child would starve the parent SSE server.
async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolveResult, reject) => {
    let timedOut = false;
    let termination: Promise<void> = Promise.resolve();
    const timeout = setTimeout(() => {
      timedOut = true;
      // pnpm can leave tsup/tsc descendants writing dist after its own exit.
      // Keep the build lock until the entire process tree has been stopped.
      if (child.pid !== undefined) {
        if (process.platform === "win32") {
          termination = new Promise<void>(
            (resolveTermination, rejectTermination) => {
              const killer = spawn(
                "taskkill",
                ["/pid", String(child.pid), "/T", "/F"],
                { stdio: "ignore", windowsHide: true },
              );
              killer.once("error", rejectTermination);
              killer.once("close", (code) => {
                if (code === 0) resolveTermination();
                else
                  rejectTermination(
                    new Error(`taskkill exited ${String(code)}`),
                  );
              });
            },
          );
          void termination.catch(() => undefined);
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              termination = Promise.reject(
                error instanceof Error ? error : new Error(String(error)),
              );
              void termination.catch(() => undefined);
            }
          }
        }
      }
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      void termination.then(() => {
        if (timedOut)
          reject(
            new Error(
              `${command} timed out after ${String(timeoutMs)} ms\n${stderr}`,
            ),
          );
        else resolveResult({ code, stdout, stderr });
      }, reject);
    });
  });
}

function expectSuccess(result: CommandResult): void {
  expect(result.code, result.stdout + result.stderr).toBe(0);
}

async function compile(
  files: readonly string[],
  emit: boolean,
): Promise<CommandResult> {
  if (!consumerDirectory) throw new Error("Consumer setup has not completed");
  return run(
    process.execPath,
    [
      resolve(repoRoot, "node_modules/typescript/bin/tsc"),
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--target",
      "ES2022",
      "--strict",
      "--skipLibCheck",
      "--types",
      "node",
      "--pretty",
      "false",
      ...(emit ? ["--outDir", "out"] : ["--noEmit"]),
      ...files,
    ],
    consumerDirectory,
  );
}

beforeAll(async () => {
  const lock = await acquireCliPackageBuildLock();
  releaseBuildLock = lock.release;
  // Hold the same lock through all consumers; package smoke builds delete dist.
  for (const name of ["ohbaby-sdk", "ohbaby-agent"]) {
    const command =
      process.platform === "win32"
        ? (process.env.ComSpec ?? "cmd.exe")
        : "pnpm";
    const args =
      process.platform === "win32"
        ? ["/d", "/s", "/c", `pnpm.cmd --filter ${name} build`]
        : ["--filter", name, "build"];
    expectSuccess(await run(command, args, repoRoot, 180_000));
  }
  consumerDirectory = await mkdtemp(join(tmpdir(), "ohbaby-model-consumer-"));
  await mkdir(join(consumerDirectory, "node_modules"));
  for (const name of ["ohbaby-sdk", "ohbaby-agent"]) {
    await symlink(
      resolve(repoRoot, "packages", name),
      join(consumerDirectory, "node_modules", name),
      "junction",
    );
  }
  await symlink(
    resolve(repoRoot, "node_modules/@types"),
    join(consumerDirectory, "node_modules/@types"),
    "junction",
  );
  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await writeFile(join(consumerDirectory, "consumer.ts"), consumerSource);
  expectSuccess(await compile(["consumer.ts"], true));
}, 840_000);

afterAll(async () => {
  try {
    if (consumerDirectory)
      await rm(consumerDirectory, { force: true, recursive: true });
  } finally {
    await releaseBuildLock?.();
  }
}, 30_000);

describe("compiled model package contracts", () => {
  it("compiles new root exports and indirect AgentRun event contracts", () => {
    // Executable consumer was compiled in beforeAll, without source path aliases.
    expect(consumerDirectory).toBeDefined();
  });

  it("rejects each removed export and property at a real consumer compile boundary", async () => {
    if (!consumerDirectory) throw new Error("Consumer setup has not completed");
    const files: string[] = [];
    for (const [index, source] of rejectedConsumers.entries()) {
      const name = `rejected-${String(index)}.ts`;
      files.push(name);
      await writeFile(join(consumerDirectory, name), source);
    }
    const result = await compile(files, false);
    expect(result.code, result.stdout + result.stderr).not.toBe(0);
    // Each isolated file must report an actual diagnostic; one missing export
    // cannot accidentally make the other negative fixtures appear covered.
    for (const name of files) {
      expect(result.stdout + result.stderr).toContain(`${name}(`);
    }
    expect(result.stdout + result.stderr).not.toContain("TS2307");
  }, 90_000);

  it.each(protocols)(
    "runs text and one tool round trip through compiled %s SDK/factory",
    async (protocol) => {
      if (!consumerDirectory)
        throw new Error("Consumer setup has not completed");
      const captured: {
        readonly method?: string;
        readonly path?: string;
        readonly credential: string | string[] | undefined;
        readonly body: unknown;
      }[] = [];
      const serverFailures: string[] = [];
      const server = createServer((request, response) => {
        void (async (): Promise<void> => {
          let raw = "";
          for await (const chunk of request) raw += String(chunk);
          captured.push({
            method: request.method,
            path: request.url,
            credential:
              request.headers[
                protocol === "anthropic" ? "x-api-key" : "authorization"
              ],
            body: JSON.parse(raw) as unknown,
          });
          if (captured.length > 3) {
            response.writeHead(400).end("Unexpected fourth request");
            return;
          }
          const step = captured.length - 1;
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          });
          for (const event of events(
            protocol,
            step === 1,
            step === 0 ? "TEXT_OK" : "TOOL_OK",
          )) {
            if (protocol !== "openai-compatible")
              response.write(`event: ${String(event.type)}\n`);
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          if (protocol === "openai-compatible")
            response.write("data: [DONE]\n\n");
          response.end();
        })().catch((error: unknown) => {
          serverFailures.push(String(error));
          if (!response.headersSent) response.writeHead(400);
          response.end("Fixture server failure");
        });
      });
      try {
        await listen(server);
        const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
        const project = join(consumerDirectory, protocol);
        await mkdir(project);
        const modelJsonPath = join(project, "model.json");
        await writeFile(
          modelJsonPath,
          JSON.stringify({
            provider: "compiled-fixture",
            defaultModel: "synthetic-model",
            models: [
              {
                model: "synthetic-model",
                contextWindowTokens: 128000,
                reasoningCapabilities: {
                  mode: "none",
                  wire: "none",
                  supportsDisabled: true,
                },
              },
            ],
            apiConfig: {
              baseUrl: protocol === "anthropic" ? origin : `${origin}/v1`,
              apiKeyEnv: "COMPILED_FIXTURE_KEY",
              interfaceProvider: protocol,
              promptCache: "disabled",
            },
            llmParams: { temperature: 0.2, maxTokens: 128 },
          }),
        );
        const result = await run(
          process.execPath,
          [
            join(consumerDirectory, "out/consumer.js"),
            project,
            modelJsonPath,
            protocol,
          ],
          project,
          30_000,
        );
        expectSuccess(result);
        expect(serverFailures).toEqual([]);
        const summaryLine = result.stdout
          .split("\n")
          .find((line) => line.startsWith("COMPILED_RESULT "));
        expect(summaryLine, result.stdout).toBeDefined();
        if (summaryLine === undefined)
          throw new Error("Consumer result was not reported");
        expect(
          JSON.parse(summaryLine.slice("COMPILED_RESULT ".length)),
        ).toEqual({
          protocol,
          text: "TEXT_OK",
          final: "TOOL_OK",
          executions: 1,
          finishReasons: ["stop", "tool_calls", "stop"],
          usage: [
            { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
            { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
            { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          ],
        });
        expect(captured).toHaveLength(3);
        expect(captured.map(({ method }) => method)).toEqual([
          "POST",
          "POST",
          "POST",
        ]);
        const credential =
          protocol === "anthropic"
            ? "dummy-local-only"
            : "Bearer dummy-local-only";
        expect(captured.map((request) => request.credential)).toEqual([
          credential,
          credential,
          credential,
        ]);
        const path =
          protocol === "anthropic"
            ? "/v1/messages"
            : protocol === "openai-responses"
              ? "/v1/responses"
              : "/v1/chat/completions";
        expect(captured.map((request) => request.path)).toEqual([
          path,
          path,
          path,
        ]);
        const expected = expectedRequests(protocol);
        captured.forEach((request, index) => {
          expect(request.body).toEqual(expected[index]);
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolveClose, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolveClose();
          });
        });
      }
    },
    60_000,
  );
});

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

function expectedRequests(protocol: Protocol): unknown[] {
  const common = { model: "synthetic-model", stream: true };
  const firstUser = {
    role: "user",
    content: "Return the synthetic text marker.",
  };
  const toolUser = {
    role: "user",
    content: "Call fixture_echo once, then return the tool marker.",
  };
  if (protocol === "openai-responses") {
    const base = {
      ...common,
      max_output_tokens: 128,
      store: false,
      instructions: "Synthetic compiled contract fixture.",
    };
    const tools = [
      {
        type: "function",
        name: "fixture_echo",
        description: "Return a fixed synthetic result.",
        parameters: schema,
        strict: false,
      },
    ];
    return [
      { ...base, input: [firstUser] },
      { ...base, tools, input: [toolUser] },
      {
        ...base,
        tools,
        input: [
          toolUser,
          {
            type: "function_call",
            call_id: "call_fixture",
            name: "fixture_echo",
            arguments: argumentsJson,
          },
          {
            type: "function_call_output",
            call_id: "call_fixture",
            output: "RESULT_fixture",
          },
        ],
      },
    ];
  }
  if (protocol === "anthropic") {
    const base = {
      ...common,
      max_tokens: 128,
      system: "Synthetic compiled contract fixture.",
    };
    const tools = [
      {
        name: "fixture_echo",
        description: "Return a fixed synthetic result.",
        input_schema: schema,
      },
    ];
    return [
      { ...base, messages: [firstUser] },
      { ...base, tools, messages: [toolUser] },
      {
        ...base,
        tools,
        messages: [
          toolUser,
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_fixture",
                name: "fixture_echo",
                input: { value: "fixture" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "call_fixture",
                content: "RESULT_fixture",
              },
            ],
          },
        ],
      },
    ];
  }
  const base = {
    ...common,
    max_tokens: 128,
    stream_options: { include_usage: true },
  };
  const system = {
    role: "system",
    content: "Synthetic compiled contract fixture.",
  };
  const tools = [
    {
      type: "function",
      function: {
        name: "fixture_echo",
        description: "Return a fixed synthetic result.",
        parameters: schema,
      },
    },
  ];
  return [
    { ...base, messages: [system, firstUser] },
    { ...base, tools, messages: [system, toolUser] },
    {
      ...base,
      tools,
      messages: [
        system,
        toolUser,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_fixture",
              type: "function",
              function: { name: "fixture_echo", arguments: argumentsJson },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_fixture",
          content: "RESULT_fixture",
        },
      ],
    },
  ];
}

function events(
  protocol: Protocol,
  tool: boolean,
  text: string,
): Record<string, unknown>[] {
  if (protocol === "openai-compatible") {
    const chunk = (
      delta: unknown,
      finish: string | null = null,
    ): Record<string, unknown> => ({
      id: "chat_fixture",
      object: "chat.completion.chunk",
      created: 1,
      model: "synthetic-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    return [
      chunk({
        role: "assistant",
        ...(tool
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "call_fixture",
                  type: "function",
                  function: {
                    name: "fixture_echo",
                    arguments: argumentsJson.slice(0, 9),
                  },
                },
              ],
            }
          : { content: text.slice(0, 3) }),
      }),
      chunk(
        tool
          ? {
              tool_calls: [
                { index: 0, function: { arguments: argumentsJson.slice(9) } },
              ],
            }
          : { content: text.slice(3) },
      ),
      {
        ...chunk({}, tool ? "tool_calls" : "stop"),
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
    ];
  }
  if (protocol === "anthropic") {
    return [
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "synthetic-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: tool
          ? {
              type: "tool_use",
              id: "call_fixture",
              name: "fixture_echo",
              input: {},
            }
          : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: tool
          ? {
              type: "input_json_delta",
              partial_json: argumentsJson.slice(0, 9),
            }
          : { type: "text_delta", text: text.slice(0, 3) },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: tool
          ? { type: "input_json_delta", partial_json: argumentsJson.slice(9) }
          : { type: "text_delta", text: text.slice(3) },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: {
          stop_reason: tool ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 20 },
      },
      { type: "message_stop" },
    ];
  }
  const item = tool
    ? {
        id: "item_fixture",
        type: "function_call",
        call_id: "call_fixture",
        name: "fixture_echo",
        arguments: argumentsJson,
        status: "completed",
      }
    : {
        id: "msg_fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
      };
  const ref = { item_id: item.id, output_index: 0 };
  const part = { type: "output_text", text, annotations: [], logprobs: [] };
  const textRef = { ...ref, content_index: 0 };
  return [
    {
      type: "response.output_item.added",
      ...ref,
      item: {
        ...item,
        status: "in_progress",
        ...(tool ? { arguments: "" } : { content: [] }),
      },
    },
    ...(tool
      ? [
          {
            type: "response.function_call_arguments.delta",
            ...ref,
            delta: argumentsJson.slice(0, 9),
          },
          {
            type: "response.function_call_arguments.delta",
            ...ref,
            delta: argumentsJson.slice(9),
          },
          {
            type: "response.function_call_arguments.done",
            ...ref,
            arguments: argumentsJson,
          },
        ]
      : [
          {
            type: "response.content_part.added",
            ...textRef,
            part: { ...part, text: "" },
          },
          {
            type: "response.output_text.delta",
            ...textRef,
            delta: text.slice(0, 3),
            logprobs: [],
          },
          {
            type: "response.output_text.delta",
            ...textRef,
            delta: text.slice(3),
            logprobs: [],
          },
          { type: "response.output_text.done", ...textRef, text, logprobs: [] },
          { type: "response.content_part.done", ...textRef, part },
        ]),
    { type: "response.output_item.done", ...ref, item },
    {
      type: "response.completed",
      response: {
        id: "resp_fixture",
        status: "completed",
        output: [item],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        previous_response_id: null,
        store: false,
      },
    },
  ];
}

const consumerSource = String.raw`
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  createLLMClient, streamResponse, toModelTools,
  type AgentRunResult, type ModelMessage, type ModelToolCall,
  type ModelToolDefinition, type ModelFinishReason,
  type ModelResponseSnapshot, type ToolCallSnapshot, type ParsedToolCall,
  type StreamingResponse, type StreamingTokenUsage,
} from "ohbaby-agent";
import type { UiEvent } from "ohbaby-sdk";

type EventOf<T> = T extends AsyncIterable<infer Event> ? Event : never;
type RunEvent = EventOf<Extract<AgentRunResult, { mode: "stream" }> ["events"]>;
type Complete = Extract<RunEvent, { type: "llm:complete" }>;
type Assert<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type RequiredTypeChecks = [Assert<NotAny<ModelMessage>>, Assert<NotAny<RunEvent>>, Assert<NotAny<StreamingResponse>>, Assert<NotAny<ModelToolCall>>, Assert<NotAny<ModelToolDefinition>>, Assert<NotAny<ModelResponseSnapshot>>];

// Type-check indirect event projections without exporting Lifecycle for tests.
function verifyPublicTypes(event: RunEvent, response: StreamingResponse, ui: UiEvent): void {
  if (event.type === "llm:complete" || event.type === "llm:delta") {
    const snapshot: ModelResponseSnapshot | undefined = event.messageSnapshot;
    void snapshot;
  }
  const observationWithoutSnapshot: Complete = { type: "llm:complete", sessionId: "s", timestamp: 1 };
  const snapshot: ModelResponseSnapshot = response.messageSnapshot;
  const reasoning: string | undefined = response.reasoningText;
  const reasoningDelta: string | undefined = response.reasoningTextDelta;
  const finish: ModelFinishReason | undefined = response.finishReason;
  const partial: ToolCallSnapshot = { index: 0, argumentsJson: "{" };
  const parsed: ParsedToolCall = { callId: "call_fixture", name: "fixture_echo", arguments: {} };
  const usage: StreamingTokenUsage = { inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  const calls: readonly ModelToolCall[] = [{ callId: "call_fixture", name: "fixture_echo", argumentsJson: "{}" }];
  const messages: readonly ModelMessage[] = [
    { role: "system", content: "s" }, { role: "developer", content: "d", name: "n" },
    { role: "user", content: [{ type: "text", text: "x", cacheControl: { type: "ephemeral", ttl: "5m" } }, { type: "image_url", image_url: { url: "data:image/png;base64,fixture", detail: "low" } }, { type: "input_audio", input_audio: { data: "fixture", format: "wav" } }, { type: "file", file: { file_id: "fixture" } }] },
    { role: "assistant", content: null, toolCalls: calls, reasoningText: "r" },
    { role: "tool", callId: "call_fixture", content: "" },
  ];
  void [observationWithoutSnapshot, snapshot, reasoning, reasoningDelta, finish, partial, parsed, usage, messages, ui];
}
void verifyPublicTypes;
const convertedTools: ModelToolDefinition[] = toModelTools([]);
void convertedTools;

const [projectDirectory, modelJsonPath, protocol] = process.argv.slice(2);
assert(projectDirectory && modelJsonPath && protocol);
const client = await createLLMClient({
  projectDirectory, modelJsonPath,
  envPath: join(projectDirectory, "absent-fixture-env"),
  env: { COMPILED_FIXTURE_KEY: "dummy-local-only" },
});
assert.equal(client.provider.kind, protocol);
assert(client.provider.client && typeof client.provider.client === "object");
// Existing SDK runtime option; no production test switch or alternate factory.
Reflect.set(client.provider.client, "maxRetries", 0);
let executions = 0;
function fixtureEcho(args: Record<string, unknown>): string {
  assert.deepEqual(args, { value: "fixture" });
  executions += 1;
  return "RESULT_" + String(args.value);
}
async function complete(messages: readonly ModelMessage[], tools?: ModelToolDefinition[]): Promise<StreamingResponse> {
  let final: StreamingResponse | undefined;
  let completeCount = 0;
  let parsedSnapshots = 0;
  let nativeSnapshots = 0;
  let partialCount = 0;
  const countBeforeRequest = executions;
  for await (const response of streamResponse(client, messages, {
    tools, purpose: "agent-step", sessionId: "compiled-fixture", contextScopeId: "main",
    signal: AbortSignal.timeout(10_000), retry: { maxRetriesPerStep: 0 },
  })) {
    assert.equal(executions, countBeforeRequest);
    if (response.isComplete) completeCount += 1;
    else {
      partialCount += 1;
      assert.equal(response.parsedToolCalls, undefined);
    }
    if (response.parsedToolCalls?.length) parsedSnapshots += 1;
    if (response.modelState) nativeSnapshots += 1;
    final = response;
  }
  // Drain the provider stream fully before checking the execution gate.
  assert(final && final.isComplete);
  // Completion notifications may precede final usage/native enrichment; consume to EOF.
  assert(completeCount >= 1);
  assert.equal(parsedSnapshots, final.parsedToolCalls?.length ? 1 : 0);
  assert.equal(nativeSnapshots, final.modelState ? 1 : 0);
  assert(partialCount > 0);
  assert.equal(final.streamStopReason, "provider_finished");
  assert(final.tokenUsage);
  return final;
}
const system: ModelMessage = { role: "system", content: "Synthetic compiled contract fixture." };
const text = await complete([system, { role: "user", content: "Return the synthetic text marker." }]);
assert.equal(text.finishReason, "stop");
assert.equal(text.messageSnapshot.content, "TEXT_OK");
const tools: ModelToolDefinition[] = [{
  name: "fixture_echo", description: "Return a fixed synthetic result.",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
}];
const history: ModelMessage[] = [system, { role: "user", content: "Call fixture_echo once, then return the tool marker." }];
const call = await complete(history, tools);
assert.equal(call.finishReason, "tool_calls");
assert.equal(call.messageSnapshot.content, null);
assert.equal(call.parsedToolCalls?.length, 1);
assert.equal(call.messageSnapshot.toolCalls?.length, 1);
const parsed = call.parsedToolCalls?.[0];
const snapshot = call.messageSnapshot.toolCalls?.[0];
assert(parsed && snapshot);
assert.equal(parsed.callId, "call_fixture");
assert.equal(parsed.name, "fixture_echo");
assert.deepEqual(parsed.arguments, { value: "fixture" });
assert.equal(snapshot.callId, parsed.callId);
assert.equal(snapshot.name, parsed.name);
assert.equal(snapshot.argumentsJson, '{ "value": "fixture" }');
assert(snapshot.callId && snapshot.name);
// Consumer-owned, explicit mapping: drop index, preserve original parameter text.
// Never cast a partial snapshot into a legal request or serialize parsed args.
const requestCall: ModelToolCall = { callId: snapshot.callId, name: snapshot.name, argumentsJson: snapshot.argumentsJson };
assert.equal(executions, 0);
const result = fixtureEcho(parsed.arguments);
history.push({ role: "assistant", content: call.messageSnapshot.content, toolCalls: [requestCall] });
history.push({ role: "tool", callId: parsed.callId, content: result });
const final = await complete(history, tools);
assert.equal(final.finishReason, "stop");
assert.equal(final.messageSnapshot.content, "TOOL_OK");
assert.equal(executions, 1);
const usage = [text, call, final].map(({ tokenUsage }) => {
  assert(tokenUsage);
  return { inputTokens: tokenUsage.inputTokens, outputTokens: tokenUsage.outputTokens, totalTokens: tokenUsage.totalTokens };
});
console.log("COMPILED_RESULT " + JSON.stringify({ protocol, text: text.messageSnapshot.content, final: final.messageSnapshot.content, executions, finishReasons: [text.finishReason, call.finishReason, final.finishReason], usage }));
`;

const rejectedConsumers = [
  ...[
    "ChatCompletionMessage",
    "ChatFinishReason",
    "InterfaceProviderFunctionTool",
    "InterfaceProviderFunctionTools",
  ].map(
    (name) =>
      `import type { ${name} } from "ohbaby-agent"; export type Rejected = ${name};`,
  ),
  'import { streamChatCompletion } from "ohbaby-agent"; void streamChatCompletion;',
  'import { toOpenAiTools } from "ohbaby-agent"; void toOpenAiTools;',
  ...["completeMessage", "reasoning", "reasoningDelta"].map(
    (name) =>
      `import type { StreamingResponse } from "ohbaby-agent"; declare const value: StreamingResponse; void value.${name};`,
  ),
  ...["prompt_tokens", "completion_tokens", "total_tokens"].map(
    (name) =>
      `import type { StreamingTokenUsage } from "ohbaby-agent"; declare const value: StreamingTokenUsage; void value.${name};`,
  ),
  'import type { ParsedToolCall } from "ohbaby-agent"; declare const value: ParsedToolCall; void value.id;',
  ...["role", "tool_calls", "reasoningText"].map(
    (name) =>
      `import type { ModelResponseSnapshot } from "ohbaby-agent"; declare const value: ModelResponseSnapshot; void value.${name};`,
  ),
  'import type { ModelMessage } from "ohbaby-agent"; const value: ModelMessage = { role: "assistant", tool_calls: [] };',
  'import type { ModelMessage } from "ohbaby-agent"; const value: ModelMessage = { role: "tool", content: "x", callId: "c", tool_call_id: "c" };',
  'import type { ModelMessage } from "ohbaby-agent"; const value: ModelMessage = { role: "function", content: "x", name: "f" };',
  'import type { ModelMessage } from "ohbaby-agent"; const value: ModelMessage = { role: "assistant", function_call: { name: "f", arguments: "{}" } };',
  'import type { ModelMessage } from "ohbaby-agent"; const value: ModelMessage = { role: "assistant", reasoning_content: "x" };',
  'import type { ModelMessage } from "ohbaby-agent"; const value: ModelMessage = { role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] };',
  'import type { ModelToolDefinition } from "ohbaby-agent"; declare const value: ModelToolDefinition; void value.function;',
  'import type { ModelToolDefinition } from "ohbaby-agent"; declare const value: ModelToolDefinition; void value.type;',
  'import type { ModelToolCall } from "ohbaby-agent"; declare const value: ModelToolCall; void value.id;',
  'import type { ModelToolCall } from "ohbaby-agent"; declare const value: ModelToolCall; void value.function;',
  'import type { ModelToolCall } from "ohbaby-agent"; declare const value: ModelToolCall; void value.type;',
  ...["llm:complete", "llm:delta"].map(
    (type) =>
      `import type { AgentRunResult } from "ohbaby-agent"; type E<T> = T extends AsyncIterable<infer V> ? V : never; declare const event: Extract<E<Extract<AgentRunResult, { mode: "stream" }>["events"]>, { type: "${type}" }>; void event.completeMessage;`,
  ),
];

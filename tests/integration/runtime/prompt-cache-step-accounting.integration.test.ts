import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UiEvent, UiPromptCacheUsage } from "ohbaby-sdk";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
  readTokenUsageMetadata,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import { createInMemoryRunLedger } from "../../../packages/ohbaby-agent/src/runtime/run-ledger/index.js";
import { createInProcessUiBackendClient } from "../../../packages/ohbaby-agent/src/adapters/ui-inprocess.js";
import type {
  LLMClientInstance,
  TokenUsage,
} from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../../packages/ohbaby-agent/src/services/interface-providers/index.js";

type ProviderScript =
  | readonly InterfaceProviderStreamEvent[]
  | ((
      request: InterfaceProviderRequest,
    ) => AsyncIterable<InterfaceProviderStreamEvent>);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function usage(inputTokens: number, cacheRead?: number): TokenUsage {
  return {
    inputTokens,
    outputTokens: 10,
    totalTokens: inputTokens + 10,
    ...(cacheRead === undefined
      ? {}
      : {
          inputBreakdown: {
            uncached: inputTokens - cacheRead,
            cacheRead,
            cacheWrite: 0,
            observed: { cacheRead: true, cacheWrite: false },
          },
        }),
  };
}

function toolStep(
  tokenUsage?: TokenUsage,
  name = "list",
): InterfaceProviderStreamEvent {
  return {
    finishReason: "tool_calls",
    tokenUsage,
    toolCallDeltas: [{ id: "call_list", index: 0, name, argumentsDelta: "{}" }],
  };
}

function stop(tokenUsage?: TokenUsage): InterfaceProviderStreamEvent {
  return { finishReason: "stop", textDelta: "Done.", tokenUsage };
}

async function fixture(scripts: readonly ProviderScript[]) {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-cache-steps-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let scriptIndex = 0;
  let runIndex = 0;
  const requests: InterfaceProviderRequest[] = [];
  const llmClient: LLMClientInstance = {
    config: {
      provider: "fake",
      model: "fake-model",
      modelProfiles: [
        {
          model: "fake-model",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
      contextWindowTokens: 1_000_000,
    },
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: {},
      isAbortError: () => false,
      async streamResponse(request) {
        requests.push(request);
        const script = scripts[scriptIndex++];
        if (script === undefined)
          throw new Error("No provider script configured");
        if (typeof script === "function") return script(request);
        return (async function* () {
          for (const event of script) yield event;
        })();
      },
    },
  };
  const runLedger = createInMemoryRunLedger();
  const bus = createBus();
  const messageManager = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  const client = createInProcessUiBackendClient({
    runLedger,
    bus,
    messageManager,
    llmClient,
    workdir: directory,
    projectDirectory: directory,
    createRunId: () => `run_${++runIndex}`,
    initialSnapshot: {
      activeSessionId: "session_1",
      permissions: [],
      runs: [],
      status: { kind: "idle" },
      sessions: [
        {
          id: "session_1",
          title: "Cache accounting",
          messages: [],
          projectRoot: directory,
          createdAt: "2026-09-15T00:00:00.000Z",
          updatedAt: "2026-09-15T00:00:00.000Z",
        },
      ],
    },
  });
  cleanups.push(() => client.dispose());
  async function cache(): Promise<UiPromptCacheUsage> {
    const events: UiEvent[] = [];
    const unsubscribe = client.subscribeEvents((event) => {
      events.push(event);
    });
    try {
      await client.executeCommand({
        argv: [],
        clientInvocationId: `status_${requests.length}`,
        commandId: "status",
        path: ["status"],
        raw: "/status",
        rawArgs: "",
        sessionId: "session_1",
        surface: "tui",
      });
    } finally {
      unsubscribe();
    }
    const event = events.findLast(
      (item) => item.type === "command.result.delivered",
    );
    if (
      event?.type !== "command.result.delivered" ||
      event.output?.kind !== "data"
    )
      throw new Error("Status data missing");
    return event.output.data.promptCacheUsage as UiPromptCacheUsage;
  }
  return {
    client,
    messageManager,
    runLedger,
    requests,
    cache,
    run: () =>
      client.submitPromptAndWait("Inspect this directory", {
        sessionId: "session_1",
      }),
  };
}

describe("final step cache accounting through the in-process runtime", () => {
  it.each([
    {
      label: "missing breakdown",
      middle: usage(2_000),
      input: 2_000,
      share: 0.7,
    },
    { label: "missing usage", middle: undefined, input: 2_000, share: 0.7 },
    {
      label: "explicit zero read",
      middle: usage(2_000, 0),
      input: 4_000,
      share: 0.35,
    },
  ])(
    "accounts trusted steps around $label",
    async ({ middle, input, share }) => {
      const f = await fixture([
        [toolStep(usage(1_000, 800))],
        [toolStep(middle)],
        [stop(usage(1_000, 600))],
      ]);
      const completion = await f.run();
      expect(completion.prompt.status).toBe("succeeded");
      expect(f.requests).toHaveLength(3);
      expect(await f.cache()).toEqual({
        sessionId: "session_1",
        accountedInputTokens: input,
        cacheReadTokens: 1_400,
        cacheReadShare: share,
      });
    },
  );

  it("keeps previous runs in the weighted denominator and leaves totals unchanged on an unknown run", async () => {
    const f = await fixture([
      [stop(usage(2_000, 1_000))],
      [toolStep(usage(1_000, 800))],
      [toolStep(usage(2_000))],
      [stop(usage(1_000, 600))],
      [stop(usage(5_000))],
    ]);
    await f.run();
    await f.run();
    const before = await f.cache();
    expect(before).toEqual({
      sessionId: "session_1",
      accountedInputTokens: 4_000,
      cacheReadTokens: 2_400,
      cacheReadShare: 0.6,
    });
    await f.run();
    expect(await f.cache()).toEqual(before);
  });

  it.each(["eof", "throw", "complete-then-throw"] as const)(
    "retains earlier settled steps after a later %s",
    async (failure) => {
      const f = await fixture([
        [toolStep(usage(1_000, 800))],
        async function* () {
          if (failure === "eof") {
            yield { textDelta: "unfinished", tokenUsage: usage(2_000, 2_000) };
            return;
          }
          if (failure === "complete-then-throw")
            yield stop(usage(2_000, 2_000));
          throw new Error("provider failure");
        },
      ]);
      const completion = await f.run();
      expect(completion.prompt.status).toBe("failed");
      expect(f.requests).toHaveLength(2);
      expect(await f.cache()).toEqual({
        sessionId: "session_1",
        accountedInputTokens: 1_000,
        cacheReadTokens: 800,
        cacheReadShare: 0.8,
      });
    },
  );

  it.each([false, true])(
    "settles before completion and retains accepted usage on abort (final received=%s)",
    async (acceptFinal) => {
      const started = Promise.withResolvers<void>();
      const f = await fixture([
        [toolStep(usage(1_000, 800))],
        async function* (request) {
          if (acceptFinal) yield stop(usage(2_000, 600));
          else yield { textDelta: "pending", tokenUsage: usage(2_000, 600) };
          started.resolve();
          await new Promise<void>((resolve) =>
            request.signal!.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
        },
      ]);
      const completion = f.run();
      await started.promise;
      expect(await f.cache()).toEqual({
        sessionId: "session_1",
        accountedInputTokens: 1_000,
        cacheReadTokens: 800,
        cacheReadShare: 0.8,
      });
      await f.client.abortRun("run_1");
      expect((await completion).prompt.status).toBe("cancelled");
      expect(await f.cache()).toEqual({
        sessionId: "session_1",
        accountedInputTokens: acceptFinal ? 3_000 : 1_000,
        cacheReadTokens: acceptFinal ? 1_400 : 800,
        cacheReadShare: acceptFinal ? 1_400 / 3_000 : 0.8,
      });
    },
  );

  it.each([false, true])(
    "keeps accepted child usage out of parent status (child fails=%s)",
    async (childFails) => {
      const parentTool: InterfaceProviderStreamEvent = {
        finishReason: "tool_calls",
        tokenUsage: usage(1_000, 800),
        toolCallDeltas: [
          {
            id: "delegate",
            index: 0,
            name: "subagent_run",
            argumentsDelta: JSON.stringify({
              prompt: "Inspect directory",
              description: "Inspect",
              role: "explore",
            }),
          },
        ],
      };
      const f = await fixture([
        [parentTool],
        ...(childFails
          ? [
              [toolStep(usage(10_000, 10_000))],
              async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
                throw new Error("child provider failure after settled step");
              },
            ]
          : [[stop(usage(10_000, 10_000))]]),
        [stop(usage(1_000, 600))],
      ]);
      expect((await f.run()).prompt.status).toBe("succeeded");
      expect(f.requests).toHaveLength(childFails ? 4 : 3);
      expect(f.requests[1]?.contextScopeId).toBeDefined();
      const childRun = await f.runLedger.get("run_2");
      expect(childRun).toMatchObject({
        status: childFails ? "failed" : "succeeded",
        contextScopeId: f.requests[1]?.contextScopeId,
      });
      if (!childRun) throw new Error("Missing child run");
      const childParts = (
        await f.messageManager.listBySession(childRun.sessionId, {
          contextScopeId: childRun.contextScopeId,
        })
      ).flatMap((message) => message.parts);
      expect(
        childParts
          .map((part) => readTokenUsageMetadata(part.metadata))
          .filter((sample) => sample !== undefined),
      ).toEqual([usage(10_000, 10_000)]);
      if (childFails) {
        expect(f.requests[2]?.contextScopeId).toBe(
          f.requests[1]?.contextScopeId,
        );
        expect(JSON.stringify(f.requests[3]?.messages)).toContain(
          "child provider failure after settled step",
        );
      }
      expect(await f.cache()).toEqual({
        sessionId: "session_1",
        accountedInputTokens: 2_000,
        cacheReadTokens: 1_400,
        cacheReadShare: 0.7,
      });
    },
  );

  it("counts only the final usage when multiple complete events disagree", async () => {
    const f = await fixture([[stop(usage(100, 100)), stop(usage(900, 0))]]);
    await f.run();
    expect(await f.cache()).toEqual({
      sessionId: "session_1",
      accountedInputTokens: 900,
      cacheReadTokens: 0,
      cacheReadShare: 0,
    });
  });

  it("retains a settled step when tool execution fails", async () => {
    const f = await fixture([
      [toolStep(usage(1_000, 800), "missing_tool")],
      [stop()],
    ]);
    await f.run();
    expect(await f.cache()).toEqual({
      sessionId: "session_1",
      accountedInputTokens: 1_000,
      cacheReadTokens: 800,
      cacheReadShare: 0.8,
    });
  });

  it("counts accepted usage before an output-length terminal result", async () => {
    const f = await fixture([
      [{ ...stop(usage(1_000, 800)), finishReason: "length" }],
    ]);
    const completion = await f.run();
    expect(completion.prompt.status).toBe("failed");
    expect(await f.cache()).toEqual({
      sessionId: "session_1",
      accountedInputTokens: 1_000,
      cacheReadTokens: 800,
      cacheReadShare: 0.8,
    });
  });
});

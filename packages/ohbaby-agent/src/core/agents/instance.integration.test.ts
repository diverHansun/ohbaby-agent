import { describe, expect, it, vi } from "vitest";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../services/interface-providers/index.js";
import { createBus } from "../../bus/index.js";
import { createContextManager, type ContextManager } from "../context/index.js";
import type { PreparedTurn, TokenCounter } from "../context/index.js";
import type { LLMClientInstance } from "../llm-client/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../message/index.js";
import type {
  ToolCallResult,
  ToolDefinition,
  ToolSchedulerInstance,
} from "../tool-scheduler/index.js";
import { Lifecycle } from "../lifecycle/index.js";
import { createAgentInstanceFactory } from "./instance.js";
import { createInMemoryRunLedger } from "../../runtime/run-ledger/index.js";
import { RunManager } from "../../runtime/run-manager/index.js";
import type {
  SandboxLease,
  SandboxManager,
} from "../../runtime/run-manager/index.js";
import { createInMemoryStreamBridge } from "../../runtime/stream-bridge/index.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

type TokenBudget = ReturnType<NonNullable<TokenCounter["getBudget"]>>;

function providerStream(
  events: readonly InterfaceProviderStreamEvent[],
): AsyncGenerator<InterfaceProviderStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    InterfaceProviderStreamEvent,
    void,
    unknown
  > {
    await Promise.resolve();
    for (const event of events) {
      yield event;
    }
  })();
}

function toolCallStep(index: number): InterfaceProviderStreamEvent {
  return {
    finishReason: "tool_calls",
    toolCallDeltas: [
      {
        argumentsDelta: JSON.stringify({ index }),
        id: `call_${String(index)}`,
        index: 0,
        name: "echo_context",
      },
    ],
  };
}

function createLongTaskLLMClient(input: {
  readonly requests: InterfaceProviderRequest[];
  readonly toolSteps: number;
}): LLMClientInstance<FakeSdkClient> {
  let nextStep = 0;
  return {
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      streamChatCompletion(
        request: InterfaceProviderRequest,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        input.requests.push(request);
        nextStep += 1;
        if (nextStep <= input.toolSteps) {
          return Promise.resolve(providerStream([toolCallStep(nextStep)]));
        }
        return Promise.resolve(
          providerStream([
            { finishReason: "stop", textDelta: "long subagent complete" },
          ]),
        );
      },
      isAbortError(): boolean {
        return false;
      },
    },
    config: {
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      maxTokens: 128,
      model: "fake-model",
      provider: "fake",
      temperature: 0,
    },
  };
}

function createSmallBudgetTokenCounter(): TokenCounter {
  return {
    estimateTokens(content: string): number {
      return Math.max(1, Math.ceil(content.length / 12));
    },
    getBudget(modelId, options): TokenBudget {
      const usedInputTokens = options?.usedInputTokens ?? 0;
      const contextWindowTokens = 260;
      const reservedOutputTokens = options?.requestedOutputTokens ?? 32;
      const safetyMarginTokens = options?.safetyMarginTokens ?? 16;
      const inputBudgetTokens =
        contextWindowTokens - reservedOutputTokens - safetyMarginTokens;
      const remainingInputTokens = inputBudgetTokens - usedInputTokens;
      return {
        contextWindowTokens,
        inputBudgetTokens,
        maxOutputTokens: reservedOutputTokens,
        modelId,
        remainingInputTokens,
        reservedOutputTokens,
        safetyMarginTokens,
        usageRatio: usedInputTokens / inputBudgetTokens,
        usedInputTokens,
      };
    },
    getLimit(): number {
      return 260;
    },
  };
}

function createToolScheduler(): ToolSchedulerInstance {
  return {
    cancel: vi.fn(),
    cancelAll: vi.fn(),
    execute: vi.fn(),
    executeBatch: vi.fn<ToolSchedulerInstance["executeBatch"]>(
      (input): Promise<ToolCallResult[]> =>
        Promise.resolve(
          input.calls.map((call) => {
            const index =
              typeof call.params.index === "number" ||
              typeof call.params.index === "string"
                ? call.params.index
                : "unknown";
            return {
              callId: call.callId,
              output: "tool output ".repeat(12) + `step=${String(index)}`,
              status: "success" as const,
            };
          }),
        ),
    ),
    get: vi.fn(),
    getAvailableTools: vi.fn<ToolSchedulerInstance["getAvailableTools"]>(() =>
      Promise.resolve([
        {
          category: "readonly",
          description: "Echo a large deterministic result.",
          name: "echo_context",
          parameters: {
            additionalProperties: false,
            properties: { index: { type: "number" } },
            required: ["index"],
            type: "object",
          },
          source: "builtin",
        },
      ] satisfies ToolDefinition[]),
    ),
    getCategory: vi.fn(),
    getPendingCalls: vi.fn(),
    getStatus: vi.fn(),
    register: vi.fn(),
    registerCategory: vi.fn(),
    unregister: vi.fn(),
  };
}

interface ToolSchedulerFixture {
  readonly executedCallIds: string[];
  readonly scheduler: ToolSchedulerInstance;
}

function createToolSchedulerFixture(): ToolSchedulerFixture {
  const executedCallIds: string[] = [];
  const scheduler = createToolScheduler();
  scheduler.executeBatch = vi.fn<ToolSchedulerInstance["executeBatch"]>(
    (input): Promise<ToolCallResult[]> => {
      executedCallIds.push(...input.calls.map((call) => call.callId));
      return Promise.resolve(
        input.calls.map((call) => {
          const index =
            typeof call.params.index === "number" ||
            typeof call.params.index === "string"
              ? call.params.index
              : "unknown";
          return {
            callId: call.callId,
            output: "tool output ".repeat(12) + `step=${String(index)}`,
            status: "success" as const,
          };
        }),
      );
    },
  );
  return { executedCallIds, scheduler };
}

function sandboxLease(sessionId: string): SandboxLease {
  const workdir = `/repo/${sessionId}`;
  return {
    adapterId: "host-local",
    capabilities: {
      canExecCommands: true,
      isolation: "none",
      readOnly: false,
      supportsGit: false,
    },
    containsTrustedPath: () => true,
    contextId: `context_${sessionId}`,
    leaseId: `lease_${sessionId}`,
    preflight: () =>
      Promise.resolve({
        commands: [],
        denylistHits: [],
        externalPaths: [],
        internalPaths: [],
        overallDanger: "readonly",
        sensitivePaths: [],
        shellKind: "bash",
      }),
    release: () => Promise.resolve(),
    resolveCommandContext: () => ({ cwd: workdir, kind: "host-local" }),
    resolvePath: (inputPath: string) => `${workdir}/${inputPath}`,
    resolvePathForExisting: (inputPath: string) =>
      Promise.resolve(`${workdir}/${inputPath}`),
    resolvePathForWrite: (inputPath: string) =>
      Promise.resolve(`${workdir}/${inputPath}`),
    sessionId,
    trustPath: (input) => Promise.resolve({ kind: input.kind, path: input.path }),
    trustedRoots: () => [{ kind: "workspace", path: workdir }],
    workdir,
  };
}

function sandboxManager(): SandboxManager {
  return {
    acquire(sessionId: string): Promise<SandboxLease> {
      return Promise.resolve(sandboxLease(sessionId));
    },
    release(): Promise<void> {
      return Promise.resolve();
    },
  };
}

function instrumentContextManager(manager: ContextManager): {
  readonly manager: ContextManager;
  readonly prepareCalls: number[];
  readonly successfulReductionStatuses: string[];
} {
  const prepareCalls: number[] = [];
  const successfulReductionStatuses: string[] = [];
  const originalPrepare = manager.prepareTurn.bind(manager);
  return {
    manager: {
      ...manager,
      async prepareTurn(input): Promise<PreparedTurn> {
        prepareCalls.push(prepareCalls.length + 1);
        const prepared = await originalPrepare(input);
        if (prepared.compaction?.status === "compacted") {
          successfulReductionStatuses.push(prepared.compaction.status);
        } else if (prepared.compaction?.status === "pruned") {
          successfulReductionStatuses.push(prepared.compaction.status);
        }
        return prepared;
      },
    },
    prepareCalls,
    successfulReductionStatuses,
  };
}

describe("AgentInstance long task integration", () => {
  it("runs 50+ subagent tool steps through repeated prepareTurn and compaction", async () => {
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    const requests: InterfaceProviderRequest[] = [];
    const llmClient = createLongTaskLLMClient({ requests, toolSteps: 51 });
    const baseContextManager = createContextManager({
      bus,
      compactionThresholds: {
        mask: 0.45,
        minRemainingInputTokens: 1,
        summary: 0.55,
      },
      llmClient: {
        generateSummary: () => Promise.resolve("compact long subagent history"),
      },
      memory: {
        load: () => Promise.resolve({ global: "", merged: "", project: "" }),
      },
      messageManager,
      systemPromptProvider: {
        build: () => Promise.resolve("Subagent long task integration."),
      },
      tokenCounter: createSmallBudgetTokenCounter(),
    });
    const context = instrumentContextManager(baseContextManager);
    const toolScheduler = createToolSchedulerFixture();
    const lifecycle = new Lifecycle({
      contextManager: context.manager,
      llmClient,
      messageManager,
      toolScheduler: toolScheduler.scheduler,
    });
    const runManager = new RunManager({
      createRunId: (): string => `run_${String(requests.length + 1)}`,
      lifecycle,
      policy: {
        defaults: {
          user: {
            disconnectMode: "continue",
            multitaskStrategy: "reject",
            permissionProfileId: "test",
          },
        },
      },
      runLedger: createInMemoryRunLedger(),
      sandboxManager: sandboxManager(),
      streamBridge: createInMemoryStreamBridge({ heartbeatIntervalMs: 0 }),
    });
    const instance = createAgentInstanceFactory({
      deps: {
        messageManager,
        runCoordinator: runManager,
        toolScheduler: toolScheduler.scheduler,
      },
    }).create({
      agentName: "explore",
      contextScopeId: "subagent_ac6",
      instanceId: "subagent_ac6",
      maxSteps: 60,
      modelId: "fake-model",
      parentSessionId: "parent_ac6",
      projectRoot: "/repo",
      sessionId: "child_ac6",
      type: "sub",
    });

    const result = await instance.turn({
      prompt: "Run a long bounded subagent job.",
      waitMode: "waitForCompletion",
    });

    expect(result).toMatchObject({
      finalOutput: "long subagent complete",
      success: true,
    });
    expect(context.prepareCalls.length).toBeGreaterThanOrEqual(52);
    expect(context.successfulReductionStatuses.length).toBeGreaterThanOrEqual(1);
    expect(context.successfulReductionStatuses).not.toContain("failed");
    expect(context.successfulReductionStatuses).not.toContain("inflated");
    expect(requests).toHaveLength(52);
    expect(toolScheduler.executedCallIds).toHaveLength(51);
    const scopedMessages = await messageManager.listBySession("child_ac6", {
      contextScopeId: "subagent_ac6",
    });
    const toolOutputs = scopedMessages
      .flatMap((message) => message.parts)
      .flatMap((part) =>
        part.type === "tool" && part.state.status === "completed"
          ? [part.state.output]
          : [],
      );
    expect(toolOutputs).toHaveLength(51);
    expect(toolOutputs[0]).toContain("step=1");
    expect(toolOutputs.at(-1)).toContain("step=51");
  });
});

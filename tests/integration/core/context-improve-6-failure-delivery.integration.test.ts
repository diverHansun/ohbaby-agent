import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { createContextManager } from "../../../packages/ohbaby-agent/src/core/context/index.js";
import { Lifecycle } from "../../../packages/ohbaby-agent/src/core/lifecycle/index.js";
import type { LLMClientInstance } from "ohbaby-llm";
import type { InterfaceProviderRequest } from "ohbaby-llm";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import type { ToolSchedulerInstance } from "../../../packages/ohbaby-agent/src/core/tool-scheduler/index.js";
import { InMemorySubagentExecutionStore } from "../../../packages/ohbaby-agent/src/agents/subagents/execution-store.js";
import { createSubagentResultArtifacts } from "../../../packages/ohbaby-agent/src/agents/subagents/result-artifacts.js";
import { createSubagentContinuationCoordinator } from "../../../packages/ohbaby-agent/src/agents/subagents/continuation-coordinator.js";
import { createStorage } from "../../../packages/ohbaby-agent/src/services/storage/index.js";
import { createInMemoryRunLedger } from "../../../packages/ohbaby-agent/src/runtime/run-ledger/in-memory.js";
import { InMemoryCurrentRunInputStore } from "../../../packages/ohbaby-agent/src/runtime/prompt-scheduler/current-run-inputs.js";
import { InMemoryPromptSubmissionStore } from "../../../packages/ohbaby-agent/src/runtime/prompt-scheduler/in-memory-store.js";

it("delivers a child compaction failure through the ordinary background result into the parent's admitted request", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "improve6-failure-"));
  const bus = createBus();
  const messageManager = createMessageManager({
    bus,
    store: createInMemoryMessageStore(),
  });
  const requests: InterfaceProviderRequest[] = [];
  const llmClient: LLMClientInstance<{ kind: "fake" }> = {
    config: {
      provider: "fake",
      model: "fake-model",
      apiKeyEnv: "UNUSED_FAKE_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      temperature: 0,
      maxTokens: 128,
      modelProfiles: [
        {
          model: "fake-model",
          contextWindowTokens: 100_000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
    },
    provider: {
      id: "fake",
      kind: "openai-compatible",
      client: { kind: "fake" },
      isAbortError: () => false,
      async streamResponse(request) {
        requests.push(request);
        return (async function* () {
          yield {
            textDelta: "Parent received the child error",
            finishReason: "stop" as const,
          };
        })();
      },
    },
  };
  const generateSummary = vi
    .fn()
    .mockRejectedValue(new Error("controlled child summary failure"));
  const contextManager = createContextManager({
    bus,
    messageManager,
    llmClient: { generateSummary },
    memory: {
      load: () => Promise.resolve({ global: "", project: "", merged: "" }),
    },
    systemPromptProvider: { build: () => Promise.resolve("stable prompt") },
    tokenCounter: {
      estimateTokens: (content) => content.length,
      getLimit: () => 100_000,
    },
  });
  const lifecycle = new Lifecycle({
    contextManager,
    messageManager,
    llmClient,
    toolScheduler: {
      executeBatch: vi.fn(),
    } as unknown as ToolSchedulerInstance,
  });
  const executions = new InMemorySubagentExecutionStore();
  const runLedger = createInMemoryRunLedger();
  await runLedger.createPending({
    runId: "parent-run",
    sessionId: "parent",
    triggerSource: "user",
  });
  await runLedger.markRunning("parent-run");
  const inputs = new InMemoryCurrentRunInputStore({
    runLedger,
    messageManager,
    promptStore: new InMemoryPromptSubmissionStore(),
  });
  const lookup = {
    executionId: "execution",
    parentSessionId: "parent",
    requesterScopeId: "primary",
  };
  await executions.accept({
    ...lookup,
    requestId: "background-call",
    requesterRunId: "parent-run",
    rootRunId: "parent-run",
    rootSessionId: "parent",
    subagentId: "child",
    mode: "background",
    prompt: "continue child",
    createdAt: 1,
  });
  await executions.bindChild(
    lookup,
    { sessionId: "child", contextScopeId: "child-scope" },
    2,
  );
  const artifacts = createSubagentResultArtifacts({
    store: executions,
    storage: createStorage({ rootDir }),
    rootDir,
    sessionExists: () => Promise.resolve(true),
  });
  const coordinator = createSubagentContinuationCoordinator({
    executions,
    inputs,
    prepareResult: (execution, signal) =>
      artifacts.prepare(execution, { signal }),
    collectFacts: async () => {
      throw new Error("Terminal child must not require running facts");
    },
  });
  try {
    for (let group = 0; group < 8; group++) {
      for (const role of ["user", "assistant"] as const) {
        const message = await messageManager.createMessage({
          sessionId: "child",
          contextScopeId: "child-scope",
          role,
          agent: "build",
        });
        await messageManager.appendPart(message.id, {
          type: "text",
          text: `old child ${group} ` + "x".repeat(10_000),
        });
        if (role === "assistant")
          await messageManager.updateMessage(message.id, { finish: "stop" });
      }
    }
    const last = await messageManager.createMessage({
      sessionId: "child",
      contextScopeId: "child-scope",
      role: "user",
      agent: "build",
    });
    await messageManager.appendPart(last.id, {
      type: "text",
      text: "Latest child task",
    });
    const childLoop = lifecycle.run({
      sessionId: "child",
      contextScopeId: "child-scope",
      isSubagent: true,
      runId: "child-run",
      directory: rootDir,
      modelId: "fake-model",
    });
    let childNext = await childLoop.next();
    while (!childNext.done) childNext = await childLoop.next();
    expect(childNext.value).toMatchObject({
      success: false,
      terminalReason: "context_compaction_failed",
    });
    expect(generateSummary).toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    await executions.finish(lookup, {
      status: "failed",
      error: childNext.value.finalResponse,
      reason: childNext.value.terminalReason,
      completedAt: 3,
    });
    const parentLoop = lifecycle.run({
      sessionId: "parent",
      runId: "parent-run",
      directory: rootDir,
      modelId: "fake-model",
      currentRunInputs: coordinator.createPort({
        sessionId: "parent",
        runId: "parent-run",
      }),
    });
    let parentNext = await parentLoop.next();
    while (!parentNext.done) parentNext = await parentLoop.next();
    expect(parentNext.value).toMatchObject({
      success: true,
      finalResponse: "Parent received the child error",
    });
    expect(requests).toHaveLength(1);
    const wire = JSON.stringify(requests[0].messages);
    expect(wire).toContain("Runtime subagent result");
    expect(wire).toContain("status: failed");
    expect(wire).toContain("context_compaction_failed");
    expect(wire).toContain(childNext.value.finalResponse);
    expect(wire).not.toContain("old child 0");
    expect((await executions.get(lookup))?.delivery).toMatchObject({
      state: "processed",
    });
    const history = await messageManager.listBySession("parent");
    expect(
      history.some(
        (message) => message.info.runtimeInput?.kind === "subagent-result",
      ),
    ).toBe(true);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

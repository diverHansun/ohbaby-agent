import { expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { AgentManager } from "../../agents/index.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../../core/message/index.js";
import { createPermissionState } from "../../permission/index.js";
import { SkillRegistry } from "../../skill/index.js";
import type {
  LLMClientInstance,
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "ohbaby-llm";

function fakeLlmClient(
  requests: InterfaceProviderRequest[],
): LLMClientInstance {
  return {
    config: {
      provider: "fixture",
      model: "shared-name",
      interfaceProvider: "openai-compatible",
      baseUrl: "https://fixture.invalid",
      maxTokens: 128,
      modelProfiles: [
        {
          model: "shared-name",
          contextWindowTokens: 128000,
          reasoningCapabilities: {
            mode: "none",
            wire: "none",
            supportsDisabled: true,
          },
        },
      ],
    },
    provider: {
      id: "fixture",
      kind: "openai-compatible",
      client: {},
      isAbortError: () => false,
      streamResponse(
        request,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        requests.push(request);
        const messages = JSON.stringify(request.messages);
        return Promise.resolve(
          (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            if (messages.includes("Task: explore")) {
              yield await Promise.resolve({
                finishReason: "stop" as const,
                textDelta: "child result",
              });
            } else if (
              messages.includes("child result") ||
              // The background spawn receipt; the result arrives later.
              JSON.stringify(request.messages.at(-1)).includes("execution_id")
            ) {
              yield await Promise.resolve({
                finishReason: "stop" as const,
                textDelta: "parent done",
              });
            } else {
              yield await Promise.resolve({
                finishReason: "tool_calls" as const,
                toolCallDeltas: [
                  {
                    id: "call-child",
                    index: 0,
                    name: "agent",
                    argumentsDelta: JSON.stringify({
                      action: "spawn",
                      description: "child",
                      role: "explore",
                      prompt: "Inspect this task",
                    }),
                  },
                ],
              });
            }
          })(),
        );
      },
    },
  };
}

it("pins child provider requests to the parent's active RunModel across session selection changes", async () => {
  const { createUiRuntimeComposition: createRuntime } =
    await import("./composition.js");
  const { createRunModel } = await import("./run-model.js");
  const bus = createBus();
  const aRequests: InterfaceProviderRequest[] = [];
  const bRequests: InterfaceProviderRequest[] = [];
  const aClient = fakeLlmClient(aRequests);
  const bClient = fakeLlmClient(bRequests);
  const a = createRunModel("entry-a", {
    ...aClient,
    config: { ...aClient.config, baseUrl: "https://a.invalid/v1" },
  });
  const b = createRunModel("entry-b", {
    ...bClient,
    config: { ...bClient.config, baseUrl: "https://b.invalid/v1" },
  });
  // The selected model is already B when the frozen A turn starts.
  const runtime = await createRuntime({
    bus,
    resolveRunModel: () => Promise.resolve(b),
    agentManager: new AgentManager(),
    messageManager: createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    }),
    permissionState: createPermissionState({
      bus,
      initialLevel: "full-access",
    }),
    skillRegistry: new SkillRegistry(),
    goalExecutionControl: { interruptGoalExecution: () => Promise.resolve() },
    workdir: process.cwd(),
  });
  try {
    const first = await runtime.startSession({
      runModel: a,
      agentName: "build",
      projectRoot: process.cwd(),
      prompt: "Delegate two tasks",
      sessionId: "parent-a",
    });
    for await (const event of first.events) void event;
    await vi.waitFor(() => {
      expect(
        aRequests.some((request) =>
          JSON.stringify(request.messages).includes("Task: explore"),
        ),
      ).toBe(true);
    });
    expect(bRequests).toHaveLength(0);
    const second = await runtime.startSession({
      runModel: b,
      agentName: "build",
      projectRoot: process.cwd(),
      prompt: "Delegate two more tasks",
      sessionId: "parent-b",
    });
    for await (const event of second.events) void event;
    await vi.waitFor(() => {
      expect(
        bRequests.some((request) =>
          JSON.stringify(request.messages).includes("Task: explore"),
        ),
      ).toBe(true);
    });
  } finally {
    await runtime.dispose();
  }
});

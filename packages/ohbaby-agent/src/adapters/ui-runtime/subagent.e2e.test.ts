import { describe, expect, it } from "vitest";
import { AgentManager } from "../../agents/index.js";
import { createBus } from "../../bus/index.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { createPermissionState } from "../../permission/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../services/interface-providers/index.js";
import { createInMemorySessionManager } from "../../services/session/index.js";
import { SkillRegistry } from "../../skill/index.js";
import { createUiRuntimeComposition } from "./composition.js";

interface FakeSdkClient {
  readonly kind: "fake";
}

function createProviderStream(
  events: readonly InterfaceProviderStreamEvent[],
): AsyncGenerator<InterfaceProviderStreamEvent, void, unknown> {
  return (async function* (): AsyncGenerator<
    InterfaceProviderStreamEvent,
    void,
    unknown
  > {
    for (const event of events) {
      yield await Promise.resolve(event);
    }
  })();
}

function subagentRunEvent(): InterfaceProviderStreamEvent {
  return {
    finishReason: "tool_calls",
    toolCallDeltas: [
      {
        argumentsDelta: JSON.stringify({
          description: "Explore first e2e",
          mode: "foreground",
          prompt: "Find the first e2e target",
          role: "explore",
        }),
        id: "call_subagent_run_1",
        index: 0,
        name: "subagent_run",
      },
      {
        argumentsDelta: JSON.stringify({
          description: "Explore second e2e",
          mode: "foreground",
          prompt: "Find the second e2e target",
          role: "explore",
        }),
        id: "call_subagent_run_2",
        index: 1,
        name: "subagent_run",
      },
    ],
  };
}

function fakeLlmClient(
  requests: InterfaceProviderRequest[],
): LLMClientInstance<FakeSdkClient> {
  return {
    config: {
      apiKeyEnv: "FAKE_API_KEY",
      baseUrl: "https://example.invalid/v1",
      interfaceProvider: "openai-compatible",
      maxTokens: 128,
      model: "fake-model",
      provider: "fake",
      temperature: 0,
    },
    provider: {
      client: { kind: "fake" },
      id: "fake",
      kind: "openai-compatible",
      isAbortError(): boolean {
        return false;
      },
      streamChatCompletion(
        request,
      ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
        requests.push(request);
        const messages = JSON.stringify(request.messages);
        if (messages.includes("Task: explore")) {
          if (messages.includes("Find the second e2e target")) {
            return Promise.resolve(
              createProviderStream([
                { finishReason: "stop", textDelta: "child second result" },
              ]),
            );
          }
          return Promise.resolve(
            createProviderStream([
              { finishReason: "stop", textDelta: "child first result" },
            ]),
          );
        }
        if (
          messages.includes("child first result") &&
          messages.includes("child second result")
        ) {
          return Promise.resolve(
            createProviderStream([
              { finishReason: "stop", textDelta: "parent final result" },
            ]),
          );
        }
        if (messages.includes("Delegate subagent e2e")) {
          return Promise.resolve(createProviderStream([subagentRunEvent()]));
        }
        return Promise.reject(new Error("No fake LLM response configured"));
      },
    },
  };
}

describe("subagent runtime e2e", () => {
  it("runs concurrent foreground subagents through isolated instance contexts in one child session", async () => {
    const bus = createBus();
    const workdir = process.cwd();
    const messageManager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    const sessionManager = createInMemorySessionManager({
      bus,
      createSessionId: () => "session_child",
      messageCleaner: {
        removeMessages(sessionId) {
          return messageManager.removeMessages(sessionId);
        },
      },
      now: () => 1,
    });
    const requests: InterfaceProviderRequest[] = [];
    const composition = await createUiRuntimeComposition({
      agentManager: new AgentManager(),
      bus,
      createSubagentId: (() => {
        let next = 1;
        return () => `subagent_e2e_${String(next++)}`;
      })(),
      llmClient: fakeLlmClient(requests),
      mcpManager: { getAllTools: () => Promise.resolve([]) },
      messageManager,
      permissionState: createPermissionState({ bus }),
      sessionManager,
      skillRegistry: new SkillRegistry({
        loader: {
          loadContent: () => Promise.reject(new Error("No skills loaded")),
          scan: () => Promise.resolve(new Map()),
        },
      }),
      workdir,
    });

    const result = await composition.startSession({
      agentName: "build",
      projectRoot: workdir,
      prompt: "Delegate subagent e2e",
      sessionId: "session_parent",
    });
    await expect(
      composition.runManager.waitForCompletion(result.runId),
    ).resolves.toMatchObject({ status: "succeeded" });

    const parentMessages = await messageManager.listBySession("session_parent");
    const childMessages = await messageManager.listBySession("session_child", {
      contextScopeId: "subagent_e2e_1",
    });
    const secondChildMessages = await messageManager.listBySession(
      "session_child",
      {
        contextScopeId: "subagent_e2e_2",
      },
    );
    const allChildMessages =
      await messageManager.listBySession("session_child");
    const scopedOutMessages = await messageManager.listBySession(
      "session_child",
      {
        contextScopeId: "missing_scope",
      },
    );
    const firstChildText = JSON.stringify(childMessages);
    const secondChildText = JSON.stringify(secondChildMessages);
    const parentText = JSON.stringify(parentMessages);

    expect(parentText).toContain("subagent_id: subagent_e2e_1");
    expect(parentText).toContain("subagent_id: subagent_e2e_2");
    expect(parentText).toContain("session_id: session_child");
    expect(parentText).toContain("context_scope_id: subagent_e2e_1");
    expect(parentText).toContain("context_scope_id: subagent_e2e_2");
    expect(parentText).toContain("parent final result");
    expect(firstChildText).toContain("Find the first e2e target");
    expect(firstChildText).toContain("child first result");
    expect(secondChildText).toContain("Find the second e2e target");
    expect(secondChildText).toContain("child second result");
    expect(allChildMessages).toHaveLength(
      childMessages.length + secondChildMessages.length,
    );
    expect(scopedOutMessages).toHaveLength(0);
    expect(requests).toHaveLength(4);
  });
});

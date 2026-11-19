import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentManager, createPersistentUiBackendClient } from "ohbaby-agent";
import { createOpenAICompatibleProvider } from "ohbaby-llm";
import type { UiMessage } from "ohbaby-sdk";
import { expect, it, vi } from "vitest";
import { AgentRegistry } from "../../../../packages/ohbaby-agent/src/agents/registry.js";
import { closeDatabase } from "../../../../packages/ohbaby-agent/src/services/database/index.js";

const partial = "text from the interrupted attempt";
const answer = "text from the completed retry";
const mainPrompt = "Retry the main model step";
const sidePrompt = "Retry the Side Chat model step";
const childPrompt = "Retry the child model step";

function chatChunk(
  delta: Record<string, unknown>,
  finishReason: "stop" | "tool_calls" | null,
): string {
  return `data: ${JSON.stringify({
    id: "retry-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function withRetryBackend(
  {
    targetPrompt,
    childTimeoutMs,
  }: { targetPrompt: string; childTimeoutMs?: number },
  exercise: (
    backend: ReturnType<typeof createPersistentUiBackendClient>,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "ohbaby-step-retry-"));
  const workdir = join(root, "workspace");
  await mkdir(workdir);
  vi.stubEnv("OHBABY_HOME", join(root, "home"));
  vi.stubEnv("OHBABY_STORAGE_ROOT", join(root, "storage"));
  const attempts: string[] = [];
  let dispatched = false;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      response.setHeader("content-type", "text/event-stream");
      if (body.includes("Write a short conversation title")) {
        response.end(chatChunk({ content: "Step retry" }, "stop"));
      } else if (
        body.includes(targetPrompt) &&
        (targetPrompt !== childPrompt ||
          body.includes("You are a focused subagent"))
      ) {
        attempts.push(body);
        if (attempts.length === 1) {
          const text = chatChunk({ content: partial }, null);
          if (childTimeoutMs === undefined) {
            response.end(text);
          } else {
            response.setHeader("retry-after-ms", "10000");
            response.end(
              text +
                'data: {"error":{"code":"server_error","type":"server_error","message":"Retry fixture"}}\n\n',
            );
          }
        } else {
          response.end(chatChunk({ content: answer }, "stop"));
        }
      } else if (body.includes("Delegate the retry test") && !dispatched) {
        dispatched = true;
        response.end(
          chatChunk(
            {
              tool_calls: [
                {
                  index: 0,
                  id: "dispatch",
                  type: "function",
                  function: {
                    name: "agent",
                    arguments: JSON.stringify({
                      action: "spawn",
                      role: "generic",
                      prompt: childPrompt,
                      timeout_ms: childTimeoutMs,
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          ),
        );
      } else {
        response.end(chatChunk({ content: "Parent acknowledgement" }, "stop"));
      }
    });
  });

  let backend: ReturnType<typeof createPersistentUiBackendClient> | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No model server port");
    const baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
    backend = createPersistentUiBackendClient({
      workdir,
      dbPath: join(root, "test.db"),
      enableSnapshots: false,
      startupSessionMode: { type: "fresh" },
      llmClient: {
        provider: createOpenAICompatibleProvider({
          id: "fixture",
          apiKey: "fixture",
          baseUrl,
        }),
        config: {
          provider: "fixture",
          model: "fixture",
          baseUrl,
          interfaceProvider: "openai-compatible",
          maxTokens: 128,
          modelProfiles: [
            {
              model: "fixture",
              contextWindowTokens: 128000,
              reasoningCapabilities: {
                mode: "none",
                wire: "none",
                supportsDisabled: true,
              },
            },
          ],
        },
      },
      agentManager: new AgentManager({
        registry: new AgentRegistry({
          configLoader: (): { agents: Record<string, never> } => ({
            agents: {},
          }),
          builtinAgents: [
            {
              name: "main",
              mode: "primary",
              description: "Main",
              default: true,
              tools: { include: ["agent"] },
            },
            {
              name: "generic",
              mode: "subagent",
              description: "Child",
              tools: { include: [] },
            },
          ],
        }),
      }),
    });
    await backend.initialize();
    await exercise(backend);
    expect(attempts).toHaveLength(childTimeoutMs === undefined ? 2 : 1);
    if (childTimeoutMs === undefined)
      expect(attempts[1]).not.toContain(partial);
  } finally {
    try {
      await backend?.dispose();
    } finally {
      closeDatabase();
      server.close();
      server.closeAllConnections();
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }
}

function expectRestartedStep(messages: readonly UiMessage[]): void {
  const assistants = messages.filter((message) => message.role === "assistant");
  expect(assistants).toHaveLength(2);
  const [interrupted, completed] = assistants;
  expect(interrupted).toMatchObject({
    finishReason: "error",
    modelRequests: [
      {
        messageId: interrupted.id,
        purpose: "agent-step",
        step: 1,
        attempt: 1,
        outcome: "error",
        retryScheduled: true,
      },
    ],
  });
  expect(completed).toMatchObject({
    finishReason: "stop",
    modelRequests: [
      {
        messageId: completed.id,
        purpose: "agent-step",
        step: 1,
        attempt: 2,
        outcome: "success",
      },
    ],
  });
  expect(interrupted.parts).toContainEqual(
    expect.objectContaining({ type: "text", text: partial }),
  );
  expect(completed.parts).toContainEqual(
    expect.objectContaining({ type: "text", text: answer }),
  );
  expect(interrupted.id).not.toBe(completed.id);
  expect(interrupted.modelRequests?.[0]?.requestId).not.toBe(
    completed.modelRequests?.[0]?.requestId,
  );
}

it.each([
  { entry: "main session", targetPrompt: mainPrompt },
  { entry: "Side Chat", targetPrompt: sidePrompt },
])(
  "retries an interrupted model step in $entry",
  async ({ entry, targetPrompt }) => {
    await withRetryBackend({ targetPrompt }, async (backend) => {
      const { id: mainSessionId } = await backend.createSession();
      if (entry === "Side Chat") {
        const initial = await backend.submitPromptAndWait(
          "Start the main session",
          {
            sessionId: mainSessionId,
          },
        );
        expect(initial.prompt).toMatchObject({ status: "succeeded" });
      }
      const sessionId =
        entry === "Side Chat"
          ? (await backend.openSideChat({ mainSessionId })).sideChatId
          : mainSessionId;
      const { prompt } = await backend.submitPromptAndWait(targetPrompt, {
        sessionId,
      });
      expect(prompt).toMatchObject({ status: "succeeded" });
      assert.ok(backend.getSessionHistory);
      const history = await backend.getSessionHistory({ sessionId });
      expectRestartedStep(
        history.messages.filter((message) => message.runId === prompt.runId),
      );
    });
  },
);

async function runChild(
  backend: ReturnType<typeof createPersistentUiBackendClient>,
): Promise<Awaited<ReturnType<typeof backend.getSubagentExecutionView>>> {
  const { id: rootSessionId } = await backend.createSession();
  const { prompt } = await backend.submitPromptAndWait(
    "Delegate the retry test",
    {
      sessionId: rootSessionId,
    },
  );
  expect(prompt).toMatchObject({ status: "succeeded" });

  const executionId = await vi.waitFor(
    async () => {
      const { executions } = await backend.listSubagentExecutions({
        rootSessionId,
      });
      expect(executions).toHaveLength(1);
      const [execution] = executions;
      expect(["queued", "running"]).not.toContain(execution.status);
      return execution.executionId;
    },
    { timeout: 5_000 },
  );
  return backend.getSubagentExecutionView({ rootSessionId, executionId });
}

it("retries an interrupted subagent model step without a parent follow-up", async () => {
  await withRetryBackend({ targetPrompt: childPrompt }, async (backend) => {
    const result = await runChild(backend);
    expect(result.execution.status).toBe("completed");
    expect(result.output).toBe(answer);
    expectRestartedStep(result.messages);
  });
});

it("ends a child execution when its deadline expires in step retry backoff", async () => {
  await withRetryBackend(
    { targetPrompt: childPrompt, childTimeoutMs: 2_000 },
    async (backend) => {
      const result = await runChild(backend);
      expect(result.execution.status).toBe("timed_out");
      const failed = result.messages.find(
        (message) => message.role === "assistant",
      );
      expect(failed).toMatchObject({
        finishReason: "error",
        modelRequests: [
          {
            purpose: "agent-step",
            step: 1,
            attempt: 1,
            outcome: "error",
            retryScheduled: true,
          },
        ],
      });
    },
  );
});

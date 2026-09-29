import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UiPermissionEvent, UiPermissionRequest } from "ohbaby-sdk";
import { createBus } from "../../../packages/ohbaby-agent/src/bus/index.js";
import { AgentManager } from "../../../packages/ohbaby-agent/src/agents/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import type { LLMClientInstance } from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import { createInMemorySessionManager } from "../../../packages/ohbaby-agent/src/services/session/index.js";
import { createInProcessUiBackendClient } from "../../../packages/ohbaby-agent/src/adapters/ui-inprocess.js";
import type { InterfaceProviderStreamEvent } from "../../../packages/ohbaby-agent/src/services/interface-providers/index.js";

function tool(
  name: string,
  params: Record<string, unknown>,
  id: string,
): InterfaceProviderStreamEvent {
  return {
    finishReason: "tool_calls",
    toolCallDeltas: [
      { index: 0, id, name, argumentsDelta: JSON.stringify(params) },
    ],
  };
}

describe("actual in-process child approvals", () => {
  it("aggregates a real child approval at root, accepts it once, and completes the original prompt", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "ohbaby-inprocess-permission-"),
    );
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    let sessionSequence = 0;
    const sessionManager = createInMemorySessionManager({
      bus,
      createSessionId: () => (sessionSequence++ === 0 ? "root" : "child"),
      messageCleaner: messageManager,
    });
    const root = await sessionManager.create(directory, {
      agentName: "build",
      title: "Root",
    });
    let primaryStep = 0;
    let childStep = 0;
    const llmClient: LLMClientInstance = {
      config: {
        apiKeyEnv: "FAKE_API_KEY",
        baseUrl: "https://example.invalid/v1",
        interfaceProvider: "openai-compatible",
        maxTokens: 128,
        model: "fake-model",
        provider: "openai",
        temperature: 0,
      },
      provider: {
        client: {},
        id: "fake",
        kind: "openai-compatible",
        isAbortError: () => false,
        async streamResponse(request) {
          const child = JSON.stringify(request.messages).includes(
            "Task: generic",
          );
          const step = child ? childStep++ : primaryStep++;
          const event =
            step > 0
              ? {
                  finishReason: "stop" as const,
                  textDelta: child ? "child complete" : "parent complete",
                }
              : child
                ? tool(
                    "bash",
                    {
                      command:
                        "node -e \"require('node:fs').appendFileSync('permission-count.txt', 'x')\"",
                    },
                    "child-call",
                  )
                : tool(
                    "subagent_run",
                    {
                      role: "generic",
                      prompt: "Run one harmless local command",
                      mode: "foreground",
                      description: "Permission child",
                    },
                    "delegate-call",
                  );
          return (async function* () {
            yield event;
          })();
        },
      },
    };
    const client = createInProcessUiBackendClient({
      bus,
      agentManager: new AgentManager(),
      llmClient,
      messageManager,
      sessionManager,
      workdir: directory,
      projectDirectory: directory,
      initialSnapshot: {
        activeSessionId: root.id,
        sessions: [
          {
            id: root.id,
            title: root.title,
            projectRoot: directory,
            createdAt: new Date(root.createdAt).toISOString(),
            updatedAt: new Date(root.updatedAt).toISOString(),
            messages: [],
          },
        ],
        runs: [],
        permissions: [],
        status: { kind: "idle" },
      },
    });
    const events: UiPermissionEvent[] = [];
    let receive!: (request: UiPermissionRequest) => void;
    const requested = new Promise<UiPermissionRequest>((resolve) => {
      receive = resolve;
    });
    const unsubscribe = client.subscribePermissionEvents((event) => {
      events.push(event);
      if (event.type === "permission.requested") receive(event.request);
    });
    const deliveryErrors: unknown[] = [];
    const unsubscribeFailing = client.subscribePermissionEvents(
      (event) => {
        if (event.type === "permission.resolved")
          throw new Error("local subscriber delivery failed");
      },
      (error) => {
        deliveryErrors.push(error);
      },
    );
    try {
      const receipt = await client.submitPromptAccepted(
        "Delegate the permission test",
        { sessionId: "root" },
      );
      const request = await requested;
      expect(request).toMatchObject({
        sessionId: "child",
        rootSessionId: "root",
        callId: "child-call",
      });
      const baseline = await client.getPermissionSnapshot({
        rootSessionId: "root",
      });
      expect(baseline.requests).toEqual([request]);
      expect(baseline.permissionRevision).toBe(1);
      await expect(
        client.getPermissionSnapshot({ rootSessionId: "child" }),
      ).rejects.toThrow();
      const context = {
        permissionEpoch: baseline.permissionEpoch,
        rootSessionId: "root",
      };
      await Promise.all([
        client.respondPermission(
          request.id,
          { choiceId: "allow_once" },
          context,
        ),
        client.respondPermission(
          request.id,
          { choiceId: "allow_once" },
          context,
        ),
      ]);
      const completion = await client.waitForPrompt(receipt.promptId);
      expect(completion.prompt.status).toBe("succeeded");
      expect(
        await readFile(join(directory, "permission-count.txt"), "utf8"),
      ).toBe("x");
      expect(
        await client.getPermissionSnapshot({ rootSessionId: "root" }),
      ).toMatchObject({ permissionRevision: 2, requests: [] });
      expect(events.map((event) => event.type)).toEqual([
        "permission.requested",
        "permission.resolved",
      ]);
      expect(deliveryErrors).toHaveLength(1);
      const snapshot = await client.getSnapshot();
      const primary = snapshot.runs.find((run) => run.sessionId === "root");
      expect(primary?.id).toBeTruthy();
      expect(request.runId).not.toBe(primary?.id);
      expect(
        JSON.stringify(
          snapshot.sessions.find((session) => session.id === "root")?.messages,
        ),
      ).toContain("parent complete");
    } finally {
      unsubscribe();
      unsubscribeFailing();
      await client.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

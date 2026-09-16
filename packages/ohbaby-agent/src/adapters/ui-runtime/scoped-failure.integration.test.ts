import { APIUserAbortError } from "openai";
import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import { createContextManager } from "../../core/context/index.js";
import { Lifecycle } from "../../core/lifecycle/index.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import type { ToolSchedulerInstance } from "../../core/tool-scheduler/index.js";
import type {
  InterfaceProviderRequest,
  InterfaceProviderStreamEvent,
} from "../../services/interface-providers/types.js";
import {
  RunManager,
  type RunStepUsageObserver,
} from "../../runtime/run-manager/index.js";
import { createInMemoryRunLedger } from "../../runtime/run-ledger/index.js";
import {
  createInMemoryStreamBridge,
  END_SENTINEL,
  HEARTBEAT_SENTINEL,
  type StreamBridgeEvent,
} from "../../runtime/stream-bridge/index.js";
import { createInMemoryUiStateStore } from "../ui-state/index.js";
import { createHostLocalSandboxManager } from "./host-local-environment.js";
import { startRunStreamProjection } from "./run-stream-adapter.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Normalized provider-event injection isolates the scope/Worker handoff from
// protocol parsing, which is exercised separately by protocol-terminal tests.
describe("failed child scope and primary run handoff", () => {
  it.each(["transport", "provider-abort", "cancel"] as const)(
    "keeps %s child history, usage and termination out of the primary run",
    async (failure) => {
      const bus = createBus();
      const messageManager = createMessageManager({
        bus,
        store: createInMemoryMessageStore(),
      });
      for (const contextScopeId of [undefined, "child"]) {
        const user = await messageManager.createMessage({
          sessionId: "shared",
          role: "user",
          agent: "build",
          contextScopeId,
        });
        await messageManager.appendPart(user.id, {
          type: "text",
          text: contextScopeId ? "child question" : "primary question",
        });
      }
      const contextManager = createContextManager({
        bus,
        messageManager,
        llmClient: { generateSummary: () => Promise.resolve("unused") },
        memory: {
          load: () => Promise.resolve({ global: "", project: "", merged: "" }),
        },
        systemPromptProvider: { build: () => Promise.resolve("system") },
        tokenCounter: {
          estimateTokens: (text) => text.length,
          getLimit: () => 100000,
        },
      });
      const calibration = vi.spyOn(contextManager, "updateCalibrationFactor");
      const primaryWaiting = deferred();
      const childFinished = deferred();
      const requests: InterfaceProviderRequest[] = [];
      const usage = { inputTokens: 20, outputTokens: 2, totalTokens: 22 };
      let primaryCalls = 0;
      let cancelChild: () => void = () => {
        throw new Error("RunManager not initialized");
      };
      const llmClient: LLMClientInstance = {
        config: {
          provider: "fixture",
          model: "fixture",
          baseUrl: "https://fixture.invalid",
          interfaceProvider: "openai-compatible",
          maxTokens: 128,
          modelProfiles: [
            {
              model: "fixture",
              contextWindowTokens: 100000,
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
          isAbortError: (error) => error instanceof APIUserAbortError,
          streamResponse(
            request,
          ): Promise<AsyncIterable<InterfaceProviderStreamEvent>> {
            requests.push(request);
            return Promise.resolve(
              (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
                if (request.contextScopeId === "child") {
                  yield await Promise.resolve({
                    textDelta: "private child fragment",
                    tokenUsage: {
                      inputTokens: 99,
                      outputTokens: 9,
                      totalTokens: 108,
                    },
                  });
                  if (failure === "cancel") {
                    cancelChild();
                    throw new APIUserAbortError();
                  }
                  if (failure === "provider-abort")
                    throw new APIUserAbortError();
                  throw Object.assign(
                    new Error("controlled transport failure"),
                    { code: "ECONNRESET" },
                  );
                }
                primaryCalls += 1;
                if (primaryCalls === 1) {
                  yield await Promise.resolve({
                    textDelta: "primary tool plan",
                    toolCallDeltas: [
                      {
                        index: 0,
                        id: "primary_call",
                        name: "lookup",
                        argumentsDelta: "{}",
                      },
                    ],
                    finishReason: "tool_calls",
                    tokenUsage: usage,
                  });
                  return;
                }
                primaryWaiting.resolve();
                await childFinished.promise;
                yield {
                  textDelta: "primary answer",
                  finishReason: "stop",
                  tokenUsage: usage,
                };
              })(),
            );
          },
        },
      };
      const executeBatch = vi
        .fn<ToolSchedulerInstance["executeBatch"]>()
        .mockResolvedValue([
          {
            callId: "primary_call",
            status: "success",
            output: "primary tool fact",
          },
        ]);
      const lifecycle = new Lifecycle({
        contextManager,
        llmClient,
        messageManager,
        toolScheduler: { executeBatch } as unknown as ToolSchedulerInstance,
      });
      const streamBridge = createInMemoryStreamBridge({
        heartbeatIntervalMs: 0,
      });
      const ledger = createInMemoryRunLedger();
      const observer = vi.fn<RunStepUsageObserver>();
      const runManager = new RunManager({
        lifecycle,
        streamBridge,
        runLedger: ledger,
        onStepUsage: observer,
        sandboxManager: createHostLocalSandboxManager(process.cwd()),
        policy: {
          defaults: {
            user: {
              permissionProfileId: "interactive",
              multitaskStrategy: "reject",
              disconnectMode: "continue",
            },
          },
        },
      });
      cancelChild = (): void => {
        runManager.cancel("child-run");
      };
      const records = new Map<string, StreamBridgeEvent[]>([
        ["primary-run", []],
        ["child-run", []],
      ]);
      const collectors = [...records].map(
        async ([runId, destination]): Promise<void> => {
          for await (const event of streamBridge.subscribe(`run/${runId}`, 0))
            if (event !== END_SENTINEL && event !== HEARTBEAT_SENTINEL)
              destination.push(event);
        },
      );
      const stateStore = createInMemoryUiStateStore({
        activeSessionId: "shared",
        permissions: [],
        runs: [],
        sessions: [
          {
            id: "shared",
            title: "test",
            messages: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        status: { kind: "idle" },
      });
      const projection = startRunStreamProjection({
        streamBridge,
        stateStore,
        runId: "primary-run",
        sessionId: "shared",
        assistantMessageId: "ui-primary",
        nextMessageId: () => "ui-primary-next",
        timestamp: () => "2026-01-01T00:00:01.000Z",
        publish: vi.fn(),
      });
      try {
        await runManager.create({
          runId: "primary-run",
          sessionId: "shared",
          directory: process.cwd(),
          modelId: "fixture",
          triggerSource: "user",
          tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        });
        await primaryWaiting.promise;
        await runManager.create({
          runId: "child-run",
          sessionId: "shared",
          contextScopeId: "child",
          isSubagent: true,
          directory: process.cwd(),
          modelId: "fixture",
          triggerSource: "user",
        });
        const child = await runManager.waitForCompletion("child-run");
        expect(child.status).toBe(
          failure === "cancel" ? "cancelled" : "failed",
        );
        expect(child.terminalReason).toBe(
          failure === "cancel" ? "cancelled" : "provider_stream_interrupted",
        );
        expect(await ledger.get("primary-run")).toMatchObject({
          status: "running",
        });
        childFinished.resolve();
        const primary = await runManager.waitForCompletion("primary-run");
        await Promise.all([...collectors, projection.done]);
        expect(primary).toMatchObject({
          status: "succeeded",
          terminalReason: "completed",
          usage: {
            inputTokens: 40,
            outputTokens: 4,
            totalTokens: 44,
            usageComplete: true,
          },
        });
        expect(await ledger.get("child-run")).toMatchObject({
          contextScopeId: "child",
          status: child.status,
        });
        expect(await ledger.get("primary-run")).toMatchObject({
          status: "succeeded",
        });
        expect(executeBatch).toHaveBeenCalledTimes(1);
        expect(observer).toHaveBeenCalledTimes(2);
        expect(observer.mock.calls.map(([event]) => event.runId)).toEqual([
          "primary-run",
          "primary-run",
        ]);
        expect(calibration).toHaveBeenCalledTimes(2);
        expect(
          calibration.mock.calls.every((call) => call[3] === undefined),
        ).toBe(true);
        const primaryRequests = requests.filter(
          (request) => request.contextScopeId === undefined,
        );
        expect(primaryRequests).toHaveLength(2);
        expect(JSON.stringify(primaryRequests)).not.toContain(
          "private child fragment",
        );
        expect(JSON.stringify(primaryRequests[1].messages)).toContain(
          "primary_call",
        );
        expect(JSON.stringify(primaryRequests[1].messages)).toContain(
          "primary tool fact",
        );
        expect(
          requests.filter((request) => request.contextScopeId === "child"),
        ).toHaveLength(1);
        const childPrepared = await contextManager.prepareTurn({
          sessionId: "shared",
          contextScopeId: "child",
          isSubagent: true,
          directory: process.cwd(),
          modelId: "fixture",
          tools: undefined,
          toolNames: [],
        });
        const childText = JSON.stringify(childPrepared.request.messages);
        expect(childText).not.toContain("primary question");
        expect(childText).not.toContain("primary_call");
        expect(childText).not.toContain("primary tool fact");
        expect(childPrepared.usage.currentTokens).toBe(
          childPrepared.sentHeuristic,
        );
        if (failure === "transport")
          expect(childText).toContain(
            "[Response interrupted: the saved text below may be incomplete.]\\nprivate child fragment",
          );
        else expect(childText).not.toContain("private child fragment");
        if (failure === "cancel")
          expect(
            childText.match(/Response cancelled by the user/g),
          ).toHaveLength(1);
        const childHistory = await messageManager.listBySession("shared", {
          contextScopeId: "child",
        });
        expect(
          childHistory
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text")
            .map((part) => part.text),
        ).toContain("private child fragment");
        const primaryEvents = records.get("primary-run") ?? [];
        const childEvents = records.get("child-run") ?? [];
        expect(
          primaryEvents.filter((event) => event.event === "run.llm.complete"),
        ).toHaveLength(2);
        expect(
          childEvents.filter((event) => event.event === "run.llm.complete"),
        ).toHaveLength(0);
        for (const [runId, status] of [
          ["primary-run", "succeeded"],
          ["child-run", child.status],
        ]) {
          expect(
            (records.get(runId) ?? []).filter(
              (event) =>
                event.event === "run.updated" &&
                (event.data as { run?: { status?: string } }).run?.status ===
                  status,
            ),
          ).toHaveLength(1);
        }
        const snapshot = await stateStore.readSnapshot();
        expect(snapshot.status.kind).toBe("idle");
        expect(snapshot.runs).toHaveLength(1);
        expect(snapshot.runs[0]).toMatchObject({
          id: "primary-run",
          terminalReason: "completed",
          status: { kind: "idle" },
        });
        expect(JSON.stringify(snapshot)).not.toContain(
          "private child fragment",
        );
        expect(JSON.stringify(snapshot)).toContain("primary answer");
      } finally {
        childFinished.resolve();
        await runManager.cancelAll();
        streamBridge.end("run/primary-run");
        streamBridge.end("run/child-run");
        await Promise.all([...collectors, projection.done]);
        calibration.mockRestore();
      }
    },
  );
});

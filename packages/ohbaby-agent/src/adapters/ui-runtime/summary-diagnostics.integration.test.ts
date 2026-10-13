import { expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import type { LLMClientInstance } from "../../core/llm-client/types.js";
import type { InterfaceProviderStreamEvent } from "../../services/interface-providers/types.js";
import {
  encodeDiagnosticEvent,
  type Logger,
} from "../../observability/logger.js";
import { createInProcessUiBackendClient } from "../ui-inprocess.js";
import type { UiEvent } from "ohbaby-sdk";

it.each([
  { hasUsage: true, retry: false },
  { hasUsage: false, retry: false },
  { hasUsage: true, retry: true },
])(
  "routes unused summary usage to diagnostics without technical UI notices ($hasUsage, $retry)",
  async ({ hasUsage, retry }) => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const logger: Logger = {
      emit(definition, input) {
        records.push(
          encodeDiagnosticEvent(
            definition,
            input,
            { roots: {} },
            "2026-10-13T00:00:00Z",
          ).record,
        );
      },
    };
    const bus = createBus();
    const messageManager = createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    });
    for (let index = 0; index < 8; index++) {
      const message = await messageManager.createMessage({
        sessionId: "diagnostic-summary",
        agent: "build",
        role: index % 2 === 0 ? "user" : "assistant",
      });
      await messageManager.appendPart(message.id, {
        type: "text",
        text: "Old history ".repeat(100),
      });
    }
    let calls = 0;
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
        async streamResponse() {
          calls++;
          await Promise.resolve();
          return (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            await Promise.resolve();
            if (hasUsage)
              yield {
                tokenUsage: {
                  inputTokens: 100,
                  outputTokens: 10,
                  totalTokens: 110,
                  reasoningTokens: 3,
                  inputBreakdown: {
                    uncached: retry ? 65 : 70,
                    cacheRead: 30,
                    cacheWrite: retry ? 5 : 0,
                    observed: { cacheRead: true, cacheWrite: retry },
                  },
                },
              };
            throw Object.assign(
              new Error("private provider response SENTINEL_SECRET"),
              retry ? { status: 503 } : {},
            );
          })();
        },
      },
    };
    const client = createInProcessUiBackendClient({
      bus,
      messageManager,
      llmClient,
      logger,
      initialSnapshot: {
        activeSessionId: "diagnostic-summary",
        permissions: [],
        runs: [],
        status: { kind: "idle" },
        sessions: [
          {
            id: "diagnostic-summary",
            title: "Existing",
            messages: [],
            createdAt: "2026-10-13T00:00:00Z",
            updatedAt: "2026-10-13T00:00:00Z",
          },
        ],
      },
    });
    const events: UiEvent[] = [];
    client.subscribeEvents((event) => events.push(event));
    try {
      const result = await client.compactSession({
        sessionId: "diagnostic-summary",
      });
      expect(result.status).toBe("failed");
      expect(calls).toBe(retry ? 2 : 1);
      expect(records).toHaveLength(calls);
      if (retry) {
        expect(records[1]).toMatchObject({
          reason: "failed",
          attempt: 2,
          cacheWriteTokens: 5,
        });
        expect(records[1].operationId).not.toBe(records[0].operationId);
        expect(records[1].compactionId).toBe(records[0].compactionId);
      }
      expect(records[0]).toMatchObject({
        event: "llm.context_summary.unused",
        reason: "failed",
        attempt: 1,
      });
      expect(records[0].operationId).toMatch(/^operation_[a-f0-9]{12}$/u);
      expect(records[0].compactionId).toMatch(/^operation_[a-f0-9]{12}$/u);
      if (hasUsage) {
        expect(records[0]).toMatchObject({
          inputTokens: 100,
          outputTokens: 10,
          totalTokens: 110,
          reasoningTokens: 3,
          cacheReadTokens: 30,
        });
      } else {
        expect(records[0]).not.toHaveProperty("inputTokens");
        expect(records[0]).not.toHaveProperty("totalTokens");
      }
      if (retry) expect(records[0]).toHaveProperty("cacheWriteTokens", 5);
      else expect(records[0]).not.toHaveProperty("cacheWriteTokens");
      expect(JSON.stringify(records)).not.toContain("SENTINEL_SECRET");
      expect(
        events.filter(
          (event) =>
            event.type === "notice.emitted" &&
            event.notice.message.includes("Context summary request"),
        ),
      ).toEqual([]);
    } finally {
      await client.dispose();
    }
  },
);

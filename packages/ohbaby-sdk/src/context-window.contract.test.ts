import { describe, expect, it } from "vitest";
import type {
  CoreAPI,
  UiContextWindowUsage,
  UiEvent,
  UiMessage,
  UiSnapshot,
} from "./index.js";

describe("context window UI contract", () => {
  it("represents session scoped context window usage in snapshots and events", () => {
    const usage: UiContextWindowUsage = {
      contextWindowRatio: 0.0384,
      contextWindowTokens: 1_000_000,
      currentTokens: 38_400,
      estimatedAt: "2026-06-06T00:00:00.000Z",
      modelId: "deepseek-v4-pro",
      sessionId: "session_1",
    };

    const snapshot: UiSnapshot = {
      activeSessionId: "session_1",
      contextWindowUsages: [usage],
      permissions: [],
      runs: [],
      sessions: [],
      status: { kind: "idle" },
    };

    const event: UiEvent = {
      type: "context.window.updated",
      usage,
    };

    expect(snapshot.contextWindowUsages).toEqual([usage]);
    expect(event).toEqual({
      type: "context.window.updated",
      usage,
    });
  });

  it("allows message lifecycle metadata for precise reasoning folding", () => {
    const message: UiMessage = {
      completedAt: "2026-06-06T00:00:01.000Z",
      createdAt: "2026-06-06T00:00:00.000Z",
      finishReason: "stop",
      id: "msg_1",
      parts: [{ text: "Thought details", type: "reasoning" }],
      role: "assistant",
      status: "completed",
      updatedAt: "2026-06-06T00:00:01.000Z",
    };

    expect(message.status).toBe("completed");
    expect(message.completedAt).toBe("2026-06-06T00:00:01.000Z");
  });

  it("exposes a query-only CoreAPI method for context window usage", async () => {
    const usage: UiContextWindowUsage = {
      contextWindowRatio: 0.04,
      contextWindowTokens: 1_000_000,
      currentTokens: 40_000,
      estimatedAt: "2026-06-06T00:00:00.000Z",
      modelId: "deepseek-v4-pro",
      sessionId: "session_1",
    };

    const core = {
      abortRun(): ReturnType<CoreAPI["abortRun"]> {
        return Promise.resolve();
      },
      compactSession(): ReturnType<CoreAPI["compactSession"]> {
        return Promise.resolve({
          sessionId: "session_1",
          status: "not-needed",
          usageAfter: {
            contextLimit: 1_000_000,
            currentTokens: 40_000,
            modelId: "deepseek-v4-pro",
            remainingTokens: 960_000,
            shouldCompress: false,
            usageRatio: 0.04,
          },
          usageBefore: {
            contextLimit: 1_000_000,
            currentTokens: 40_000,
            modelId: "deepseek-v4-pro",
            remainingTokens: 960_000,
            shouldCompress: false,
            usageRatio: 0.04,
          },
        });
      },
      executeCommand(): ReturnType<CoreAPI["executeCommand"]> {
        return Promise.resolve();
      },
      getContextWindowUsage(input: {
        readonly sessionId: string;
      }): ReturnType<CoreAPI["getContextWindowUsage"]> {
        return Promise.resolve(
          input.sessionId === usage.sessionId ? usage : null,
        );
      },
      getSnapshot(): ReturnType<CoreAPI["getSnapshot"]> {
        return Promise.resolve({
          activeSessionId: null,
          permissions: [],
          runs: [],
          sessions: [],
          status: { kind: "idle" },
        });
      },
      listCommands(): ReturnType<CoreAPI["listCommands"]> {
        return Promise.resolve({ commands: [], version: "test" });
      },
      respondInteraction(): ReturnType<CoreAPI["respondInteraction"]> {
        return Promise.resolve();
      },
      respondPermission(): ReturnType<CoreAPI["respondPermission"]> {
        return Promise.resolve();
      },
      submitPrompt(): ReturnType<CoreAPI["submitPrompt"]> {
        return Promise.resolve();
      },
    } satisfies CoreAPI;

    await expect(
      core.getContextWindowUsage({ sessionId: "session_1" }),
    ).resolves.toEqual(usage);
  });
});

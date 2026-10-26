import type { ContextModel } from "../run-model.js";
import type { ContextUsage, SummaryRequestResult } from "./types.js";
import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../message/index.js";
import { createContextManager } from "./context-manager.js";
import type { ContextLLMClient, TokenCounter } from "./types.js";

function model(entryId: string, limit: number): ContextModel {
  const tokenCounter: TokenCounter = {
    estimateTokens: (text) => text.length,
    getLimit: () => limit,
  };
  const summaryClient: ContextLLMClient = {
    generateSummary(): Promise<SummaryRequestResult> {
      throw new Error("Unexpected summary");
    },
  };
  return { entryId, tokenCounter, summaryClient };
}

describe("per-call context model", () => {
  it("uses independent windows for entries with the same provider model name", async () => {
    const large = model("large", 1_000_000);
    const small = model("small", 128_000);
    const bus = createBus();
    const manager = createContextManager({
      bus,
      messageManager: createMessageManager({
        bus,
        store: createInMemoryMessageStore(),
      }),
      systemPromptProvider: {
        build(): Promise<string> {
          return Promise.resolve("system");
        },
      },
    });
    const usage = async (
      sessionId: string,
      runModel: typeof large,
    ): Promise<ContextUsage> => {
      const context = await manager.assemble(sessionId, "/tmp", {
        isSubagent: false,
        toolNames: [],
        runModel,
      });
      return manager.getUsage({
        context,
        modelId: "same-name",
        tools: [],
        runModel,
      });
    };
    const [a, b] = await Promise.all([usage("a", large), usage("b", small)]);
    expect(a.contextLimit).toBe(1_000_000);
    expect(b.contextLimit).toBe(128_000);
  });
});

it("resets calibration when the same entry receives a new model configuration", async () => {
  const bus = createBus();
  const manager = createContextManager({
    bus,
    messageManager: createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    }),
    systemPromptProvider: {
      build(): Promise<string> {
        return Promise.resolve(
          "system prompt with enough tokens to measure calibration",
        );
      },
    },
  });
  const original = model("entry", 128_000);
  const changed = model("entry", 64_000);
  const read = async (
    sessionId: string,
    runModel: typeof original,
  ): Promise<ContextUsage> => {
    const context = await manager.assemble(sessionId, "/tmp", {
      isSubagent: false,
      toolNames: [],
      runModel,
    });
    return manager.getUsage({
      context,
      modelId: "same-name",
      tools: [],
      runModel,
    });
  };
  const baseline = await read("a", original);
  await read("b", original);
  manager.updateCalibrationFactor("a", 300, 100, undefined, original);
  manager.updateCalibrationFactor("b", 300, 100, undefined, original);
  const calibrated = await read("a", original);
  expect(calibrated.currentTokens).toBeGreaterThan(baseline.currentTokens);
  const refreshed = await read("a", changed);
  expect(refreshed.currentTokens).toBe(baseline.currentTokens);
  expect(refreshed.contextLimit).toBe(64_000);
  expect((await read("b", original)).currentTokens).toBe(
    calibrated.currentTokens,
  );
});

it("ignores late calibration from the previous model after a new model's usage was read", async () => {
  const bus = createBus();
  const manager = createContextManager({
    bus,
    messageManager: createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    }),
    systemPromptProvider: {
      build: () => Promise.resolve("system prompt for measuring late feedback"),
    },
  });
  const a = model("a", 128_000);
  const b = model("b", 64_000);
  const read = async (runModel: ContextModel): Promise<ContextUsage> => {
    const context = await manager.assemble("session", "/tmp", {
      isSubagent: false,
      toolNames: [],
      runModel,
    });
    return manager.getUsage({
      context,
      modelId: "same-name",
      tools: [],
      runModel,
    });
  };
  await read(a);
  const clean = await read(b);
  manager.updateCalibrationFactor("session", 200, 100, undefined, a);
  expect((await read(b)).currentTokens).toBe(clean.currentTokens);
});

it("preserves the active model calibration while inspecting another selected model", async () => {
  const bus = createBus();
  const manager = createContextManager({
    bus,
    messageManager: createMessageManager({
      bus,
      store: createInMemoryMessageStore(),
    }),
    systemPromptProvider: {
      build: () =>
        Promise.resolve("system prompt for concurrent model inspection"),
    },
  });
  const a = model("a", 128_000);
  const b = model("b", 128_000);
  const prepare = (
    runModel: ContextModel,
  ): ReturnType<typeof manager.prepareTurn> =>
    manager.prepareTurn({
      runModel,
      sessionId: "session",
      directory: "/tmp",
      modelId: "same-name",
      tools: [],
      toolNames: [],
    });
  await prepare(a);
  manager.updateCalibrationFactor("session", 200, 100, undefined, a);
  const calibrated = await prepare(a);
  const context = await manager.assemble("session", "/tmp", {
    isSubagent: false,
    toolNames: [],
    runModel: b,
  });
  const cleanB = manager.getUsage({
    context,
    modelId: "same-name",
    tools: [],
    runModel: b,
  });
  expect((await prepare(a)).usage.currentTokens).toBe(
    calibrated.usage.currentTokens,
  );
  // Returning the usage view to A must not reset the still-running A turn.
  const activeContext = await manager.assemble("session", "/tmp", {
    isSubagent: false,
    toolNames: [],
    runModel: a,
  });
  expect(
    manager.getUsage({
      context: activeContext,
      modelId: "same-name",
      tools: [],
      runModel: a,
    }).currentTokens,
  ).toBe(calibrated.usage.currentTokens);
  expect((await prepare(a)).usage.currentTokens).toBe(
    calibrated.usage.currentTokens,
  );
  manager.updateCalibrationFactor("session", 300, 100, undefined, a);
  expect(
    manager.getUsage({ context, modelId: "same-name", tools: [], runModel: b })
      .currentTokens,
  ).toBe(cleanB.currentTokens);
  // Starting B after A clears any older B execution calibration.
  manager.updateCalibrationFactor("session", 300, 100, undefined, b);
  expect((await prepare(b)).usage.currentTokens).toBe(cleanB.currentTokens);
});

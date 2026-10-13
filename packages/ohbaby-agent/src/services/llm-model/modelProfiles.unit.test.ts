import { describe, expect, it } from "vitest";
import {
  calculateTokenBudget,
  createModelProfileRegistry,
} from "./modelProfiles.js";

describe("modelProfiles", () => {
  it("resolves user profiles before detected or default fallback values", () => {
    const registry = createModelProfileRegistry({
      fallbackContextWindowTokens: 64_000,
      userProfiles: [
        {
          contextWindowTokens: 256_000,
          maxOutputTokens: 32_000,
          model: "gpt-4o",
          provider: "openai",
        },
        {
          contextWindowTokens: 32_000,
          id: "local:dev",
          model: "dev",
          provider: "local",
        },
      ],
    });

    expect(registry.resolve("gpt-4o", "openai")).toMatchObject({
      contextWindowTokens: 256_000,
      id: "openai:gpt-4o",
      maxOutputTokens: 32_000,
      source: "user",
    });
    expect(registry.resolve("gpt-4.1-mini", "openai")).toMatchObject({
      contextWindowTokens: 64_000,
      provider: "openai",
      source: "fallback",
    });
    expect(registry.resolve("missing-model", "custom")).toMatchObject({
      contextWindowTokens: 64_000,
      id: "custom:missing-model",
      model: "missing-model",
      provider: "custom",
      source: "fallback",
    });
  });

  it("keeps user profiles isolated by provider when model names match", () => {
    const registry = createModelProfileRegistry({
      userProfiles: [
        {
          contextWindowTokens: 32_000,
          model: "chat",
          provider: "provider-a",
        },
        {
          contextWindowTokens: 128_000,
          model: "chat",
          provider: "provider-b",
        },
      ],
    });

    expect(registry.resolve("chat", "provider-a")).toMatchObject({
      contextWindowTokens: 32_000,
      id: "provider-a:chat",
      provider: "provider-a",
    });
    expect(registry.resolve("chat", "provider-b")).toMatchObject({
      contextWindowTokens: 128_000,
      id: "provider-b:chat",
      provider: "provider-b",
    });
  });

  it.each([
    "gpt-5",
    "claude-sonnet-4.6",
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-4o",
  ])(
    "does not override detected limits or infer a provider for %s",
    (model) => {
      const registry = createModelProfileRegistry({
        fallbackContextWindowTokens: 96_000,
      });
      expect(registry.resolve(model)).toMatchObject({
        contextWindowTokens: 96_000,
        maxOutputTokens: 8_192,
        provider: "custom",
        source: "fallback",
      });
    },
  );

  it.each([
    { kind: "no thinking", requested: 16_384, inputBudget: 82_592 },
    { kind: "fixed B of 32K", requested: 49_152, inputBudget: 49_824 },
    { kind: "effort-only", requested: 32_768, inputBudget: 66_208 },
  ])(
    "reserves the full explicit $kind request independently of ordinary preference",
    ({ requested, inputBudget }) => {
      const registry = createModelProfileRegistry({
        fallbackContextWindowTokens: 100_000,
        fallbackMaxOutputTokens: 4_096,
      });
      const budget = registry.calculateBudget("custom", {
        requestedOutputTokens: requested,
        usedInputTokens: 20_000,
      });
      expect(budget.reservedOutputTokens).toBe(requested);
      expect(budget.inputBudgetTokens).toBe(inputBudget);
      expect(budget.remainingInputTokens).toBe(inputBudget - 20_000);
    },
  );

  it("calculates input token budgets with output reservation and safety margin", () => {
    const budget = calculateTokenBudget(
      {
        contextWindowTokens: 64_000,
        id: "custom:chat",
        maxOutputTokens: 8_192,
        model: "chat",
        provider: "custom",
        source: "user",
      },
      {
        requestedOutputTokens: 12_000,
        safetyMarginTokens: 1_000,
        usedInputTokens: 10_000,
      },
    );

    expect(budget).toEqual({
      contextWindowTokens: 64_000,
      inputBudgetTokens: 51_000,
      maxOutputTokens: 8_192,
      modelId: "custom:chat",
      remainingInputTokens: 41_000,
      reservedOutputTokens: 12_000,
      safetyMarginTokens: 1_000,
      usageRatio: 10_000 / 51_000,
      usedInputTokens: 10_000,
    });
  });

  it("reserves the complete ordinary output even when no input budget remains", () => {
    const budget = calculateTokenBudget(
      {
        contextWindowTokens: 128_000,
        id: "custom:oversized",
        maxOutputTokens: 128_000,
        model: "oversized",
        provider: "custom",
        source: "fallback",
      },
      {
        safetyMarginTokens: 1_024,
        usedInputTokens: 64,
      },
    );

    expect(budget.inputBudgetTokens).toBe(0);
    expect(budget.remainingInputTokens).toBe(0);
    expect(budget.reservedOutputTokens).toBe(128_000);
    expect(budget.usageRatio).toBe(1);
  });
});

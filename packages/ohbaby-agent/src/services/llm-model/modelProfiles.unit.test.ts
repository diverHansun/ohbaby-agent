import { describe, expect, it } from "vitest";
import {
  calculateTokenBudget,
  createModelProfileRegistry,
} from "./modelProfiles.js";

describe("modelProfiles", () => {
  it("resolves built-in profiles, user overrides, and fallback profiles", () => {
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
      contextWindowTokens: 1_000_000,
      provider: "openai",
      source: "builtin",
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
      inputBudgetTokens: 54_808,
      maxOutputTokens: 8_192,
      modelId: "custom:chat",
      remainingInputTokens: 44_808,
      reservedOutputTokens: 8_192,
      safetyMarginTokens: 1_000,
      usageRatio: 10_000 / 54_808,
      usedInputTokens: 10_000,
    });
  });

  it("caps output reservation so an oversized max output does not erase the input budget", () => {
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

    expect(budget.inputBudgetTokens).toBe(63_488);
    expect(budget.reservedOutputTokens).toBe(63_488);
    expect(budget.usageRatio).toBe(64 / 63_488);
  });
});

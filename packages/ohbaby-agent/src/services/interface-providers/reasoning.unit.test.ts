import { describe, expect, it } from "vitest";
import {
  mergeReasoningIntent,
  resolveRequestReasoning,
  toAnthropicReasoningWire,
  toChatReasoningWire,
  toResponsesReasoningWire,
  type ResolveRequestReasoningOptions,
} from "./reasoning.js";
import type { ReasoningCapabilities } from "../../config/llm/types.js";
const openai = {
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  interfaceProvider: "openai-responses" as const,
  model: "gpt-5.2",
  maxTokens: 8192,
};
const custom = (
  capabilities: ReasoningCapabilities,
): ResolveRequestReasoningOptions => ({
  ...openai,
  provider: "custom",
  baseUrl: "https://custom.example/v1",
  model: "custom-model",
  modelProfiles: [
    {
      provider: "custom",
      model: "custom-model",
      contextWindowTokens: 128000,
      reasoningCapabilities: capabilities,
    },
  ],
});
const effort = {
  mode: "effort",
  wire: "openai",
  supportsDisabled: true,
  efforts: ["low", "medium", "high"],
  temperature: "disabled-only",
} as const;

describe("request reasoning resolution", () => {
  it("sends product on/medium by default with explicit provenance retained", () => {
    const result = resolveRequestReasoning(openai);
    expect(result.intent).toEqual({
      enabled: true,
      effort: "medium",
      explicit: { enabled: false, effort: false },
    });
    expect(toResponsesReasoningWire(result)).toEqual({
      reasoning: { effort: "medium" },
      include: ["reasoning.encrypted_content"],
    });
  });
  it("merges fields before defaults and keeps disabled preferences out of wire", () => {
    const result = resolveRequestReasoning({
      ...openai,
      reasoning: { enabled: false, effort: "high" },
      override: { effort: "future-tier" },
    });
    expect(result.intent).toEqual({
      enabled: false,
      effort: "future-tier",
      explicit: { enabled: true, effort: true },
    });
    expect(toResponsesReasoningWire(result)).toEqual({
      reasoning: { effort: "none" },
    });
  });
  it("retains provenance across inheritance without mutating the parent", () => {
    const inherited = mergeReasoningIntent(undefined, { effort: "high" });
    const child = resolveRequestReasoning({
      ...openai,
      reasoning: inherited,
      override: { enabled: false },
    });
    expect(child.intent.explicit).toEqual({ enabled: true, effort: true });
    expect(inherited).toEqual({
      enabled: true,
      effort: "high",
      explicit: { enabled: false, effort: true },
    });
    expect(Object.isFrozen(child.intent)).toBe(true);
    expect(Object.isFrozen(child.intent.explicit)).toBe(true);
  });
  it("title disables while context summary inherits high", () => {
    expect(
      resolveRequestReasoning({
        ...openai,
        reasoning: { effort: "high" },
        purpose: "session-title",
      }).mode,
    ).toBe("disabled");
    expect(
      resolveRequestReasoning({
        ...openai,
        reasoning: { effort: "high" },
        purpose: "context-summary",
      }).effort,
    ).toBe("high");
  });
  it("rejects unsupported effort and only accepts an explicit map", () => {
    const target = custom({ ...effort, efforts: ["low", "high"] });
    expect(resolveRequestReasoning(target).effort).toBe("low");
    expect(() =>
      resolveRequestReasoning({ ...target, reasoning: { effort: "medium" } }),
    ).toThrow(/medium.*low.*high/);
    expect(
      resolveRequestReasoning({
        ...custom({
          ...effort,
          efforts: ["low", "high"],
          effortMap: { medium: "high" },
        }),
        reasoning: { effort: "medium" },
      }).effort,
    ).toBe("high");
  });
  it("binary default is enabled without claiming medium; explicit effort fails", () => {
    const target = {
      ...custom({
        mode: "binary",
        wire: "enable-thinking",
        supportsDisabled: true,
      }),
      interfaceProvider: "openai-compatible" as const,
    };
    const result = resolveRequestReasoning(target);
    expect(result.mode).toBe("binary");
    expect(result.effort).toBeUndefined();
    expect(toChatReasoningWire(result)).toEqual({ enable_thinking: true });
    expect(() =>
      resolveRequestReasoning({ ...target, reasoning: { effort: "medium" } }),
    ).toThrow(/only.*on\/off|binary/i);
  });
  it("nonreasoning defaults stay usable and explicit enabled or effort fail", () => {
    const target = { ...openai, model: "gpt-4o" };
    expect(toResponsesReasoningWire(resolveRequestReasoning(target))).toEqual(
      {},
    );
    expect(() =>
      resolveRequestReasoning({ ...target, reasoning: { enabled: true } }),
    ).toThrow(/does not support reasoning/);
    expect(() =>
      resolveRequestReasoning({
        ...target,
        reasoning: mergeReasoningIntent(undefined, { effort: "medium" }),
      }),
    ).toThrow(/does not support reasoning/);
  });
  it.each([
    { model: "gpt-5.2-unknown" },
    { baseUrl: "https://unverified.example/v1" },
    { provider: "other" },
  ])(
    "does not infer capabilities from similar names or arbitrary endpoints %j",
    (patch) => {
      expect(resolveRequestReasoning({ ...openai, ...patch }).mode).toBe(
        "service-default",
      );
    },
  );
  it("fails before the request if disabled or explicit temperature is unsupported", () => {
    expect(() =>
      resolveRequestReasoning({
        ...custom({ ...effort, supportsDisabled: false }),
        reasoning: { enabled: false },
      }),
    ).toThrow(/cannot disable/);
    expect(() =>
      resolveRequestReasoning({ ...openai, temperature: 0.2 }),
    ).toThrow(/temperature.*remove/i);
    expect(
      resolveRequestReasoning({
        ...openai,
        reasoning: { enabled: false },
        temperature: 0.2,
      }).mode,
    ).toBe("disabled");
  });
  it("accepts Sonnet 4.6 max and rejects unknown strength without lowering it", () => {
    const target = {
      ...openai,
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      interfaceProvider: "anthropic" as const,
      model: "claude-sonnet-4-6",
    };
    expect(
      toAnthropicReasoningWire(
        resolveRequestReasoning({ ...target, reasoning: { effort: "max" } }),
      ),
    ).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
    });
    expect(() =>
      resolveRequestReasoning({ ...target, reasoning: { effort: "xhigh" } }),
    ).toThrow(/Unsupported reasoning effort/);
  });
  it("maps adaptive and explicit budget configurations with bounded output", () => {
    const adaptive = resolveRequestReasoning({
      ...custom({ ...effort, wire: "anthropic-adaptive" }),
      interfaceProvider: "anthropic",
    });
    expect(toAnthropicReasoningWire(adaptive)).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    const budget = {
      ...custom({
        ...effort,
        wire: "anthropic-budget",
        budgets: { low: 1024, medium: 4096, high: 8192 },
        minBudgetTokens: 1024,
      }),
      interfaceProvider: "anthropic" as const,
    };
    expect(toAnthropicReasoningWire(resolveRequestReasoning(budget))).toEqual({
      thinking: { type: "enabled", budget_tokens: 4096 },
    });
    expect(() =>
      resolveRequestReasoning({ ...budget, maxTokens: 4096 }),
    ).toThrow(/budget.*maxTokens/i);
    expect(
      toAnthropicReasoningWire(
        resolveRequestReasoning({
          ...budget,
          reasoning: { enabled: false, effort: "future" },
        }),
      ),
    ).toEqual({ thinking: { type: "disabled" } });
  });
});

describe("Stage C reliable defaults and service defaults", () => {
  it.each(["agent-step", "context-summary", "session-title"] as const)(
    "unknown %s preserves preference and omits controls",
    (purpose) => {
      const resolved = resolveRequestReasoning({
        ...openai,
        model: "unknown",
        reasoning: { enabled: false, effort: "high" },
        purpose,
      });
      expect(resolved.mode).toBe("service-default");
      expect(resolved.intent.effort).toBe("high");
      expect(toChatReasoningWire(resolved)).toEqual({});
      expect(toAnthropicReasoningWire(resolved)).toEqual({});
      expect(toResponsesReasoningWire(resolved)).toEqual({
        include: ["reasoning.encrypted_content"],
      });
    },
  );
  it("chooses medium then confirmed default then stable lowest order", () => {
    expect(
      resolveRequestReasoning(custom({ ...effort, defaultEffort: "high" }))
        .effort,
    ).toBe("medium");
    expect(
      resolveRequestReasoning(
        custom({ ...effort, efforts: ["high", "low"], defaultEffort: "high" }),
      ).effort,
    ).toBe("high");
    expect(
      resolveRequestReasoning(
        custom({ ...effort, efforts: ["high", "minimal", "low"] }),
      ).effort,
    ).toBe("minimal");
    expect(
      resolveRequestReasoning(
        custom({
          ...effort,
          efforts: ["deep", "fast"],
          effortOrder: ["fast", "deep"],
        }),
      ).effort,
    ).toBe("fast");
    expect(
      resolveRequestReasoning(custom({ ...effort, efforts: ["deep", "fast"] }))
        .mode,
    ).toBe("service-default");
  });
  it("does not bypass malformed config or invalid temperature on unknown", () => {
    expect(() =>
      resolveRequestReasoning({
        ...openai,
        model: "unknown",
        temperature: NaN,
      }),
    ).toThrow(/temperature/i);
    expect(() =>
      resolveRequestReasoning({
        ...openai,
        model: "unknown",
        reasoning: { effort: "" },
      }),
    ).toThrow();
  });
  it("always-on title stays sendable and invalid explicit effort remains rejected", () => {
    expect(
      resolveRequestReasoning({
        ...custom({ ...effort, supportsDisabled: false }),
        purpose: "session-title",
      }).effort,
    ).toBe("medium");
    expect(() =>
      resolveRequestReasoning({
        ...openai,
        purpose: "session-title",
        reasoning: { effort: "wrong" },
      }),
    ).toThrow(/Unsupported/);
  });
});

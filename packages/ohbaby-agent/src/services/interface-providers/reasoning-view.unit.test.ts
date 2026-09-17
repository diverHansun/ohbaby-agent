import { expect, it } from "vitest";
import {
  reasoningCapabilityView,
  resolveRequestReasoning,
} from "./reasoning.js";
const options = {
  provider: "custom",
  model: "m",
  baseUrl: "https://custom.example",
  interfaceProvider: "openai-compatible" as const,
  maxTokens: 5000,
};
it("publishes only verified ordered raw labels and defaults", () => {
  const view = reasoningCapabilityView({
    ...options,
    modelProfiles: [
      {
        model: "m",
        contextWindowTokens: 10000,
        reasoningCapabilities: {
          mode: "effort",
          wire: "reasoning",
          supportsDisabled: false,
          efforts: ["high", "low"],
          effortMap: { medium: "high" },
        },
      },
    ],
  });
  expect(view).toEqual({
    status: "identified",
    mode: "effort",
    supportsDisabled: false,
    efforts: ["low", "high"],
    default: { enabled: true, effort: "low" },
    source: "local-model-profile",
  });
  expect(JSON.stringify(view)).not.toMatch(/wire|effortMap|apiKey/);
});
it("unknown has no fabricated options; detected incomplete ordering remains service default", () => {
  expect(reasoningCapabilityView(options)).toMatchObject({
    status: "unknown",
    efforts: [],
  });
  expect(
    reasoningCapabilityView({
      ...options,
      modelProfiles: [
        {
          model: "m",
          contextWindowTokens: 10000,
          reasoningCapabilities: {
            mode: "effort",
            wire: "reasoning",
            supportsDisabled: false,
            efforts: ["deep", "fast"],
          },
        },
      ],
    }),
  ).toMatchObject({ status: "unknown", efforts: [] });
});
it.each([
  [
    "https://zenmux.ai/api/v1",
    "openai-compatible",
    "deepseek/deepseek-v4-flash",
    "high",
  ],
  [
    "https://zenmux.ai/api/v1",
    "openai-responses",
    "openai/gpt-5.6-luna",
    "medium",
  ],
  [
    "https://zenmux.ai/api/anthropic",
    "anthropic",
    "anthropic/claude-sonnet-5",
    "medium",
  ],
] as const)(
  "uses verified exact profile %s %s %s",
  (baseUrl, interfaceProvider, model, effort) => {
    const view = reasoningCapabilityView({
      ...options,
      provider: "zenmux",
      baseUrl,
      interfaceProvider,
      model,
    });
    expect(view.default?.effort).toBe(effort);
    expect(
      reasoningCapabilityView({
        ...options,
        provider: "zenmux",
        baseUrl: baseUrl + "-different",
        interfaceProvider,
        model,
      }).status,
    ).toBe("unknown");
  },
);
it("explicit matching overrides outrank discovered route-specific evidence", () => {
  const view = reasoningCapabilityView({
    ...options,
    modelProfiles: [
      {
        model: "m",
        contextWindowTokens: 10000,
        reasoningCapabilities: {
          mode: "binary",
          wire: "thinking",
          supportsDisabled: false,
        },
      },
      {
        provider: "custom",
        model: "m",
        baseUrl: options.baseUrl,
        interfaceProvider: options.interfaceProvider,
        contextWindowTokens: 10000,
        reasoningCapabilitySource: "model-metadata",
        reasoningCapabilities: {
          mode: "effort",
          wire: "openai",
          supportsDisabled: true,
          efforts: ["medium"],
        },
      },
    ],
  });
  expect(view.mode).toBe("binary");
  expect(view.source).toBe("local-model-profile");
});
it.each([
  ["https://zenmux.ai/api/v1", "openai-compatible", "openai/gpt-5.6-luna"],
  ["https://zenmux.ai/api/v1", "openai-responses", "openai/gpt-5.6-luna"],
  ["https://zenmux.ai/api/anthropic", "anthropic", "anthropic/claude-sonnet-5"],
] as const)(
  "does not infer per-model disable support from generic protocol %s %s %s",
  (baseUrl, interfaceProvider, model) => {
    const target = {
      ...options,
      provider: "zenmux",
      baseUrl,
      interfaceProvider,
      model,
    };
    expect(reasoningCapabilityView(target).supportsDisabled).toBe(false);
    expect(() =>
      resolveRequestReasoning({ ...target, reasoning: { enabled: false } }),
    ).toThrow(/cannot disable/);
    expect(
      resolveRequestReasoning({ ...target, purpose: "session-title" }).mode,
    ).toBe("effort");
  },
);

import { describe, expect, it } from "vitest";
import {
  listConfiguredModelSummaries,
  summarizeActiveModel,
} from "./activeModel.js";
import type { LLMConfig } from "../../config/index.js";

describe("active model projection", () => {
  const activeConfig: LLMConfig = {
    provider: "custom",
    model: "gpt-4o",
    apiKey: "sk-secret",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    interfaceProvider: "openai-compatible",
    temperature: 0.7,
    maxTokens: 4096,
    modelProfiles: [
      {
        provider: "custom",
        model: "gpt-4o",
        label: "GPT-4o Custom",
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_384,
      },
    ],
  };

  it("should summarize the active model without leaking apiKey", () => {
    const summary = summarizeActiveModel(activeConfig);

    expect(summary).toMatchObject({
      id: "custom:gpt-4o",
      provider: "custom",
      model: "gpt-4o",
      label: "GPT-4o Custom",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      interfaceProvider: "openai-compatible",
    });
    expect(summary.profile?.contextWindowTokens).toBe(128_000);
    expect(JSON.stringify(summary)).not.toContain("sk-secret");
  });

  it("should list only the configured single active model for now", () => {
    expect(listConfiguredModelSummaries(activeConfig)).toEqual([
      summarizeActiveModel(activeConfig),
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LLMConfigManager } from "../manager.js";
import { capabilitiesFor } from "ohbaby-llm";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "model-document-"));
  LLMConfigManager.resetInstance();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const route = {
  provider: "custom",
  model: "shared",
  baseUrl: "http://localhost:1/v1",
  interfaceProvider: "openai-compatible" as const,
};
const none = {
  mode: "none",
  wire: "none",
  supportsDisabled: true,
  temperature: "allowed",
} as const;
async function load(value: unknown): Promise<import("ohbaby-llm").LLMConfig> {
  const modelJsonPath = join(dir, "model.json");
  await writeFile(modelJsonPath, JSON.stringify(value));
  return LLMConfigManager.getInstance().reload({
    modelJsonPath,
    envPath: join(dir, ".env"),
    env: {},
  });
}
describe("agent model document boundary", () => {
  it("projects only the selected independent entry, never its same-route sibling capability", async () => {
    const config = await load({
      activeProfileId: "a",
      provider: "custom",
      defaultModel: "shared",
      apiConfig: route,
      llmParams: { maxTokens: 8192 },
      models: [
        { ...route, id: "a", apiKeyEnv: "A_KEY", contextWindowTokens: 123000 },
        {
          ...route,
          id: "b",
          apiKeyEnv: "B_KEY",
          contextWindowTokens: 456000,
          reasoningCapabilities: none,
        },
      ],
    });
    expect(config.apiKeyEnv).toBe("A_KEY");
    expect(config.modelProfiles).toHaveLength(1);
    expect(config.contextWindowTokens).toBe(123000);
    expect(capabilitiesFor(config).capability).toBeUndefined();
  });
  it("migrates the most-specific budget and effective wildcard explicit capability together", async () => {
    const config = await load({
      provider: "custom",
      defaultModel: "shared",
      apiConfig: route,
      llmParams: { maxTokens: 7000, contextWindowTokens: 11000 },
      models: [
        {
          model: "shared",
          contextWindowTokens: 22000,
          reasoningCapabilities: none,
        },
        { ...route, id: "budget", contextWindowTokens: 33000 },
      ],
    });
    expect(config.modelProfiles).toHaveLength(1);
    expect(config.contextWindowTokens).toBe(33000);
    expect(capabilitiesFor(config).capability).toEqual(none);
    expect(config.maxTokens).toBe(7000);
  });
});

it("preserves original matcher specificity before filling missing provider fields", async () => {
  const config = await load({
    provider: "custom",
    defaultModel: "shared",
    apiConfig: route,
    llmParams: { maxTokens: 7000 },
    models: [
      {
        id: "first",
        model: "shared",
        baseUrl: route.baseUrl,
        interfaceProvider: route.interfaceProvider,
        contextWindowTokens: 10000,
        reasoningCapabilities: none,
      },
      {
        id: "last",
        provider: "custom",
        model: "shared",
        baseUrl: route.baseUrl,
        contextWindowTokens: 20000,
        reasoningCapabilities: {
          mode: "binary",
          wire: "thinking",
          supportsDisabled: false,
        },
      },
    ],
  });
  expect(config.modelProfiles?.[0].id).toBe("last");
  expect(config.contextWindowTokens).toBe(20000);
  expect(capabilitiesFor(config).capability?.mode).toBe("binary");
});

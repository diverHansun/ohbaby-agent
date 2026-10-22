import { expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setActiveLLMConfig } from "../writer.js";
import type { ModelJsonConfig, ModelJsonModelProfile } from "ohbaby-llm";
import { capabilitiesFor } from "ohbaby-llm";
import { loadProjectedModelJson } from "../model-document.js";

it("preserves independent routes and legacy profiles, and resolves the exact route first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ohbaby-route-"));
  const path = join(dir, "model.json");
  const baseUrl = "https://gateway.invalid/v1";
  const chat: ModelJsonModelProfile = {
    provider: "gateway",
    model: "Dual",
    baseUrl,
    interfaceProvider: "openai-compatible",
    contextWindowTokens: 100000,
    reasoningCapabilities: {
      mode: "binary",
      wire: "thinking",
      supportsDisabled: true,
    },
  };
  const responses: ModelJsonModelProfile = {
    ...chat,
    interfaceProvider: "openai-responses",
    reasoningCapabilities: {
      mode: "effort",
      wire: "openai",
      supportsDisabled: true,
      efforts: ["medium", "high"],
    },
  };
  const other = { ...responses, baseUrl: `${baseUrl}/Other` };
  const generic = {
    provider: "gateway",
    model: "Dual",
    contextWindowTokens: 50000,
    reasoningCapabilities: chat.reasoningCapabilities,
  };
  const caseDistinct = { ...responses, model: "dual" };
  const initial = [chat, responses, other, generic, caseDistinct];
  const read = async (): Promise<ModelJsonConfig> =>
    JSON.parse(await readFile(path, "utf8")) as ModelJsonConfig;
  try {
    await writeFile(
      path,
      JSON.stringify({
        provider: "gateway",
        defaultModel: "Dual",
        apiConfig: { baseUrl },
        llmParams: { maxTokens: 8192 },
        models: initial,
      }),
    );
    await setActiveLLMConfig({
      provider: "gateway",
      model: "Dual",
      baseUrl: `${baseUrl}/`,
      interfaceProvider: "openai-responses",
      contextWindowTokens: 200000,
      updateActiveModelProfile: true,
      modelJsonPath: path,
    });
    const written = await read();
    expect(written.models).toHaveLength(5);
    expect(written.models?.[0]).toMatchObject({
      ...chat,
      baseUrl: `${baseUrl}/`,
      interfaceProvider: "openai-responses",
      contextWindowTokens: 200000,
    });
    expect(written.models?.slice(1)).toMatchObject([
      responses,
      other,
      generic,
      caseDistinct,
    ]);
    const projected = await loadProjectedModelJson({ modelJsonPath: path });
    expect(
      capabilitiesFor({
        provider: "gateway",
        model: "Dual",
        baseUrl,
        interfaceProvider: "openai-responses",
        maxTokens: 8192,
        modelProfiles: projected.models,
      }).capability?.mode,
    ).toBe("binary");
    await setActiveLLMConfig({
      provider: "gateway",
      model: "Dual",
      baseUrl,
      interfaceProvider: "openai-responses",
      clearActiveModelProfile: true,
      modelJsonPath: path,
    });
    expect((await read()).models).toHaveLength(5);
    expect((await read()).models?.[0].contextWindowTokens).toBe(128000);
    expect((await read()).models?.slice(1)).toEqual(written.models?.slice(1));
    await setActiveLLMConfig({
      provider: "gateway",
      model: "Dual",
      baseUrl: `${baseUrl}/new`,
      interfaceProvider: "openai-responses",
      contextWindowTokens: 300000,
      updateActiveModelProfile: true,
      modelJsonPath: path,
    });
    const added = (await read()).models?.at(-1);
    expect(added).toBeDefined();
    expect(added?.reasoningCapabilities).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("loads exact active route windows for summary and token budgets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ohbaby-active-route-"));
  const path = join(dir, "model.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        provider: "gateway",
        defaultModel: "Dual",
        apiConfig: {
          baseUrl: "https://a.test/v1",
          interfaceProvider: "openai-responses",
        },
        llmParams: { maxTokens: 8192 },
        models: [
          {
            provider: "gateway",
            model: "Dual",
            baseUrl: "https://a.test/v1",
            interfaceProvider: "openai-responses",
            contextWindowTokens: 200000,
          },
          {
            provider: "gateway",
            model: "Dual",
            baseUrl: "https://b.test/v1",
            interfaceProvider: "openai-compatible",
            contextWindowTokens: 30000,
          },
          { provider: "gateway", model: "dual", contextWindowTokens: 10000 },
        ],
      }),
    );
    const { LLMConfigManager } = await import("../manager.js");
    const { summarizeActiveModel } =
      await import("../../../services/llm-model/activeModel.js");
    const manager = LLMConfigManager.getInstance();
    const config = await manager.reload({ modelJsonPath: path });
    expect(summarizeActiveModel(config).profile?.contextWindowTokens).toBe(
      200000,
    );
    const { activeModelBudgetProfiles } = await import("ohbaby-llm");
    const { createHeuristicTokenCounter } =
      await import("../../../services/llm-model/tokenCounting.js");
    expect(
      createHeuristicTokenCounter({
        provider: config.provider,
        profiles: activeModelBudgetProfiles(config),
      }).getBudget(config.model).contextWindowTokens,
    ).toBe(200000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  undefined,
  "openai-compatible",
  "openai-responses",
  "anthropic",
] as const)(
  "loads missing-only protocol inference (%s)",
  async (interfaceProvider) => {
    const dir = await mkdtemp(join(tmpdir(), "ohbaby-protocol-"));
    const path = join(dir, "model.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          provider: "gateway",
          defaultModel: "Dual",
          apiConfig: {
            baseUrl: "https://gateway.invalid/api/anthropic",
            ...(interfaceProvider === undefined ? {} : { interfaceProvider }),
          },
          llmParams: { maxTokens: 8192 },
        }),
      );
      const { LLMConfigManager } = await import("../manager.js");
      const config = await LLMConfigManager.getInstance().reload({
        modelJsonPath: path,
      });
      expect(config.interfaceProvider).toBe(interfaceProvider ?? "anthropic");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("legacy connect refreshes the first duplicate entry and retains its sibling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ohbaby-duplicate-"));
  const path = join(dir, "model.json");
  const baseUrl = "https://gateway.invalid/v1";
  const profile: ModelJsonModelProfile = {
    provider: "gateway",
    model: "Dual",
    baseUrl,
    interfaceProvider: "openai-responses",
    contextWindowTokens: 100000,
    reasoningCapabilities: {
      mode: "effort",
      wire: "openai",
      supportsDisabled: true,
      efforts: ["medium", "high"],
    },
  };
  try {
    await writeFile(
      path,
      JSON.stringify({
        provider: "gateway",
        defaultModel: "Dual",
        apiConfig: { baseUrl, interfaceProvider: "openai-responses" },
        llmParams: { maxTokens: 8192 },
        models: [
          {
            ...profile,
            reasoningCapabilities: {
              ...profile.reasoningCapabilities,
              efforts: ["medium"],
            },
          },
          profile,
        ],
      }),
    );
    await setActiveLLMConfig({
      provider: "gateway",
      model: "Dual",
      baseUrl,
      interfaceProvider: "openai-responses",
      contextWindowTokens: 200000,
      updateActiveModelProfile: true,
      modelJsonPath: path,
    });
    const written = JSON.parse(await readFile(path, "utf8")) as ModelJsonConfig;
    expect(written.models).toHaveLength(2);
    expect(written.models?.[0]).toMatchObject({
      ...profile,
      contextWindowTokens: 200000,
      reasoningCapabilities: {
        ...profile.reasoningCapabilities,
        efforts: ["medium"],
      },
    });
    expect(written.models?.[1]).toMatchObject(profile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

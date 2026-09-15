import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateModelJson } from "../validation.js";
import { setActiveLLMConfig } from "../writer.js";
import type { ModelJsonConfig } from "../types.js";
import { LLMConfigManager } from "../manager.js";

const paths: string[] = [];
afterEach(async () => {
  LLMConfigManager.resetInstance();
  await Promise.all(
    paths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const config = (llmParams: object): ModelJsonConfig => ({
  provider: "openai",
  defaultModel: "gpt-5.2",
  apiConfig: {
    baseUrl: "https://api.openai.com/v1",
    interfaceProvider: "openai-responses",
  },
  llmParams: { maxTokens: 8192, ...llmParams },
});
async function modelPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ohbaby-reasoning-config-"));
  paths.push(dir);
  return join(dir, "model.json");
}

describe("reasoning configuration", () => {
  it("accepts omitted temperature for reasoning models", () => {
    expect(() => {
      validateModelJson(config({}));
    }).not.toThrow();
  });
  it.each([
    null,
    "yes",
    { enabled: "true" },
    { effort: 1 },
    { effort: "none" },
  ])("rejects invalid reasoning intent %j", (reasoning) => {
    expect(() => {
      validateModelJson(config({ temperature: 0.2, reasoning }));
    }).toThrow(/reasoning/i);
  });
  it("preserves disabled effort preferences without checking model support", () => {
    expect(() => {
      validateModelJson(
        config({ reasoning: { enabled: false, effort: "future-tier" } }),
      );
    }).not.toThrow();
  });
  it("loads explicit intent without turning omitted fields into explicit defaults", async () => {
    const path = await modelPath();
    await writeFile(
      path,
      JSON.stringify(config({ reasoning: { effort: "high" } })),
    );
    const loaded = await LLMConfigManager.getInstance().load({
      modelJsonPath: path,
      env: {},
    });
    expect(loaded).toMatchObject({ reasoning: { effort: "high" } });
    expect(loaded).not.toHaveProperty("temperature");
  });
  it("writer does not introduce a temperature and merges reasoning fields", async () => {
    const path = await modelPath();
    await setActiveLLMConfig({
      provider: "openai",
      model: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1",
      modelJsonPath: path,
    });
    expect(
      (JSON.parse(await readFile(path, "utf8")) as ModelJsonConfig).llmParams,
    ).not.toHaveProperty("temperature");
    await writeFile(
      path,
      JSON.stringify(config({ reasoning: { enabled: false, effort: "high" } })),
    );
    await setActiveLLMConfig({
      provider: "openai",
      model: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1",
      modelJsonPath: path,
      reasoning: { effort: "low" },
    });
    expect(
      (JSON.parse(await readFile(path, "utf8")) as ModelJsonConfig).llmParams
        .reasoning,
    ).toEqual({ enabled: false, effort: "low" });
  });
  it("rejects a strength capability whose wire can only carry a switch", () => {
    expect(() => {
      validateModelJson({
        ...config({}),
        models: [
          {
            model: "custom",
            contextWindowTokens: 10000,
            reasoningCapabilities: {
              mode: "effort",
              wire: "enable-thinking",
              supportsDisabled: true,
              efforts: ["medium"],
            },
          },
        ],
      });
    }).toThrow(/reasoning/i);
  });
  it("retains capability overrides when connection refresh updates budgeting", async () => {
    const path = await modelPath();
    const capabilities = { mode: "none", wire: "none", supportsDisabled: true };
    await writeFile(
      path,
      JSON.stringify({
        ...config({}),
        models: [
          {
            provider: "openai",
            model: "gpt-5.2",
            contextWindowTokens: 10000,
            reasoningCapabilities: capabilities,
          },
        ],
      }),
    );
    await setActiveLLMConfig({
      provider: "openai",
      model: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1",
      modelJsonPath: path,
      updateActiveModelProfile: true,
      contextWindowTokens: 20000,
    });
    expect(
      (JSON.parse(await readFile(path, "utf8")) as ModelJsonConfig).models,
    ).toEqual([
      {
        provider: "openai",
        model: "gpt-5.2",
        contextWindowTokens: 20000,
        reasoningCapabilities: capabilities,
      },
    ]);
  });
  it("rejects invalid writer reasoning before object merge can hide it", async () => {
    const path = await modelPath();
    await expect(
      setActiveLLMConfig({
        provider: "openai",
        model: "gpt-5.2",
        baseUrl: "https://api.openai.com/v1",
        modelJsonPath: path,
        reasoning: null as never,
      }),
    ).rejects.toThrow(/reasoning/i);
  });
  it("rejects malformed explicit capability metadata", () => {
    expect(() => {
      validateModelJson({
        ...config({ temperature: 0.2 }),
        models: [
          {
            model: "custom",
            contextWindowTokens: 10000,
            reasoningCapabilities: {
              mode: "effort",
              wire: "openai",
              supportsDisabled: true,
              efforts: ["none"],
            },
          },
        ],
      });
    }).toThrow(/reasoning|effort/i);
  });
});

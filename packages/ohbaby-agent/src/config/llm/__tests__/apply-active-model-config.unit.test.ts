import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyActiveModelConfig } from "../apply-active-model-config.js";
import { _LLMConfigManager as LLMConfigManager } from "../index.js";

describe("applyActiveModelConfig", () => {
  let tempRoot: string;
  let modelJsonPath: string;
  let envPath: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-connect-"));
    modelJsonPath = path.join(tempRoot, ".ohbaby-agent", "model.json");
    envPath = path.join(tempRoot, ".env");
    process.env = { ...originalEnv };
    delete process.env.ZENMUX_API_KEY;
    LLMConfigManager.resetInstance();
  });

  afterEach(async () => {
    process.env = originalEnv;
    LLMConfigManager.resetInstance();
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  it("rejects a missing provider without writing model.json", async () => {
    await expect(
      applyActiveModelConfig({
        apiKey: "sk-test-secret",
        apiKeyEnv: "ZENMUX_API_KEY",
        baseUrl: "https://zenmux.ai/api/anthropic",
        interfaceProvider: "anthropic",
        model: "anthropic/claude-sonnet-4.6",
        modelJsonPath,
        projectRoot: tempRoot,
      }),
    ).rejects.toThrow("Provider required");

    await expect(fs.stat(modelJsonPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes safe active config, env value, and resolved model profile", async () => {
    const result = await applyActiveModelConfig({
      apiKey: "sk-test-secret",
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      interfaceProvider: "anthropic",
      model: "anthropic/claude-sonnet-4.6",
      modelJsonPath,
      projectRoot: tempRoot,
      provider: "zenmux",
    });

    const modelJson = JSON.parse(
      await fs.readFile(modelJsonPath, "utf-8"),
    ) as {
      readonly provider: string;
      readonly defaultModel: string;
      readonly apiConfig: {
        readonly baseUrl: string;
        readonly apiKeyEnv: string;
        readonly interfaceProvider: string;
      };
      readonly llmParams: {
        readonly maxTokens: number;
        readonly contextWindowTokens?: number;
      };
      readonly models?: readonly {
        readonly provider?: string;
        readonly model: string;
        readonly contextWindowTokens: number;
        readonly maxOutputTokens?: number;
      }[];
    };

    expect(result).toEqual({
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      contextWindowTokens: 200_000,
      interfaceProvider: "anthropic",
      maxOutputTokens: 8_192,
      model: "anthropic/claude-sonnet-4.6",
      modelJsonPath,
      provider: "zenmux",
      saved: true,
      envPath,
    });
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
    expect(modelJson).toMatchObject({
      provider: "zenmux",
      defaultModel: "anthropic/claude-sonnet-4.6",
      apiConfig: {
        baseUrl: "https://zenmux.ai/api/anthropic",
        apiKeyEnv: "ZENMUX_API_KEY",
        interfaceProvider: "anthropic",
      },
      llmParams: {
        contextWindowTokens: 200_000,
        maxTokens: 8_192,
      },
      models: [
        {
          provider: "zenmux",
          model: "anthropic/claude-sonnet-4.6",
          contextWindowTokens: 200_000,
          maxOutputTokens: 8_192,
        },
      ],
    });
    await expect(fs.readFile(envPath, "utf-8")).resolves.toBe(
      "ZENMUX_API_KEY=sk-test-secret\n",
    );
    expect(process.env.ZENMUX_API_KEY).toBe("sk-test-secret");
  });

  it("uses existing env values when API key value is omitted", async () => {
    await fs.writeFile(envPath, "ZENMUX_API_KEY=sk-existing\n", "utf-8");

    await expect(
      applyActiveModelConfig({
        apiKeyEnv: "ZENMUX_API_KEY",
        baseUrl: "https://zenmux.ai/api/anthropic",
        interfaceProvider: "anthropic",
        model: "anthropic/claude-sonnet-4.6",
        modelJsonPath,
        projectRoot: tempRoot,
        provider: "zenmux",
      }),
    ).resolves.toMatchObject({
      apiKeyEnv: "ZENMUX_API_KEY",
      saved: true,
    });

    await expect(fs.readFile(envPath, "utf-8")).resolves.toBe(
      "ZENMUX_API_KEY=sk-existing\n",
    );
  });
});

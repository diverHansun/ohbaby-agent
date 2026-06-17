import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyActiveModelConfig } from "../apply-active-model-config.js";
import { _LLMConfigManager as LLMConfigManager } from "../index.js";

describe("applyActiveModelConfig", () => {
  let tempRoot: string;
  let homeRoot: string;
  let modelJsonPath: string;
  let envPath: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalApiKey: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-connect-"));
    homeRoot = path.join(tempRoot, "home");
    modelJsonPath = path.join(tempRoot, ".ohbaby-agent", "model.json");
    envPath = path.join(homeRoot, ".ohbaby-agent", ".env");
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalApiKey = process.env.ZENMUX_API_KEY;
    process.env.HOME = homeRoot;
    process.env.USERPROFILE = homeRoot;
    delete process.env.ZENMUX_API_KEY;
    fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              context_length: 200_000,
              id: "anthropic/claude-sonnet-4.6",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    LLMConfigManager.resetInstance();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    restoreEnvValue("HOME", originalHome);
    restoreEnvValue("USERPROFILE", originalUserProfile);
    restoreEnvValue("ZENMUX_API_KEY", originalApiKey);
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

    const modelJson = JSON.parse(await fs.readFile(modelJsonPath, "utf-8")) as {
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
      contextWindowSource: "detected",
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
    await fs.mkdir(path.dirname(envPath), { recursive: true });
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

  it("uses detected context window over a user-provided value", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              context_length: 262_144,
              id: "moonshotai/kimi-k2.6",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await applyActiveModelConfig({
      apiKey: "sk-test-secret",
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      contextWindowTokens: 128_000,
      interfaceProvider: "anthropic",
      model: "moonshotai/kimi-k2.6",
      modelJsonPath,
      projectRoot: tempRoot,
      provider: "zenmux",
    });

    expect(result.contextWindowTokens).toBe(262_144);
    expect(result.contextWindowSource).toBe("detected");
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");

    const modelJson = JSON.parse(await fs.readFile(modelJsonPath, "utf-8")) as {
      readonly llmParams: {
        readonly contextWindowTokens?: number;
      };
    };
    expect(modelJson.llmParams.contextWindowTokens).toBe(262_144);
  });

  it("uses the user-provided context window and returns a warning when detection fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const result = await applyActiveModelConfig({
      apiKey: "sk-test-secret",
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      contextWindowTokens: 64_000,
      interfaceProvider: "anthropic",
      model: "custom-model",
      modelJsonPath,
      projectRoot: tempRoot,
      provider: "zenmux",
    });

    expect(result.contextWindowTokens).toBe(64_000);
    expect(result.contextWindowSource).toBe("user");
    expect(result.warning).toMatch(/context window/i);
  });

  it("uses a 128k default and returns a warning when detection fails without a user value", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const result = await applyActiveModelConfig({
      apiKey: "sk-test-secret",
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      interfaceProvider: "anthropic",
      model: "custom-model",
      modelJsonPath,
      projectRoot: tempRoot,
      provider: "zenmux",
    });

    expect(result.contextWindowTokens).toBe(128_000);
    expect(result.contextWindowSource).toBe("default");
    expect(result.warning).toMatch(/context window/i);

    const modelJson = JSON.parse(await fs.readFile(modelJsonPath, "utf-8")) as {
      readonly llmParams: {
        readonly contextWindowTokens?: number;
      };
    };
    expect(modelJson.llmParams.contextWindowTokens).toBe(128_000);
  });

  it("rejects non-positive user-provided context window tokens before probing or writing", async () => {
    await expect(
      applyActiveModelConfig({
        apiKey: "sk-test-secret",
        apiKeyEnv: "ZENMUX_API_KEY",
        baseUrl: "https://zenmux.ai/api/anthropic",
        contextWindowTokens: 0,
        interfaceProvider: "anthropic",
        model: "custom-model",
        modelJsonPath,
        projectRoot: tempRoot,
        provider: "zenmux",
      }),
    ).rejects.toThrow("Context window must be a positive integer");

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fs.stat(modelJsonPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects non-positive user-provided max output tokens before probing or writing", async () => {
    await expect(
      applyActiveModelConfig({
        apiKey: "sk-test-secret",
        apiKeyEnv: "ZENMUX_API_KEY",
        baseUrl: "https://zenmux.ai/api/anthropic",
        interfaceProvider: "anthropic",
        maxOutputTokens: -1,
        model: "custom-model",
        modelJsonPath,
        projectRoot: tempRoot,
        provider: "zenmux",
      }),
    ).rejects.toThrow("Max output tokens must be a positive integer");

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(fs.stat(modelJsonPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

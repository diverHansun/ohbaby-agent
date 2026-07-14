import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyActiveModelConfig,
  probeActiveModelContextWindow,
} from "../apply-active-model-config.js";
import { _LLMConfigManager as LLMConfigManager } from "../index.js";

describe("applyActiveModelConfig", () => {
  let tempRoot: string;
  let homeRoot: string;
  let modelJsonPath: string;
  let envPath: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalApiKey: string | undefined;
  let originalLmStudioApiKey: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ohbaby-connect-"));
    homeRoot = path.join(tempRoot, "home");
    modelJsonPath = path.join(tempRoot, ".ohbaby", "model.json");
    envPath = path.join(homeRoot, ".ohbaby", ".env");
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalApiKey = process.env.ZENMUX_API_KEY;
    originalLmStudioApiKey = process.env.LM_STUDIO_API_KEY;
    process.env.HOME = homeRoot;
    process.env.USERPROFILE = homeRoot;
    delete process.env.ZENMUX_API_KEY;
    delete process.env.LM_STUDIO_API_KEY;
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
    restoreEnvValue("LM_STUDIO_API_KEY", originalLmStudioApiKey);
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

  it("uses an env file API key when the process env value is empty", async () => {
    process.env.ZENMUX_API_KEY = "";
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    await fs.writeFile(envPath, "ZENMUX_API_KEY=sk-existing\n", "utf-8");

    const result = await applyActiveModelConfig({
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      interfaceProvider: "anthropic",
      model: "anthropic/claude-sonnet-4.6",
      modelJsonPath,
      projectRoot: tempRoot,
      provider: "zenmux",
    });

    expect(result.warning).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://zenmux.ai/api/anthropic/v1/models",
      expect.objectContaining({
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": "sk-existing",
        },
      }),
    );
    await expect(
      LLMConfigManager.getInstance().load({
        envPath,
        modelJsonPath,
        projectDirectory: tempRoot,
      }),
    ).resolves.toMatchObject({
      apiKey: "sk-existing",
      apiKeyEnv: "ZENMUX_API_KEY",
    });
  });

  it("probes with an env file API key when the process env value is empty", async () => {
    process.env.ZENMUX_API_KEY = "";
    await fs.mkdir(path.dirname(envPath), { recursive: true });
    await fs.writeFile(envPath, "ZENMUX_API_KEY=sk-existing\n", "utf-8");

    const result = await probeActiveModelContextWindow({
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      interfaceProvider: "anthropic",
      model: "anthropic/claude-sonnet-4.6",
      envPath,
    });

    expect(result).toEqual({
      contextWindowSource: "detected",
      contextWindowTokens: 200_000,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://zenmux.ai/api/anthropic/v1/models",
      expect.objectContaining({
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": "sk-existing",
        },
      }),
    );
  });

  it("warns when an api key env is configured but no value is available", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("unauthorized", { status: 401 }),
    );

    const result = await applyActiveModelConfig({
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      interfaceProvider: "anthropic",
      model: "anthropic/claude-sonnet-4.6",
      modelJsonPath,
      projectRoot: tempRoot,
      provider: "zenmux",
    });

    expect(result).toMatchObject({
      apiKeyEnv: "ZENMUX_API_KEY",
      contextWindowSource: "default",
      contextWindowTokens: 128_000,
      saved: true,
    });
    expect(result.warning).toContain(
      "API key env ZENMUX_API_KEY is configured but no value was found",
    );
    expect(result.warning).toMatch(/context window/i);
    await expect(fs.stat(envPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("saves local-compatible model config without api key metadata or env writes", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              context_length: 65_536,
              id: "local-model",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await applyActiveModelConfig({
      baseUrl: "http://127.0.0.1:1234/v1",
      interfaceProvider: "openai-compatible",
      model: "local-model",
      modelJsonPath,
      projectRoot: tempRoot,
      provider: "lmstudio",
    } as unknown as Parameters<typeof applyActiveModelConfig>[0]);

    const modelJson = JSON.parse(await fs.readFile(modelJsonPath, "utf-8")) as {
      readonly apiConfig: {
        readonly apiKeyEnv?: string;
        readonly baseUrl: string;
      };
    };

    expect(result).toMatchObject({
      baseUrl: "http://127.0.0.1:1234/v1",
      contextWindowSource: "detected",
      contextWindowTokens: 65_536,
      model: "local-model",
      provider: "lmstudio",
      saved: true,
    });
    expect(result).not.toHaveProperty("apiKeyEnv");
    expect(result.warning).toBeUndefined();
    expect(modelJson.apiConfig).toEqual({
      baseUrl: "http://127.0.0.1:1234/v1",
      interfaceProvider: "openai-compatible",
    });
    await expect(fs.stat(envPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/v1/models",
      expect.objectContaining({
        headers: { Authorization: "Bearer not-needed" },
      }),
    );
  });

  it("uses a provider-derived api key env when key value is provided without a name", async () => {
    const result = await applyActiveModelConfig({
      apiKey: "sk-local-proxy-secret",
      baseUrl: "http://127.0.0.1:1234/v1",
      interfaceProvider: "openai-compatible",
      model: "local-model",
      modelJsonPath,
      projectRoot: tempRoot,
      provider: "lm-studio",
    } as unknown as Parameters<typeof applyActiveModelConfig>[0]);

    expect(result.apiKeyEnv).toBe("LM_STUDIO_API_KEY");
    await expect(fs.readFile(envPath, "utf-8")).resolves.toBe(
      "LM_STUDIO_API_KEY=sk-local-proxy-secret\n",
    );
    expect(process.env.LM_STUDIO_API_KEY).toBe("sk-local-proxy-secret");
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

  it("probes context window without writing active config", async () => {
    const result = await probeActiveModelContextWindow({
      apiKey: "sk-test-secret",
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      interfaceProvider: "anthropic",
      model: "anthropic/claude-sonnet-4.6",
    });

    expect(result).toEqual({
      contextWindowSource: "detected",
      contextWindowTokens: 200_000,
    });
    expect(JSON.stringify(result)).not.toContain("sk-test-secret");
    await expect(fs.stat(modelJsonPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("probes context window with the same user and default fallback rules as connect", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const userFallback = await probeActiveModelContextWindow({
      apiKey: "sk-test-secret",
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      contextWindowTokens: 96_000,
      interfaceProvider: "anthropic",
      model: "custom-model",
    });
    expect(userFallback).toMatchObject({
      contextWindowSource: "user",
      contextWindowTokens: 96_000,
    });
    expect(userFallback.warning).toMatch(/context window/i);

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const defaultFallback = await probeActiveModelContextWindow({
      apiKey: "sk-test-secret",
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      interfaceProvider: "anthropic",
      model: "custom-model",
    });
    expect(defaultFallback).toMatchObject({
      contextWindowSource: "default",
      contextWindowTokens: 128_000,
    });
    expect(defaultFallback.warning).toMatch(/context window/i);
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

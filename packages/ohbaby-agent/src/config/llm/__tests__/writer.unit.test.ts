import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import { setActiveLLMConfig } from "../index.js";

vi.mock("node:fs/promises");

interface WrittenModelJson {
  readonly provider: string;
  readonly defaultModel: string;
  readonly apiConfig: {
    readonly baseUrl: string;
    readonly apiKeyEnv?: string;
    readonly interfaceProvider?: string;
  };
  readonly llmParams: {
    readonly temperature: number;
    readonly maxTokens: number;
    readonly contextWindowTokens?: number;
  };
  readonly models?: readonly unknown[];
}

function callPathToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  throw new TypeError(`Expected file path string, received ${typeof value}`);
}

function callContentToString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  throw new TypeError(
    `Expected written content string, received ${typeof value}`,
  );
}

function findWriteCall(
  predicate: (filePath: string) => boolean,
): readonly unknown[] | undefined {
  return vi
    .mocked(fs.writeFile)
    .mock.calls.find(([file]) => predicate(callPathToString(file)));
}

function parseModelJsonWrite(
  call: readonly unknown[] | undefined,
): WrittenModelJson {
  if (!call) {
    throw new Error("Expected model.json write call.");
  }
  return JSON.parse(callContentToString(call[1])) as WrittenModelJson;
}

describe("setActiveLLMConfig", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.rename).mockResolvedValue(undefined);
  });

  it("should write model.json and .env without returning the API key", async () => {
    const missing = new Error("ENOENT") as NodeJS.ErrnoException;
    missing.code = "ENOENT";
    vi.mocked(fs.readFile).mockRejectedValue(missing);

    const result = await setActiveLLMConfig({
      provider: "custom",
      model: "glm-4.5",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKeyEnv: "ZHIPU_API_KEY",
      apiKey: "sk-secret",
      temperature: 0.2,
      maxTokens: 2048,
      modelJsonPath: "D:/repo/.ohbaby-agent/model.json",
      envPath: "D:/repo/.env",
    });

    const modelJsonWrite = findWriteCall((file) => file.includes("model.json"));
    expect(modelJsonWrite).toBeDefined();
    const modelJson = parseModelJsonWrite(modelJsonWrite);

    expect(modelJson).toEqual({
      provider: "custom",
      defaultModel: "glm-4.5",
      apiConfig: {
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        apiKeyEnv: "ZHIPU_API_KEY",
        interfaceProvider: "openai-compatible",
      },
      llmParams: {
        temperature: 0.2,
        maxTokens: 2048,
      },
    });
    expect(fs.rename).toHaveBeenCalled();

    const envWrite = findWriteCall((file) => file.includes(".env.tmp-"));
    expect(callContentToString(envWrite?.[1])).toBe(
      "ZHIPU_API_KEY=sk-secret\n",
    );

    expect(result).toEqual({
      provider: "custom",
      model: "glm-4.5",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKeyEnv: "ZHIPU_API_KEY",
      interfaceProvider: "openai-compatible",
      modelJsonPath: "D:/repo/.ohbaby-agent/model.json",
      envPath: "D:/repo/.env",
    });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("should omit apiKeyEnv and skip .env writes for keyless endpoints", async () => {
    const missing = new Error("ENOENT") as NodeJS.ErrnoException;
    missing.code = "ENOENT";
    vi.mocked(fs.readFile).mockRejectedValue(missing);

    const result = await setActiveLLMConfig({
      provider: "lmstudio",
      model: "local-model",
      baseUrl: "http://127.0.0.1:1234/v1",
      modelJsonPath: "D:/repo/.ohbaby-agent/model.json",
    });

    const modelJsonWrite = findWriteCall((file) => file.includes("model.json"));
    const modelJson = parseModelJsonWrite(modelJsonWrite);

    expect(modelJson.apiConfig).toEqual({
      baseUrl: "http://127.0.0.1:1234/v1",
      interfaceProvider: "openai-compatible",
    });
    expect(findWriteCall((file) => file.includes(".env.tmp-"))).toBeUndefined();
    expect(result).toEqual({
      provider: "lmstudio",
      model: "local-model",
      baseUrl: "http://127.0.0.1:1234/v1",
      interfaceProvider: "openai-compatible",
      modelJsonPath: "D:/repo/.ohbaby-agent/model.json",
    });
  });

  it("should preserve existing llmParams and model profiles unless overridden", async () => {
    const existingModelJson = {
      provider: "openai",
      defaultModel: "gpt-4",
      apiConfig: {
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      llmParams: {
        temperature: 0.1,
        maxTokens: 1234,
        contextWindowTokens: 128_000,
      },
      models: [
        {
          provider: "openai",
          model: "gpt-4o",
          contextWindowTokens: 128_000,
        },
      ],
    };
    vi.mocked(fs.readFile).mockImplementation((file) => {
      const filePath = callPathToString(file);
      if (filePath.endsWith("model.json")) {
        return Promise.resolve(JSON.stringify(existingModelJson));
      }
      if (filePath.endsWith(".env")) {
        return Promise.resolve("OPENAI_API_KEY=old\n");
      }
      return Promise.reject(new Error(`Unexpected read: ${filePath}`));
    });

    await setActiveLLMConfig({
      provider: "custom",
      model: "qwen-plus",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKeyEnv: "DASHSCOPE_API_KEY",
      modelJsonPath: "D:/repo/.ohbaby-agent/model.json",
      envPath: "D:/repo/.env",
    });

    const modelJsonWrite = findWriteCall((file) => file.includes("model.json"));
    const modelJson = parseModelJsonWrite(modelJsonWrite);

    expect(modelJson.llmParams).toEqual(existingModelJson.llmParams);
    expect(modelJson.models).toEqual(existingModelJson.models);
    expect(modelJson.apiConfig.interfaceProvider).toBe("openai-compatible");

    const envWrite = findWriteCall((file) => file.endsWith(".env"));
    expect(envWrite).toBeUndefined();
  });

  it("should update the active per-model profile and max token settings", async () => {
    const existingModelJson = {
      provider: "zenmux",
      defaultModel: "old-model",
      apiConfig: {
        baseUrl: "https://zenmux.ai/api/v1",
        apiKeyEnv: "ZENMUX_API_KEY",
      },
      llmParams: {
        temperature: 0,
        maxTokens: 4096,
        contextWindowTokens: 128_000,
      },
      models: [
        {
          provider: "zenmux",
          model: "anthropic/claude-sonnet-4.6",
          contextWindowTokens: 128_000,
          maxOutputTokens: 4096,
        },
        {
          provider: "openai",
          model: "gpt-4o",
          contextWindowTokens: 128_000,
        },
      ],
    };
    vi.mocked(fs.readFile).mockImplementation((file) => {
      const filePath = callPathToString(file);
      if (filePath.endsWith("model.json")) {
        return Promise.resolve(JSON.stringify(existingModelJson));
      }
      return Promise.reject(new Error(`Unexpected read: ${filePath}`));
    });

    await setActiveLLMConfig({
      provider: "zenmux",
      model: "anthropic/claude-sonnet-4.6",
      baseUrl: "https://zenmux.ai/api/anthropic",
      apiKeyEnv: "ZENMUX_API_KEY",
      interfaceProvider: "anthropic",
      contextWindowTokens: 200_000,
      maxOutputTokens: 8192,
      maxTokens: 8192,
      updateActiveModelProfile: true,
      modelJsonPath: "D:/repo/.ohbaby-agent/model.json",
    });

    const modelJsonWrite = findWriteCall((file) => file.includes("model.json"));
    const modelJson = parseModelJsonWrite(modelJsonWrite);

    expect(modelJson.llmParams).toEqual({
      temperature: 0,
      maxTokens: 8192,
      contextWindowTokens: 200_000,
    });
    expect(modelJson.models).toEqual([
      {
        provider: "openai",
        model: "gpt-4o",
        contextWindowTokens: 128_000,
      },
      {
        provider: "zenmux",
        model: "anthropic/claude-sonnet-4.6",
        contextWindowTokens: 200_000,
        maxOutputTokens: 8192,
      },
    ]);
  });

  it("should clear stale active context window tokens when requested", async () => {
    const existingModelJson = {
      provider: "openai",
      defaultModel: "gpt-4.1",
      apiConfig: {
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
      },
      llmParams: {
        temperature: 0.1,
        maxTokens: 32_768,
        contextWindowTokens: 1_000_000,
      },
      models: [
        {
          provider: "custom",
          model: "unknown-model",
          contextWindowTokens: 900_000,
        },
        {
          provider: "openai",
          model: "gpt-4o",
          contextWindowTokens: 128_000,
        },
      ],
    };
    vi.mocked(fs.readFile).mockImplementation((file) => {
      const filePath = callPathToString(file);
      if (filePath.endsWith("model.json")) {
        return Promise.resolve(JSON.stringify(existingModelJson));
      }
      return Promise.reject(new Error(`Unexpected read: ${filePath}`));
    });

    await setActiveLLMConfig({
      provider: "custom",
      model: "unknown-model",
      baseUrl: "https://example.com/v1",
      apiKeyEnv: "CUSTOM_API_KEY",
      clearContextWindowTokens: true,
      modelJsonPath: "D:/repo/.ohbaby-agent/model.json",
    });

    const modelJsonWrite = findWriteCall((file) => file.includes("model.json"));
    const modelJson = parseModelJsonWrite(modelJsonWrite);

    expect(modelJson.llmParams).toEqual({
      temperature: 0.1,
      maxTokens: 32_768,
    });
    expect(modelJson.models).toEqual([
      {
        provider: "openai",
        model: "gpt-4o",
        contextWindowTokens: 128_000,
      },
    ]);
  });
});

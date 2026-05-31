import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import { setActiveLLMConfig } from "../index.js";

vi.mock("node:fs/promises");

interface WrittenModelJson {
  readonly provider: string;
  readonly defaultModel: string;
  readonly apiConfig: {
    readonly baseUrl: string;
    readonly apiKeyEnv: string;
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

    const envWrite = findWriteCall((file) => file.endsWith(".env"));
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
});

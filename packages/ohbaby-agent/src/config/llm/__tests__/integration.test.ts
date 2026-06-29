/**
 * Integration tests for config/llm module.
 * Tests the complete flow from public API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import {
  getLLMConfig,
  reloadLLMConfig,
  isLLMConfigCached,
  ConfigError,
  _LLMConfigManager as LLMConfigManager,
} from "../index.js";

// Mock fs module
vi.mock("node:fs/promises");

describe("config/llm integration", () => {
  const validModelJson = {
    provider: "openai",
    defaultModel: "gpt-4",
    apiConfig: {
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
    },
    llmParams: {
      temperature: 0.7,
      maxTokens: 4096,
    },
  };

  const originalEnv = process.env;

  beforeEach(() => {
    LLMConfigManager.resetInstance();
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.OPENAI_API_KEY = "sk-test-integration-key";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getLLMConfig", () => {
    it("should load complete configuration", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validModelJson));

      const config = await getLLMConfig();

      expect(config).toEqual({
        provider: "openai",
        model: "gpt-4",
        apiKey: "sk-test-integration-key",
        apiKeyEnv: "OPENAI_API_KEY",
        baseUrl: "https://api.openai.com/v1",
        interfaceProvider: "openai-compatible",
        temperature: 0.7,
        maxTokens: 4096,
      });
    });

    it("should load explicit interface provider metadata", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          ...validModelJson,
          apiConfig: {
            ...validModelJson.apiConfig,
            interfaceProvider: "anthropic",
          },
        }),
      );

      const config = await getLLMConfig();

      expect(config.interfaceProvider).toBe("anthropic");
      expect(config.apiKeyEnv).toBe("OPENAI_API_KEY");
    });

    it("should cache after first call", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validModelJson));

      expect(isLLMConfigCached()).toBe(false);

      await getLLMConfig();

      expect(isLLMConfigCached()).toBe(true);
      expect(fs.readFile).toHaveBeenCalledTimes(1);

      await getLLMConfig();

      expect(fs.readFile).toHaveBeenCalledTimes(1);
    });

    it("should throw ConfigError for missing file", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(error);

      await expect(getLLMConfig()).rejects.toThrow(ConfigError);
      await expect(getLLMConfig()).rejects.toMatchObject({
        code: "FILE_NOT_FOUND",
      });
    });

    it("should throw ConfigError for invalid JSON", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("{ broken json");

      await expect(getLLMConfig()).rejects.toThrow(ConfigError);
      await expect(getLLMConfig()).rejects.toMatchObject({
        code: "INVALID_JSON",
      });
    });

    it("should throw ConfigError for missing required fields", async () => {
      const incompleteConfig = {
        provider: "openai",
        // missing other fields
      };
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify(incompleteConfig),
      );

      await expect(getLLMConfig()).rejects.toThrow(ConfigError);
      await expect(getLLMConfig()).rejects.toMatchObject({
        code: "MISSING_FIELD",
      });
    });

    it("should use the SDK placeholder when configured API key is missing", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validModelJson));
      delete process.env.OPENAI_API_KEY;

      await expect(getLLMConfig()).resolves.toMatchObject({
        apiKey: "not-needed",
        apiKeyEnv: "OPENAI_API_KEY",
      });
    });

    it("should use the SDK placeholder when configured API key is empty", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validModelJson));
      process.env.OPENAI_API_KEY = "";

      await expect(getLLMConfig()).resolves.toMatchObject({
        apiKey: "not-needed",
        apiKeyEnv: "OPENAI_API_KEY",
      });
    });

    it("should load keyless configuration without apiKeyEnv", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({
          ...validModelJson,
          apiConfig: {
            baseUrl: "http://127.0.0.1:1234/v1",
            interfaceProvider: "openai-compatible",
          },
          defaultModel: "local-model",
          provider: "lmstudio",
        }),
      );

      await expect(getLLMConfig()).resolves.toMatchObject({
        apiKey: "not-needed",
        baseUrl: "http://127.0.0.1:1234/v1",
        interfaceProvider: "openai-compatible",
        model: "local-model",
        provider: "lmstudio",
      });
    });

    it("should throw ConfigError for invalid temperature", async () => {
      const invalidConfig = {
        ...validModelJson,
        llmParams: { ...validModelJson.llmParams, temperature: 3.0 },
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(invalidConfig));

      await expect(getLLMConfig()).rejects.toThrow(ConfigError);
      await expect(getLLMConfig()).rejects.toMatchObject({
        code: "INVALID_TEMPERATURE",
      });
    });
  });

  describe("reloadLLMConfig", () => {
    it("should reload configuration from file", async () => {
      const updatedModelJson = {
        ...validModelJson,
        defaultModel: "gpt-4-turbo",
        llmParams: { ...validModelJson.llmParams, temperature: 1.0 },
      };

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(validModelJson))
        .mockResolvedValueOnce(JSON.stringify(updatedModelJson));

      const config1 = await getLLMConfig();
      expect(config1.model).toBe("gpt-4");
      expect(config1.temperature).toBe(0.7);

      const config2 = await reloadLLMConfig();
      expect(config2.model).toBe("gpt-4-turbo");
      expect(config2.temperature).toBe(1.0);
    });

    it("should update cache after reload", async () => {
      const updatedModelJson = {
        ...validModelJson,
        defaultModel: "gpt-4-turbo",
      };

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(JSON.stringify(validModelJson))
        .mockResolvedValueOnce(JSON.stringify(updatedModelJson));

      await getLLMConfig();
      await reloadLLMConfig();

      // Subsequent getLLMConfig should return updated config
      const config = await getLLMConfig();
      expect(config.model).toBe("gpt-4-turbo");
      expect(fs.readFile).toHaveBeenCalledTimes(2);
    });
  });

  describe("different providers", () => {
    it("should support zhipu provider", async () => {
      const zhipuConfig = {
        provider: "zhipu",
        defaultModel: "glm-4-plus",
        apiConfig: {
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          apiKeyEnv: "ZHIPU_API_KEY",
        },
        llmParams: {
          temperature: 0.2,
          maxTokens: 2048,
        },
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(zhipuConfig));
      process.env.ZHIPU_API_KEY = "zhipu-test-key";

      const config = await getLLMConfig();

      expect(config.provider).toBe("zhipu");
      expect(config.model).toBe("glm-4-plus");
      expect(config.apiKey).toBe("zhipu-test-key");
      expect(config.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    });

    it("should support custom provider", async () => {
      const customConfig = {
        provider: "custom",
        defaultModel: "custom-model",
        apiConfig: {
          baseUrl: "http://localhost:8080/v1",
          apiKeyEnv: "CUSTOM_API_KEY",
        },
        llmParams: {
          temperature: 0.5,
          maxTokens: 1024,
        },
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(customConfig));
      process.env.CUSTOM_API_KEY = "custom-key";

      const config = await getLLMConfig();

      expect(config.provider).toBe("custom");
      expect(config.model).toBe("custom-model");
    });
  });
});

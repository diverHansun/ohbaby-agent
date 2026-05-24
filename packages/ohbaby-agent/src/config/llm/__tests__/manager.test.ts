/**
 * Unit tests for LLMConfigManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _LLMConfigManager as LLMConfigManager } from "../index.js";
import { ConfigError } from "../types.js";
import * as loaders from "../loaders.js";

// Mock loaders module
vi.mock("../loaders.js");

describe("LLMConfigManager", () => {
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
      contextWindowTokens: 128_000,
    },
    models: [
      {
        contextWindowTokens: 256_000,
        maxOutputTokens: 32_000,
        model: "gpt-4o",
        provider: "openai",
      },
    ],
  };

  const originalEnv = process.env;

  beforeEach(() => {
    // Reset singleton instance before each test
    LLMConfigManager.resetInstance();
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.OPENAI_API_KEY = "sk-test-key-123";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getInstance", () => {
    it("should return the same instance", () => {
      const instance1 = LLMConfigManager.getInstance();
      const instance2 = LLMConfigManager.getInstance();

      expect(instance1).toBe(instance2);
    });

    it("should return new instance after reset", () => {
      const instance1 = LLMConfigManager.getInstance();
      LLMConfigManager.resetInstance();
      const instance2 = LLMConfigManager.getInstance();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe("load", () => {
    it("should load and return valid configuration", async () => {
      vi.mocked(loaders.loadModelJson).mockResolvedValue(validModelJson);
      vi.mocked(loaders.loadApiKey).mockReturnValue("sk-test-key-123");

      const manager = LLMConfigManager.getInstance();
      const config = await manager.load();

      expect(config).toEqual({
        provider: "openai",
        model: "gpt-4",
        apiKey: "sk-test-key-123",
        baseUrl: "https://api.openai.com/v1",
        temperature: 0.7,
        maxTokens: 4096,
        contextWindowTokens: 128_000,
        modelProfiles: [
          {
            contextWindowTokens: 128_000,
            maxOutputTokens: 4096,
            model: "gpt-4",
            provider: "openai",
          },
          {
            contextWindowTokens: 256_000,
            maxOutputTokens: 32_000,
            model: "gpt-4o",
            provider: "openai",
          },
        ],
      });
      expect(loaders.loadProjectEnv).not.toHaveBeenCalled();
    });

    it("should load API key from project .env when shell env is absent", async () => {
      vi.mocked(loaders.loadModelJson).mockResolvedValue(validModelJson);
      vi.mocked(loaders.loadApiKey)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce("sk-project-key");
      vi.mocked(loaders.loadProjectEnv).mockResolvedValue({
        OPENAI_API_KEY: "sk-project-key",
      });

      const manager = LLMConfigManager.getInstance();
      const config = await manager.load({ projectDirectory: "D:/repo" });

      expect(config.apiKey).toBe("sk-project-key");
      expect(loaders.loadProjectEnv).toHaveBeenCalledWith("D:/repo");
      expect(loaders.loadApiKey).toHaveBeenNthCalledWith(1, "OPENAI_API_KEY");
      expect(loaders.loadApiKey).toHaveBeenNthCalledWith(2, "OPENAI_API_KEY", {
        OPENAI_API_KEY: "sk-project-key",
      });
    });

    it("should cache configuration after first load", async () => {
      vi.mocked(loaders.loadModelJson).mockResolvedValue(validModelJson);
      vi.mocked(loaders.loadApiKey).mockReturnValue("sk-test-key-123");

      const manager = LLMConfigManager.getInstance();

      await manager.load();
      await manager.load();
      await manager.load();

      expect(loaders.loadModelJson).toHaveBeenCalledTimes(1);
    });

    it("should cache configuration by project directory", async () => {
      vi.mocked(loaders.loadModelJson).mockResolvedValue(validModelJson);
      vi.mocked(loaders.loadApiKey)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce("sk-project-a")
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce("sk-project-b");
      vi.mocked(loaders.loadProjectEnv)
        .mockResolvedValueOnce({ OPENAI_API_KEY: "sk-project-a" })
        .mockResolvedValueOnce({ OPENAI_API_KEY: "sk-project-b" });

      const manager = LLMConfigManager.getInstance();

      const first = await manager.load({ projectDirectory: "D:/repo-a" });
      const second = await manager.load({ projectDirectory: "D:/repo-a" });
      const third = await manager.load({ projectDirectory: "D:/repo-b" });

      expect(first).toBe(second);
      expect(third.apiKey).toBe("sk-project-b");
      expect(loaders.loadModelJson).toHaveBeenCalledTimes(2);
      expect(loaders.loadProjectEnv).toHaveBeenNthCalledWith(1, "D:/repo-a");
      expect(loaders.loadProjectEnv).toHaveBeenNthCalledWith(2, "D:/repo-b");
    });

    it("should return cached config on subsequent calls", async () => {
      vi.mocked(loaders.loadModelJson).mockResolvedValue(validModelJson);
      vi.mocked(loaders.loadApiKey).mockReturnValue("sk-test-key-123");

      const manager = LLMConfigManager.getInstance();

      const config1 = await manager.load();
      const config2 = await manager.load();

      expect(config1).toBe(config2);
    });

    it("should throw ConfigError for missing API key", async () => {
      vi.mocked(loaders.loadModelJson).mockResolvedValue(validModelJson);
      vi.mocked(loaders.loadApiKey).mockReturnValue(undefined);

      const manager = LLMConfigManager.getInstance();

      await expect(manager.load()).rejects.toThrow(ConfigError);
    });

    it("should set lastError on failure", async () => {
      vi.mocked(loaders.loadModelJson).mockRejectedValue(
        new ConfigError("File not found", "FILE_NOT_FOUND"),
      );

      const manager = LLMConfigManager.getInstance();

      try {
        await manager.load();
      } catch {
        // Expected
      }

      expect(manager.getLastError()).not.toBeNull();
      expect(manager.getLastError()?.code).toBe("FILE_NOT_FOUND");
    });

    it("should clear lastError on successful load", async () => {
      vi.mocked(loaders.loadModelJson)
        .mockRejectedValueOnce(
          new ConfigError("File not found", "FILE_NOT_FOUND"),
        )
        .mockResolvedValueOnce(validModelJson);
      vi.mocked(loaders.loadApiKey).mockReturnValue("sk-test-key-123");

      const manager = LLMConfigManager.getInstance();

      try {
        await manager.load();
      } catch {
        // Expected first call to fail
      }

      expect(manager.getLastError()).not.toBeNull();

      // Reset and retry
      LLMConfigManager.resetInstance();
      const newManager = LLMConfigManager.getInstance();
      await newManager.load();

      expect(newManager.getLastError()).toBeNull();
    });
  });

  describe("reload", () => {
    it("should clear cache and reload from file", async () => {
      vi.mocked(loaders.loadModelJson).mockResolvedValue(validModelJson);
      vi.mocked(loaders.loadApiKey).mockReturnValue("sk-test-key-123");

      const manager = LLMConfigManager.getInstance();

      await manager.load();
      expect(loaders.loadModelJson).toHaveBeenCalledTimes(1);

      await manager.reload();
      expect(loaders.loadModelJson).toHaveBeenCalledTimes(2);
    });

    it("should return updated configuration", async () => {
      const updatedModelJson = {
        ...validModelJson,
        defaultModel: "gpt-4-turbo",
      };

      vi.mocked(loaders.loadModelJson)
        .mockResolvedValueOnce(validModelJson)
        .mockResolvedValueOnce(updatedModelJson);
      vi.mocked(loaders.loadApiKey).mockReturnValue("sk-test-key-123");

      const manager = LLMConfigManager.getInstance();

      const config1 = await manager.load();
      expect(config1.model).toBe("gpt-4");

      const config2 = await manager.reload();
      expect(config2.model).toBe("gpt-4-turbo");
    });

    it("should re-read project .env values on reload", async () => {
      vi.mocked(loaders.loadModelJson).mockResolvedValue(validModelJson);
      vi.mocked(loaders.loadApiKey)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce("sk-old-project-key")
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce("sk-new-project-key");
      vi.mocked(loaders.loadProjectEnv)
        .mockResolvedValueOnce({ OPENAI_API_KEY: "sk-old-project-key" })
        .mockResolvedValueOnce({ OPENAI_API_KEY: "sk-new-project-key" });

      const manager = LLMConfigManager.getInstance();

      const config1 = await manager.load({ projectDirectory: "D:/repo" });
      const config2 = await manager.reload({ projectDirectory: "D:/repo" });

      expect(config1.apiKey).toBe("sk-old-project-key");
      expect(config2.apiKey).toBe("sk-new-project-key");
      expect(loaders.loadProjectEnv).toHaveBeenCalledTimes(2);
    });

    it("should clear lastError before reload", async () => {
      vi.mocked(loaders.loadModelJson)
        .mockRejectedValueOnce(
          new ConfigError("File not found", "FILE_NOT_FOUND"),
        )
        .mockResolvedValueOnce(validModelJson);
      vi.mocked(loaders.loadApiKey).mockReturnValue("sk-test-key-123");

      const manager = LLMConfigManager.getInstance();

      try {
        await manager.load();
      } catch {
        // Expected
      }

      expect(manager.getLastError()).not.toBeNull();

      await manager.reload();

      expect(manager.getLastError()).toBeNull();
    });
  });

  describe("isCached", () => {
    it("should return false initially", () => {
      const manager = LLMConfigManager.getInstance();

      expect(manager.isCached()).toBe(false);
    });

    it("should return true after successful load", async () => {
      vi.mocked(loaders.loadModelJson).mockResolvedValue(validModelJson);
      vi.mocked(loaders.loadApiKey).mockReturnValue("sk-test-key-123");

      const manager = LLMConfigManager.getInstance();
      await manager.load();

      expect(manager.isCached()).toBe(true);
    });

    it("should return false after failed load", async () => {
      vi.mocked(loaders.loadModelJson).mockRejectedValue(
        new ConfigError("File not found", "FILE_NOT_FOUND"),
      );

      const manager = LLMConfigManager.getInstance();

      try {
        await manager.load();
      } catch {
        // Expected
      }

      expect(manager.isCached()).toBe(false);
    });

    it("should return false after reload clears cache", async () => {
      vi.mocked(loaders.loadModelJson)
        .mockResolvedValueOnce(validModelJson)
        .mockRejectedValueOnce(
          new ConfigError("File not found", "FILE_NOT_FOUND"),
        );
      vi.mocked(loaders.loadApiKey).mockReturnValue("sk-test-key-123");

      const manager = LLMConfigManager.getInstance();
      await manager.load();

      expect(manager.isCached()).toBe(true);

      try {
        await manager.reload();
      } catch {
        // Expected
      }

      expect(manager.isCached()).toBe(false);
    });
  });
});

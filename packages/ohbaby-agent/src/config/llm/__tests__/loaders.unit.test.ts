/**
 * Unit tests for loader functions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadModelJson,
  loadApiKey,
  loadEnvFile,
  getModelJsonPath,
} from "../loaders.js";
import { ConfigError } from "../types.js";

// Mock fs module
vi.mock("node:fs/promises");

describe("getModelJsonPath", () => {
  it("should return path under home directory", () => {
    const result = getModelJsonPath();
    const homeDir = os.homedir();
    expect(result).toBe(path.join(homeDir, ".ohbaby-agent", "model.json"));
  });
});

describe("loadModelJson", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should load and parse valid JSON", async () => {
    const mockConfig = {
      provider: "openai",
      defaultModel: "gpt-4",
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockConfig));

    const result = await loadModelJson();

    expect(result).toEqual(mockConfig);
  });

  it("should load model.json from an explicit path", async () => {
    const mockConfig = {
      provider: "openai",
      defaultModel: "gpt-4",
    };
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockConfig));

    const result = await loadModelJson({
      modelJsonPath: "D:/tmp/model.json",
    });

    expect(result).toEqual(mockConfig);
    expect(fs.readFile).toHaveBeenCalledWith("D:/tmp/model.json", "utf-8");
  });

  it("should throw FILE_NOT_FOUND for missing file", async () => {
    const error = new Error("ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    vi.mocked(fs.readFile).mockRejectedValue(error);

    await expect(loadModelJson()).rejects.toThrow(ConfigError);
    try {
      await loadModelJson();
    } catch (e) {
      expect((e as ConfigError).code).toBe("FILE_NOT_FOUND");
    }
  });

  it("should throw LOAD_FAILED for other read errors", async () => {
    const error = new Error("Permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    vi.mocked(fs.readFile).mockRejectedValue(error);

    await expect(loadModelJson()).rejects.toThrow(ConfigError);
    try {
      await loadModelJson();
    } catch (e) {
      expect((e as ConfigError).code).toBe("LOAD_FAILED");
    }
  });

  it("should throw INVALID_JSON for malformed JSON", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("{ invalid json }");

    await expect(loadModelJson()).rejects.toThrow(ConfigError);
    try {
      await loadModelJson();
    } catch (e) {
      expect((e as ConfigError).code).toBe("INVALID_JSON");
    }
  });

  it("should include path in error context", async () => {
    const error = new Error("ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    vi.mocked(fs.readFile).mockRejectedValue(error);

    try {
      await loadModelJson();
    } catch (e) {
      expect((e as ConfigError).context?.path).toBeDefined();
    }
  });
});

describe("loadApiKey", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return API key from environment", () => {
    process.env.TEST_API_KEY = "sk-test-123";

    const result = loadApiKey("TEST_API_KEY");

    expect(result).toBe("sk-test-123");
  });

  it("should read API key from provided env before process.env", () => {
    process.env.TEST_API_KEY = "process-key";

    const result = loadApiKey("TEST_API_KEY", {
      TEST_API_KEY: "provided-key",
    });

    expect(result).toBe("provided-key");
  });

  it("should return undefined for missing env var", () => {
    delete process.env.MISSING_KEY;

    const result = loadApiKey("MISSING_KEY");

    expect(result).toBeUndefined();
  });

  it("should return empty string if env var is empty", () => {
    process.env.EMPTY_KEY = "";

    const result = loadApiKey("EMPTY_KEY");

    expect(result).toBe("");
  });
});

describe("loadEnvFile", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should parse dotenv file values", async () => {
    vi.mocked(fs.readFile).mockResolvedValue('A=1\nB="two words"\n');

    await expect(loadEnvFile("D:/repo/.env")).resolves.toEqual({
      A: "1",
      B: "two words",
    });
    expect(fs.readFile).toHaveBeenCalledWith("D:/repo/.env", "utf-8");
  });

  it("should return empty env for missing dotenv file", async () => {
    const error = new Error("ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    vi.mocked(fs.readFile).mockRejectedValue(error);

    await expect(loadEnvFile("D:/repo/.env")).resolves.toEqual({});
  });
});

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMConfig } from "ohbaby-llm";
import { createLLMClient } from "./create-llm-client.js";
import { getLLMConfig } from "../../config/index.js";
import * as llm from "ohbaby-llm";
import { tokenUsageNormalization } from "../../observability/index.js";

vi.mock("../../config/index.js", () => ({ getLLMConfig: vi.fn() }));

type ConfigErrorWithCode = Error & { code: string };

const mockConfig: LLMConfig = {
  provider: "openai",
  model: "gpt-4",
  apiKey: "sk-test-123",
  apiKeyEnv: "OPENAI_API_KEY",
  baseUrl: "https://api.openai.com/v1",
  interfaceProvider: "openai-compatible",
  promptCache: "auto",
  temperature: 0.7,
  maxTokens: 4096,
};

describe("createLLMClient agent wrapper", () => {
  it("should export createLLMClient", () => {
    expect(typeof createLLMClient).toBe("function");
  });
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to the current project directory and its .env", async () => {
    vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);

    await createLLMClient();

    expect(getLLMConfig).toHaveBeenCalledWith({
      projectDirectory: process.cwd(),
      envPath: path.join(process.cwd(), ".env"),
    });
  });

  it("preserves explicit configuration options", async () => {
    vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);
    const options = {
      projectDirectory: "/project",
      envPath: "/custom/.env",
      modelJsonPath: "/custom/model.json",
      env: { OPENAI_API_KEY: "test-key" },
    };

    await createLLMClient(options);

    expect(getLLMConfig).toHaveBeenCalledWith(options);
  });

  it("reports token normalization diagnostics through the injected logger", async () => {
    vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);
    const clientFactory = vi.spyOn(llm, "createLLMClientFromConfig");
    const logger = { emit: vi.fn() };
    await createLLMClient({ logger });

    const report = clientFactory.mock.calls[0]?.[1]?.tokenUsageReporter;
    expect(report).toBeTypeOf("function");
    report?.({
      type: "llm.usage.normalization",
      code: "raw-total-mismatch",
      protocol: "openai-compatible",
      received: 999,
      normalizedTotal: 120,
    });

    expect(logger.emit).toHaveBeenCalledTimes(1);
    expect(logger.emit).toHaveBeenCalledWith(tokenUsageNormalization, {
      code: "raw-total-mismatch",
      field: undefined,
      normalizedTotal: 120,
      protocol: "openai-compatible",
      received: 999,
      retained: undefined,
    });
  });
  it("should create client with config from config module", async () => {
    vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);

    const client = await createLLMClient();

    expect(client).toBeDefined();
    expect(client.provider).toBeDefined();
    expect(client.provider.client).toBeDefined();
    expect(client.config).toBeDefined();
    expect(client.config.provider).toBe("openai");
    expect(client.config.model).toBe("gpt-4");
    expect(client.config.baseUrl).toBe("https://api.openai.com/v1");
    expect(client.config.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(client.config.interfaceProvider).toBe("openai-compatible");
    expect(client.config.temperature).toBe(0.7);
    expect(client.config.maxTokens).toBe(4096);
    expect("client" in client).toBe(false);
  });

  it("should pass project directory to config loading", async () => {
    vi.mocked(getLLMConfig).mockResolvedValue(mockConfig);

    await createLLMClient({ projectDirectory: "D:/repo" });

    expect(getLLMConfig).toHaveBeenCalledWith({
      envPath: path.join("D:/repo", ".env"),
      projectDirectory: "D:/repo",
    });
  });

  it("should propagate ConfigError from config module", async () => {
    const configError = new Error(
      "Configuration file not found",
    ) as ConfigErrorWithCode;
    configError.code = "FILE_NOT_FOUND";
    vi.mocked(getLLMConfig).mockRejectedValue(configError);

    await expect(createLLMClient()).rejects.toThrow(
      "Configuration file not found",
    );
  });
});

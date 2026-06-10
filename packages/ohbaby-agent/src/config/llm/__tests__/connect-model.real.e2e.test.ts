import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { config as loadDotenv } from "dotenv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLLMClient,
  streamChatCompletion,
} from "../../../core/llm-client/index.js";
import { applyActiveModelConfig } from "../apply-active-model-config.js";
import { _LLMConfigManager as LLMConfigManager } from "../index.js";

const runRealE2E =
  process.env.OHBABY_CONNECT_MODEL_REAL_E2E === "1"
    ? describe
    : describe.skip;

const DEFAULT_BASE_URL = "https://zenmux.ai/api/anthropic";
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";
const MARKER = "OHBABY_CONNECT_REAL_OK";

runRealE2E("connectModel real API e2e", () => {
  beforeEach(() => {
    LLMConfigManager.resetInstance();
    loadDotenv({ path: path.join(process.cwd(), ".env") });
  });

  afterEach(() => {
    LLMConfigManager.resetInstance();
  });

  it(
    "saves a Zenmux Anthropic-compatible config from root .env and streams",
    async () => {
      const apiKey = process.env.ZENMUX_API_KEY?.trim();
      if (!apiKey) {
        throw new Error(
          "Set ZENMUX_API_KEY in the environment or root .env for real connectModel e2e.",
        );
      }

      const projectRoot = await mkdtemp(
        path.join(tmpdir(), "ohbaby-connect-real-"),
      );
      const modelJsonPath = path.join(
        projectRoot,
        "home",
        ".ohbaby-agent",
        "model.json",
      );
      const envPath = path.join(process.cwd(), ".env");
      const baseUrl =
        process.env.OHBABY_CONNECT_REAL_BASE_URL ?? DEFAULT_BASE_URL;
      const model = process.env.OHBABY_CONNECT_REAL_MODEL ?? DEFAULT_MODEL;

      try {
        const result = await applyActiveModelConfig({
          apiKeyEnv: "ZENMUX_API_KEY",
          baseUrl,
          interfaceProvider: "anthropic",
          model,
          modelJsonPath,
          projectRoot,
          provider: "zenmux",
          envPath,
        });

        expect(result.saved).toBe(true);
        expect(result.provider).toBe("zenmux");
        expect(result.apiKeyEnv).toBe("ZENMUX_API_KEY");
        expect(JSON.stringify(result)).not.toContain(apiKey);
        expect(result.contextWindowTokens).toBeGreaterThanOrEqual(200_000);

        const client = await createLLMClient({
          envPath,
          modelJsonPath,
          projectDirectory: projectRoot,
        });
        expect(client.provider.kind).toBe("anthropic");
        expect("apiKey" in client.config).toBe(false);

        let fullText = "";
        for await (const response of streamChatCompletion(client, [
          {
            role: "user",
            content: `Reply with exactly: ${MARKER}`,
          },
        ])) {
          if (typeof response.completeMessage.content === "string") {
            fullText = response.completeMessage.content;
          }
          if (normalize(fullText).includes(normalize(MARKER))) {
            break;
          }
        }

        expect(normalize(fullText)).toContain(normalize(MARKER));
      } finally {
        await rm(projectRoot, { recursive: true, force: true });
      }
    },
    180_000,
  );
});

function normalize(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "").toUpperCase();
}

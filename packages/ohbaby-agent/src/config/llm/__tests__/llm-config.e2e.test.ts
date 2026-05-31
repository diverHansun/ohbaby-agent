import * as path from "node:path";
import { config as loadDotenv } from "dotenv";
import { describe, expect, it, beforeEach } from "vitest";
import {
  createLLMClient,
  streamChatCompletion,
} from "../../../core/llm-client/index.js";
import { _LLMConfigManager as LLMConfigManager } from "../index.js";

const runE2E = process.env.OHBABY_LLM_E2E === "1" ? describe : describe.skip;

runE2E("LLM config real API e2e", () => {
  beforeEach(() => {
    LLMConfigManager.resetInstance();
    loadDotenv({ path: path.join(process.cwd(), ".env") });
  });

  it("should load configured credentials and stream one minimal response", async () => {
    const client = await createLLMClient({ projectDirectory: process.cwd() });
    let sawResponse = false;

    for await (const response of streamChatCompletion(client, [
      { role: "user", content: "Reply with exactly: ok" },
    ])) {
      if (
        response.completeMessage.content ||
        response.finishReason !== undefined
      ) {
        sawResponse = true;
      }
    }

    expect(sawResponse).toBe(true);
    expect("apiKey" in client.config).toBe(false);
  });
});

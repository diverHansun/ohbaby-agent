import * as path from "node:path";
import { config as loadDotenv } from "dotenv";
import { describe, expect, it, beforeEach } from "vitest";
import {
  createLLMClient,
  streamChatCompletion,
} from "../../../core/llm-client/index.js";
import { _LLMConfigManager as LLMConfigManager } from "../index.js";

const runE2E = process.env.OHBABY_LLM_E2E === "1" ? describe : describe.skip;
const MARKER = "OHBABY_LLM_REAL_OK";

runE2E("LLM config real API e2e", () => {
  beforeEach(() => {
    LLMConfigManager.resetInstance();
    loadDotenv({ path: path.join(process.cwd(), ".env") });
  });

  it("should load configured credentials and stream one marker response", async () => {
    const client = await createLLMClient({ projectDirectory: process.cwd() });
    let fullText = "";

    for await (const response of streamChatCompletion(client, [
      { role: "user", content: `Reply with exactly: ${MARKER}` },
    ])) {
      if (typeof response.completeMessage.content === "string") {
        fullText = response.completeMessage.content;
      }
      if (normalize(fullText).includes(normalize(MARKER))) {
        break;
      }
    }

    expect(normalize(fullText)).toContain(normalize(MARKER));
    expect("apiKey" in client.config).toBe(false);
  });
});

function normalize(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "").toUpperCase();
}

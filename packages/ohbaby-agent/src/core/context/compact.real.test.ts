import * as path from "node:path";
import { config as loadDotenv } from "dotenv";
import { beforeEach, describe, expect, it } from "vitest";
import { probeContextWindow } from "../../config/llm/context-window-probe.js";
import type { MessageWithParts } from "../message/index.js";
import { serializeForLlm } from "./serializer.js";

const runRealE2E =
  process.env.OHBABY_COMPACT_REAL_E2E === "1" ? describe : describe.skip;

const DEFAULT_BASE_URL = "https://zenmux.ai/api/anthropic";
const DEFAULT_MODEL = "moonshotai/kimi-k2.6";

interface AnthropicMessageResponse {
  readonly content?: readonly { readonly text?: string; readonly type?: string }[];
}

runRealE2E("compact real ZenMux/Kimi e2e", () => {
  beforeEach(() => {
    loadDotenv({ path: path.join(process.cwd(), ".env") });
  });

  it(
    "detects Kimi K2.6 context window from Anthropic-compatible model metadata",
    async () => {
      const apiKey = requireZenMuxApiKey();
      const result = await probeContextWindow({
        apiKey,
        baseUrl: process.env.OHBABY_COMPACT_REAL_BASE_URL ?? DEFAULT_BASE_URL,
        interfaceProvider: "anthropic",
        model: process.env.OHBABY_COMPACT_REAL_MODEL ?? DEFAULT_MODEL,
      });

      expect(result).toEqual({ contextWindowTokens: 262_144 });
    },
    180_000,
  );

  it(
    "accepts a serialized user-wrapped context summary request",
    async () => {
      const apiKey = requireZenMuxApiKey();
      const baseUrl =
        process.env.OHBABY_COMPACT_REAL_BASE_URL ?? DEFAULT_BASE_URL;
      const model = process.env.OHBABY_COMPACT_REAL_MODEL ?? DEFAULT_MODEL;
      const marker = `OHBABY_COMPACT_${String(Date.now())}`;
      const messages = serializeForLlm({
        history: [
          contextSummaryMessage(
            `## Goal\n- Preserve the marker ${marker} for the next turn.`,
          ),
          userMessage(`Reply with exactly: ${marker}`),
        ],
        isSubagent: false,
        memory: { global: "", project: "", merged: "" },
        systemPrompt: "",
      });

      expect(messages[0]).toMatchObject({
        role: "user",
        content: expect.stringContaining("<context_summary>") as string,
      });

      const response = await fetch(`${baseUrl.replace(/\/+$/u, "")}/v1/messages`, {
        body: JSON.stringify({
          max_tokens: 32,
          messages: messages.map((message) => ({
            content: message.content,
            role: message.role,
          })),
          model,
          temperature: 0,
        }),
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        method: "POST",
      });

      const payload = (await response.json()) as AnthropicMessageResponse;
      if (!response.ok) {
        throw new Error(
          `ZenMux compact e2e failed with HTTP ${String(response.status)}`,
        );
      }
      expect(normalize(responseText(payload))).toContain(normalize(marker));
    },
    180_000,
  );
});

function requireZenMuxApiKey(): string {
  const apiKey = process.env.ZENMUX_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Set ZENMUX_API_KEY in the environment or root .env for compact real e2e.",
    );
  }
  return apiKey;
}

function contextSummaryMessage(text: string): MessageWithParts {
  return {
    info: {
      agent: "context",
      id: "summary",
      role: "assistant",
      sessionId: "session_1",
      time: { created: 1_000 },
    },
    parts: [
      {
        id: "summary_part",
        messageId: "summary",
        metadata: { kind: "context-summary" },
        orderIndex: 0,
        sessionId: "session_1",
        synthetic: true,
        text,
        type: "text",
      },
    ],
  };
}

function userMessage(text: string): MessageWithParts {
  return {
    info: {
      agent: "user",
      id: "user",
      role: "user",
      sessionId: "session_1",
      time: { created: 2_000 },
    },
    parts: [
      {
        id: "user_part",
        messageId: "user",
        orderIndex: 0,
        sessionId: "session_1",
        text,
        type: "text",
      },
    ],
  };
}

function responseText(payload: unknown): string {
  if (!isRecord(payload)) {
    return "";
  }
  const content = payload.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
}

function normalize(value: string): string {
  return value.replace(/[^A-Za-z0-9]/gu, "").toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

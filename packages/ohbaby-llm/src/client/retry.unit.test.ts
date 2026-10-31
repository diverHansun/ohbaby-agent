import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicConnectionTimeoutError,
} from "@anthropic-ai/sdk/error";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { isRetryableProviderError } from "./retry.js";

describe("provider retry classification", () => {
  it.each([
    { status: 503, code: "context_length_exceeded" },
    { status: 429, message: "maximum context window exceeded" },
    { code: "ECONNRESET", message: "input token limit exceeded" },
  ])(
    "excludes context overflow before transient classification: %j",
    (error) => {
      expect(isRetryableProviderError(error)).toBe(false);
    },
  );

  it.each([{ status: 503 }, { status: 429 }, { code: "ECONNRESET" }])(
    "preserves ordinary transient retries: %j",
    (error) => {
      expect(isRetryableProviderError(error)).toBe(true);
    },
  );

  it.each([
    new OpenAI.APIConnectionError({ message: "Connection error." }),
    new OpenAI.APIConnectionTimeoutError(),
    new AnthropicConnectionError({ message: "Connection error." }),
    new AnthropicConnectionTimeoutError(),
  ])(
    "retries SDK-wrapped network failures without a status or code: $message",
    (error) => {
      expect(isRetryableProviderError(error)).toBe(true);
    },
  );
});

import { describe, expect, it, vi } from "vitest";
import {
  buildModelMetadataUrl,
  extractContextWindowTokens,
  probeContextWindow,
} from "../context-window-probe.js";

describe("context window metadata probe helpers", () => {
  it("builds Anthropic-compatible model metadata URLs from common base URL shapes", () => {
    expect(
      buildModelMetadataUrl({
        baseUrl: "https://zenmux.ai/api/anthropic",
        interfaceProvider: "anthropic",
      }),
    ).toBe("https://zenmux.ai/api/anthropic/v1/models");
    expect(
      buildModelMetadataUrl({
        baseUrl: "https://zenmux.ai/api/anthropic/v1",
        interfaceProvider: "anthropic",
      }),
    ).toBe("https://zenmux.ai/api/anthropic/v1/models");
    expect(
      buildModelMetadataUrl({
        baseUrl: "https://zenmux.ai/api/anthropic/v1/messages",
        interfaceProvider: "anthropic",
      }),
    ).toBe("https://zenmux.ai/api/anthropic/v1/models");
  });

  it("builds OpenAI-compatible model metadata URLs from common base URL shapes", () => {
    expect(
      buildModelMetadataUrl({
        baseUrl: "https://api.example.com/v1",
        interfaceProvider: "openai-compatible",
      }),
    ).toBe("https://api.example.com/v1/models");
    expect(
      buildModelMetadataUrl({
        baseUrl: "https://api.example.com/v1/chat/completions",
        interfaceProvider: "openai-compatible",
      }),
    ).toBe("https://api.example.com/v1/models");
  });

  it("extracts input context fields and ignores output token fields", () => {
    expect(extractContextWindowTokens({ context_length: 262_144 })).toBe(
      262_144,
    );
    expect(extractContextWindowTokens({ contextWindow: 262_144 })).toBe(
      262_144,
    );
    expect(extractContextWindowTokens({ context_window: 262_144 })).toBe(
      262_144,
    );
    expect(extractContextWindowTokens({ context_window_tokens: 262_144 })).toBe(
      262_144,
    );
    expect(extractContextWindowTokens({ max_input_tokens: 262_144 })).toBe(
      262_144,
    );
    expect(extractContextWindowTokens({ max_context_tokens: 262_144 })).toBe(
      262_144,
    );
    expect(extractContextWindowTokens({ max_tokens: 16_384 })).toBeUndefined();
  });

  it("prefers an exact model id over an earlier fuzzy match", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { context_length: 128_000, id: "openai/gpt-4o-2024-11-20" },
            { context_length: 1_000_000, id: "openai/gpt-4.1" },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(
        probeContextWindow({
          apiKey: "secret",
          baseUrl: "https://api.example.com/v1",
          interfaceProvider: "openai-compatible",
          model: "openai/gpt-4.1",
        }),
      ).resolves.toEqual({ contextWindowTokens: 1_000_000 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to provider-prefixed fuzzy matching for Kimi aliases", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ context_length: 262_144, id: "moonshotai/kimi-k2.6" }],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(
        probeContextWindow({
          apiKey: "secret",
          baseUrl: "https://zenmux.ai/api/anthropic",
          interfaceProvider: "anthropic",
          model: "kimi-2.6",
        }),
      ).resolves.toEqual({ contextWindowTokens: 262_144 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not treat broad digit substrings as a fuzzy model match", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              context_length: 200_000,
              id: "anthropic/claude-3-5-sonnet-20240620",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(
        probeContextWindow({
          apiKey: "secret",
          baseUrl: "https://api.example.com/v1",
          interfaceProvider: "openai-compatible",
          model: "claude-sonnet-4.6",
        }),
      ).resolves.toEqual({
        warning:
          "Unable to detect model context window from metadata; using the configured fallback.",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

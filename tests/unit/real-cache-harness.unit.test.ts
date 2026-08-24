import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterfaceProviderRequest } from "../../packages/ohbaby-agent/src/services/interface-providers/index.js";
import {
  assertAppendExtension,
  assertCacheableStablePrefix,
  CACHE_FIXTURE_FORCE_MARKER,
  installFixtureToolChoice,
  projectRequest,
  resolveAnthropicProfile,
  resolveOpenAiCompatibleProfile,
} from "../smoke/real-cache-harness.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function request(
  promptCache: InterfaceProviderRequest["promptCache"],
  messages: InterfaceProviderRequest["messages"] = [
    { content: "hello", role: "user" },
  ],
): InterfaceProviderRequest {
  return {
    maxTokens: 32,
    messages,
    model: "fixture-model",
    promptCache,
    temperature: 0,
  };
}

describe("real cache harness preflight", () => {
  it("fails before provider setup when the configured cache threshold is too high", () => {
    const stableTokens = assertCacheableStablePrefix(4_096);

    expect(stableTokens).toBeGreaterThanOrEqual(4_096);
    expect(() => assertCacheableStablePrefix(stableTokens + 1)).toThrow(
      /below the configured minimum/u,
    );
  });

  it("records and compares both keyed and keyless cache projections", () => {
    const keyed = projectRequest(
      request({
        key: "session-scope-key",
        reason: "test",
        strategy: "openai-keyed-implicit",
      }),
      0,
    );
    const keylessLeft = projectRequest(
      request({ reason: "test", strategy: "anthropic-top-level-auto" }),
      0,
    );
    const keylessRight = projectRequest(
      request({ reason: "test", strategy: "anthropic-top-level-auto" }, [
        { content: "hello", role: "user" },
        { content: "world", role: "assistant" },
      ]),
      0,
    );

    expect(keyed).toMatchObject({ cacheKeyPresent: true });
    expect(keyed.cacheKeyFingerprint).toHaveLength(16);
    expect(keylessLeft).toMatchObject({ cacheKeyPresent: false });
    expect(keylessLeft.cacheKeyFingerprint).toBeUndefined();
    expect(() =>
      assertAppendExtension(keylessLeft, keylessRight),
    ).not.toThrow();
  });

  it("resolves ZenMux through its official OpenAI and Anthropic base URLs", () => {
    vi.stubEnv("ZENMUX_API_KEY", "test-only");
    vi.stubEnv("OHBABY_REAL_CACHE_OPENAI_MODEL", "deepseek/deepseek-v4-flash");
    vi.stubEnv(
      "OHBABY_REAL_CACHE_ANTHROPIC_MODEL",
      "deepseek/deepseek-v4-flash",
    );

    expect(resolveOpenAiCompatibleProfile()).toMatchObject({
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/v1",
      disableReasoningForForcedToolChoice: true,
      interfaceProvider: "openai-compatible",
      model: "deepseek/deepseek-v4-flash",
      provider: "zenmux",
    });
    expect(resolveAnthropicProfile()).toMatchObject({
      allowsUnreportedImplicitCacheWrite: true,
      apiKeyEnv: "ZENMUX_API_KEY",
      baseUrl: "https://zenmux.ai/api/anthropic",
      disableReasoningForForcedToolChoice: true,
      interfaceProvider: "anthropic",
      model: "deepseek/deepseek-v4-flash",
      provider: "zenmux",
    });

    vi.stubEnv("OHBABY_REAL_CACHE_ANTHROPIC_MODEL", "anthropic/claude-test");
    expect(resolveAnthropicProfile()).not.toHaveProperty(
      "allowsUnreportedImplicitCacheWrite",
    );
  });

  it("drops stale content-length after injecting the deterministic tool choice", async () => {
    const outbound = vi.fn(() => Promise.resolve(new Response(null)));
    vi.stubGlobal("fetch", outbound);
    const restore = installFixtureToolChoice("openai-compatible", true);

    try {
      await fetch("https://example.test/v1/chat/completions", {
        body: JSON.stringify({
          messages: [
            {
              content: CACHE_FIXTURE_FORCE_MARKER,
              role: "user",
            },
          ],
        }),
        headers: {
          "content-length": "1",
          "content-type": "application/json",
        },
        method: "POST",
      });

      const [, forwardedInit] = outbound.mock.calls[0] ?? [];
      const forwardedHeaders = new Headers(forwardedInit?.headers);
      expect(forwardedHeaders.has("content-length")).toBe(false);
      expect(forwardedHeaders.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(forwardedInit?.body))).toMatchObject({
        reasoning: { enabled: false },
        tool_choice: {
          function: { name: "cache_fixture_read" },
          type: "function",
        },
      });
    } finally {
      restore();
    }
  });

  it("rewrites Request input without forwarding its stale content-length", async () => {
    const outbound = vi.fn(() => Promise.resolve(new Response(null)));
    vi.stubGlobal("fetch", outbound);
    const restore = installFixtureToolChoice("openai-compatible", true);

    try {
      const request = new Request("https://example.test/v1/chat/completions", {
        body: JSON.stringify({
          messages: [
            {
              content: CACHE_FIXTURE_FORCE_MARKER,
              role: "user",
            },
          ],
        }),
        headers: {
          "content-length": "1",
          "content-type": "application/json",
        },
        method: "POST",
      });

      await fetch(request);

      const [forwarded] = outbound.mock.calls[0] ?? [];
      expect(forwarded).toBeInstanceOf(Request);
      const forwardedRequest = forwarded as Request;
      expect(forwardedRequest.method).toBe("POST");
      expect(forwardedRequest.headers.has("content-length")).toBe(false);
      expect(forwardedRequest.headers.get("content-type")).toBe(
        "application/json",
      );
      await expect(forwardedRequest.json()).resolves.toMatchObject({
        reasoning: { enabled: false },
        tool_choice: {
          function: { name: "cache_fixture_read" },
          type: "function",
        },
      });
    } finally {
      restore();
    }
  });

  it("disables reasoning with the Anthropic protocol conversion shape", async () => {
    const outbound = vi.fn(() => Promise.resolve(new Response(null)));
    vi.stubGlobal("fetch", outbound);
    const restore = installFixtureToolChoice("anthropic", true);

    try {
      await fetch("https://example.test/v1/messages", {
        body: JSON.stringify({
          messages: [
            {
              content: CACHE_FIXTURE_FORCE_MARKER,
              role: "user",
            },
          ],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      const [, forwardedInit] = outbound.mock.calls[0] ?? [];
      expect(JSON.parse(String(forwardedInit?.body))).toMatchObject({
        thinking: { type: "disabled" },
        tool_choice: { name: "cache_fixture_read", type: "tool" },
      });
    } finally {
      restore();
    }
  });
});

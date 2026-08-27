import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InterfaceProviderRequest } from "../../packages/ohbaby-agent/src/services/interface-providers/index.js";
import {
  assertAppendExtension,
  assertCacheableStablePrefix,
  CACHE_FIXTURE_FORCE_MARKER,
  CACHE_FIXTURE_READ_TOOL,
  createRealCacheHarness,
  installFixtureToolChoice,
  projectRequest,
  resolveAnthropicProfile,
  resolveOpenAiCompatibleProfile,
} from "../smoke/real-cache-harness.js";

function openAiSse(chunks: readonly unknown[]): Response {
  return new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" }, status: 200 },
  );
}

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
  it("carries the resolved tool snapshot into the first provider request", async () => {
    const evidenceDirectory = await mkdtemp(
      join(tmpdir(), "ohbaby-cache-harness-unit-"),
    );
    const requests: Record<string, unknown>[] = [];
    vi.stubEnv("OHBABY_CACHE_HARNESS_TEST_KEY", "test-only");
    vi.stubEnv("OHBABY_REAL_CACHE_EVIDENCE_DIR", evidenceDirectory);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        if (requests.length === 1) {
          return openAiSse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: {
                          arguments: '{"path":"fixture.txt"}',
                          name: CACHE_FIXTURE_READ_TOOL,
                        },
                        id: "call_cache_fixture",
                        index: 0,
                        type: "function",
                      },
                    ],
                  },
                  finish_reason: null,
                  index: 0,
                },
              ],
            },
            {
              choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }],
            },
          ]);
        }
        return openAiSse([
          {
            choices: [
              {
                delta: { content: "done" },
                finish_reason: null,
                index: 0,
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          },
        ]);
      }),
    );
    const harness = await createRealCacheHarness({
      apiKeyEnv: "OHBABY_CACHE_HARNESS_TEST_KEY",
      baseUrl: "https://cache-harness.invalid/v1",
      interfaceProvider: "openai-compatible",
      minimumCacheableTokens: 1,
      model: "fixture-model",
      provider: "fixture",
    });

    try {
      const turn = await harness.runTurn({
        maxSteps: 2,
        prompt: `${CACHE_FIXTURE_FORCE_MARKER} read fixture.txt`,
        sessionId: "session_tools",
      });
      const firstTools = requests[0]?.tools;

      expect(Array.isArray(firstTools)).toBe(true);
      expect(firstTools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            function: expect.objectContaining({
              name: CACHE_FIXTURE_READ_TOOL,
            }),
          }),
        ]),
      );
      expect(turn.projections[0]?.toolNames).toContain(CACHE_FIXTURE_READ_TOOL);
      expect(harness.fixtureExecutions()).toBe(1);
    } finally {
      await harness.close();
      await rm(evidenceDirectory, { force: true, recursive: true });
    }
  });

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

import { describe, expect, it } from "vitest";
import type { InterfaceProviderRequest } from "../../packages/ohbaby-agent/src/services/interface-providers/index.js";
import {
  assertAppendExtension,
  assertCacheableStablePrefix,
  projectRequest,
} from "../smoke/real-cache-harness.js";

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
});

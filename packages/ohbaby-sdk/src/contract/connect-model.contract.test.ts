import { describe, expect, expectTypeOf, it } from "vitest";
import {
  connectUrlPathWarning,
  inferConnectModelInterfaceProvider,
} from "./connect-model.js";
import type {
  UiConnectModelInput,
  UiConnectModelInterfaceProvider,
  UiCurrentModelInterfaceProvider,
  UiProbeModelContextWindowInput,
} from "./connect-model.js";

describe("model interface-provider UI boundary", () => {
  it("accepts the same three protocols for current, connect and probe", () => {
    expectTypeOf<UiConnectModelInterfaceProvider>().toEqualTypeOf<
      "openai-compatible" | "openai-responses" | "anthropic"
    >();
    expectTypeOf<UiCurrentModelInterfaceProvider>().toEqualTypeOf<UiConnectModelInterfaceProvider>();
    expectTypeOf<
      UiConnectModelInput["interfaceProvider"]
    >().toEqualTypeOf<UiConnectModelInterfaceProvider>();
    expectTypeOf<
      UiProbeModelContextWindowInput["interfaceProvider"]
    >().toEqualTypeOf<UiConnectModelInterfaceProvider>();
    const choice: UiConnectModelInterfaceProvider = "openai-responses";
    expect(choice).toBe("openai-responses");
  });
  it("keeps legacy URL inference and defaults OpenAI to Chat", () => {
    expect(
      inferConnectModelInterfaceProvider("https://api.openai.com/v1"),
    ).toBe("openai-compatible");
    expect(
      inferConnectModelInterfaceProvider("https://api.anthropic.com"),
    ).toBe("anthropic");
  });
  it.each([
    ["openai-compatible", "https://example.test/v1/chat/completions"],
    ["openai-responses", "https://example.test/v1/responses/"],
    ["anthropic", "https://example.test/v1/messages"],
  ] as const)(
    "warns when %s base URL already includes its request path",
    (protocol, url) => {
      expect(connectUrlPathWarning(url, protocol)).toMatch(/request path/i);
    },
  );
  it.each(["openai-compatible", "openai-responses"] as const)(
    "does not warn for ZenMux /api/v1 with %s",
    (protocol) => {
      expect(
        connectUrlPathWarning("https://zenmux.ai/api/v1", protocol),
      ).toBeUndefined();
    },
  );
  it("warns for the ZenMux Anthropic /api/v1 route observed failing in a full Claude request", () => {
    expect(
      connectUrlPathWarning(
        "https://zenmux.ai/api/v1",
        "anthropic",
        "anthropic/claude-sonnet-5",
      ),
    ).toContain("https://zenmux.ai/api/anthropic");
    expect(
      connectUrlPathWarning(
        "https://zenmux.ai/api/anthropic",
        "anthropic",
        "anthropic/claude-sonnet-5",
      ),
    ).toBeUndefined();
    expect(
      connectUrlPathWarning(
        "https://other.example/api/v1",
        "anthropic",
        "anthropic/claude-sonnet-5",
      ),
    ).toBeUndefined();
    expect(
      connectUrlPathWarning(
        "https://zenmux.ai/api/v1",
        "anthropic",
        "anthropic/other-model",
      ),
    ).toBeUndefined();
  });
  it("does not warn when a path contains a resource name without ending in it", () => {
    expect(
      connectUrlPathWarning(
        "https://example.test/responses/proxy",
        "openai-responses",
      ),
    ).toBeUndefined();
  });
  it("warns when a Responses client receives a Chat completions resource URL", () => {
    expect(
      connectUrlPathWarning(
        "https://gateway.example/v1/chat/completions",
        "openai-responses",
      ),
    ).toMatch(/request path/i);
  });
});

import { describe, expect, it } from "vitest";
import {
  createInterfaceProvider,
  resolveInterfaceProviderKind,
} from "./index.js";

describe("interface provider registry", () => {
  it("should default to openai-compatible without inferring from vendor id", () => {
    expect(resolveInterfaceProviderKind(undefined)).toBe("openai-compatible");
    expect(
      createInterfaceProvider({
        id: "anthropic",
        interfaceProvider: undefined,
        apiKey: "test-key",
        baseUrl: "https://api.anthropic.com",
      }).kind,
    ).toBe("openai-compatible");
  });

  it("should create anthropic adapter only when interfaceProvider is explicit", () => {
    expect(resolveInterfaceProviderKind("anthropic")).toBe("anthropic");
    expect(
      createInterfaceProvider({
        id: "claude",
        interfaceProvider: "anthropic",
        apiKey: "test-key",
        baseUrl: "https://api.anthropic.com",
      }).kind,
    ).toBe("anthropic");
  });

  it("does not fall through to the Chat Completions adapter for Responses", () => {
    expect(() => {
      createInterfaceProvider({
        id: "openai",
        interfaceProvider: "openai-responses",
        apiKey: "test-key",
        baseUrl: "https://api.openai.com/v1",
      });
    }).toThrow(/Responses.*not implemented/u);
  });
});

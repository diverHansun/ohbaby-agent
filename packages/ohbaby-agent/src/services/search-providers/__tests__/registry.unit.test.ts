import { describe, expect, it } from "vitest";
import {
  createSearchProvider,
  InvalidProviderConfigError,
  registerSearchProvider,
  UnknownProviderError,
} from "../index.js";
import type { SearchProvider } from "../index.js";

function createMockProvider(id: string): SearchProvider {
  return {
    id,
    fetch: () => Promise.resolve([]),
    search: () => Promise.resolve([]),
  };
}

describe("search provider registry unit", () => {
  it("creates a registered provider by id", () => {
    const providerId = "mock-registry";
    registerSearchProvider(providerId, () => createMockProvider(providerId));

    const provider = createSearchProvider({
      apiKey: "test-key",
      providerId,
    });

    expect(provider.id).toBe(providerId);
  });

  it("rejects unknown providers with a clear error", () => {
    expect(() =>
      createSearchProvider({
        apiKey: "test-key",
        providerId: "missing-provider",
      }),
    ).toThrow(UnknownProviderError);
  });

  it("rejects missing API keys before creating clients", () => {
    expect(() =>
      createSearchProvider({
        apiKey: " ",
        providerId: "tavily",
      }),
    ).toThrow(InvalidProviderConfigError);
  });
});

import { describe, expect, it } from "vitest";
import { SearchConfigError, type SearchConfigErrorCode } from "../types.js";
import { validateApiKey, validateSearchJson } from "../validation.js";

function expectSearchConfigError(
  action: () => void,
  code: SearchConfigErrorCode,
): void {
  let thrownError: unknown;
  try {
    action();
  } catch (error) {
    thrownError = error;
  }

  expect(thrownError).toBeInstanceOf(SearchConfigError);
  expect((thrownError as SearchConfigError).code).toBe(code);
}

describe("config/tools/search validation", () => {
  it("fills defaults for an empty search.json object", () => {
    expect(validateSearchJson({})).toEqual({
      apiKeyEnv: "TAVILY_API_KEY",
      defaults: {
        maxResults: 5,
        searchDepth: "basic",
        timeout: 60,
        topic: "general",
      },
      provider: "tavily",
    });
  });

  it("accepts a complete Tavily search configuration", () => {
    expect(
      validateSearchJson({
        apiKeyEnv: "CUSTOM_TAVILY_KEY",
        baseUrl: "https://search.example.com",
        defaults: {
          maxResults: 10,
          searchDepth: "advanced",
          timeout: 120,
          topic: "news",
        },
        provider: "tavily",
      }),
    ).toEqual({
      apiKeyEnv: "CUSTOM_TAVILY_KEY",
      baseUrl: "https://search.example.com",
      defaults: {
        maxResults: 10,
        searchDepth: "advanced",
        timeout: 120,
        topic: "news",
      },
      provider: "tavily",
    });
  });

  it("rejects invalid provider, URL, and defaults with VALIDATION_FAILED", () => {
    expect(() =>
      validateSearchJson({
        baseUrl: "not-a-url",
        defaults: { maxResults: 100, searchDepth: "deep" },
        provider: "unknown",
      }),
    ).toThrow(SearchConfigError);
    expect(() =>
      validateSearchJson({
        baseUrl: "not-a-url",
        defaults: { maxResults: 100, searchDepth: "deep" },
        provider: "unknown",
      }),
    ).toThrow(/provider/);
  });

  it("resolves and trims API keys from the configured environment variable", () => {
    expect(
      validateApiKey(
        {
          TAVILY_API_KEY: " tvly-test-key ",
        },
        "TAVILY_API_KEY",
      ),
    ).toBe("tvly-test-key");
  });

  it("distinguishes missing and empty API keys", () => {
    expectSearchConfigError(
      () => validateApiKey({}, "TAVILY_API_KEY"),
      "MISSING_API_KEY",
    );
    expectSearchConfigError(
      () => validateApiKey({ TAVILY_API_KEY: "  " }, "TAVILY_API_KEY"),
      "EMPTY_API_KEY",
    );
  });
});

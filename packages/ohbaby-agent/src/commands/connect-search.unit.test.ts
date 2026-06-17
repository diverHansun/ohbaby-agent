import { describe, expect, it } from "vitest";
import { parseConnectSearchArgs } from "./connect-search.js";

describe("parseConnectSearchArgs", () => {
  it("uses Tavily defaults when no arguments are provided", () => {
    expect(parseConnectSearchArgs([])).toEqual({
      apiKeyEnv: "TAVILY_API_KEY",
      provider: "tavily",
    });
  });

  it("accepts non-sensitive provider and api key env arguments", () => {
    expect(
      parseConnectSearchArgs([
        "--provider=tavily",
        "--api-key-env",
        "CUSTOM_TAVILY_KEY",
      ]),
    ).toEqual({
      apiKeyEnv: "CUSTOM_TAVILY_KEY",
      provider: "tavily",
    });
  });

  it("rejects API key arguments without echoing the key value", () => {
    const result = parseConnectSearchArgs(["--api-key", "tvly-secret-value"]);

    expect(result).toMatchObject({
      code: "UNSUPPORTED_SECRET_ARG",
    });
    expect(JSON.stringify(result)).not.toContain("tvly-secret-value");
  });

  it("does not echo unknown argument values", () => {
    const result = parseConnectSearchArgs(["tvly-unknown-secret"]);

    expect(result).toMatchObject({
      code: "INVALID_ARGS",
      message: "Unknown /connect-search argument",
    });
    expect(JSON.stringify(result)).not.toContain("tvly-unknown-secret");
  });

  it("does not echo unsupported provider values", () => {
    const result = parseConnectSearchArgs([
      "--provider",
      "tvly-provider-secret",
    ]);

    expect(result).toMatchObject({
      code: "INVALID_ARGS",
      message: "Unsupported search provider",
    });
    expect(JSON.stringify(result)).not.toContain("tvly-provider-secret");
  });
});

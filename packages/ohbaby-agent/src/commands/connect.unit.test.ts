import { describe, expect, it } from "vitest";
import { parseConnectArgs } from "./connect.js";

const required = [
  "--provider",
  "test",
  "--base-url",
  "https://example.com/v1",
  "--model",
  "test-model",
];

describe("connect protocol arguments", () => {
  it.each(["openai-compatible", "openai-responses", "anthropic"])(
    "preserves explicit %s when editing window settings",
    (interfaceProvider) => {
      expect(
        parseConnectArgs([
          ...required,
          "--interface-provider",
          interfaceProvider,
          "--context-window",
          "1000",
        ]),
      ).toMatchObject({ interfaceProvider, contextWindowTokens: 1000 });
    },
  );
  it.each(["", "invalid", "null"])("rejects invalid explicit %s", (value) => {
    expect(
      parseConnectArgs([...required, `--interface-provider=${value}`]),
    ).toMatchObject({ code: "INVALID_ARGS" });
  });
  it("infers omitted protocols and defaults OpenAI addresses to Chat", () => {
    expect(parseConnectArgs(required)).toMatchObject({
      interfaceProvider: "openai-compatible",
    });
    expect(
      parseConnectArgs([
        "--provider",
        "test",
        "--base-url",
        "https://api.anthropic.com",
        "--model",
        "test",
      ]),
    ).toMatchObject({ interfaceProvider: "anthropic" });
  });
});

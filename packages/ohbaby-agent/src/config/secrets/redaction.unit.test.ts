import { describe, expect, it } from "vitest";
import { redactSettingsError, redactSettingsUrl } from "./redaction.js";

describe("settings redaction", () => {
  it("preserves ordinary URLs without unrelated environment values", () => {
    expect(redactSettingsUrl("http://localhost:8080/v1")).toBe(
      "http://localhost:8080/v1",
    );
    expect(
      redactSettingsUrl("http://localhost:1/v1/long-secret-value", [
        "long-secret-value",
      ]),
    ).not.toContain("long-secret-value");
  });

  it("does not throw on malformed percent-encoding in MCP URL credentials", () => {
    expect(() =>
      redactSettingsError("connect failed", [
        {
          type: "http",
          url: "https://bad%zzuser:pass%zz@mcp.example/mcp",
          enabled: true,
          trust: false,
          timeout: 5000,
        },
      ]),
    ).not.toThrow();
  });
});

it("redacts explicit short credentials without masking generic ports and flags", () => {
  expect(
    redactSettingsError("upstream rejected abc123", [
      {
        type: "http",
        url: "https://mcp.example",
        headers: { "X-Api-Key": "abc123" },
        enabled: true,
        trust: false,
        timeout: 5000,
      },
    ]),
  ).not.toContain("abc123");
  expect(
    redactSettingsUrl("http://localhost:8080/v1/abc123", ["abc123"]),
  ).not.toContain("abc123");
  const config = {
    type: "stdio" as const,
    command: "fake",
    args: [],
    env: { PORT: "8080", DEBUG: "1", API_KEY: "abc123" },
    enabled: true,
    trust: false,
    timeout: 5000,
  };
  expect(
    redactSettingsError("port 8080, debug 1, rejected abc123", [config]),
  ).toBe("port 8080, debug 1, rejected [REDACTED]");
});

import { describe, expect, it } from "vitest";
import {
  redactSettingsArgs,
  redactSettingsError,
  redactSettingsUrl,
} from "./redaction.js";

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

  it.each([
    [
      "server -H'Authorization: Basic demo-credential' --port 8080",
      "server -H[REDACTED] --port 8080",
    ],
    [
      'server -H"X-Custom-Auth: demo credential" --port 8080',
      "server -H[REDACTED] --port 8080",
    ],
    [
      "server -HX-Custom-Auth:demo-credential --port 8080",
      "server -H[REDACTED] --port 8080",
    ],
    [
      "server --header=X-Custom-Auth:demo-credential --port 8080",
      "server --header=[REDACTED] --port 8080",
    ],
    [
      "server --headers=X-Custom-Auth:demo-credential --port 8080",
      "server --headers=[REDACTED] --port 8080",
    ],
  ])(
    "masks attached header values in settings arguments and errors: %s",
    (script, expected) => {
      const config = {
        type: "stdio" as const,
        command: "sh",
        args: ["-c", script],
        enabled: true,
        trust: false,
        timeout: 5000,
      };

      expect(redactSettingsArgs(config)).toEqual(["-c", expected]);
      expect(redactSettingsError(`Spawn failed: ${script}`, [config])).toBe(
        `Spawn failed: ${expected}`,
      );
      expect(config.args).toEqual(["-c", script]);
    },
  );

  it.each([
    [
      ["-c", "server -H'Authorization: Basic demo-credential' --port 8080"],
      "demo-credential",
    ],
    [
      ["-c", 'server -H"X-Custom-Auth: demo credential" --port 8080'],
      "demo credential",
    ],
    [
      ["-c", "server -H 'X-Custom-Auth: demo credential' --port 8080"],
      "demo credential",
    ],
    [
      ["-c", "server --header=X-Custom-Auth:demo-credential --port 8080"],
      "demo-credential",
    ],
    [
      ["-c", "server --headers='X-Custom-Auth: demo credential' --port 8080"],
      "demo credential",
    ],
    [
      ["-c", "server --api-key='demo credential' --port 8080"],
      "demo credential",
    ],
    [["--header", "Authorization: Basic demo-credential"], "demo-credential"],
    [["-HAuthorization: Basic demo-credential"], "demo-credential"],
  ] satisfies [string[], string][])(
    "masks extracted credential values in errors for %j",
    (args, secret) => {
      const config = {
        type: "stdio" as const,
        command: "sh",
        args: [...args],
        env: { PORT: "8080", DEBUG: "1" },
        enabled: true,
        trust: false,
        timeout: 5000,
      };

      expect(
        redactSettingsError(`Rejected ${secret}; port 8080, debug 1`, [config]),
      ).toBe("Rejected [REDACTED]; port 8080, debug 1");
      expect(JSON.stringify(redactSettingsArgs(config))).not.toContain(secret);
      expect(config.args).toEqual(args);
    },
  );
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

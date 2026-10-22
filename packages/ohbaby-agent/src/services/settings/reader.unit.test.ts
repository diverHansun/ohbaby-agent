import { describe, expect, it } from "vitest";
import { redactSettingsError } from "./reader.js";
import type { McpServerConfig } from "../../config/mcp/types.js";

const common = { enabled: true, trust: false, timeout: 1000 };

describe("settings error redaction", () => {
  it.each([
    [
      "headers and environment",
      "Connection refused; header-value env-value",
      [
        {
          ...common,
          type: "http",
          url: "http://localhost/mcp",
          headers: { "X-Custom": "header-value" },
        },
        {
          ...common,
          type: "stdio",
          command: "fake",
          args: [],
          env: { CUSTOM: "env-value" },
        },
      ],
      ["header-value", "env-value"],
    ],
    [
      "URL credentials and query",
      "Failed http://alice:pa%24ss@localhost/mcp?api_key=query-value",
      [
        {
          ...common,
          type: "http",
          url: "http://alice:pa%24ss@localhost/mcp?api_key=query-value",
        },
      ],
      ["alice", "pa%24ss", "query-value"],
    ],
    [
      "generic credentials",
      "Connection refused; Authorization: Bearer token-value; apiKey=api-value; password=pw-value",
      [],
      ["token-value", "api-value", "pw-value"],
    ],
    [
      "sensitive stdio args",
      "Cannot connect --token=argument-value --api-key=key-value",
      [
        {
          ...common,
          type: "stdio",
          command: "fake",
          args: ["--token=argument-value", "--api-key=key-value"],
        },
      ],
      ["argument-value", "key-value"],
    ],
  ] satisfies [string, string, McpServerConfig[], string[]][])(
    "hides %s while preserving the failure reason",
    (_name, error, configs, secrets) => {
      const message = redactSettingsError(error, configs);
      for (const secret of secrets) expect(message).not.toContain(secret);
      expect(message).toContain("[REDACTED]");
      expect(message).toMatch(/Connection refused|Failed|Cannot connect/);
    },
  );
  it("redacts separately supplied credential args", () => {
    const message = redactSettingsError(
      "failed args: --token argument-secret --header X-Custom:arg-header-value",
      [
        {
          ...common,
          type: "stdio",
          command: "fake",
          args: [
            "--token",
            "argument-secret",
            "--header",
            "X-Custom:arg-header-value",
          ],
        },
      ],
    );
    expect(message).not.toContain("argument-secret");
    expect(message).not.toContain("arg-header-value");
  });
  it.each([
    ["--token=opaque-token-value", "opaque-token-value"],
    ["--api-key=opaque-key-value", "opaque-key-value"],
    ["--header=X-Custom:opaque-header-value", "X-Custom:opaque-header-value"],
  ])(
    "redacts a value-only error for configured equals-style arg %s",
    (argument, value) => {
      const message = redactSettingsError(`Connection refused: ${value}`, [
        {
          ...common,
          type: "stdio",
          command: "fake",
          args: [argument],
        },
      ]);
      expect(message).toBe("Connection refused: [REDACTED]");
    },
  );
  it.each([
    [
      ["--header=X-Custom:inline-header-secret"],
      "Failed request with X-Custom: inline-header-secret",
      "inline-header-secret",
    ],
    [
      ["--header", "X-Custom:separate-header-secret"],
      "Failed request with X-Custom: separate-header-secret",
      "separate-header-secret",
    ],
    [
      ["--access-token", "separate-access-secret"],
      "Authentication rejected separate-access-secret",
      "separate-access-secret",
    ],
    [
      ["--refresh-token", "separate-refresh-secret"],
      "Authentication rejected separate-refresh-secret",
      "separate-refresh-secret",
    ],
    [
      ["--access-token=inline-access-secret"],
      "Authentication rejected inline-access-secret",
      "inline-access-secret",
    ],
    [
      ["--refresh-token=inline-refresh-secret"],
      "Authentication rejected inline-refresh-secret",
      "inline-refresh-secret",
    ],
  ])(
    "redacts normalized header or token-alias errors for %j",
    (args, error, secret) => {
      const message = redactSettingsError(error, [
        {
          ...common,
          type: "stdio",
          command: "fake",
          args,
        },
      ]);
      expect(message).not.toContain(secret);
      expect(message).toContain("[REDACTED]");
      expect(message).toMatch(/Failed request|Authentication rejected/);
    },
  );
});

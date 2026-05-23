import { afterEach, describe, expect, it } from "vitest";
import { createTransport } from "../core/transport.js";

describe("createTransport", () => {
  const originalSecret = process.env.OHBABY_MCP_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.OHBABY_MCP_SECRET;
    } else {
      process.env.OHBABY_MCP_SECRET = originalSecret;
    }
  });

  it("passes only explicit stdio env values to the SDK transport", () => {
    process.env.OHBABY_MCP_SECRET = "do-not-forward";

    const transport = createTransport({
      args: [],
      command: "node",
      enabled: true,
      env: { MCP_ALLOWED: "yes" },
      timeout: 5000,
      trust: false,
      type: "stdio",
    });
    const serverParams = (
      transport as unknown as {
        readonly _serverParams: { readonly env?: Record<string, string> };
      }
    )._serverParams;

    expect(serverParams.env).toEqual({ MCP_ALLOWED: "yes" });
    expect(serverParams.env).not.toHaveProperty("OHBABY_MCP_SECRET");
  });
});

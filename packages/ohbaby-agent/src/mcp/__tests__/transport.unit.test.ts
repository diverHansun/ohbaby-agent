import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransport } from "../core/transport.js";
import { PROXY_ENVIRONMENT_KEYS } from "../../utils/network-proxy/policy.js";

describe("createTransport", () => {
  beforeEach(() => {
    // Without an installed snapshot, proxy settings come from process.env;
    // clear the developer shell's values so the expected env stays fixed.
    for (const key of PROXY_ENVIRONMENT_KEYS) {
      vi.stubEnv(key, undefined);
      vi.stubEnv(key.toLowerCase(), undefined);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("passes only explicit stdio env values to the SDK transport", () => {
    vi.stubEnv("OHBABY_MCP_SECRET", "do-not-forward");

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

    expect(serverParams.env).toMatchObject({
      MCP_ALLOWED: "yes",
      NO_PROXY: "localhost,127.0.0.1,::1,127.0.0.0/8",
    });
    expect(serverParams.env).not.toHaveProperty("OHBABY_MCP_SECRET");
  });
});

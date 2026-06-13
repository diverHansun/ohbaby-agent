import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpTransport } from "../types.js";

describe("McpClient default SDK metadata", () => {
  afterEach(() => {
    vi.doUnmock("@modelcontextprotocol/sdk/client/index.js");
    vi.doUnmock("../../package-version.js");
    vi.resetModules();
  });

  it("uses the agent package version for default SDK client metadata", async () => {
    const createdClients: unknown[] = [];

    vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
      Client: class FakeSdkClient {
        readonly close = vi.fn(() => Promise.resolve());
        readonly connect = vi.fn(() => Promise.resolve());
        readonly listTools = vi.fn(() => Promise.resolve({ tools: [] }));
        readonly setNotificationHandler = vi.fn();

        constructor(metadata: unknown) {
          createdClients.push(metadata);
        }
      },
    }));
    vi.doMock("../../package-version.js", () => ({
      getAgentPackageVersion: (): string => "9.9.9",
    }));

    const { McpClient } = await import("../core/client.js");
    const client = new McpClient(
      "test",
      {
        args: [],
        command: "node",
        enabled: true,
        timeout: 5000,
        trust: false,
        type: "stdio",
      },
      {
        createTransport: (): McpTransport => ({}),
      },
    );

    await client.connect();

    expect(createdClients).toEqual([{ name: "ohbaby-agent", version: "9.9.9" }]);
  });
});

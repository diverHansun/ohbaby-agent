import { describe, expect, it, vi } from "vitest";
import { DaemonHttpClient } from "./http.js";
import type { ModelConnectRequest } from "./wire.js";

describe("daemon model protocol wire contract", () => {
  it.each(["openai-compatible", "openai-responses", "anthropic"] as const)(
    "sends %s unchanged for connect and probe",
    async (interfaceProvider) => {
      const fetchImpl = vi.fn<typeof fetch>(() =>
        Promise.resolve(Response.json({ ok: true })),
      );
      const client = new DaemonHttpClient({
        baseUrl: "https://fixture.test",
        clientId: "fixture",
        token: "fixture",
        fetch: fetchImpl,
      });
      const input: ModelConnectRequest = {
        provider: "fixture",
        model: "model",
        baseUrl: "https://model.test/v1",
        interfaceProvider,
      };
      await client.connectModel(input);
      await client.probeModelContextWindow(input);
      expect(
        fetchImpl.mock.calls.map((call) => {
          const body = call[1]?.body;
          if (typeof body !== "string")
            throw new Error("Expected JSON request body");
          return JSON.parse(body) as unknown;
        }),
      ).toEqual([input, input]);
    },
  );
});

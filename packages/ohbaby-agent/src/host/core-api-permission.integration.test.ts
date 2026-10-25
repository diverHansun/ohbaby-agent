import { describe, expect, it, vi } from "vitest";
import { createRPC, type CoreAPI } from "ohbaby-sdk";
import { buildCoreAPIImpl, type CoreApiHost } from "./core-api-factory.js";

describe("default CoreAPI approval boundary", () => {
  it("subscribes synchronously and queries approvals through the actual persistent host", async () => {
    // Exercise the real persistent host and schema without disk migration latency.
    // This test covers the approval API boundary, not persistence across restarts.
    vi.stubEnv("OHBABY_DB_PATH", ":memory:");
    let host: CoreApiHost | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      host = await buildCoreAPIImpl();
      const rpc = createRPC<CoreAPI>();
      rpc.connectImpl(host.core);
      const client = rpc.createProxy(host.callbacks);
      unsubscribe = client.subscribePermissionEvents(vi.fn(), vi.fn());
      // Observe the erroneous Promise in the regression's RED run as well.
      if (unsubscribe instanceof Promise)
        await unsubscribe.catch(() => undefined);
      expect(unsubscribe).toBeTypeOf("function");
      await expect(
        client.getPermissionSnapshot({ rootSessionId: null }),
      ).resolves.toMatchObject({
        rootSessionId: null,
        permissionRevision: 0,
        requests: [],
      });
      const controller = new AbortController();
      controller.abort();
      await expect(
        client.getPermissionSnapshot({
          rootSessionId: null,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      try {
        if (typeof unsubscribe === "function") unsubscribe();
        await host?.dispose();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });
});

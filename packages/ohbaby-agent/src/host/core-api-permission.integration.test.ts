import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRPC, type CoreAPI } from "ohbaby-sdk";
import { buildCoreAPIImpl } from "./core-api-factory.js";

describe("default CoreAPI approval boundary", () => {
  it("subscribes synchronously and queries approvals through the actual persistent host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohbaby-core-approval-"));
    vi.stubEnv("OHBABY_DB_PATH", join(directory, "agent.db"));
    const host = await buildCoreAPIImpl();
    let unsubscribe: (() => void) | undefined;
    try {
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
      if (typeof unsubscribe === "function") unsubscribe();
      await host.dispose();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

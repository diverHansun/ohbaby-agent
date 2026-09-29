import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { expect, it, vi } from "vitest";
import { createRPC, type CoreAPI } from "ohbaby-sdk";
import { buildCoreAPIImpl } from "../../../packages/ohbaby-agent/src/host/core-api-factory.js";
import { OhbabyTerminalApp } from "../../../packages/ohbaby-cli/src/tui/app.js";
import { waitForFrame } from "./helpers.js";
vi.mock("../../../packages/ohbaby-cli/src/tui/pending-prompts.js", () => ({
  createPendingPromptStorage: () => ({
    read: () => [],
    write: () => undefined,
  }),
}));

it("recovers the default persistent host through its real JSON proxy with live query cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-tui-host-recovery-"));
  vi.stubEnv("OHBABY_DB_PATH", join(directory, "agent.db"));
  const host = await buildCoreAPIImpl({ inProcess: true });
  const rpc = createRPC<CoreAPI>();
  rpc.connectImpl(host.core);
  const client = rpc.createProxy(host.callbacks);
  const session = await client.createSession();
  await client.selectSession(session.id);
  const legacy = vi.spyOn(host.core, "getSnapshot");
  const app = render(
    <OhbabyTerminalApp
      client={client}
      subscribeEvents={host.callbacks.subscribeEvents}
    />,
  );
  try {
    const frame = await waitForFrame(
      app,
      (current) =>
        current.includes("Sync failed") ||
        (current.includes(session.id) && !current.includes("Syncing session")),
    );
    expect(frame).not.toContain("Sync failed");
    expect(frame).not.toContain("throwIfAborted");
    const controller = new AbortController();
    await expect(
      client.getSessionView?.({
        sessionId: session.id,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ version: { sessionId: session.id } });
    await expect(
      client.getSessionHistory?.({
        sessionId: session.id,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ version: { sessionId: session.id } });
    await expect(
      client.getSessionControl?.({
        sessionId: session.id,
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ sessionId: session.id, runId: null });
    await expect(
      client.getPromptReceipt?.({
        clientRequestId: "unknown-original",
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      clientRequestId: "unknown-original",
      receipt: null,
    });
    controller.abort();
    await expect(
      client.getSessionView?.({
        sessionId: session.id,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(legacy).not.toHaveBeenCalled();
  } finally {
    app.unmount();
    await host.dispose();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

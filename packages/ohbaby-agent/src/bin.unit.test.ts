import { describe, expect, it, vi } from "vitest";

describe("runOhbabyCli", () => {
  it("creates the default CLI client through the persistent backend factory", async () => {
    vi.resetModules();
    const submitPrompt = vi.fn(() => Promise.resolve());
    const createPersistentUiBackendClient = vi.fn(() => ({
      abortRun: vi.fn(() => Promise.resolve()),
      executeCommand: vi.fn(() => Promise.resolve()),
      getSnapshot: vi.fn(() => Promise.resolve()),
      listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
      respondInteraction: vi.fn(() => Promise.resolve()),
      respondPermission: vi.fn(() => Promise.resolve()),
      submitPrompt,
      subscribeEvents: vi.fn((): (() => void) => () => undefined),
    }));
    vi.doMock("./adapters/ui-persistent.js", () => ({
      createPersistentUiBackendClient,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "-p", "hello"]),
    ).resolves.toBe(0);
    expect(createPersistentUiBackendClient).toHaveBeenCalledTimes(1);
    expect(submitPrompt).toHaveBeenCalledWith("hello");
  });
});

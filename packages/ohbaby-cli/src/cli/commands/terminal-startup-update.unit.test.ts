import { describe, expect, it, vi } from "vitest";
import { createTerminalCommand } from "./terminal.js";
import type {
  CliCommandRuntime,
  CliStartupUpdate,
  CliStartupUpdateDecision,
} from "./types.js";

function createRuntime(decision: CliStartupUpdateDecision): {
  readonly order: string[];
  readonly runtime: CliCommandRuntime;
  readonly renderTerminalUi: ReturnType<typeof vi.fn>;
  readonly startupUpdate: CliStartupUpdate;
} {
  const order: string[] = [];
  const startupUpdate: CliStartupUpdate = {
    readNotice: vi.fn(() => {
      order.push("notice");
      return "ohbaby 9.9.9 is available";
    }),
    runAutomaticUpdate: vi.fn(() => {
      order.push("auto-update");
      return Promise.resolve(decision);
    }),
    refreshInBackground: vi.fn(() => {
      order.push("refresh");
    }),
  };
  const renderTerminalUi = vi.fn(() => {
    order.push("render");
    return { waitUntilExit: (): Promise<void> => Promise.resolve() };
  });
  const runtime = {
    createCoreHost: vi.fn(() => {
      order.push("host");
      return {
        core: {},
        callbacks: { subscribeEvents: (): (() => void) => () => undefined },
        dispose: (): Promise<void> => Promise.resolve(),
      };
    }),
    renderTerminalUi,
    showServeCoexistenceNotice: vi.fn(() => {
      order.push("coexistence");
      return Promise.resolve();
    }),
    startupUpdate,
    stderr: { write: vi.fn() },
    takeStartupNotices: () => ["env warning"],
  } as unknown as CliCommandRuntime;
  return { order, renderTerminalUi, runtime, startupUpdate };
}

describe("terminal startup update", () => {
  it("runs automatic update before loading the host and appends the notice", async () => {
    const { order, renderTerminalUi, runtime } = createRuntime("continue");

    await createTerminalCommand(runtime).handler({} as never);

    expect(order).toEqual([
      "coexistence",
      "auto-update",
      "notice",
      "host",
      "refresh",
      "render",
    ]);
    expect(renderTerminalUi).toHaveBeenCalledWith(
      expect.objectContaining({
        initialNotices: ["env warning", "ohbaby 9.9.9 is available"],
      }),
    );
  });

  it("exits before loading the host when automatic update finished", async () => {
    const { order, runtime } = createRuntime("exit");

    await createTerminalCommand(runtime).handler({} as never);

    expect(order).toEqual(["coexistence", "auto-update"]);
    expect(runtime.createCoreHost).not.toHaveBeenCalled();
  });

  it("only shows the cached notice for a remote TUI", async () => {
    const { order, runtime, startupUpdate } = createRuntime("exit");

    await createTerminalCommand(runtime).handler({
      remotePort: 4096,
    } as never);

    expect(order).toEqual(["notice", "host", "render"]);
    expect(startupUpdate.runAutomaticUpdate).not.toHaveBeenCalled();
    expect(startupUpdate.refreshInBackground).not.toHaveBeenCalled();
  });
});

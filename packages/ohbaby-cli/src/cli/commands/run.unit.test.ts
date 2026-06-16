import { describe, expect, it, vi } from "vitest";
import { createRunCommand } from "./run.js";
import type { CliCommandRuntime, CliCoreHost } from "./types.js";

describe("createRunCommand", () => {
  it("uses the embedded backend for non-interactive prompt runs", async () => {
    const runtime = createRuntime({ isStdinTTY: () => true });
    const command = createRunCommand(runtime);

    await command.handler({
      mode: "plan",
      permission: "full-access",
      prompt: ["hello"],
    } as never);

    expect(runtime.createCoreHost).toHaveBeenCalledWith({
      inProcess: true,
      mode: "plan",
      permission: "full-access",
    });
  });

  it("rejects missing prompt on an interactive stdin before creating a host", async () => {
    const runtime = createRuntime({ isStdinTTY: () => true });
    const command = createRunCommand(runtime);

    await expect(command.handler({} as never)).rejects.toThrow(
      "run requires a prompt or piped stdin",
    );
    expect(runtime.createCoreHost).not.toHaveBeenCalled();
    expect(runtime.readStdin).not.toHaveBeenCalled();
  });

  it("rejects empty piped stdin before creating a host", async () => {
    const runtime = createRuntime({
      isStdinTTY: () => false,
      readStdin: () => Promise.resolve(" \n"),
    });
    const command = createRunCommand(runtime);

    await expect(command.handler({} as never)).rejects.toThrow(
      "run requires a non-empty prompt or piped stdin",
    );
    expect(runtime.createCoreHost).not.toHaveBeenCalled();
  });
});

function createRuntime(
  overrides: Partial<CliCommandRuntime> & {
    readonly isStdinTTY: () => boolean;
  },
): CliCommandRuntime & {
  readonly createCoreHost: ReturnType<typeof vi.fn>;
  readonly readStdin: ReturnType<typeof vi.fn>;
} {
  const host = {
    callbacks: {
      subscribeEvents: vi.fn((): (() => void) => () => undefined),
    },
    core: {
      abortRun: vi.fn(() => Promise.resolve()),
      compactSession: vi.fn(() => Promise.resolve()),
      executeCommand: vi.fn(() => Promise.resolve()),
      getSnapshot: vi.fn(() => Promise.resolve()),
      listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
      respondInteraction: vi.fn(() => Promise.resolve()),
      respondPermission: vi.fn(() => Promise.resolve()),
      submitPrompt: vi.fn(() => Promise.resolve()),
    },
    dispose: vi.fn(() => Promise.resolve()),
  } as unknown as CliCoreHost;
  const runtime = {
    createCoreHost: vi.fn(() => host),
    createStdoutRenderer: vi.fn(() => ({ handle: vi.fn() })),
    failUsage(message: string): never {
      throw new Error(message);
    },
    readStdin: vi.fn(() => Promise.resolve("")),
    renderTerminalUi: vi.fn(),
    setExitCode: vi.fn(),
    stderr: { write: vi.fn() },
    ...overrides,
  };

  return runtime as unknown as CliCommandRuntime & {
    readonly createCoreHost: ReturnType<typeof vi.fn>;
    readonly readStdin: ReturnType<typeof vi.fn>;
  };
}

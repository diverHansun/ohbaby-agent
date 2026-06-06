import { describe, expect, it, vi } from "vitest";

describe("runOhbabyCli", () => {
  it("starts the terminal UI through injected host dependencies", async () => {
    vi.resetModules();
    const core = createCore();
    const createCoreHost = vi.fn(() => ({
      callbacks: { subscribeEvents },
      core,
      dispose,
    }));
    const dispose = vi.fn(() => Promise.resolve());
    const loadRuntimeEnvIntoProcessEnv = vi.fn(() => Promise.resolve());
    const subscribeEvents = vi.fn((): (() => void) => () => undefined);
    const waitUntilExit = vi.fn(() => Promise.resolve());
    const renderTerminalUi = vi.fn(() => ({ waitUntilExit }));
    vi.doMock("ohbaby-agent", () => {
      throw new Error("agent should be loaded only by the default loader");
    });
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi,
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(
        ["node", "ohbaby", "--mode", "plan", "--permission", "full-access"],
        {},
        {
          createCoreHost,
          loadRuntimeEnvIntoProcessEnv,
        },
      ),
    ).resolves.toBe(0);
    expect(loadRuntimeEnvIntoProcessEnv).toHaveBeenCalledTimes(1);
    expect(createCoreHost).toHaveBeenCalledWith({
      mode: "plan",
      permission: "full-access",
    });
    const renderCalls = renderTerminalUi.mock.calls as unknown as [
      {
        readonly client: unknown;
        readonly subscribeEvents: unknown;
      },
    ][];
    const renderOptions = renderCalls[0]?.[0] as
      | {
          readonly client: unknown;
          readonly subscribeEvents: unknown;
        }
      | undefined;
    expect(renderOptions?.client).toBeTypeOf("object");
    expect(renderOptions?.subscribeEvents).toBeTypeOf("function");
    const handler = vi.fn();
    (
      renderOptions?.subscribeEvents as
        | ((nextHandler: typeof handler) => unknown)
        | undefined
    )?.(handler);
    expect(subscribeEvents).toHaveBeenCalledWith(handler);
    expect(core.submitPrompt).not.toHaveBeenCalled();
    expect(waitUntilExit).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("runs a prompt through the run subcommand and disposes resources", async () => {
    vi.resetModules();
    const core = createCore();
    const dispose = vi.fn(() => Promise.resolve());
    const unsubscribe = vi.fn();
    const subscribeEvents = vi.fn(() => unsubscribe);
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl: vi.fn(() => ({
        callbacks: { subscribeEvents },
        core,
        dispose,
      })),
      loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi: vi.fn(),
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "run", "hello", "world"]),
    ).resolves.toBe(0);
    expect(core.submitPrompt).toHaveBeenCalledWith("hello world");
    expect(subscribeEvents).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rejects the old prompt flag instead of accepting bare startup prompts", async () => {
    vi.resetModules();
    const stderr: string[] = [];
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl: vi.fn(),
      loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi: vi.fn(),
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "-p", "hello"], {
        stderr: { write: (chunk: string) => stderr.push(chunk) },
        stdout: { write: vi.fn() },
      }),
    ).resolves.toBe(2);
    expect(stderr.join("")).toContain("Unknown argument");
  });

  it("reports serve as not implemented", async () => {
    vi.resetModules();
    const stderr: string[] = [];
    vi.doMock("ohbaby-agent", () => ({
      buildCoreAPIImpl: vi.fn(),
      loadRuntimeEnvIntoProcessEnv: vi.fn(() => Promise.resolve()),
    }));
    vi.doMock("./tui/index.js", () => ({
      renderTerminalUi: vi.fn(),
    }));

    const { runOhbabyCli } = await import("./bin.js");

    await expect(
      runOhbabyCli(["node", "ohbaby", "serve"], {
        stderr: { write: (chunk: string) => stderr.push(chunk) },
        stdout: { write: vi.fn() },
      }),
    ).resolves.toBe(1);
    expect(stderr.join("")).toContain("serve mode is not yet implemented");
  });
});

function createCore(): {
  readonly abortRun: ReturnType<typeof vi.fn>;
  readonly compactSession: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
  readonly getContextWindowUsage: ReturnType<typeof vi.fn>;
  readonly getSnapshot: ReturnType<typeof vi.fn>;
  readonly listCommands: ReturnType<typeof vi.fn>;
  readonly respondInteraction: ReturnType<typeof vi.fn>;
  readonly respondPermission: ReturnType<typeof vi.fn>;
  readonly submitPrompt: ReturnType<typeof vi.fn>;
} {
  return {
    abortRun: vi.fn(() => Promise.resolve()),
    compactSession: vi.fn(() => Promise.resolve()),
    executeCommand: vi.fn(() => Promise.resolve()),
    getContextWindowUsage: vi.fn(() => Promise.resolve(null)),
    getSnapshot: vi.fn(() => Promise.resolve()),
    listCommands: vi.fn(() => Promise.resolve({ commands: [] })),
    respondInteraction: vi.fn(() => Promise.resolve()),
    respondPermission: vi.fn(() => Promise.resolve()),
    submitPrompt: vi.fn(() => Promise.resolve()),
  };
}

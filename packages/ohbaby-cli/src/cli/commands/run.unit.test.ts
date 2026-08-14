import { describe, expect, it, vi } from "vitest";
import type { UiPromptCompletion } from "ohbaby-sdk";
import { createRunCommand } from "./run.js";
import type { CliCommandRuntime, CliCoreHost } from "./types.js";

function completion(
  status: "succeeded" | "failed" | "cancelled" | "interrupted",
): UiPromptCompletion {
  const base = {
    clientRequestId: "request_1",
    createdAt: "2026-08-14T00:00:00.000Z",
    endedAt: "2026-08-14T00:00:01.000Z",
    promptId: "prompt_1",
    scopeKey: "/workspace",
    sessionId: "session_1",
    text: "hello",
    updatedAt: "2026-08-14T00:00:01.000Z",
    userMessageId: "message_1",
  } as const;
  if (status === "failed" || status === "interrupted") {
    return {
      prompt: {
        ...base,
        error: {
          code: status === "failed" ? "PROVIDER_FAILED" : "PROCESS_INTERRUPTED",
          message: status === "failed" ? "provider failed" : "run interrupted",
          retryable: status === "failed",
          source: status === "failed" ? "provider" : "runtime",
        },
        status,
      },
    };
  }
  return { prompt: { ...base, status } };
}

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
    expect(runtime.host.core.submitPromptAndWait).toHaveBeenCalledWith("hello");
  });

  it("does not dispose the host until prompt completion resolves", async () => {
    let resolveCompletion!: (value: UiPromptCompletion) => void;
    const pending = new Promise<UiPromptCompletion>((resolve) => {
      resolveCompletion = resolve;
    });
    const runtime = createRuntime({ isStdinTTY: () => true });
    vi.mocked(runtime.host.core.submitPromptAndWait).mockReturnValue(pending);
    const command = createRunCommand(runtime);

    const running = command.handler({ prompt: ["hello"] } as never);
    await vi.waitFor(() => {
      expect(runtime.host.core.submitPromptAndWait).toHaveBeenCalledOnce();
    });
    expect(runtime.host.dispose).not.toHaveBeenCalled();

    resolveCompletion(completion("succeeded"));
    await running;

    expect(runtime.host.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["failed", 1, "PROVIDER_FAILED: provider failed"],
    ["cancelled", 1, "prompt cancelled"],
    ["interrupted", 130, "PROCESS_INTERRUPTED: run interrupted"],
  ] as const)(
    "maps %s completion to the existing CLI exit policy",
    async (status, exitCode, message) => {
      const runtime = createRuntime({ isStdinTTY: () => true });
      vi.mocked(runtime.host.core.submitPromptAndWait).mockResolvedValue(
        completion(status),
      );
      const command = createRunCommand(runtime);

      await command.handler({ prompt: ["hello"] } as never);

      expect(runtime.setExitCode).toHaveBeenCalledWith(exitCode);
      expect(runtime.stderrWrite).toHaveBeenCalledWith(`${message}\n`);
      expect(runtime.host.dispose).toHaveBeenCalledOnce();
    },
  );

  it("keeps technical submit-and-wait failures on the rejection path", async () => {
    const runtime = createRuntime({ isStdinTTY: () => true });
    const transportError = new Error("transport unavailable");
    vi.mocked(runtime.host.core.submitPromptAndWait).mockRejectedValue(
      transportError,
    );
    const command = createRunCommand(runtime);

    await expect(
      command.handler({ prompt: ["hello"] } as never),
    ).rejects.toBe(transportError);
    expect(runtime.setExitCode).not.toHaveBeenCalled();
    expect(runtime.host.dispose).toHaveBeenCalledOnce();
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
  readonly host: CliCoreHost;
  readonly readStdin: ReturnType<typeof vi.fn>;
  readonly stderrWrite: ReturnType<typeof vi.fn>;
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
      submitPromptAndWait: vi.fn(() => Promise.resolve(completion("succeeded"))),
    },
    dispose: vi.fn(() => Promise.resolve()),
  } as unknown as CliCoreHost;
  const stderrWrite = vi.fn();
  const runtime = {
    createCoreHost: vi.fn(() => host),
    createStdoutRenderer: vi.fn(() => ({ handle: vi.fn() })),
    failUsage(message: string): never {
      throw new Error(message);
    },
    readStdin: vi.fn(() => Promise.resolve("")),
    renderTerminalUi: vi.fn(),
    setExitCode: vi.fn(),
    stderr: { write: stderrWrite },
    stderrWrite,
    host,
    ...overrides,
  };

  return runtime as unknown as CliCommandRuntime & {
    readonly createCoreHost: ReturnType<typeof vi.fn>;
    readonly host: CliCoreHost;
    readonly readStdin: ReturnType<typeof vi.fn>;
    readonly stderrWrite: ReturnType<typeof vi.fn>;
  };
}

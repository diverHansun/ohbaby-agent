import { describe, expect, it, vi } from "vitest";
import {
  buildUiCommandDetails,
  executeRecordedUiCommand,
  summarizeUiCommandError,
  type UiCommandRecord,
  type UiCommandRecorder,
  type UiCommandDetails,
} from "./command-record.js";

// @ts-expect-error Details are branded and must come from the SDK allowlist builder.
const unsafeDetails: UiCommandDetails = { apiKey: "secret" };
void unsafeDetails;

function fixedDependencies(records: UiCommandRecord[]): {
  readonly createOperationId: () => string;
  readonly now: () => Date;
  readonly recorder: UiCommandRecorder;
} {
  return {
    createOperationId: (): string => "operation_1",
    now: (): Date => new Date("2026-08-14T00:00:00.000Z"),
    recorder: {
      record(record: UiCommandRecord): void {
        records.push(record);
      },
    },
  };
}

describe("executeRecordedUiCommand", () => {
  it("records one operation from started through returned without changing the result", async () => {
    const records: UiCommandRecord[] = [];
    const result = { promptId: "prompt_1", sessionId: "session_1" };

    const returned = await executeRecordedUiCommand({
      ...fixedDependencies(records),
      correlation: { clientRequestId: "request_1" },
      correlateResult: (value: typeof result) => ({
        promptId: value.promptId,
        sessionId: value.sessionId,
      }),
      entryPoint: "server-rpc",
      execute: () => Promise.resolve(result),
      method: "submitPromptAccepted",
    });

    expect(returned).toBe(result);
    expect(records).toEqual([
      {
        correlation: { clientRequestId: "request_1" },
        entryPoint: "server-rpc",
        method: "submitPromptAccepted",
        occurredAt: "2026-08-14T00:00:00.000Z",
        operationId: "operation_1",
        phase: "started",
      },
      {
        correlation: {
          clientRequestId: "request_1",
          promptId: "prompt_1",
          sessionId: "session_1",
        },
        entryPoint: "server-rpc",
        method: "submitPromptAccepted",
        occurredAt: "2026-08-14T00:00:00.000Z",
        operationId: "operation_1",
        outcome: { kind: "returned" },
        phase: "completed",
      },
    ]);
  });

  it("records a safe thrown outcome and rethrows the original error", async () => {
    const records: UiCommandRecord[] = [];
    const error = Object.assign(
      new Error("Authorization: Bearer secret-token; response body=private"),
      { code: "PROVIDER_AUTH", responseBody: "private", status: 401 },
    );

    const execution = executeRecordedUiCommand({
      ...fixedDependencies(records),
      correlation: { sessionId: "session_1" },
      entryPoint: "agent-host",
      execute: () => Promise.reject(error),
      method: "connectModel",
    });

    await expect(execution).rejects.toBe(error);
    expect(records[1]).toMatchObject({
      outcome: {
        error: {
          code: "PROVIDER_AUTH",
          message: "Command execution failed",
          name: "Error",
        },
        kind: "threw",
      },
      phase: "completed",
    });
    expect(JSON.stringify(records)).not.toContain("secret-token");
    expect(JSON.stringify(records)).not.toContain("private");
    expect(JSON.stringify(records)).not.toContain("stack");
  });

  it("treats a resolved failed prompt completion as returned", async () => {
    const records: UiCommandRecord[] = [];
    await executeRecordedUiCommand({
      ...fixedDependencies(records),
      entryPoint: "agent-host",
      execute: () =>
        Promise.resolve({
          prompt: {
            error: {
              code: "PROVIDER_AUTH",
              message: "provider failed",
              retryable: false,
              source: "provider" as const,
            },
            status: "failed" as const,
          },
        }),
      method: "submitPromptAccepted",
    });

    expect(records[1]).toMatchObject({ outcome: { kind: "returned" } });
  });

  it("fails open when the recorder rejects entries and diagnoses at most once", async () => {
    const diagnostic = vi.fn(() => {
      throw new Error("diagnostic failure");
    });
    const recorder: UiCommandRecorder = {
      record(): void {
        throw new Error("sink full");
      },
    };

    await expect(
      executeRecordedUiCommand({
        createOperationId: () => "operation_1",
        entryPoint: "server-rest",
        execute: () => Promise.resolve("business result"),
        method: "abortRun",
        now: () => new Date("2026-08-14T00:00:00.000Z"),
        onDiagnostic: diagnostic,
        recorder,
      }),
    ).resolves.toBe("business result");
    expect(diagnostic).toHaveBeenCalledTimes(1);
  });

  it("does not await recorder-owned downstream work and preserves intake order", async () => {
    const phases: UiCommandRecord["phase"][] = [];
    const recorder: UiCommandRecorder = {
      record(record): void {
        phases.push(record.phase);
        void new Promise<void>(() => undefined);
      },
    };

    await expect(
      executeRecordedUiCommand({
        createOperationId: () => "operation_1",
        entryPoint: "server-rest",
        execute: () => Promise.resolve("done"),
        method: "archiveSession",
        now: () => new Date("2026-08-14T00:00:00.000Z"),
        recorder,
      }),
    ).resolves.toBe("done");
    expect(phases).toEqual(["started", "completed"]);
  });

  it("isolates operation id, clock, and result-correlation failures", async () => {
    const diagnostic = vi.fn();
    const recorder = { record: vi.fn() };

    await expect(
      executeRecordedUiCommand({
        correlateResult: () => {
          throw new Error("correlation failed");
        },
        createOperationId: () => {
          throw new Error("id failed");
        },
        entryPoint: "server-rpc",
        execute: () => Promise.resolve(42),
        method: "setPermission",
        now: () => {
          throw new Error("clock failed");
        },
        onDiagnostic: diagnostic,
        recorder,
      }),
    ).resolves.toBe(42);
    expect(recorder.record).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledTimes(1);
  });

  it("fails open when hostile arguments break the SDK-owned details builder", async () => {
    const diagnostic = vi.fn();
    const records: UiCommandRecord[] = [];
    const hostileArgs = new Proxy([] as unknown[], {
      get(): never {
        throw new Error("hostile argument getter");
      },
    });

    await expect(
      executeRecordedUiCommand({
        ...fixedDependencies(records),
        args: hostileArgs,
        entryPoint: "server-rpc",
        execute: () => Promise.resolve("business result"),
        method: "submitPromptAccepted",
        onDiagnostic: diagnostic,
      }),
    ).resolves.toBe("business result");
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.details === undefined)).toBe(true);
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "details" }),
    );
  });
});

describe("UI command record redaction", () => {
  it("uses method-specific detail allowlists instead of raw params", () => {
    expect(
      buildUiCommandDetails("submitPromptAccepted", [
        "private prompt body",
        {
          clientRequestId: "request-secret",
          sessionId: "session-secret",
        },
      ]),
    ).toEqual({
      hasClientRequestId: true,
      hasExplicitSessionId: true,
      textLength: 19,
    });
    expect(
      buildUiCommandDetails("connectModel", [
        {
          apiKey: "secret-api-key",
          apiKeyEnv: "SECRET_ENV",
          baseUrl: "https://private.example",
          interfaceProvider: "openai-compatible",
          model: "private-model",
          provider: "private-provider",
        },
      ]),
    ).toEqual({
      hasApiKey: true,
      hasExplicitContextWindow: false,
      interfaceProvider: "openai-compatible",
    });
    expect(
      JSON.stringify(
        buildUiCommandDetails("setSearchApiKey", [
          {
            apiKey: "secret-search-key",
            apiKeyEnv: "SECRET_SEARCH_ENV",
            provider: "tavily",
          },
        ]),
      ),
    ).not.toMatch(/secret|TAVILY/i);
  });

  it("normalizes unsafe error fields", () => {
    const summary = summarizeUiCommandError({
      code: "bad code with token=secret",
      message: "secret response body",
      name: "Secret Error Name",
      stack: "private stack",
    });

    expect(summary).toEqual({
      message: "Command execution failed",
      name: "Error",
    });
  });

  it("does not treat alphanumeric secret-shaped names or codes as safe", () => {
    expect(
      summarizeUiCommandError({
        code: "AKIAIOSFODNN7EXAMPLE",
        name: "SecretToken",
      }),
    ).toEqual({
      message: "Command execution failed",
      name: "Error",
    });
  });
});

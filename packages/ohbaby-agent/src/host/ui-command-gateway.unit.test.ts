import { describe, expect, it, vi } from "vitest";
import type {
  UiBackendClient,
  UiCommandRecord,
  UiCommandRecorder,
  UiPromptCompletion,
} from "ohbaby-sdk";
import { createUiCommandGateway } from "./ui-command-gateway.js";
import type { UiPromptQueueExecutionPort } from "../adapters/ui-inprocess.js";

const completion: UiPromptCompletion = {
  prompt: {
    clientRequestId: "request_1",
    createdAt: "2026-08-14T00:00:00.000Z",
    endedAt: "2026-08-14T00:00:01.000Z",
    promptId: "prompt_1",
    scopeKey: "/workspace",
    sessionId: "session_1",
    status: "succeeded",
    text: "private prompt",
    updatedAt: "2026-08-14T00:00:01.000Z",
    userMessageId: "message_1",
  },
};

function createGateway(
  client: Partial<UiBackendClient>,
  records: UiCommandRecord[],
): UiBackendClient {
  return createUiCommandGateway(client as UiBackendClient, {
    correlation: { clientId: "client_1", transportRequestId: "rpc_1" },
    createOperationId: () => "operation_1",
    entryPoint: "server-rpc",
    now: () => new Date("2026-08-14T00:00:00.000Z"),
    recorder: { record: (record) => records.push(record) },
  });
}

describe("createUiCommandGateway", () => {
  it("records accepted prompt admission once and enriches returned correlation", async () => {
    const records: UiCommandRecord[] = [];
    const raw = {
      submitPromptAccepted: vi.fn(() =>
        Promise.resolve({
          clientRequestId: "request_1",
          createdAt: "2026-08-14T00:00:00.000Z",
          promptId: "prompt_1",
          sessionId: "session_1",
          status: "queued" as const,
          userMessageId: "message_1",
        }),
      ),
    };
    const gateway = createGateway(raw, records);

    await gateway.submitPromptAccepted("private prompt", {
      clientRequestId: "request_1",
      sessionId: "session_1",
    });

    expect(raw.submitPromptAccepted).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      correlation: {
        clientId: "client_1",
        clientRequestId: "request_1",
        sessionId: "session_1",
        transportRequestId: "rpc_1",
      },
      method: "submitPromptAccepted",
      phase: "started",
    });
    expect(records[1]).toMatchObject({
      correlation: {
        promptId: "prompt_1",
        sessionId: "session_1",
      },
      outcome: { kind: "returned" },
      phase: "completed",
    });
    expect(JSON.stringify(records)).not.toContain("private prompt");
  });

  it("composes submit-and-wait without recording a third operation", async () => {
    const records: UiCommandRecord[] = [];
    const raw = {
      submitPromptAccepted: vi.fn(() =>
        Promise.resolve({
          clientRequestId: "request_1",
          createdAt: "2026-08-14T00:00:00.000Z",
          promptId: "prompt_1",
          sessionId: "session_1",
          status: "queued" as const,
          userMessageId: "message_1",
        }),
      ),
      waitForPrompt: vi.fn(() => Promise.resolve(completion)),
    };
    const gateway = createGateway(raw, records);

    await expect(gateway.submitPromptAndWait("hello")).resolves.toBe(
      completion,
    );

    expect(records.map((record) => record.method)).toEqual([
      "submitPromptAccepted",
      "submitPromptAccepted",
    ]);
    expect(raw.waitForPrompt).toHaveBeenCalledWith("prompt_1", {
      signal: undefined,
    });
  });

  it("records only executeCommand when raw command handling submits internally", async () => {
    const records: UiCommandRecord[] = [];
    const rawSubmit = vi.fn(() => Promise.resolve());
    const raw = {
      executeCommand: vi.fn(async () => {
        await rawSubmit();
        return {
          status: "completed" as const,
          commandRunId: "command_1",
          clientInvocationId: "invoke_1",
          outputCount: 0,
          eventCount: 0,
        };
      }),
    };
    const gateway = createGateway(raw, records);

    await gateway.executeCommand({
      argv: [],
      clientInvocationId: "invoke_1",
      commandId: "skill:test",
      path: ["skill:test"],
      raw: "/skill:test",
      rawArgs: "",
      surface: "tui",
    });

    expect(rawSubmit).toHaveBeenCalledTimes(1);
    expect(records.map((record) => record.method)).toEqual([
      "executeCommand",
      "executeCommand",
    ]);
  });

  it("keeps the command result when the injected recorder fails", async () => {
    const recorder: UiCommandRecorder = {
      record(): void {
        throw new Error("sink unavailable");
      },
    };
    const raw = { abortRun: vi.fn(() => Promise.resolve()) };
    const gateway = createUiCommandGateway(raw as unknown as UiBackendClient, {
      entryPoint: "agent-host",
      recorder,
    });

    await expect(gateway.abortRun("run_1")).resolves.toBeUndefined();
    expect(raw.abortRun).toHaveBeenCalledWith("run_1");
  });
});

it("records an explicit resend once with the new prompt receipt and trusted owner", async () => {
  const records: UiCommandRecord[] = [];
  const receipt = {
    clientRequestId: "resend:one",
    createdAt: "2026-10-15T00:00:00.000Z",
    promptId: "new-prompt",
    sessionId: "session",
    status: "queued" as const,
    userMessageId: "new-message",
  };
  const raw = {
    resendSteerInputForOwner: vi.fn<
      UiPromptQueueExecutionPort["resendSteerInputForOwner"]
    >(() => Promise.resolve(receipt)),
  };
  const gateway = createUiCommandGateway(
    raw as unknown as UiBackendClient & typeof raw,
    {
      entryPoint: "server-rpc",
      recorder: { record: (record) => records.push(record) },
    },
  );
  const input = { inputId: "steer:old", operationId: "one" };
  expect(
    await gateway.resendSteerInputForOwner(input, "trusted-owner", "session"),
  ).toEqual(receipt);
  expect(raw.resendSteerInputForOwner).toHaveBeenCalledWith(
    input,
    "trusted-owner",
    "session",
  );
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    method: "resendSteerInput",
    phase: "started",
    correlation: { clientId: "trusted-owner" },
  });
  expect(records[1]).toMatchObject({
    method: "resendSteerInput",
    phase: "completed",
    correlation: {
      promptId: "new-prompt",
      clientRequestId: "resend:one",
      sessionId: "session",
    },
  });
});

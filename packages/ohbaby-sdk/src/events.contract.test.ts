import { describe, expect, it } from "vitest";
import type { UiEvent } from "./index.js";

describe("UiEvent protocol", () => {
  it("represents command and interaction protocol events with correlation ids", () => {
    const events: UiEvent[] = [
      {
        type: "command.started",
        command: {
          clientInvocationId: "inv_1",
          commandId: "status",
          commandRunId: "cmd_1",
          path: ["status"],
          surface: "tui",
        },
        timestamp: 1,
      },
      {
        type: "command.result.delivered",
        commandRunId: "cmd_1",
        clientInvocationId: "inv_1",
        output: { kind: "text", text: "OK" },
        timestamp: 2,
      },
      {
        type: "interaction.requested",
        request: {
          clientInvocationId: "inv_1",
          commandRunId: "cmd_1",
          interactionId: "int_1",
          kind: "select-one",
          options: [{ id: "model_1", label: "GPT" }],
          prompt: "Choose a model",
          subject: "model",
        },
        timestamp: 3,
      },
      {
        type: "notice.emitted",
        notice: {
          createdAt: "2026-05-19T00:00:00.000Z",
          id: "notice_1",
          key: "provider:missing-key",
          level: "error",
          message: "OPENAI_API_KEY is not configured",
          title: "Provider configuration failed",
        },
        timestamp: 4,
      },
    ];

    expect(events.map((event) => event.type)).toEqual([
      "command.started",
      "command.result.delivered",
      "interaction.requested",
      "notice.emitted",
    ]);
  });
});


import { describe, expect, it } from "vitest";
import { CommandsEvent } from "../../commands/index.js";
import { InteractionEvent } from "../../runtime/interaction-broker/index.js";
import { appEventProjectors, toAppStreamEvent } from "./projectors.js";

describe("app event projectors", () => {
  it("exposes app event projector entries in bus subscription order", () => {
    expect(appEventProjectors.map((projector) => projector.event.type)).toEqual([
      "commands.started.internal",
      "commands.result.delivered.internal",
      "commands.failed.internal",
      "commands.catalog.updated.internal",
      "interaction.requested.internal",
      "interaction.resolved.internal",
    ]);

    expect(appEventProjectors.map((projector) => projector.event)).toEqual([
      CommandsEvent.Started,
      CommandsEvent.ResultDelivered,
      CommandsEvent.Failed,
      CommandsEvent.CatalogUpdated,
      InteractionEvent.Requested,
      InteractionEvent.Resolved,
    ]);
  });

  it("projects command and interaction bus events to SDK UI events", () => {
    const [
      commandStarted,
      commandResultDelivered,
      commandFailed,
      commandCatalogUpdated,
      interactionRequested,
      interactionResolved,
    ] = appEventProjectors;

    expect(
      commandStarted.project({
        clientInvocationId: "inv_1",
        commandId: "status",
        commandRunId: "cmd_1",
        path: ["status"],
        sessionId: "session_1",
        surface: "tui",
        timestamp: 1,
      }),
    ).toEqual({
      type: "command.started",
      uiEvent: {
        command: {
          clientInvocationId: "inv_1",
          commandId: "status",
          commandRunId: "cmd_1",
          path: ["status"],
          sessionId: "session_1",
          surface: "tui",
        },
        timestamp: 1,
        type: "command.started",
      },
    });

    expect(
      commandResultDelivered.project({
        clientInvocationId: "inv_1",
        commandRunId: "cmd_1",
        output: { kind: "text", text: "OK" },
        action: { kind: "open", label: "Open" },
        timestamp: 2,
      }),
    ).toEqual({
      type: "command.result.delivered",
      uiEvent: {
        action: { kind: "open", label: "Open" },
        clientInvocationId: "inv_1",
        commandRunId: "cmd_1",
        output: { kind: "text", text: "OK" },
        timestamp: 2,
        type: "command.result.delivered",
      },
    });

    expect(
      commandFailed.project({
        clientInvocationId: "inv_2",
        commandRunId: "cmd_2",
        error: { code: "INVALID_ARGS", message: "bad args" },
        timestamp: 3,
      }),
    ).toEqual({
      type: "command.failed",
      uiEvent: {
        clientInvocationId: "inv_2",
        commandRunId: "cmd_2",
        error: { code: "INVALID_ARGS", message: "bad args" },
        timestamp: 3,
        type: "command.failed",
      },
    });

    expect(
      commandCatalogUpdated.project({
        version: "v1",
        reason: "registered",
        timestamp: 4,
      }),
    ).toEqual({
      type: "command.catalog.updated",
      uiEvent: {
        reason: "registered",
        timestamp: 4,
        type: "command.catalog.updated",
        version: "v1",
      },
    });

    expect(
      interactionRequested.project({
        request: {
          clientInvocationId: "inv_3",
          commandRunId: "cmd_3",
          interactionId: "interaction_1",
          kind: "select-one",
          subject: "model",
        },
        timestamp: 5,
      }),
    ).toEqual({
      type: "interaction.requested",
      uiEvent: {
        request: {
          clientInvocationId: "inv_3",
          commandRunId: "cmd_3",
          interactionId: "interaction_1",
          kind: "select-one",
          subject: "model",
        },
        timestamp: 5,
        type: "interaction.requested",
      },
    });

    expect(
      interactionResolved.project({
        clientInvocationId: "inv_3",
        commandRunId: "cmd_3",
        interactionId: "interaction_1",
        response: { kind: "cancelled", reason: "user-cancelled" },
        timestamp: 6,
      }),
    ).toEqual({
      type: "interaction.resolved",
      uiEvent: {
        clientInvocationId: "inv_3",
        commandRunId: "cmd_3",
        interactionId: "interaction_1",
        status: "cancelled",
        timestamp: 6,
        type: "interaction.resolved",
      },
    });
  });

  it("converts projected UI events to stream events without type or undefined fields", () => {
    const [, commandResultDelivered, , commandCatalogUpdated, , interactionResolved] =
      appEventProjectors;

    expect(
      toAppStreamEvent(
        commandResultDelivered.project({
          clientInvocationId: "inv_1",
          commandRunId: "cmd_1",
          timestamp: 2,
        }),
      ),
    ).toEqual({
      data: {
        clientInvocationId: "inv_1",
        commandRunId: "cmd_1",
        timestamp: 2,
      },
      type: "command.result.delivered",
    });

    expect(
      toAppStreamEvent(
        commandCatalogUpdated.project({
          version: "v1",
          timestamp: 4,
        }),
      ),
    ).toEqual({
      data: {
        timestamp: 4,
        version: "v1",
      },
      type: "command.catalog.updated",
    });

    expect(
      toAppStreamEvent(
        interactionResolved.project({
          commandRunId: "cmd_3",
          interactionId: "interaction_1",
          response: { kind: "accepted", choiceId: "yes" },
          timestamp: 6,
        }),
      ),
    ).toEqual({
      data: {
        commandRunId: "cmd_3",
        interactionId: "interaction_1",
        status: "accepted",
        timestamp: 6,
      },
      type: "interaction.resolved",
    });
  });
});

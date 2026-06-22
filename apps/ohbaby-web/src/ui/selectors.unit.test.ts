import { describe, expect, it } from "vitest";
import type { UiMessage, UiSnapshot } from "ohbaby-sdk";
import type { StoreSnapshot } from "../api/daemon/wire.js";
import { messageText, selectViewModel } from "./selectors.js";

const timestamp = "2026-06-12T00:00:00.000Z";

function store(snapshot: UiSnapshot): StoreSnapshot {
  return {
    connectionState: "live",
    error: null,
    view: {
      commandCatalogVersion: null,
      commandNotices: [],
      lastAppliedSeqNum: 10,
      snapshot,
    },
  };
}

function baseSnapshot(): UiSnapshot {
  return {
    activeSessionId: "session_1",
    contextWindowUsages: [
      {
        contextWindowRatio: 0.25,
        contextWindowTokens: 200_000,
        currentTokens: 50_000,
        estimatedAt: timestamp,
        modelId: "glm-5.1",
        sessionId: "session_1",
      },
    ],
    permission: {
      level: "default",
      mode: "auto",
      sessionRules: [],
    },
    permissions: [],
    runs: [],
    sessions: [
      {
        createdAt: timestamp,
        id: "session_1",
        messages: [],
        title: "Session",
        updatedAt: timestamp,
      },
    ],
    status: { kind: "idle" },
  };
}

describe("ohbaby-web ui selectors", () => {
  it("projects header and composer state from the daemon snapshot", () => {
    const view = selectViewModel(store(baseSnapshot()));

    expect(view.header).toMatchObject({
      connectionKind: "idle",
      contextLabel: "50k / 200k",
      contextRatio: 0.25,
      modelLabel: "glm-5.1",
    });
    expect(view.composer).toMatchObject({
      canSend: true,
      mode: "auto",
      permissionLevel: "default",
    });
  });

  it("keeps already pending permissions visible under full-access policy", () => {
    const snapshot = {
      ...baseSnapshot(),
      permission: { level: "full-access", mode: "plan", sessionRules: [] },
      permissions: [
        {
          choices: [{ id: "allow", intent: "allow", label: "Allow" }],
          description: "Run bash",
          id: "permission_1",
          runId: "run_1",
          title: "Permission",
        },
      ],
    } satisfies UiSnapshot;

    expect(selectViewModel(store(snapshot)).pendingPermissions).toHaveLength(1);
  });

  it("extracts display text from text and reasoning message parts only", () => {
    const message: UiMessage = {
      createdAt: timestamp,
      id: "message_1",
      parts: [
        { text: "hello", type: "text" },
        { text: " there", type: "reasoning" },
        {
          call: { id: "call_1", input: {}, name: "read", status: "completed" },
          type: "tool-call",
        },
      ],
      role: "assistant",
    };

    expect(messageText(message)).toBe("hello there");
  });

  it("passes command notices through to the view model", () => {
    const snapshot = store(baseSnapshot());
    const view = selectViewModel({
      ...snapshot,
      view: {
        ...snapshot.view,
        commandNotices: [
          {
            commandId: "status",
            createdAt: timestamp,
            id: "command_1",
            kind: "success",
            path: ["status"],
            text: "status",
          },
        ],
      },
    });

    expect(view.commandNotices).toHaveLength(1);
    expect(view.commandNotices[0]).toMatchObject({
      commandId: "status",
      text: "status",
    });
  });
});

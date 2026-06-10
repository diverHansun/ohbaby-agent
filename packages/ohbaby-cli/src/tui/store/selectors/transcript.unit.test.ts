import { describe, expect, it } from "vitest";
import type { UiMessage, UiSnapshot } from "ohbaby-sdk";
import { createStateFromSnapshot } from "../events.js";
import {
  selectCommandNoticeLaneState,
  selectCommittedItems,
  selectLiveMessage,
  selectNoticeLaneState,
  selectTranscriptSplit,
} from "./transcript.js";

describe("transcript selectors", () => {
  it("selects pre-computed committed and live transcript slices", () => {
    const committed = userMessage("user_1", "inspect this");
    const live = assistantMessage("assistant_1", "working", {
      status: "streaming",
    });
    const state = createStateFromSnapshot(
      snapshot({
        messages: [committed, live],
        status: { kind: "running", runId: "run_1" },
      }),
    );

    expect(
      selectCommittedItems(state).map((item) => item.message),
    ).toEqual([committed]);
    expect(selectLiveMessage(state)).toEqual(live);
    expect(selectTranscriptSplit(state)).toEqual({
      committedItems: [
        {
          id: "user_1",
          message: committed,
          messageId: "user_1",
          spacing: true,
        },
      ],
      liveMessage: live,
    });
  });

  it("keeps UI notices and command notices in separate lanes", () => {
    let state = createStateFromSnapshot(
      snapshot({
        messages: [],
        status: { kind: "idle" },
      }),
    );
    state = {
      ...state,
      commandNotices: [
        {
          commandId: "command_status",
          id: "command_notice_1",
          kind: "result",
          text: "status: idle",
        },
      ],
      notices: [
        {
          createdAt: "2026-06-07T00:00:00.000Z",
          id: "notice_1",
          level: "warning",
          message: "Context window usage could not be refreshed",
          title: "Context unavailable",
        },
      ],
    };

    expect(selectNoticeLaneState(state)).toEqual({
      notices: state.notices,
    });
    expect(selectCommandNoticeLaneState(state)).toEqual({
      commandNotices: state.commandNotices,
    });
  });
});

function snapshot(input: {
  readonly messages: readonly UiMessage[];
  readonly status: UiSnapshot["status"];
}): UiSnapshot {
  return {
    activeSessionId: "session_1",
    permissions: [],
    runs: [],
    sessions: [
      {
        createdAt: "2026-06-07T00:00:00.000Z",
        id: "session_1",
        messages: input.messages,
        title: "Main",
        updatedAt: "2026-06-07T00:00:00.000Z",
      },
    ],
    status: input.status,
  };
}

function userMessage(id: string, text: string): UiMessage {
  return {
    createdAt: "2026-06-07T00:00:01.000Z",
    id,
    parts: [{ text, type: "text" }],
    role: "user",
  };
}

function assistantMessage(
  id: string,
  text: string,
  patch: Partial<UiMessage> = {},
): UiMessage {
  return {
    createdAt: "2026-06-07T00:00:02.000Z",
    id,
    parts: [{ text, type: "text" }],
    role: "assistant",
    ...patch,
  };
}

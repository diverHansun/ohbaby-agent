import type { UiPromptSubmission } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import { rewindablePrompts, rewindConfirmation } from "./rewind-model.js";

function prompt(
  promptId: string,
  startedAt: string,
  patch: Partial<UiPromptSubmission> = {},
): UiPromptSubmission {
  return {
    promptId,
    clientRequestId: `client-${promptId}`,
    scopeKey: "scope",
    sessionId: "session",
    userMessageId: `user-${promptId}`,
    text: `${promptId}\nsecond line`,
    status: "succeeded",
    createdAt: startedAt,
    startedAt,
    updatedAt: startedAt,
    ...patch,
  };
}

describe("rewind list (T24)", () => {
  it("lists this session's started prompts, newest first", () => {
    const list = rewindablePrompts(
      [
        prompt("old", "2026-11-11T10:00:00Z"),
        prompt("new", "2026-11-11T10:05:00Z", { status: "running" }),
        prompt("queued", "2026-11-11T10:06:00Z", { status: "queued" }),
        prompt("steer", "2026-11-11T10:07:00Z", { status: "steered" }),
        prompt("gone", "2026-11-11T10:08:00Z", { rewoundAt: "x" }),
        prompt("other", "2026-11-11T10:09:00Z", { sessionId: "other" }),
      ],
      "session",
    );
    expect(list.map((item) => item.promptId)).toEqual(["new", "old"]);
  });
});

describe("rewind confirmation (T25, T26)", () => {
  it("counts the selected turn and says files stay", () => {
    expect(
      rewindConfirmation({ turns: 1, goal: null, running: false, queued: 0 }),
    ).toBe(
      "Rewind 1 turn. File changes won't be undone. Enter to confirm, Esc to cancel.",
    );
  });

  it("adds the goal, running and queue sentences", () => {
    expect(
      rewindConfirmation({
        turns: 3,
        goal: { status: "active" } as never,
        running: true,
        queued: 2,
      }),
    ).toBe(
      "Rewind 3 turns. File changes won't be undone. Goal turns already used won't be refunded. The current task will stop first. 2 queued messages will be removed. The goal will pause. Enter to confirm, Esc to cancel.",
    );
  });
});

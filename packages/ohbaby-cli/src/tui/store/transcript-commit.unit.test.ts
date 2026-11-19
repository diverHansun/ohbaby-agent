import type { UiMessage, UiMessagePart } from "ohbaby-sdk";
import { describe, expect, it } from "vitest";
import {
  advanceTranscriptCommit,
  computeLiveStartIndex,
} from "./transcript.js";

describe("computeLiveStartIndex", () => {
  it("keeps a lone streaming text part live", () => {
    expect(computeLiveStartIndex(streaming([text("hello")]))).toBe(0);
  });

  it("seals every part before the streaming tail text", () => {
    expect(
      computeLiveStartIndex(streaming([text("first"), text("tail")])),
    ).toBe(1);
  });

  it("keeps running tool calls live", () => {
    expect(
      computeLiveStartIndex(
        streaming([text("intro"), toolCall("call_1", "running")]),
      ),
    ).toBe(1);
  });

  it("seals completed tool calls together with their results", () => {
    expect(
      computeLiveStartIndex(
        streaming([
          text("intro"),
          toolCall("call_1", "completed"),
          toolResult("call_1"),
          text("tail"),
        ]),
      ),
    ).toBe(3);
  });

  it("never separates a parallel tool call from its pending sibling", () => {
    expect(
      computeLiveStartIndex(
        streaming([
          toolCall("call_a", "completed"),
          toolCall("call_b", "running"),
          toolResult("call_a"),
        ]),
      ),
    ).toBe(0);
  });

  it("seals reasoning once later parts exist", () => {
    expect(
      computeLiveStartIndex(streaming([reasoning("thinking"), text("tail")])),
    ).toBe(1);
  });

  it("keeps a completed tool call live until its result arrives", () => {
    expect(
      computeLiveStartIndex(
        streaming([toolCall("call_1", "completed"), text("tail")]),
      ),
    ).toBe(0);
  });
});

describe("advanceTranscriptCommit", () => {
  it("commits every message whole when the runtime is idle", () => {
    const messages = [userMessage("user_1"), assistantMessage("assistant_1")];

    const state = advanceTranscriptCommit(undefined, messages, {
      kind: "idle",
    });

    expect(state.committedItems.map((item) => item.id)).toEqual([
      "user_1",
      "assistant_1",
    ]);
    expect(state.committedItems.every((item) => item.spacing)).toBe(true);
    expect(state.liveMessage).toBeNull();
  });

  it("keeps an unsealed streaming message entirely live", () => {
    const live = streaming([text("partial")], "assistant_live");
    const messages = [userMessage("user_1"), live];

    const state = advanceTranscriptCommit(undefined, messages, running());

    expect(state.committedItems.map((item) => item.id)).toEqual(["user_1"]);
    expect(state.liveMessage).toBe(live);
  });

  it("commits the sealed prefix of a live message as a fragment", () => {
    const live = streaming(
      [
        text("intro"),
        toolCall("call_1", "completed"),
        toolResult("call_1"),
        text("tail"),
      ],
      "assistant_live",
    );

    const state = advanceTranscriptCommit(
      undefined,
      [userMessage("user_1"), live],
      running(),
    );

    expect(state.committedItems.map((item) => item.id)).toEqual([
      "user_1",
      "assistant_live#0-3",
    ]);
    const fragment = state.committedItems.at(-1);
    expect(fragment?.spacing).toBe(false);
    expect(fragment?.message.parts).toHaveLength(3);
    expect(fragment?.message.status).toBe("completed");
    expect(state.liveMessage?.parts).toEqual([text("tail")]);
  });

  it("collapses sealed reasoning by committing the fragment as completed", () => {
    const live = streaming(
      [reasoning("thinking"), text("tail")],
      "assistant_live",
    );

    const state = advanceTranscriptCommit(undefined, [live], running());

    const fragment = state.committedItems.at(0);
    expect(fragment?.message.status).toBe("completed");
    expect(fragment?.message.parts).toEqual([reasoning("thinking")]);
  });

  it("does not re-commit fragments on subsequent advances", () => {
    const live = streaming(
      [
        text("intro"),
        toolCall("call_1", "completed"),
        toolResult("call_1"),
        text("tail"),
      ],
      "assistant_live",
    );
    const messages = [userMessage("user_1"), live];

    const first = advanceTranscriptCommit(undefined, messages, running());
    const second = advanceTranscriptCommit(first, messages, running());

    expect(second.committedItems).toBe(first.committedItems);
    expect(second.committedPartCounts).toBe(first.committedPartCounts);
  });

  it("appends a new fragment when more parts seal", () => {
    const earlier = streaming(
      [text("intro"), toolCall("call_1", "running")],
      "assistant_live",
    );
    const later = streaming(
      [
        text("intro"),
        toolCall("call_1", "completed"),
        toolResult("call_1"),
        text("tail"),
      ],
      "assistant_live",
    );

    const first = advanceTranscriptCommit(undefined, [earlier], running());
    const second = advanceTranscriptCommit(first, [later], running());

    expect(first.committedItems.map((item) => item.id)).toEqual([
      "assistant_live#0-1",
    ]);
    expect(second.committedItems.map((item) => item.id)).toEqual([
      "assistant_live#0-1",
      "assistant_live#1-3",
    ]);
    expect(second.liveMessage?.parts).toEqual([text("tail")]);
  });

  it("emits the trailing fragment with spacing once the run goes idle", () => {
    const live = streaming(
      [
        text("intro"),
        toolCall("call_1", "completed"),
        toolResult("call_1"),
        text("tail"),
      ],
      "assistant_live",
    );
    const completed: UiMessage = { ...live, status: "completed" };

    const first = advanceTranscriptCommit(undefined, [live], running());
    const second = advanceTranscriptCommit(first, [completed], {
      kind: "idle",
    });

    expect(second.committedItems.map((item) => item.id)).toEqual([
      "assistant_live#0-3",
      "assistant_live#3-4",
    ]);
    expect(second.committedItems.at(-1)?.spacing).toBe(true);
    expect(second.liveMessage).toBeNull();
  });

  it("never re-commits parts even if the sealed boundary moves backwards", () => {
    const sealed = streaming([text("intro"), text("tail")], "assistant_live");
    const regressed = streaming([text("intro")], "assistant_live");

    const first = advanceTranscriptCommit(undefined, [sealed], running());
    const second = advanceTranscriptCommit(first, [regressed], running());

    expect(first.committedPartCounts.assistant_live).toBe(1);
    expect(second.committedItems).toBe(first.committedItems);
    expect(second.liveMessage).toBeNull();
  });

  it("hides the live message entirely once all parts are sealed", () => {
    const live = streaming(
      [text("intro"), toolCall("call_1", "completed"), toolResult("call_1")],
      "assistant_live",
    );

    const state = advanceTranscriptCommit(undefined, [live], running());

    expect(state.committedItems.map((item) => item.id)).toEqual([
      "assistant_live#0-3",
    ]);
    expect(state.liveMessage).toBeNull();
  });

  it("appends a final item when a fully sealed live message completes", () => {
    const live = streaming(
      [text("intro"), toolCall("call_1", "completed"), toolResult("call_1")],
      "assistant_live",
    );
    const completed: UiMessage = {
      ...live,
      finishReason: "length",
      status: "completed",
    };

    const first = advanceTranscriptCommit(undefined, [live], running());
    const second = advanceTranscriptCommit(first, [completed], {
      kind: "idle",
    });

    expect(second.committedItems.map((item) => item.id)).toEqual([
      "assistant_live#0-3",
      "assistant_live#final",
    ]);
    const finalItem = second.committedItems.at(-1);
    expect(finalItem?.spacing).toBe(true);
    expect(finalItem?.message.parts).toEqual([]);
    expect(finalItem?.message.finishReason).toBe("length");
    expect(second.liveMessage).toBeNull();
  });

  it("refreshes a committed whole message in place when it changes", () => {
    const original = assistantMessage("assistant_1");
    const updated: UiMessage = {
      ...original,
      parts: [text("revised answer")],
    };

    const first = advanceTranscriptCommit(undefined, [original], {
      kind: "idle",
    });
    const second = advanceTranscriptCommit(first, [updated], {
      kind: "idle",
    });

    expect(second.committedItems.map((item) => item.id)).toEqual([
      "assistant_1",
    ]);
    expect(second.committedItems[0].message).toBe(updated);
  });

  it("appends a final item when an already committed message later reports truncation", () => {
    const original = assistantMessage("assistant_1");
    const updated: UiMessage = {
      ...original,
      finishReason: "length",
    };

    const first = advanceTranscriptCommit(undefined, [original], {
      kind: "idle",
    });
    const second = advanceTranscriptCommit(first, [updated], {
      kind: "idle",
    });

    expect(second.committedItems.map((item) => item.id)).toEqual([
      "assistant_1",
      "assistant_1#final",
    ]);
    expect(second.committedItems[0].message).toBe(original);
    expect(second.committedItems[1].message.parts).toEqual([]);
    expect(second.committedItems[1].message.finishReason).toBe("length");
  });

  it("preserves the live message reference between unrelated advances", () => {
    const live = streaming(
      [
        text("intro"),
        toolCall("call_1", "completed"),
        toolResult("call_1"),
        text("tail"),
      ],
      "assistant_live",
    );

    const first = advanceTranscriptCommit(undefined, [live], running());
    const second = advanceTranscriptCommit(first, [live], running());

    expect(second.liveMessage).toBe(first.liveMessage);
  });
});

describe("retried attempts", () => {
  const failed = {
    requestId: "r1",
    runId: "run_1",
    messageId: "attempt_1",
    step: 1,
    attempt: 1,
    purpose: "agent-step" as const,
    startedAt: 1,
    endedAt: 2,
    outcome: "error" as const,
    retryScheduled: true as const,
  };
  const attempt = (
    parts: readonly UiMessagePart[],
    status: UiMessage["status"],
  ): UiMessage => ({
    ...streaming(parts, "attempt_1"),
    runId: "run_1",
    status,
    modelRequests: [
      status === "streaming"
        ? {
            ...failed,
            endedAt: undefined,
            outcome: "running",
            retryScheduled: undefined,
          }
        : failed,
    ],
  });
  const retry: UiMessage = {
    ...streaming([], "attempt_2"),
    runId: "run_1",
    modelRequests: [
      {
        ...failed,
        requestId: "r2",
        messageId: "attempt_2",
        attempt: 2,
        startedAt: 3,
        endedAt: undefined,
        outcome: "running",
        retryScheduled: undefined,
      },
    ],
  };
  const lines = (state: ReturnType<typeof advanceTranscriptCommit>): string[] =>
    state.committedItems.flatMap((item) =>
      item.message.parts.flatMap((part) =>
        part.type === "text" ? [part.text] : [],
      ),
    );

  it("keeps frozen parts and drops the rest once the retry starts", () => {
    const user = userMessage("user_1");
    let state = advanceTranscriptCommit(
      undefined,
      [user, attempt([reasoning("plan"), text("Half an")], "streaming")],
      running(),
    );
    expect(state.committedItems.map((item) => item.id)).toEqual([
      "user_1",
      "attempt_1#0-1",
    ]);
    // Waiting for the retry: the failed attempt is still the live tail.
    state = advanceTranscriptCommit(
      state,
      [user, attempt([reasoning("plan"), text("Half an")], "error")],
      running(),
    );
    expect(state.liveMessage?.parts).toEqual([text("Half an")]);
    state = advanceTranscriptCommit(
      state,
      [user, attempt([reasoning("plan"), text("Half an")], "error"), retry],
      running(),
    );
    // Only the closing spacer follows the frozen reasoning; the half answer goes.
    expect(state.committedItems.map((item) => item.id)).toEqual([
      "user_1",
      "attempt_1#0-1",
      "attempt_1#final",
    ]);
    expect(lines(state)).toEqual(["user prompt"]);
    expect(state.liveMessage?.id).toBe("attempt_2");
    // The retry streams on: nothing more commits for the replaced attempt.
    const committed = state.committedItems;
    state = advanceTranscriptCommit(
      state,
      [
        user,
        attempt([reasoning("plan"), text("Half an")], "error"),
        { ...retry, parts: [text("Full answer")] },
      ],
      running(),
    );
    expect(state.committedItems).toBe(committed);
  });

  it("keeps a pending retry out of scrollback even when Steer is accepted", () => {
    const user = userMessage("user_1");
    const steer = {
      ...userMessage("steer"),
      parts: [text("Steer instruction")],
    };
    const partial = attempt([text("Half an answer")], "error");
    const streaming = {
      ...attempt(partial.parts, "streaming"),
      status: undefined,
    };
    const waiting = advanceTranscriptCommit(
      undefined,
      [user, streaming],
      running(),
    );
    const steered = advanceTranscriptCommit(
      waiting,
      [user, streaming, steer],
      running(),
    );
    expect(steered.committedItems.map((item) => item.id)).toEqual(["user_1"]);
    expect(steered.liveMessage?.parts).toEqual(partial.parts);

    // The request end can arrive before the failed message state.
    const scheduled = advanceTranscriptCommit(
      steered,
      [user, { ...partial, status: undefined }, steer],
      running(),
    );
    expect(scheduled.committedItems).toBe(steered.committedItems);
    expect(scheduled.liveMessage?.id).toBe(partial.id);

    const placeholder = { ...retry, modelRequests: [] };
    const opening = advanceTranscriptCommit(
      scheduled,
      [user, partial, steer, placeholder],
      running(),
    );
    expect(opening.committedItems.map((item) => item.id)).toEqual(["user_1"]);
    expect(opening.liveMessage?.id).toBe(partial.id);

    const restarted = advanceTranscriptCommit(
      opening,
      [user, partial, steer, retry],
      running(),
    );
    expect(lines(restarted)).toEqual(["user prompt", "Steer instruction"]);
    expect(restarted.liveMessage?.id).toBe(retry.id);

    const stopped = advanceTranscriptCommit(opening, [user, partial, steer], {
      kind: "idle",
    });
    expect(lines(stopped)).toEqual([
      "user prompt",
      "Half an answer",
      "Steer instruction",
    ]);
  });

  it("restores without a retried attempt and keeps one whose retry never ran", () => {
    const user = userMessage("user_1");
    const answer = {
      ...assistantMessage("attempt_2"),
      runId: "run_1",
      modelRequests: retry.modelRequests,
    };
    expect(
      lines(
        advanceTranscriptCommit(
          undefined,
          [user, attempt([text("Half an")], "error"), answer],
          { kind: "idle" },
        ),
      ),
    ).toEqual(["user prompt", "assistant answer"]);
    // Nothing changed, so nothing re-renders.
    const messages = [user, attempt([text("Half an")], "error"), answer];
    const first = advanceTranscriptCommit(undefined, messages, {
      kind: "idle",
    });
    expect(
      advanceTranscriptCommit(first, messages, { kind: "idle" }).committedItems,
    ).toBe(first.committedItems);
    expect(
      lines(
        advanceTranscriptCommit(
          undefined,
          [user, attempt([text("Half an")], "error")],
          { kind: "idle" },
        ),
      ),
    ).toEqual(["user prompt", "Half an"]);
  });
});

function running(): { kind: "running"; runId: string } {
  return { kind: "running", runId: "run_1" };
}

function text(value: string): UiMessagePart {
  return { text: value, type: "text" };
}

function reasoning(value: string): UiMessagePart {
  return { text: value, type: "reasoning" };
}

function toolCall(
  id: string,
  status: "pending" | "running" | "completed" | "failed",
): UiMessagePart {
  return {
    call: { id, input: {}, name: "read", status },
    type: "tool-call",
  };
}

function toolResult(callId: string): UiMessagePart {
  return {
    result: { callId, output: "ok" },
    type: "tool-result",
  };
}

function streaming(
  parts: readonly UiMessagePart[],
  id = "assistant_streaming",
): UiMessage {
  return {
    createdAt: "2026-06-10T00:00:01.000Z",
    id,
    parts,
    role: "assistant",
    status: "streaming",
  };
}

function userMessage(id: string): UiMessage {
  return {
    createdAt: "2026-06-10T00:00:00.000Z",
    id,
    parts: [text("user prompt")],
    role: "user",
  };
}

function assistantMessage(id: string): UiMessage {
  return {
    createdAt: "2026-06-10T00:00:02.000Z",
    id,
    parts: [text("assistant answer")],
    role: "assistant",
    status: "completed",
  };
}

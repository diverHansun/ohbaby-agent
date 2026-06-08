import { describe, expect, it, vi } from "vitest";
import { createCoalescedTuiEventDispatcher } from "./stream-coalescer.js";
import type { TuiEvent } from "./snapshot.js";

describe("createCoalescedTuiEventDispatcher", () => {
  it("uses a conservative default flush cadence for streaming text", () => {
    vi.useFakeTimers();
    const batches: readonly TuiEvent[][] = [];
    const dispatcher = createCoalescedTuiEventDispatcher((events) => {
      (batches as TuiEvent[][]).push([...events]);
    });

    dispatcher.dispatch(delta("Hel", "Hel"));

    vi.advanceTimersByTime(49);
    expect(batches).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(batches).toHaveLength(1);

    dispatcher.dispose();
    vi.useRealTimers();
  });

  it("coalesces adjacent text deltas for the same message part", () => {
    vi.useFakeTimers();
    const batches: readonly TuiEvent[][] = [];
    const dispatcher = createCoalescedTuiEventDispatcher(
      (events) => {
        (batches as TuiEvent[][]).push([...events]);
      },
      { flushMs: 33 },
    );

    dispatcher.dispatch(delta("Hel", "Hel"));
    dispatcher.dispatch(delta("lo", "Hello"));

    expect(batches).toEqual([]);

    vi.advanceTimersByTime(33);

    expect(batches).toEqual([
      [
        expect.objectContaining({
          content: "Hello",
          delta: "Hello",
          type: "message.part.delta",
        }),
      ],
    ]);

    dispatcher.dispose();
    vi.useRealTimers();
  });

  it("flushes pending deltas before non-delta events", () => {
    vi.useFakeTimers();
    const batches: readonly TuiEvent[][] = [];
    const dispatcher = createCoalescedTuiEventDispatcher(
      (events) => {
        (batches as TuiEvent[][]).push([...events]);
      },
      { flushMs: 33 },
    );
    const runEvent: TuiEvent = {
      run: {
        id: "run_1",
        sessionId: "session_1",
        startedAt: "2026-06-07T00:00:00.000Z",
        status: { kind: "idle" },
        updatedAt: "2026-06-07T00:00:01.000Z",
      },
      type: "run.updated",
    };

    dispatcher.dispatch(delta("Hel", "Hel"));
    dispatcher.dispatch(runEvent);

    expect(batches).toEqual([
      [
        expect.objectContaining({
          content: "Hel",
          delta: "Hel",
          type: "message.part.delta",
        }),
        runEvent,
      ],
    ]);

    dispatcher.dispose();
    vi.useRealTimers();
  });

  it("flushes pending deltas when disposed before the timer fires", () => {
    vi.useFakeTimers();
    const batches: readonly TuiEvent[][] = [];
    const dispatcher = createCoalescedTuiEventDispatcher(
      (events) => {
        (batches as TuiEvent[][]).push([...events]);
      },
      { flushMs: 33 },
    );

    dispatcher.dispatch(delta("Hel", "Hel"));
    dispatcher.dispose();

    expect(batches).toEqual([
      [
        expect.objectContaining({
          content: "Hel",
          delta: "Hel",
          type: "message.part.delta",
        }),
      ],
    ]);

    vi.advanceTimersByTime(33);
    expect(batches).toHaveLength(1);

    vi.useRealTimers();
  });
});

function delta(deltaText: string, content: string): TuiEvent {
  return {
    content,
    delta: deltaText,
    messageId: "message_1",
    partId: "part_1",
    sessionId: "session_1",
    type: "message.part.delta",
  };
}

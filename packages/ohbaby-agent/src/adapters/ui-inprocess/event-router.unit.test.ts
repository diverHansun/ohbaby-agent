import type { UiEvent, UiNotice } from "ohbaby-sdk";
import { describe, expect, it, vi } from "vitest";
import { InProcessEventRouter } from "./event-router.js";
import type { NoticeDraft } from "./types.js";

function noticeFromDraft(draft: NoticeDraft): UiNotice {
  return {
    ...draft,
    createdAt: draft.createdAt ?? "2026-05-20T00:00:00.000Z",
    id: "notice_1",
  };
}

describe("InProcessEventRouter", () => {
  it("isolates event handlers from handler exceptions", (): void => {
    const router = new InProcessEventRouter({
      createNotice: noticeFromDraft,
      nowMs: (): number => 1,
    });
    const received: UiEvent[] = [];
    router.subscribeEvents((): void => {
      throw new Error("handler failed");
    });
    router.subscribeEvents((event): void => {
      received.push(event);
    });
    const event: UiEvent = {
      status: { kind: "idle" },
      timestamp: 1,
      type: "runtime.updated",
    };

    router.publish(event);

    expect(received).toEqual([event]);
  });

  it("reports failed critical delivery and disconnects that observer", () => {
    const router = new InProcessEventRouter({
      createNotice: noticeFromDraft,
      nowMs: (): number => 2,
    });
    const healthy = vi.fn<(event: UiEvent) => void>();
    router.subscribeEvents(() => {
      throw new Error("socket failed");
    });
    router.subscribeEvents(healthy);
    const event: UiEvent = {
      type: "session.unavailable",
      sessionId: "a",
      runtimeEpoch: "e",
      reason: "projection failed",
    };
    expect(() => {
      router.publishRecovery(event);
    }).toThrow("socket failed");
    expect(healthy).toHaveBeenCalledOnce();
    expect(() => {
      router.publishRecovery(event);
    }).not.toThrow();
  });

  it("delivers unavailable to an observer that only rejects changed events", () => {
    const router = new InProcessEventRouter({
      createNotice: noticeFromDraft,
      nowMs: (): number => 2,
    });
    const received: UiEvent[] = [];
    const healthy = vi.fn<(event: UiEvent) => void>();
    router.subscribeEvents((event) => {
      if (event.type === "session.changed")
        throw new Error("delta renderer failed");
      received.push(event);
    });
    router.subscribeEvents(healthy);
    const changed: UiEvent = {
      type: "session.changed",
      version: {
        runtimeEpoch: "e",
        sessionId: "a",
        viewGeneration: "g",
        sessionRevision: 1,
      },
    };
    expect(() => {
      router.publishRecovery(changed);
    }).toThrow("delta renderer failed");
    const unavailable: UiEvent = {
      type: "session.unavailable",
      runtimeEpoch: "e",
      sessionId: "a",
      reason: "delta renderer failed",
    };
    expect(() => {
      router.publishRecovery(unavailable);
    }).not.toThrow();
    expect(received).toEqual([unavailable]);
    expect(healthy.mock.calls.map((call) => call[0])).toEqual([
      changed,
      unavailable,
    ]);
  });

  it("reports even an undefined observer failure and attempts unavailable delivery", () => {
    const router = new InProcessEventRouter({
      createNotice: noticeFromDraft,
      nowMs: (): number => 2,
    });
    const unavailable = vi.fn();
    router.subscribeEvents((event) => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercise an untyped observer failure
      if (event.type === "session.changed") throw undefined;
      unavailable(event);
    });
    expect(() => {
      router.publishRecovery({
        type: "session.changed",
        version: {
          runtimeEpoch: "e",
          sessionId: "a",
          viewGeneration: "g",
          sessionRevision: 1,
        },
      });
    }).toThrow("Session observer failed");
    router.publishRecovery({
      type: "session.unavailable",
      runtimeEpoch: "e",
      sessionId: "a",
      reason: "observer failed",
    });
    expect(unavailable).toHaveBeenCalledOnce();
  });

  it("stops delivery after unsubscribe", (): void => {
    const router = new InProcessEventRouter({
      createNotice: noticeFromDraft,
      nowMs: (): number => 1,
    });
    const handler = vi.fn();
    const unsubscribe = router.subscribeEvents(handler);

    unsubscribe();
    router.publishNotice({
      key: "notice",
      level: "info",
      message: "hello",
      title: "Hello",
    });

    expect(handler).not.toHaveBeenCalled();
  });
});

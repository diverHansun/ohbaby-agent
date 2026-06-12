import type { UiEvent, UiNotice, UiSnapshot } from "ohbaby-sdk";
import { describe, expect, it, vi } from "vitest";
import { InProcessEventRouter } from "./event-router.js";
import type { NoticeDraft } from "./types.js";

const SNAPSHOT: UiSnapshot = {
  activeSessionId: null,
  permissions: [],
  runs: [],
  sessions: [],
  status: { kind: "idle" },
};

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

  it("publishes a snapshot replacement after routed state changes", async (): Promise<void> => {
    const router = new InProcessEventRouter({
      createNotice: noticeFromDraft,
      nowMs: (): number => 2,
    });
    const received: UiEvent[] = [];
    router.subscribeEvents((event): void => {
      received.push(event);
    });

    await router.publishSnapshotReplacement(() => Promise.resolve(SNAPSHOT));

    expect(received).toEqual([
      {
        snapshot: SNAPSHOT,
        timestamp: 2,
        type: "snapshot.replaced",
      },
    ]);
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

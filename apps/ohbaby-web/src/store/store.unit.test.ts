import { describe, expect, it, vi } from "vitest";
import type { UiSnapshot } from "ohbaby-sdk";
import { createOhbabyWebStore } from "./store.js";

function snapshot(title: string): UiSnapshot {
  return {
    activeSessionId: "session_1",
    permission: { level: "default", mode: "auto", sessionRules: [] },
    permissions: [],
    runs: [],
    sessions: [
      {
        createdAt: "2026-06-12T00:00:00.000Z",
        id: "session_1",
        messages: [],
        title,
        updatedAt: "2026-06-12T00:00:00.000Z",
      },
    ],
    status: { kind: "idle" },
  };
}

describe("createOhbabyWebStore", () => {
  it("distinguishes authoritative snapshot barriers from incremental events", () => {
    const store = createOhbabyWebStore();

    expect(
      store.applyEvent(
        { snapshot: snapshot("initial"), type: "snapshot.replaced" },
        0,
        "snapshot-barrier",
      ),
    ).toBe(true);
    expect(store.getSnapshot().view.snapshot?.sessions[0]?.title).toBe(
      "initial",
    );

    expect(
      store.applyEvent(
        { snapshot: snapshot("stale SSE"), type: "snapshot.replaced" },
        0,
        "incremental",
      ),
    ).toBe(false);
    expect(
      store.applyEvent(
        { snapshot: snapshot("projected"), type: "snapshot.replaced" },
        0,
        "snapshot-barrier",
      ),
    ).toBe(true);
    expect(store.getSnapshot().view.snapshot?.sessions[0]?.title).toBe(
      "projected",
    );
  });

  it("isolates a throwing store listener from later observers", () => {
    const store = createOhbabyWebStore();
    const observed = vi.fn();
    const observationDiagnostic = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    store.subscribe(() => {
      throw new Error("observer failed");
    });
    store.subscribe(observed);

    try {
      expect(
        store.applyEvent(
          { snapshot: snapshot("safe"), type: "snapshot.replaced" },
          0,
          "snapshot-barrier",
        ),
      ).toBe(true);
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observationDiagnostic).toHaveBeenCalledWith(
        '{"stage":"store-listener","type":"ui.observation.failure"}',
      );
    } finally {
      observationDiagnostic.mockRestore();
    }
  });
});

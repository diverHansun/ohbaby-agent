import { describe, expect, it, vi } from "vitest";
import type { UiEvent } from "../contract/events.js";
import type { UiSubagentInstanceSnapshot } from "../contract/subagent-instance.js";
import { createSubagentInstanceReader } from "./subagent-instance-reader.js";

function snapshot(revision: number, ids = ["one"]): UiSubagentInstanceSnapshot {
  return {
    rootSessionId: "root",
    runtimeEpoch: "epoch",
    bindingGeneration: 1,
    revision,
    complete: true,
    instances: ids.map((id) => ({
      rootSessionId: "root",
      subagentId: id,
      displayName: id,
      description: "task",
      createdAt: 1,
      updatedAt: 2,
      status: "completed",
      approvalBlocked: false,
      settling: false,
      unprocessedMessageCount: 0,
    })),
  };
}
describe("versioned subagent instance reader", () => {
  it("replaces complete snapshots and preserves a closed removal against stale revisions and failures", async () => {
    const list = vi.fn().mockResolvedValue(snapshot(1));
    const reader = createSubagentInstanceReader(
      { listSubagentInstances: list },
      { rootSessionId: "root", runtimeEpoch: "epoch", bindingGeneration: 1 },
    );
    await reader.refresh();
    expect(reader.getSnapshot().snapshot?.instances).toHaveLength(1);
    list.mockResolvedValueOnce(snapshot(3, []));
    await reader.refresh();
    list.mockResolvedValueOnce(snapshot(2));
    await reader.refresh();
    expect(reader.getSnapshot().snapshot?.instances).toEqual([]);
    list.mockRejectedValueOnce(new Error("offline"));
    await reader.refresh();
    expect(reader.getSnapshot()).toMatchObject({
      error: "offline",
      snapshot: { revision: 3, instances: [] },
    });
    reader.dispose();
  });

  it("ignores overlapping old reads and late responses after selecting another root", async () => {
    const pending: ((value: UiSubagentInstanceSnapshot) => void)[] = [];
    const reader = createSubagentInstanceReader(
      {
        listSubagentInstances: () =>
          new Promise((resolve) => pending.push(resolve)),
      },
      { rootSessionId: "root" },
    );
    const first = reader.refresh();
    const second = reader.refresh();
    pending[1](snapshot(4, []));
    await second;
    pending[0](snapshot(3));
    await first;
    expect(reader.getSnapshot().snapshot?.instances).toEqual([]);
    const old = reader.refresh();
    const switched = reader.select({ rootSessionId: "other" });
    pending[2](snapshot(5));
    await old;
    expect(reader.getSnapshot().snapshot).toBeUndefined();
    pending[3]({ ...snapshot(1, []), rootSessionId: "other" });
    await switched;
    expect(reader.getSnapshot().snapshot?.rootSessionId).toBe("other");
    reader.dispose();
  });

  it("refreshes on its existing event channel and rejects partial or cross-binding snapshots", async () => {
    let emit!: (event: UiEvent) => void;
    const list = vi.fn().mockResolvedValue(snapshot(1));
    const reader = createSubagentInstanceReader(
      {
        listSubagentInstances: list,
        subscribeEvents: (handler): (() => void) => {
          emit = handler;
          return () => undefined;
        },
      },
      { rootSessionId: "root", runtimeEpoch: "epoch", bindingGeneration: 1 },
    );
    await reader.refresh();
    list.mockResolvedValueOnce({ ...snapshot(2, []), bindingGeneration: 2 });
    emit({
      type: "subagent.instances.invalidated",
      rootSessionId: "root",
      runtimeEpoch: "epoch",
      revision: 2,
    });
    await vi.waitFor(() => {
      expect(reader.getSnapshot().loading).toBe(false);
    });
    expect(reader.getSnapshot().snapshot?.instances).toHaveLength(1);
    expect(reader.getSnapshot().error).toContain("scope or version");
    list.mockResolvedValueOnce({ ...snapshot(3, []), complete: false });
    await reader.refresh();
    expect(reader.getSnapshot().snapshot?.revision).toBe(1);
    reader.dispose();
  });
});

import { describe, expect, it, vi } from "vitest";
import { InMemorySubagentInstanceStore } from "../../agents/subagents/in-memory-store.js";
import { InMemorySubagentExecutionStore } from "../../agents/subagents/execution-store.js";
import type {
  SubagentInstanceRecord,
  SubagentStatusResult,
} from "../../agents/subagents/types.js";
import type { UiSubagentInstancesInvalidatedEvent } from "ohbaby-sdk";
import { SubagentInstanceProjection } from "./subagent-instances.js";

function instance(id: string): SubagentInstanceRecord {
  return {
    subagentId: id,
    parentSessionId: "root",
    sessionId: "child",
    contextScopeId: id,
    name: `Name ${id}`,
    role: "explore",
    initialPrompt: "inspect repository",
    status: "completed",
    pendingQueue: [],
    createdAt: 1,
    updatedAt: 2,
  };
}
async function setup(
  runtime?: (
    rootSessionId: string,
  ) => Promise<SubagentStatusResult | undefined>,
): Promise<{
  instances: InMemorySubagentInstanceStore;
  executions: InMemorySubagentExecutionStore;
  projection: SubagentInstanceProjection;
  events: UiSubagentInstancesInvalidatedEvent[];
  stop: () => Promise<undefined>;
}> {
  const instances = new InMemorySubagentInstanceStore();
  const executions = new InMemorySubagentExecutionStore();
  const events: UiSubagentInstancesInvalidatedEvent[] = [];
  const stop = vi.fn(() => Promise.resolve(undefined));
  const projection = new SubagentInstanceProjection({
    runtimeEpoch: "epoch",
    instances,
    executions,
    stop,
    validateRoot: (input): Promise<void> =>
      input.rootSessionId === "root" &&
      (!input.runtimeEpoch || input.runtimeEpoch === "epoch")
        ? Promise.resolve()
        : Promise.reject(
            Object.assign(new Error("Wrong scope"), {
              code: "SESSION_SCOPE_CHANGED",
            }),
          ),
    runtime:
      runtime ??
      ((): Promise<SubagentStatusResult | undefined> =>
        Promise.resolve(undefined)),
    unprocessedCount: (record): Promise<number> =>
      Promise.resolve(record.executionId === "latest" ? 2 : 0),
    publish: (event): void => {
      events.push(event);
    },
  });
  await instances.create(instance("one"));
  return { instances, executions, projection, events, stop };
}
describe("complete subagent instance snapshots", () => {
  it("retains more than fifty instances and collapses cross-turn executions into one row", async () => {
    const { instances, executions, projection } = await setup();
    for (let index = 0; index < 60; index++)
      await instances.create(instance(`i${String(index)}`));
    for (let index = 0; index < 5; index++) {
      const executionId = index === 4 ? "latest" : `e${String(index)}`;
      const { record } = await executions.accept({
        executionId,
        subagentId: "one",
        requestId: executionId,
        parentSessionId: "root",
        requesterScopeId: "primary",
        requesterRunId: `root-${String(index)}`,
        rootSessionId: "root",
        rootRunId: `root-${String(index)}`,
        mode: "background",
        prompt: "latest task",
        createdAt: index + 10,
      });
      await executions.finish(record, {
        status: "completed",
        completedAt: index + 20,
      });
    }
    const snapshot = await projection.list({
      rootSessionId: "root",
      bindingGeneration: 3,
    });
    expect(snapshot).toMatchObject({
      complete: true,
      runtimeEpoch: "epoch",
      bindingGeneration: 3,
    });
    expect(snapshot.instances).toHaveLength(61);
    expect(
      snapshot.instances.find((item) => item.subagentId === "one"),
    ).toMatchObject({
      latestExecutionId: "latest",
      displayName: "Name one",
      description: "latest task",
      unprocessedMessageCount: 2,
      approvalBlocked: false,
      settling: false,
    });
    projection.dispose();
  });

  it("invalidates completed-instance close without any new execution event", async () => {
    const { instances, projection, events } = await setup();
    const before = await projection.list({ rootSessionId: "root" });
    await instances.update("one", { closedAt: 5, updatedAt: 5 });
    const after = await projection.list({ rootSessionId: "root" });
    expect(after.instances).toEqual([]);
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(events.at(-1)).toMatchObject({
      rootSessionId: "root",
      runtimeEpoch: "epoch",
      revision: after.revision,
    });
    await expect(
      projection.stop({
        rootSessionId: "root",
        subagentId: "one",
        expectedExecutionId: "old",
      }),
    ).rejects.toMatchObject({ code: "SUBAGENT_CLOSED" });
    projection.dispose();
  });

  it("retries an in-flight read when close changes the instance set", async () => {
    const { instances, projection } = await setup();
    const list = instances.listByParent.bind(instances);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    instances.listByParent = async (
      root,
    ): Promise<readonly SubagentInstanceRecord[]> => {
      const result = await list(root);
      if (first) {
        first = false;
        await gate;
      }
      return result;
    };
    const reading = projection.list({ rootSessionId: "root" });
    await vi.waitFor(() => {
      expect(first).toBe(false);
    });
    await instances.update("one", { closedAt: 9, updatedAt: 9 });
    release();
    expect((await reading).instances).toEqual([]);
    projection.dispose();
  });

  it("retries the first snapshot when child inputs close during runtime fact collection", async () => {
    let entered!: () => void;
    let release!: () => void;
    const collecting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    let unprocessed = false;
    const { projection, events } = await setup(async () => {
      const snapshot: SubagentStatusResult = {
        items: [instance("one")],
        executions: [],
        runtime: [
          {
            subagentId: "one",
            settling: false,
            unprocessedMessages: unprocessed
              ? [{ inputId: "input", text: "unread", reason: "failed" }]
              : [],
          },
        ],
      };
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return snapshot;
    });
    events.length = 0;
    const reading = projection.list({ rootSessionId: "root" });
    await collecting;
    unprocessed = true;
    projection.invalidateSession("child");
    release();
    const snapshot = await reading;
    expect(snapshot.instances[0]?.unprocessedMessageCount).toBe(1);
    expect(snapshot.revision).toBeGreaterThan(1);
    expect(events).toContainEqual({
      type: "subagent.instances.invalidated",
      rootSessionId: "root",
      runtimeEpoch: "epoch",
      revision: snapshot.revision,
    });
    const later = await projection.list({ rootSessionId: "root" });
    expect(later.revision).toBe(snapshot.revision);
    expect(later.instances[0]?.unprocessedMessageCount).toBe(1);
    projection.dispose();
  });

  it("refuses wrong roots, missing identities and reads after disposal without invoking stop", async () => {
    const { projection, stop } = await setup();
    await expect(
      projection.stop({
        rootSessionId: "other",
        subagentId: "one",
        expectedExecutionId: "execution",
      }),
    ).rejects.toMatchObject({ code: "SESSION_SCOPE_CHANGED" });
    await expect(
      projection.stop({
        rootSessionId: "root",
        subagentId: "missing",
        expectedExecutionId: "execution",
      }),
    ).rejects.toMatchObject({ code: "SUBAGENT_NOT_FOUND" });
    await expect(
      projection.stop({
        rootSessionId: "root",
        subagentId: "one",
        expectedExecutionId: "",
      }),
    ).rejects.toMatchObject({ code: "INVALID_SESSION_QUERY" });
    expect(stop).not.toHaveBeenCalled();
    projection.dispose();
    await expect(projection.list({ rootSessionId: "root" })).rejects.toThrow(
      "disposed",
    );
  });
});

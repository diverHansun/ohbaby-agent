import { describe, expect, it } from "vitest";
import { SessionExecutionGate } from "../session-execution.js";
import {
  InMemorySubagentExecutionStore,
  type SubagentExecutionRecord,
} from "../../agents/subagents/execution-store.js";
import {
  reserveSubagentWakeup,
  type SubagentWakeupAdmission,
} from "./subagent-wakeup.js";

async function fixture(): Promise<{
  input: SubagentWakeupAdmission;
  executions: InMemorySubagentExecutionStore;
  record: SubagentExecutionRecord;
  gate: SessionExecutionGate;
}> {
  const executions = new InMemorySubagentExecutionStore();
  const gate = new SessionExecutionGate();
  const accepted = await executions.accept({
    executionId: "e",
    requestId: "call",
    parentSessionId: "parent",
    rootSessionId: "parent",
    rootRunId: "old-run",
    requesterRunId: "old-run",
    requesterScopeId: "primary",
    subagentId: "child",
    mode: "background",
    prompt: "task",
    createdAt: 1,
  });
  const { record } = await executions.finish(accepted.record, {
    status: "completed",
    output: "done",
    completedAt: 2,
  });
  let queue = Promise.resolve();
  const input: SubagentWakeupAdmission = {
    sessionId: "parent",
    reason: "result" as const,
    executions,
    gate,
    signal: new AbortController().signal,
    candidates: [record],
    now: () => 3,
    canStart: () => Promise.resolve(true),
    withSessionControl: <T>(
      _id: string,
      work: () => Promise<T>,
    ): Promise<T> => {
      const result = queue.then(work);
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  return { input, executions, record, gate };
}
describe("subagent wake admission", () => {
  it("reserves the shared execution gate before claiming a terminal result", async () => {
    const f = await fixture();
    const [first, concurrent] = await Promise.all([
      reserveSubagentWakeup(f.input),
      reserveSubagentWakeup(f.input),
    ]);
    expect(first).toBeTypeOf("symbol");
    expect(concurrent).toBeUndefined();
    expect(f.gate.isHeld("parent")).toBe(true);
    expect((await f.executions.get(f.record))?.delivery.wakeupAttemptedAt).toBe(
      3,
    );
    if (!first) throw new Error("Expected reservation");
    f.gate.release(first);
    expect(await reserveSubagentWakeup(f.input)).toBeUndefined();
    expect(f.gate.isHeld("parent")).toBe(false);
  });
  it("does not claim while a user owns the gate or queued input has priority", async () => {
    const f = await fixture();
    const user = Symbol("user");
    f.gate.reserve("parent", user);
    expect(await reserveSubagentWakeup(f.input)).toBeUndefined();
    f.gate.release(user);
    expect(
      await reserveSubagentWakeup({
        ...f.input,
        canStart: () => Promise.resolve(false),
      }),
    ).toBeUndefined();
    expect(
      (await f.executions.get(f.record))?.delivery.wakeupAttemptedAt,
    ).toBeUndefined();
  });
  it("checks cancellation again after asynchronous admission checks", async () => {
    const f = await fixture();
    const controller = new AbortController();
    expect(
      await reserveSubagentWakeup({
        ...f.input,
        signal: controller.signal,
        canStart: () => {
          controller.abort();
          return Promise.resolve(true);
        },
      }),
    ).toBeUndefined();
    expect(f.gate.isHeld("parent")).toBe(false);
    expect(
      (await f.executions.get(f.record))?.delivery.wakeupAttemptedAt,
    ).toBeUndefined();
  });
  it("releases a reservation if a later claim fails after an earlier result was claimed", async () => {
    const f = await fixture();
    let attempts = 0;
    await expect(
      reserveSubagentWakeup({
        ...f.input,
        candidates: [f.record, { ...f.record, executionId: "second" }],
        executions: {
          claimWakeup: () => {
            if (attempts++ > 0)
              return Promise.reject(new Error("later storage failure"));
            return Promise.resolve(true);
          },
        },
      }),
    ).rejects.toThrow("later storage failure");
    expect(f.gate.isHeld("parent")).toBe(false);
  });
  it("releases a reservation when persistent result claiming fails", async () => {
    const f = await fixture();
    await expect(
      reserveSubagentWakeup({
        ...f.input,
        executions: {
          claimWakeup: () => Promise.reject(new Error("storage unavailable")),
        },
      }),
    ).rejects.toThrow("storage unavailable");
    expect(f.gate.isHeld("parent")).toBe(false);
  });
});

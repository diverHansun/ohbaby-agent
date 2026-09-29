import { describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
} from "../../core/message/index.js";
import { InMemorySubagentExecutionStore } from "../../agents/subagents/execution-store.js";
import { InMemorySubagentInstanceStore } from "../../agents/subagents/in-memory-store.js";
import { createInMemoryRunLedger } from "../run-ledger/index.js";
import { InMemoryPromptSubmissionStore } from "../prompt-scheduler/in-memory-store.js";
import { InMemoryCurrentRunInputStore } from "../prompt-scheduler/current-run-inputs.js";
import { createSessionExecutionRecovery } from "./session.js";

function fixture(isOwnerAlive: (pid: number) => boolean = (pid) => pid === 2): {
  runs: ReturnType<typeof createInMemoryRunLedger>;
  prompts: InMemoryPromptSubmissionStore;
  messages: ReturnType<typeof createMessageManager>;
  inputs: InMemoryCurrentRunInputStore;
  executions: InMemorySubagentExecutionStore;
  instances: InMemorySubagentInstanceStore;
  recover: ReturnType<typeof createSessionExecutionRecovery>;
} {
  const runs = createInMemoryRunLedger({
    ownerId: "new",
    ownerPid: 2,
    isOwnerAlive,
  });
  const prompts = new InMemoryPromptSubmissionStore({
    ownerId: "new",
    ownerPid: 2,
    isOwnerAlive,
  });
  const messages = createMessageManager({
    bus: createBus(),
    store: createInMemoryMessageStore(),
  });
  const inputs = new InMemoryCurrentRunInputStore({
    runLedger: runs,
    promptStore: prompts,
    messageManager: messages,
  });
  const executions = new InMemorySubagentExecutionStore();
  const instances = new InMemorySubagentInstanceStore();
  const recover = createSessionExecutionRecovery({
    runs,
    prompts,
    messages,
    inputs,
    executions,
    instances,
    ownerId: "new",
    scopeKey: "scope",
    isOwnerAlive,
  });
  return { runs, prompts, messages, inputs, executions, instances, recover };
}
describe("root session execution recovery", () => {
  it("blocks an invalid active child Run even when its root already has a real terminal", async () => {
    const f = fixture();
    await f.runs.createPending({
      runId: "root",
      sessionId: "s",
      triggerSource: "user",
    });
    await f.runs.markRunning("root");
    await f.runs.markSucceeded("root");
    await f.recover("s");
    await f.runs.createPending({
      runId: "child",
      sessionId: "child-session",
      contextScopeId: "child-scope",
      triggerSource: "user",
      ownerId: "unknown",
      ownerPid: 0,
    });
    await acceptChildExecution(f, "child-execution", 1);
    await f.executions.bindChild(
      { executionId: "child-execution", parentSessionId: "s" },
      { sessionId: "child-session", contextScopeId: "child-scope" },
      1,
    );
    await f.executions.start(
      { executionId: "child-execution", parentSessionId: "s" },
      "child",
      1,
    );
    await expect(f.recover("s")).rejects.toThrow(/unknown owner/);
    expect((await f.runs.get("root"))?.status).toBe("succeeded");
    expect((await f.runs.get("child"))?.status).toBe("pending");
    expect((await f.executions.listByRootRun("root"))[0]?.status).toBe(
      "running",
    );
  });
  it.each([0, -1, 1.5, NaN, Infinity])(
    "blocks a prompt with invalid owner PID %s before admitting the session",
    async (ownerPid) => {
      const f = fixture();
      const prompts = new InMemoryPromptSubmissionStore({
        ownerId: "old",
        ownerPid,
      });
      await prompts.accept({
        promptId: "p",
        clientRequestId: "request-p",
        sessionId: "s",
        scopeKey: "scope",
        text: "queued",
        userMessageId: "u",
        maxQueuedPrompts: 10,
      });
      const probe = vi.fn(() => false);
      const recover = createSessionExecutionRecovery({
        ...f,
        prompts,
        ownerId: "new",
        scopeKey: "scope",
        isOwnerAlive: probe,
      });
      await expect(recover("s")).rejects.toThrow(/unknown owner/);
      expect((await prompts.get("p"))?.status).toBe("queued");
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity])(
    "blocks invalid child instance PID %s before changing root facts or eligibility",
    async (ownerPid) => {
      const f = fixture();
      await f.runs.createPending({
        runId: "root",
        sessionId: "s",
        triggerSource: "user",
        ownerId: "old",
        ownerPid: 1,
      });
      await acceptChildExecution(f, "child", 1);
      await f.instances.create({
        subagentId: "child",
        contextScopeId: "child-scope",
        sessionId: "child-session",
        parentSessionId: "s",
        role: "generic",
        initialPrompt: "inspect",
        status: "running",
        ownerId: "old",
        ownerPid,
        currentRunId: "child-run",
        currentInput: {
          executionId: "child",
          rootRunId: "root",
          prompt: "inspect",
        },
        pendingQueue: [],
        createdAt: 1,
        updatedAt: 1,
      });
      const probe = vi.fn(() => false);
      const recover = createSessionExecutionRecovery({
        ...f,
        ownerId: "new",
        scopeKey: "scope",
        isOwnerAlive: probe,
      });
      await expect(recover("s")).rejects.toThrow(/child instance/);
      expect((await f.runs.get("root"))?.status).toBe("pending");
      expect(
        (await f.instances.get({ subagentId: "child", parentSessionId: "s" }))
          ?.status,
      ).toBe("running");
      expect(probe).toHaveBeenCalledWith(1);
      expect(probe).not.toHaveBeenCalledWith(ownerPid);
    },
  );
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "blocks an invalid Run owner PID %s before probing or changing facts",
    async (ownerPid) => {
      const f = fixture();
      await f.runs.createPending({
        runId: "unknown",
        sessionId: "s",
        triggerSource: "user",
        ownerId: "old",
        ownerPid,
      });
      const probe = vi.fn(() => false);
      const recover = createSessionExecutionRecovery({
        ...f,
        ownerId: "new",
        scopeKey: "scope",
        isOwnerAlive: probe,
      });
      await expect(recover("s")).rejects.toThrow(/unknown owner/);
      expect((await f.runs.get("unknown"))?.status).toBe("pending");
      expect(probe).not.toHaveBeenCalled();
    },
  );
  it("repairs an orphan once without executing work and preserves a live foreign owner", async () => {
    const f = fixture();
    await f.runs.createPending({
      runId: "dead",
      sessionId: "s",
      triggerSource: "user",
      ownerId: "old",
      ownerPid: 1,
    });
    await f.runs.createPending({
      runId: "live",
      sessionId: "other",
      triggerSource: "user",
      ownerId: "another",
      ownerPid: 2,
    });
    const message = await f.messages.createMessage({
      sessionId: "s",
      runId: "dead",
      role: "assistant",
      agent: "primary",
    });
    const call = await f.messages.appendPart(message.id, {
      type: "tool",
      tool: "write",
      callId: "a",
      state: { status: "pending", input: {}, raw: "{}" },
    });
    expect(await Promise.all([f.recover("s"), f.recover("s")])).toEqual([
      true,
      true,
    ]);
    expect(await f.recover("s")).toBe(false);
    expect(await f.runs.get("dead")).toMatchObject({
      status: "interrupted",
      endTimeSource: "recovery",
    });
    const repaired = await f.messages.getPart(call.id);
    expect(repaired).toMatchObject({ state: { status: "error" } });
    if (repaired?.type === "tool" && repaired.state.status === "error")
      expect(repaired.state.error).toContain("outcome unknown");
    expect(await f.runs.get("live")).toMatchObject({ status: "pending" });
    await expect(f.recover("other")).resolves.toBe(false);
    expect(await f.runs.get("live")).toMatchObject({ status: "pending" });
  });
  it("coalesces retries, contains malformed session failures and rejects unknown roots", async () => {
    const f = fixture();
    await f.runs.createPending({
      runId: "dead",
      sessionId: "s",
      triggerSource: "user",
      ownerId: "old",
      ownerPid: 1,
    });
    const scan = vi
      .spyOn(f.messages, "listPageByRun")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(f.recover("s")).rejects.toThrow("disk full");
    expect(scan).toHaveBeenCalledTimes(1);
    await f.recover("healthy");
    await Promise.all([f.recover("s"), f.recover("s")]);
    expect(scan).toHaveBeenCalledTimes(2);
    await f.executions.accept({
      executionId: "e",
      requestId: "q",
      parentSessionId: "bad",
      requesterScopeId: "primary",
      requesterRunId: "missing",
      rootSessionId: "bad",
      rootRunId: "missing",
      subagentId: "child",
      mode: "background",
      prompt: "x",
      createdAt: 1,
    });
    await expect(f.recover("bad")).rejects.toThrow(/missing/);
    expect((await f.executions.listByRootRun("missing"))[0]?.status).toBe(
      "queued",
    );
  });
});

async function acceptChildExecution(
  f: ReturnType<typeof fixture>,
  executionId: string,
  createdAt: number,
): Promise<void> {
  await f.executions.accept({
    executionId,
    requestId: executionId,
    parentSessionId: "s",
    requesterScopeId: "primary",
    requesterRunId: "root",
    rootSessionId: "s",
    rootRunId: "root",
    subagentId: executionId,
    mode: "background",
    prompt: "child input",
    createdAt,
  });
}

describe("recovery review regressions", () => {
  it("does not repeat checked run history or writes while still finding a new orphan", async () => {
    const f = fixture();
    await f.runs.createPending({
      runId: "root",
      sessionId: "s",
      triggerSource: "user",
      ownerId: "old",
      ownerPid: 1,
    });
    await acceptChildExecution(f, "child", 1);
    await f.recover("s");
    const scans = vi.spyOn(f.messages, "listPageByRun");
    const close = vi.spyOn(f.inputs, "close");
    const runRecovery = vi.spyOn(f.runs, "recoverOrphanedRuns");
    const promptRecovery = vi.spyOn(f.prompts, "recoverAllInterrupted");
    const finish = vi.spyOn(f.executions, "finish");
    await f.recover("s");
    expect(scans).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(runRecovery).not.toHaveBeenCalled();
    expect(promptRecovery).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
    await f.runs.createPending({
      runId: "new-orphan",
      sessionId: "s",
      triggerSource: "user",
      ownerId: "old",
      ownerPid: 1,
    });
    await f.recover("s");
    expect((await f.runs.get("new-orphan"))?.status).toBe("interrupted");
    expect(scans.mock.calls.map((call) => call[1])).toEqual(["new-orphan"]);
  });

  it("rechecks a foreign owner after it dies instead of caching the whole session as ready", async () => {
    const live = new Set([2, 3]);
    const f = fixture((pid) => live.has(pid));
    await f.runs.createPending({
      runId: "foreign",
      sessionId: "s",
      triggerSource: "user",
      ownerId: "foreign",
      ownerPid: 3,
    });
    await f.recover("s");
    expect((await f.runs.get("foreign"))?.status).toBe("pending");
    live.delete(3);
    await f.recover("s");
    expect(await f.runs.get("foreign")).toMatchObject({
      status: "interrupted",
      endTimeSource: "recovery",
    });
  });

  it("keeps successful run checks across a later child-save failure but retries that child", async () => {
    const f = fixture();
    await f.runs.createPending({
      runId: "root",
      sessionId: "s",
      triggerSource: "user",
      ownerId: "old",
      ownerPid: 1,
    });
    await acceptChildExecution(f, "child", 1);
    const finish = vi
      .spyOn(f.executions, "finish")
      .mockRejectedValueOnce(new Error("child save unavailable"));
    await expect(f.recover("s")).rejects.toThrow("child save unavailable");
    const scans = vi.spyOn(f.messages, "listPageByRun");
    await f.recover("s");
    expect(finish).toHaveBeenCalledTimes(2);
    expect(scans).not.toHaveBeenCalled();
    expect(
      (await f.executions.get({ executionId: "child", parentSessionId: "s" }))
        ?.status,
    ).toBe("interrupted");
  });

  it("keeps completed history checks when a later run fails and retries only unfinished checks", async () => {
    const f = fixture();
    for (const runId of ["first", "second", "third"])
      await f.runs.createPending({
        runId,
        sessionId: "s",
        triggerSource: "user",
        ownerId: "old",
        ownerPid: 1,
      });
    const ordered = await f.runs.listBySession("s");
    const failingRun = ordered[1]?.runId;
    const scan = f.messages.listPageByRun.bind(f.messages);
    let fail = true;
    const scans = vi
      .spyOn(f.messages, "listPageByRun")
      .mockImplementation(async (...args) => {
        if (args[1] === failingRun && fail) {
          fail = false;
          throw new Error("history temporarily unavailable");
        }
        return scan(...args);
      });
    await expect(f.recover("s")).rejects.toThrow(
      "history temporarily unavailable",
    );
    scans.mockClear();
    await f.recover("s");
    expect(scans.mock.calls.map((call) => call[1])).toEqual(
      ordered.slice(1).map((run) => run.runId),
    );
  });

  it("checks every child owner beyond the first history page before changing any execution", async () => {
    const f = fixture();
    await f.runs.createPending({
      runId: "root",
      sessionId: "s",
      triggerSource: "user",
      ownerId: "old",
      ownerPid: 1,
    });
    await f.runs.createPending({
      runId: "live-child",
      sessionId: "child-session",
      contextScopeId: "child-scope",
      triggerSource: "user",
      ownerId: "foreign",
      ownerPid: 2,
    });
    await acceptChildExecution(f, "oldest", 1);
    await f.executions.bindChild(
      { executionId: "oldest", parentSessionId: "s" },
      { sessionId: "child-session", contextScopeId: "child-scope" },
      1,
    );
    await f.executions.start(
      { executionId: "oldest", parentSessionId: "s" },
      "live-child",
      1,
    );
    for (let index = 1; index <= 205; index++)
      await acceptChildExecution(f, `later-${String(index)}`, index + 1);
    const before = await f.executions.listByRootRun("root");
    await expect(f.recover("s")).rejects.toThrow(/owner/i);
    expect(await f.runs.get("live-child")).toMatchObject({
      status: "pending",
      ownerId: "foreign",
    });
    expect(await f.executions.listByRootRun("root")).toEqual(before);
  });

  it("closes an orphan child execution even when its terminal root owner is still alive", async () => {
    const f = fixture();
    await f.runs.createPending({
      runId: "root",
      sessionId: "s",
      triggerSource: "user",
      ownerId: "foreign",
      ownerPid: 2,
    });
    await f.runs.markRunning("root");
    await f.runs.markSucceeded("root");
    const root = await f.runs.get("root");
    await f.recover("s");
    await f.runs.createPending({
      runId: "dead-child",
      sessionId: "child-session",
      contextScopeId: "child-scope",
      triggerSource: "user",
      ownerId: "old",
      ownerPid: 1,
    });
    await acceptChildExecution(f, "child", 1);
    await f.executions.bindChild(
      { executionId: "child", parentSessionId: "s" },
      { sessionId: "child-session", contextScopeId: "child-scope" },
      1,
    );
    await f.executions.start(
      { executionId: "child", parentSessionId: "s" },
      "dead-child",
      1,
    );
    await f.recover("s");
    expect(await f.runs.get("root")).toEqual(root);
    expect(await f.runs.get("dead-child")).toMatchObject({
      status: "interrupted",
      endTimeSource: "recovery",
    });
    expect(
      await f.executions.get({ executionId: "child", parentSessionId: "s" }),
    ).toMatchObject({ status: "interrupted", reason: "process-interrupted" });
  });
});

it.each([undefined, 2])(
  "preserves an unresolved child instance with unknown or live owner pid %s",
  async (ownerPid) => {
    const f = fixture();
    await f.runs.createPending({
      runId: "root",
      sessionId: "s",
      triggerSource: "user",
      ownerId: "old",
      ownerPid: 1,
    });
    await acceptChildExecution(f, "child", 1);
    await f.instances.create({
      subagentId: "child",
      sessionId: "child-session",
      contextScopeId: "child-scope",
      parentSessionId: "s",
      role: "generic",
      initialPrompt: "child input",
      status: "running",
      pendingQueue: [],
      currentInput: {
        executionId: "child",
        rootRunId: "root",
        prompt: "child input",
      },
      ownerId: "unknown-or-live-owner",
      ownerPid,
      createdAt: 1,
      updatedAt: 1,
    });
    const instance = await f.instances.get({
      subagentId: "child",
      parentSessionId: "s",
    });
    const executions = await f.executions.listByRootRun("root");
    await expect(f.recover("s")).rejects.toThrow(/owner/i);
    expect(
      await f.instances.get({ subagentId: "child", parentSessionId: "s" }),
    ).toEqual(instance);
    expect(await f.executions.listByRootRun("root")).toEqual(executions);
  },
);

it("does not let an older recovery overwrite an instance claimed after another recovery finishes", async () => {
  const f = fixture();
  await f.runs.createPending({
    runId: "root",
    sessionId: "s",
    triggerSource: "user",
    ownerId: "old",
    ownerPid: 1,
  });
  await acceptChildExecution(f, "child", 1);
  await f.instances.create({
    subagentId: "child",
    sessionId: "child-session",
    contextScopeId: "child-scope",
    parentSessionId: "s",
    role: "generic",
    initialPrompt: "old",
    status: "running",
    ownerId: "old",
    ownerPid: 1,
    currentRunId: "old-child-run",
    currentInput: { executionId: "child", rootRunId: "root", prompt: "old" },
    pendingQueue: [],
    createdAt: 1,
    updatedAt: 1,
  });
  let release!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const scan = f.messages.listPageByRun.bind(f.messages);
  vi.spyOn(f.messages, "listPageByRun").mockImplementationOnce(
    async (...args) => {
      reached();
      await paused;
      return scan(...args);
    },
  );
  const first = f.recover("s");
  await entered;
  try {
    const otherRecovery = createSessionExecutionRecovery({
      ...f,
      ownerId: "another-backend",
      scopeKey: "scope",
      isOwnerAlive: (pid) => pid === 2,
    });
    await otherRecovery("s");
    const currentInput = {
      executionId: "new-execution",
      rootRunId: "new-root",
      prompt: "new",
    };
    await f.instances.claim("child", {
      status: "running",
      ownerId: "new-owner",
      ownerPid: 2,
      currentRunId: "new-child-run",
      currentInput,
      updatedAt: Date.now(),
    });
    const newPending = {
      executionId: "new-pending",
      rootRunId: "new-root",
      prompt: "next",
    };
    await f.instances.appendPendingQueue("child", newPending, Date.now());
    release();
    await first;
    expect(
      await f.instances.get({ subagentId: "child", parentSessionId: "s" }),
    ).toMatchObject({
      status: "running",
      ownerId: "new-owner",
      ownerPid: 2,
      currentRunId: "new-child-run",
      currentInput,
      pendingQueue: [newPending],
    });
  } finally {
    release();
    await first.catch(() => undefined);
  }
});

it.each(["queued", "starting", "running"] as const)(
  "blocks new-version %s input with unknown ownership without changing it",
  async (status) => {
    const f = fixture();
    const accepted = await f.prompts.accept({
      scopeKey: "scope",
      sessionId: "s",
      promptId: "p",
      clientRequestId: "c",
      userMessageId: "u",
      text: "preserve",
      maxQueuedPrompts: 10,
    });
    f.prompts.runtimeInputMemory.put({
      ...accepted.record,
      status,
      ownerId: undefined,
      ownerPid: undefined,
    });
    const original = await f.prompts.get("p");
    await expect(f.recover("s")).rejects.toThrow(/Prompt p.*unknown owner/);
    expect(await f.prompts.get("p")).toEqual(original);
    await expect(f.recover("healthy")).resolves.toBe(false);
    if (!original) throw new Error("Missing prompt");
    f.prompts.runtimeInputMemory.put({ ...original, status: "retained" });
    await expect(f.recover("s")).resolves.toBe(false);
    expect((await f.prompts.get("p"))?.status).toBe("retained");
  },
);

it("carries actual partial repairs through a failed entry until a successful projection refresh", async () => {
  const f = fixture();
  await f.runs.createPending({
    runId: "orphan",
    sessionId: "s",
    triggerSource: "user",
    ownerId: "old",
    ownerPid: 1,
  });
  vi.spyOn(f.messages, "listPageByRun").mockRejectedValueOnce(
    new Error("history read failed"),
  );
  await expect(f.recover("s")).rejects.toThrow("history read failed");
  expect((await f.runs.get("orphan"))?.status).toBe("interrupted");
  expect(await f.recover("s")).toBe(true);
  expect(await f.recover("s")).toBe(false);
});

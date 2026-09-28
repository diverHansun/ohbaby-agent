import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { DatabaseSubagentExecutionStore } from "../../agents/subagents/execution-store.js";
import { DatabaseSubagentInstanceStore } from "../../agents/subagents/database-store.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { createDatabaseRunLedger } from "../run-ledger/index.js";
import { DatabasePromptSubmissionStore } from "../prompt-scheduler/database-store.js";
import { DatabaseCurrentRunInputStore } from "../prompt-scheduler/current-run-inputs.js";
import { createSessionExecutionRecovery } from "./session.js";

function recovery(): {
  runs: ReturnType<typeof createDatabaseRunLedger>;
  messages: ReturnType<typeof createMessageManager>;
  inputs: DatabaseCurrentRunInputStore;
  recover: ReturnType<typeof createSessionExecutionRecovery>;
} {
  const runs = createDatabaseRunLedger({
    ownerId: "new",
    ownerPid: process.pid,
  });
  const messages = createMessageManager({
    bus: createBus(),
    store: createDatabaseMessageStore(),
  });
  const inputs = new DatabaseCurrentRunInputStore();
  const recover = createSessionExecutionRecovery({
    runs,
    messages,
    inputs,
    prompts: new DatabasePromptSubmissionStore({
      ownerId: "new",
      ownerPid: process.pid,
    }),
    executions: new DatabaseSubagentExecutionStore(),
    instances: new DatabaseSubagentInstanceStore(),
    ownerId: "new",
    scopeKey: "scope",
  });
  return { runs, messages, inputs, recover };
}

it("checks 6000 old terminal histories once on cold entry without no-op write transactions", async () => {
  const root = await mkdtemp(join(tmpdir(), "recovery-history-scale-"));
  try {
    initDatabase({ dbPath: join(root, "facts.db") });
    const db = getDatabase();
    db.prepare(
      "INSERT INTO session(id,project_id,project_root,title,status,created_at,updated_at,data) VALUES ('s','p',?,'s','active',1,1,'{}')",
    ).run(root);
    const insert = db.prepare(
      "INSERT INTO run_ledger(run_id,session_id,trigger,status,created_at,started_at,ended_at,inputs_closed_at,inputs_close_reason,owner_id,owner_pid) VALUES (?,'s','user',?,1,2,3,3,?,'dead-owner',2147483647)",
    );
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < 6000; i++) {
      const status = ["succeeded", "failed", "cancelled"][i % 3] ?? "succeeded";
      insert.run(`history-${String(i)}`, status, status);
    }
    db.exec("COMMIT");
    const f = recovery();
    const scan = vi.spyOn(f.messages, "listPageByRun");
    const close = vi.spyOn(f.inputs, "close");
    const exec = vi.spyOn(db, "exec");
    const coldStartedAt = performance.now();
    await expect(f.recover("s")).resolves.toBeUndefined();
    const coldReadMs = performance.now() - coldStartedAt;
    expect(scan).toHaveBeenCalledTimes(6000);
    scan.mockClear();
    const warmStartedAt = performance.now();
    await expect(f.recover("s")).resolves.toBeUndefined();
    const repeatedEntryMs = performance.now() - warmStartedAt;
    expect(scan).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(
      exec.mock.calls.filter(([sql]) =>
        /BEGIN|UPDATE|INSERT|DELETE/i.test(sql),
      ),
    ).toEqual([]);
    expect(await f.runs.listBySession("s")).toHaveLength(6000);
    process.stdout.write(
      `${JSON.stringify({ scenario: "session-recovery-6000-terminal-runs", coldReadMs, repeatedEntryMs, repeatedHistoryScans: scan.mock.calls.length, writeTransactions: exec.mock.calls.filter(([sql]) => /BEGIN/i.test(sql)).length })}\n`,
    );
  } finally {
    closeDatabase();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(["succeeded", "failed", "cancelled"] as const)(
  "checks unfinished legacy %s history despite observed terminal and closed-input fields",
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), "recovery-legacy-terminal-"));
    try {
      initDatabase({ dbPath: join(root, "facts.db") });
      getDatabase()
        .prepare(
          "INSERT INTO session(id,project_id,project_root,title,status,created_at,updated_at,data) VALUES ('s','p',?,'s','active',1,1,'{}')",
        )
        .run(root);
      const f = recovery();
      await f.runs.createPending({
        runId: "old",
        sessionId: "s",
        triggerSource: "user",
        ownerId: "old",
        ownerPid: 2147483647,
      });
      await f.runs.markRunning("old");
      const message = await f.messages.createMessage({
        sessionId: "s",
        runId: "old",
        role: "assistant",
        agent: "primary",
      });
      await f.messages.updateMessage(message.id, {
        modelRequests: [
          {
            requestId: "old-request",
            runId: "old",
            messageId: message.id,
            step: 1,
            attempt: 1,
            purpose: "main",
            startedAt: 1,
            outcome: "running",
          },
        ],
      });
      const tool = await f.messages.appendPart(message.id, {
        type: "tool",
        callId: "old-call",
        tool: "write",
        state: { status: "running", input: {} },
      });
      if (status === "succeeded") await f.runs.markSucceeded("old");
      else if (status === "failed")
        await f.runs.markFailed("old", "legacy failure");
      else await f.runs.markCancelled("old", "legacy stop");
      const original = await f.runs.get("old");
      expect(original?.inputsClosedAt).toBeTypeOf("number");
      expect(original?.endTimeSource).toBeUndefined();
      await f.recover("s");
      expect(await f.messages.getPart(tool.id)).toMatchObject({
        state: { status: "error" },
      });
      const repaired = (await f.messages.listByIds("s", [message.id])).at(
        0,
      )?.info;
      if (repaired?.role !== "assistant")
        throw new Error("Missing legacy assistant message");
      expect(repaired.modelRequests?.[0]).toMatchObject({
        outcome: "aborted",
        endTimeSource: "recovery",
      });
      expect(await f.runs.get("old")).toEqual(original);
    } finally {
      closeDatabase();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("reopens a partially repaired recovery run and finishes its history despite already closed inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "recovery-history-reopen-"));
  const dbPath = join(root, "facts.db");
  try {
    initDatabase({ dbPath });
    getDatabase()
      .prepare(
        "INSERT INTO session(id,project_id,project_root,title,status,created_at,updated_at,data) VALUES ('s','p',?,'s','active',1,1,'{}')",
      )
      .run(root);
    const f = recovery();
    await f.runs.createPending({
      runId: "old",
      sessionId: "s",
      triggerSource: "user",
      ownerId: "old",
      ownerPid: 2147483647,
    });
    await f.runs.markRunning("old");
    const message = await f.messages.createMessage({
      sessionId: "s",
      runId: "old",
      role: "assistant",
      agent: "primary",
    });
    await f.messages.updateMessage(message.id, {
      modelRequests: [
        {
          requestId: "unfinished-request",
          runId: "old",
          messageId: message.id,
          step: 1,
          attempt: 1,
          purpose: "main",
          startedAt: 1,
          outcome: "running",
        },
      ],
    });
    const first = await f.messages.appendPart(message.id, {
      type: "tool",
      tool: "write",
      callId: "first",
      state: { status: "pending", input: {}, raw: "{}" },
    });
    const second = await f.messages.appendPart(message.id, {
      type: "tool",
      tool: "write",
      callId: "second",
      state: { status: "running", input: {} },
    });
    const update = f.messages.updatePart.bind(f.messages);
    vi.spyOn(f.messages, "updatePart").mockImplementationOnce(
      async (...args) => {
        await update(...args);
        throw new Error("interrupted after first durable history repair");
      },
    );
    await expect(f.recover("s")).rejects.toThrow(
      "first durable history repair",
    );
    const savedRun = await f.runs.get("old");
    const savedFirst = await f.messages.getPart(first.id);
    const savedMessage = (await f.messages.listByIds("s", [message.id])).at(
      0,
    )?.info;
    expect(savedRun).toMatchObject({
      status: "interrupted",
      endTimeSource: "recovery",
    });
    expect(savedRun?.inputsClosedAt).toBeTypeOf("number");
    if (savedMessage?.role !== "assistant")
      throw new Error("Missing saved assistant message");
    expect(savedMessage.modelRequests?.[0]).toMatchObject({
      outcome: "aborted",
      endTimeSource: "recovery",
    });
    expect(savedMessage.modelRequests?.[0]?.endedAt).toBeTypeOf("number");
    expect(await f.messages.getPart(second.id)).toMatchObject({
      state: { status: "running" },
    });
    closeDatabase();
    initDatabase({ dbPath });
    const reopened = recovery();
    const scans = vi.spyOn(reopened.messages, "listPageByRun");
    const reads = vi.spyOn(reopened.messages, "getPart");
    const close = vi.spyOn(reopened.inputs, "close");
    await reopened.recover("s");
    expect(scans).toHaveBeenCalledTimes(1);
    expect(reads.mock.calls).toEqual([[second.id]]);
    expect(close).not.toHaveBeenCalled();
    expect(await reopened.messages.getPart(first.id)).toEqual(savedFirst);
    expect(await reopened.messages.getPart(second.id)).toMatchObject({
      state: { status: "error" },
    });
    expect(
      (await reopened.messages.listByIds("s", [message.id]))[0]?.info,
    ).toMatchObject({
      ...savedMessage,
      time: { created: savedMessage.time.created },
    });
    expect(await reopened.runs.get("old")).toEqual(savedRun);
    scans.mockClear();
    const transactions = vi.spyOn(getDatabase(), "exec");
    await reopened.recover("s");
    expect(scans).not.toHaveBeenCalled();
    expect(
      transactions.mock.calls.filter(([sql]) => /BEGIN/i.test(sql)),
    ).toEqual([]);
  } finally {
    closeDatabase();
    await rm(root, { recursive: true, force: true });
  }
});

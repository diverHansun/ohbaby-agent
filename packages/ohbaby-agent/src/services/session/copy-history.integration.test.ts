import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import { createContextManager } from "../../core/context/context-manager.js";
import { serializeForLlm } from "../../core/context/serializer.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { DatabaseCurrentRunInputStore } from "../../runtime/prompt-scheduler/current-run-inputs.js";
import { DatabasePromptSubmissionStore } from "../../runtime/prompt-scheduler/database-store.js";
import {
  planSessionWorkspaceMove,
  commitSessionWorkspaceMove,
} from "./workspace-move.js";
import { recoverTodosFromMessages } from "../../tools/todo.js";
import {
  initDatabase,
  closeDatabase,
  getDatabase,
  runWriteTransaction,
} from "../database/index.js";
import { HistoryCutInvalidError } from "./errors.js";
import {
  copySessionHistory,
  findEndedMainRun,
  findForkableMainRun,
} from "./copy-history.js";
import {
  createDatabaseSessionStore,
  readSessionRow,
} from "./database-store.js";

const main = "source-session";
const scope = "/workspace";
const sideChat = {
  mainSessionId: main,
  boundaryMessageId: "boundary",
  ownerPid: process.pid,
};

beforeEach(() => {
  initDatabase({ dbPath: ":memory:" });
  getDatabase()
    .prepare(
      `INSERT INTO session
    (id, project_id, working_directory, workspace_directory, pending_working_directory, agent, title, created_at, updated_at, data)
    VALUES (?, 'project', '/work', ?, '/next', 'editor', 'main', 0, 0, ?)`,
    )
    .run(
      main,
      scope,
      JSON.stringify({ modelEntryId: "test-model", childrenIds: ["child"] }),
    );
});
afterEach(closeDatabase);

function run(
  id: string,
  at: number,
  status = "succeeded",
  trigger = "user",
  context: string | null = null,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO run_ledger(run_id,session_id,trigger,status,created_at,started_at,ended_at,inputs_closed_at,inputs_close_reason,owner_pid,owner_id,context_scope_id)
  VALUES(?,?,?,?,?,?,?,?, 'finished',42,'owner',?)`,
    )
    .run(
      id,
      main,
      trigger,
      status,
      at,
      at,
      status === "running" ? null : at + 1,
      status === "running" ? null : at + 1,
      context,
    );
}

function message(
  id: string,
  runId: string | null,
  at: number,
  role = "user",
  extra: Record<string, unknown> = {},
): void {
  const data = {
    id,
    sessionId: main,
    runId: runId ?? undefined,
    role,
    agent: "editor",
    time: { created: at, completed: at },
    ...extra,
  };
  getDatabase()
    .prepare(
      "INSERT INTO message(id,session_id,role,created_at,updated_at,data,context_scope_id) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      id,
      main,
      role,
      at,
      at,
      JSON.stringify(data),
      typeof extra.contextScopeId === "string" ? extra.contextScopeId : null,
    );
}

function part(
  messageId: string,
  type: string,
  body: Record<string, unknown>,
  orderIndex = 0,
): void {
  const id = `part-of-${messageId}-${String(orderIndex)}`;
  const data = { id, messageId, sessionId: main, orderIndex, type, ...body };
  getDatabase()
    .prepare(
      "INSERT INTO part(id,message_id,session_id,type,order_index,created_at,updated_at,data) VALUES(?,?,?,?,?,1,2,?)",
    )
    .run(id, messageId, main, type, orderIndex, JSON.stringify(data));
}
function prompt(
  promptId: string,
  msgId: string,
  runId: string | null,
  status = "succeeded",
  scopeKey = scope,
): void {
  getDatabase()
    .prepare(
      `INSERT INTO prompt_submission
    (prompt_id,scope_key,session_id,user_message_id,text,status,run_id,client_request_id,admission_order,accepted_at,created_at,updated_at,owner_id,owner_pid,title_expected,edit_lease_id)
    VALUES(?,?,?,?,'question',?,?,?,1,1,1,1,'owner',42,'title','lease')`,
    )
    .run(promptId, scopeKey, main, msgId, status, runId, `client-${promptId}`);
}
function copy(
  cutRunId: string | null,
): Promise<ReturnType<typeof copySessionHistory>> {
  return runWriteTransaction(getDatabase(), (db) =>
    copySessionHistory(db, {
      sourceSessionId: main,
      cutRunId,
      promptScopeKey: scope,
      title: "Side chat 1",
      data: { sideChat },
    }),
  );
}
function rows(table: string, sessionId: string): Record<string, unknown>[] {
  return getDatabase()
    .prepare(`SELECT * FROM ${table} WHERE session_id=? ORDER BY rowid`)
    .all(sessionId);
}
async function modelMessages(
  sessionId: string,
): Promise<ReturnType<typeof serializeForLlm>> {
  const bus = createBus();
  const inputs = new DatabaseCurrentRunInputStore();
  const manager = createContextManager({
    bus,
    messageManager: createMessageManager({
      bus,
      store: createDatabaseMessageStore(),
    }),
    filterModelHistory: (history) => inputs.filterModelHistory(history),
    systemPromptProvider: { build: () => Promise.resolve("system") },
  });
  const context = await manager.assemble(sessionId, "/work", {
    isSubagent: false,
    toolNames: [],
    runModel: {
      entryId: "test-model",
      tokenCounter: {
        estimateTokens: (text) => text.length,
        getLimit: () => 128000,
      },
      summaryClient: {
        generateSummary: () => {
          throw new Error("Unexpected compaction");
        },
      },
    },
  });
  return serializeForLlm(context);
}

describe("copySessionHistory", () => {
  it.each(["succeeded", "running"])(
    "cuts before a later %s turn and keeps view and model ordering across timestamp ties",
    async (status) => {
      run("old-run-a", 1);
      message("z-old-message", "old-run-a", 1);
      part("z-old-message", "text", { text: "first" });
      prompt(
        "old-prompt-a",
        "z-old-message",
        "old-run-a",
        "succeeded",
        "/work",
      );
      await commitSessionWorkspaceMove(planSessionWorkspaceMove(main, scope));
      run("old-run-b", 2, "succeeded", "subagent");
      message("a-old-message", "old-run-b", 1, "assistant");
      part("a-old-message", "text", { text: "second" });
      run("child-run", 2, "succeeded", "user", "child");
      message("child-message", "child-run", 1, "user", {
        contextScopeId: "child",
      });
      run("old-run-c", 3, status);
      message("last-message", "old-run-c", 3);
      prompt("last-prompt", "last-message", "old-run-c", status);
      const db = getDatabase();
      const tables = [
        "message",
        "part",
        "run_ledger",
        "prompt_submission",
        "current_run_input",
      ];
      const snapshot = (): unknown[] => [
        db.prepare("SELECT * FROM session WHERE id=?").get(main),
        ...tables.map((t) => rows(t, main)),
      ];
      const before = snapshot();
      // A completed main wake-up has no prompt record but its answer is a valid fork.
      expect(findForkableMainRun(db, main, "old-run-b")).toBe("old-run-b");
      expect(findForkableMainRun(db, main)).toBe("old-run-b");
      expect(findForkableMainRun(db, main, "child-run")).toBeNull();
      const { sessionId, copiedMessageCount } = await copy("old-run-b");
      expect(snapshot()).toEqual(before);
      expect(copiedMessageCount).toBe(2);
      expect(readSessionRow(db, sessionId)).toMatchObject({
        title: "Side chat 1",
        status: "active",
        modelEntryId: "test-model",
        projectId: "project",
        workingDirectory: "/work",
        workspaceDirectory: scope,
        pendingWorkingDirectory: scope,
        agentName: "editor",
        stats: { messageCount: 2, lastMessageAt: 1 },
        childrenIds: [],
        isSubagent: false,
        sideChat,
      });
      await createDatabaseSessionStore().update(sessionId, { title: "test" });
      expect(readSessionRow(db, sessionId)?.sideChat).toEqual(sideChat);
      expect(tables.map((t) => rows(t, sessionId).length)).toEqual([
        2, 2, 2, 1, 0,
      ]);
      const historyWindow = {
        runIds: rows("run_ledger", sessionId).map((row) => String(row.run_id)),
      };
      const prompts = new DatabasePromptSubmissionStore();
      const inDestination = await prompts.listForSession(
        scope,
        sessionId,
        historyWindow,
      );
      expect(inDestination).toHaveLength(1);
      expect(inDestination[0]).toMatchObject({
        scopeKey: scope,
        status: "succeeded",
        sessionId,
      });
      expect(
        await prompts.listForSession("/work", sessionId, historyWindow),
      ).toEqual([]);
      expect(rows("prompt_submission", main)[0].scope_key).toBe("/work");
      const store = createDatabaseMessageStore();
      const labels = (
        records: Awaited<ReturnType<typeof store.listBySession>>,
      ): string[] =>
        records.flatMap((m) =>
          m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])),
        );
      expect(labels(await store.listBySession(sessionId))).toEqual([
        "first",
        "second",
      ]);
      expect(
        labels(
          (await store.listPageBySession(sessionId, { limit: 2 })).messages,
        ),
      ).toEqual(["second", "first"]);
      const copied = JSON.stringify(tables.map((t) => rows(t, sessionId)));
      for (const old of [
        "old-run-a",
        "old-run-b",
        "old-prompt-a",
        "z-old-message",
        "a-old-message",
        "old-run-c",
        "child-run",
        main,
      ])
        expect(copied).not.toContain(old);
      expect(rows("run_ledger", sessionId)[0]).toMatchObject({
        owner_id: null,
        owner_pid: null,
        inputs_closed_at: 2,
      });
      expect(rows("prompt_submission", sessionId)[0]).toMatchObject({
        owner_id: null,
        owner_pid: null,
        edit_lease_id: null,
        title_expected: null,
        admission_order: 1,
      });
    },
  );

  it("finds only ended main runs with an anchor and ignores runs whose prompts are pending", async () => {
    run("finish", 1);
    message("user", "finish", 1);
    run("pending", 2);
    prompt("racing", "msg", "pending", "running");
    message("msg", "pending", 2);
    run("silent", 3, "failed");
    run("hidden", 4, "succeeded", "subagent");
    message("hidden-msg", "hidden", 4, "user", {
      runtimeInput: { kind: "subagent-status" },
    });
    run("child", 5, "succeeded", "user", "private");
    message("child-msg", "child", 5);
    expect(findEndedMainRun(getDatabase(), main)).toBe("finish");
    for (const id of ["pending", "silent", "hidden", "child", "missing"]) {
      expect(findEndedMainRun(getDatabase(), main, id)).toBeNull();
      await expect(copy(id)).rejects.toBeInstanceOf(HistoryCutInvalidError);
    }
    const { sessionId, copiedMessageCount } = await copy(null);
    expect(copiedMessageCount).toBe(0);
    expect(rows("message", sessionId)).toEqual([]);
    expect(getDatabase().prepare("SELECT id FROM session").all()).toHaveLength(
      2,
    );
  });

  it("forks only at a final AI answer, and skips newer turns without one", () => {
    const db = getDatabase();
    run("answered", 1, "interrupted");
    message("partial", "answered", 1, "assistant");
    part("partial", "text", { text: "Partial reply" });
    part(
      "partial",
      "text",
      {
        text: "Stopped",
        synthetic: true,
        metadata: { kind: "lifecycle-interruption" },
      },
      1,
    );
    message("summary", "answered", 2, "assistant", { agent: "context" });
    part("summary", "text", {
      text: "Summary",
      metadata: { kind: "context-summary" },
    });
    message("compacted", "answered", 3, "assistant");
    part("compacted", "reasoning", { text: "Retired", time: { compacted: 4 } });
    run("user-only", 4, "cancelled");
    message("unanswered", "user-only", 4);
    part("unanswered", "text", { text: "Question" });
    prompt("cancelled", "unanswered", "user-only", "cancelled");
    run("tool", 5);
    message("interim", "tool", 5, "assistant");
    part("interim", "text", { text: "Previous step" });
    message("tool-call", "tool", 6, "assistant");
    part("tool-call", "text", { text: "I'll check" });
    part(
      "tool-call",
      "tool",
      { tool: "todo_read", state: { status: "completed", input: {} } },
      1,
    );
    run("thinking", 7, "failed");
    message("thought", "thinking", 7, "assistant");
    part("thought", "reasoning", { text: "Thinking" });
    part(
      "thought",
      "text",
      {
        text: "Interrupted",
        synthetic: true,
        metadata: { kind: "lifecycle-interruption" },
      },
      1,
    );
    part(
      "thought",
      "text",
      { text: "internal", metadata: { displayText: " \n " } },
      2,
    );
    run("runtime", 8, "succeeded", "subagent");
    message("input", "runtime", 8, "user", {
      runtimeInput: { kind: "subagent-result" },
    });
    part("input", "text", { text: "Child output" });
    expect(findForkableMainRun(db, main)).toBe("answered");
    expect(findForkableMainRun(db, main, "answered")).toBe("answered");
    for (const id of ["user-only", "tool", "thinking", "runtime"]) {
      expect(findForkableMainRun(db, main, id)).toBeNull();
    }
    expect(findEndedMainRun(db, main)).toBe("thinking");
  });

  it("retains the same latest answer across successive forks of runs that started together", async () => {
    const db = getDatabase();
    const turns = Array.from({ length: 12 }, (_, index) => index + 1);
    for (const turn of turns) {
      const id = `run-${String(turn).padStart(2, "0")}`;
      run(id, 1);
      const replyId = `reply-${String(turn)}`;
      message(replyId, id, turn, "assistant");
      part(replyId, "text", { text: `Answer ${String(turn)}` });
    }

    let sourceSessionId = main;
    for (let generation = 0; generation < 3; generation++) {
      const cutRunId = findForkableMainRun(db, sourceSessionId);
      const copy = await runWriteTransaction(db, (tx) =>
        copySessionHistory(tx, {
          sourceSessionId,
          cutRunId,
          promptScopeKey: scope,
          title: "Fork",
        }),
      );
      // Join through rewritten references: every answer must retain its place in the tie.
      const copied = db
        .prepare<{ created_at: number }>(
          `
        SELECT m.created_at FROM run_ledger r JOIN message m ON json_extract(m.data, '$.runId') = r.run_id
        WHERE r.session_id = ? AND m.session_id = ? ORDER BY r.run_id
      `,
        )
        .all(copy.sessionId, copy.sessionId);
      expect(copied.map((row) => row.created_at)).toEqual(turns);
      sourceSessionId = copy.sessionId;
    }
  });

  it("remaps runtime inputs, resend and steer receipts and preserves the assembled model request", async () => {
    run("old-run", 1);
    message("old-start", "old-run", 1);
    part("old-start", "text", { text: "initial" });
    prompt("old-prompt", "old-start", "old-run");
    for (const [kind, sourceId, at] of [
      ["user-steer", "old-steered", 2],
      ["subagent-result", "external-agent", 3],
    ] as const) {
      const inputId = `old-input-${String(at)}`,
        messageId = `old-msg-${String(at)}`;
      const runtimeInput = { inputId, sourceId, kind, targetRunId: "old-run" };
      message(messageId, "old-run", at, "user", { runtimeInput });
      part(messageId, "text", { text: kind });
      const data = {
        inputId,
        sourceId,
        messageId,
        source: kind,
        runId: "old-run",
        sessionId: main,
        acceptedAt: at,
        ...(kind === "subagent-result"
          ? { processedRequestId: "sent-request" }
          : { firstAttemptRequestId: "sent-request" }),
      };
      getDatabase()
        .prepare("INSERT INTO current_run_input VALUES(?,?,?,?,?,?,?,?)")
        .run(
          inputId,
          "old-run",
          main,
          kind,
          sourceId,
          messageId,
          at,
          JSON.stringify(data),
        );
    }
    prompt("old-steered", "old-msg-2", null, "steered");
    const db = getDatabase();
    db.prepare(
      `UPDATE prompt_submission SET steer_receipt=?,resend_of_prompt_id='old-prompt' WHERE prompt_id='old-steered'`,
    ).run(
      JSON.stringify({
        promptId: "old-steered",
        userMessageId: "old-msg-2",
        inputId: "old-input-2",
        acceptedTargetRunId: "old-run",
        clientRequestId: "old-req",
      }),
    );
    db.exec(
      "UPDATE prompt_submission SET resend_of_prompt_id='excluded' WHERE prompt_id='old-prompt'",
    );
    const before = await modelMessages(main);
    expect(before.map((m) => m.content)).toEqual([
      "system",
      "initial",
      "user-steer",
      "subagent-result",
    ]);
    const { sessionId } = await copy("old-run");
    expect(await modelMessages(sessionId)).toEqual(before);
    const records = rows("prompt_submission", sessionId);
    const steer = records.find((r) => r.status === "steered");
    const start = records.find((r) => r.status === "succeeded");
    if (!start || !steer) throw new Error("Copied prompts are missing");
    expect(steer.resend_of_prompt_id).toBe(start.prompt_id);
    expect(start.resend_of_prompt_id).toBeNull();
    expect(steer.client_request_id).toBe(`copy:${String(steer.prompt_id)}`);
    const inputs = rows("current_run_input", sessionId);
    expect(JSON.parse(String(steer.steer_receipt))).toMatchObject({
      promptId: steer.prompt_id,
      inputId: inputs[0].input_id,
      userMessageId: steer.user_message_id,
      acceptedTargetRunId: inputs[0].run_id,
      clientRequestId: `copy:${String(steer.prompt_id)}:steer`,
    });
    const copied = JSON.stringify([
      records,
      inputs,
      rows("message", sessionId),
      rows("part", sessionId),
    ]);
    for (const old of [
      "old-input-",
      "old-msg-",
      "old-run",
      "old-prompt",
      "old-steered",
      "old-start",
      main,
    ])
      expect(copied).not.toContain(old);
  });

  it("restores only compaction marks committed by the cut, keeping summaries in model order", async () => {
    run("early", 1);
    message("m1", "early", 1);
    part("m1", "text", { text: "original" });
    const beforeCompaction = await modelMessages(main);
    run("later", 4);
    message("summary", null, 3, "assistant");
    part("summary", "text", {
      text: "short version",
      metadata: { kind: "context-summary" },
    });
    message("m2", "later", 4);
    part("m2", "text", { text: "next" });
    getDatabase().exec(
      `UPDATE part SET data=json_set(data,'$.time',json('{"compacted":3}')) WHERE message_id='m1'`,
    );
    const afterCompaction = await modelMessages(main);
    expect(JSON.stringify(afterCompaction)).toContain("short version");
    expect(JSON.stringify(afterCompaction)).not.toContain("original");
    expect(await modelMessages((await copy("early")).sessionId)).toEqual(
      beforeCompaction,
    );
    expect(await modelMessages((await copy("later")).sessionId)).toEqual(
      afterCompaction,
    );
  });

  it("replays native tool calls and rebuilds todos without copying live state", async () => {
    const db = getDatabase();
    run("tool-run", 1);
    const todos = [{ content: "finish report", status: "pending" }];
    message("tool-msg", "tool-run", 1, "assistant");
    const modelState = {
      version: 1,
      origin: {
        provider: "openai",
        model: "test",
        protocol: "openai-responses",
        endpoint: "https://fixture.invalid/v1",
      },
      output: {
        protocol: "openai-responses",
        items: [
          {
            type: "function_call",
            id: "fc",
            call_id: "call-id",
            name: "todo_write",
            arguments: JSON.stringify({ todos }),
            status: "completed",
          },
        ],
      },
      estimate: { tokens: 100, source: "output" },
    };
    part("tool-msg", "model-state", { modelState });
    part(
      "tool-msg",
      "tool",
      {
        tool: "todo_write",
        callId: "call-id",
        state: { status: "completed", input: { todos }, output: "ok" },
      },
      1,
    );
    db.prepare("INSERT INTO goal_record VALUES(?,1,1,?)").run(
      main,
      '{"status":"active"}',
    );
    db.prepare(
      `INSERT INTO subagent_instance(subagent_id,session_id,context_scope_id,parent_session_id,role,initial_prompt,status,created_at,updated_at)
      VALUES('worker',?,'child',?,'worker','wait','running',1,1)`,
    ).run(main, main);
    prompt("queued", "reserved", null, "queued");
    const before = await modelMessages(main);
    const { sessionId } = await copy("tool-run");
    expect(await modelMessages(sessionId)).toEqual(before);
    expect(before).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        modelState,
        toolCalls: [expect.objectContaining({ callId: "call-id" })],
      }),
    );
    expect(
      recoverTodosFromMessages(
        await createDatabaseMessageStore().listBySession(sessionId),
      ),
    ).toEqual(todos);
    for (const t of ["prompt_submission", "goal_record", "subagent_instance"])
      expect(rows(t, sessionId)).toEqual([]);
  });
});

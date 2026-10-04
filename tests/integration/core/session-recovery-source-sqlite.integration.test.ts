import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySessionChange, type UiSessionRecoveryEvent } from "ohbaby-sdk";
import { DatabasePromptSubmissionStore } from "../../../packages/ohbaby-agent/src/runtime/prompt-scheduler/database-store.js";
import { promptRecordToUi } from "../../../packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-mapper.js";
import {
  createBus,
  type BusInstance,
} from "../../../packages/ohbaby-agent/src/bus/index.js";
import { createInProcessUiBackendClient } from "../../../packages/ohbaby-agent/src/adapters/ui-inprocess.js";
import type { LLMClientInstance } from "../../../packages/ohbaby-agent/src/core/llm-client/index.js";
import { InMemoryGoalPersistence } from "../../../packages/ohbaby-agent/src/goals/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
  type MessageManager,
  type MessageStore,
} from "../../../packages/ohbaby-agent/src/core/message/index.js";
import { SourceSessionProjection } from "../../../packages/ohbaby-agent/src/adapters/ui-state/source-session-projection.js";
import { runToUiRun } from "../../../packages/ohbaby-agent/src/adapters/ui-state/persistent-store.js";
import {
  createDatabaseRunLedger,
  type RunLedger,
} from "../../../packages/ohbaby-agent/src/runtime/run-ledger/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  type DatabaseConnection,
  type DatabaseStatement,
  type SqliteValue,
} from "../../../packages/ohbaby-agent/src/services/database/index.js";

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("source recovery against SQLite", () => {
  let directory: string;
  let store: MessageStore;
  let messages: MessageManager;
  let ledger: RunLedger;
  let bus: BusInstance;
  let clock: number;
  const projections: SourceSessionProjection[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ohbaby-source-recovery-"));
    initDatabase({ dbPath: join(directory, "agent.db") });
    for (const id of ["a", "b"])
      getDatabase()
        .prepare(
          "INSERT INTO session (id, project_id, project_root, title, status, created_at, updated_at, data) VALUES (?, 'project', '/workspace', ?, 'active', 1, 1, '{}')",
        )
        .run(id, id);
    clock = 1000;
    store = createDatabaseMessageStore();
    bus = createBus();
    messages = createMessageManager({ bus, store, now: () => ++clock });
    ledger = createDatabaseRunLedger({ now: () => ++clock });
  });

  afterEach(async () => {
    for (const projection of projections.splice(0)) {
      projection.reasoning.dispose();
      projection.owner.dispose();
    }
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  });

  function projection(
    promptStore?: DatabasePromptSubmissionStore,
    runtimeEpoch = "runtime",
  ): {
    source: SourceSessionProjection;
    events: UiSessionRecoveryEvent[];
  } {
    const events: UiSessionRecoveryEvent[] = [];
    const source = new SourceSessionProjection({
      runtimeEpoch,
      messageManager: messages,
      metadata: (id) =>
        Promise.resolve({
          id,
          title: id,
          createdAt: "2026-09-25",
          updatedAt: "2026-09-25",
        }),
      runs: async (id) => (await ledger.listBySession(id)).map(runToUiRun),
      prompts: async (id, messages, runs) =>
        promptStore
          ? (
              await promptStore.listForSession("/workspace", id, {
                messageIds: messages.map((message) => message.id),
                runIds: runs.map((run) => run.id),
              })
            ).map(promptRecordToUi)
          : [],
      publish: (event) => {
        events.push(event);
      },
    });
    projections.push(source);
    return { source, events };
  }

  it.each(["initial seed", "rebuild"])(
    "preserves auxiliary events received during %s",
    async (phase) => {
      const { source, events } = projection();
      if (phase === "rebuild") await source.owner.initialize("a");
      const entered = gate();
      const release = gate();
      const original = store.listPageBySession.bind(store);
      vi.spyOn(store, "listPageBySession").mockImplementationOnce(
        async (...args) => {
          entered.resolve();
          await release.promise;
          return original(...args);
        },
      );
      const initializing =
        phase === "rebuild"
          ? source.owner.rebuild("a")
          : source.owner.initialize("a");
      await entered.promise;
      try {
        const commits = [
          source.commitEvent({
            type: "session.updated",
            session: {
              id: "a",
              title: "new title",
              createdAt: "2026",
              updatedAt: "2026",
              messages: [],
            },
          }),
          source.commitEvent({
            type: "goal.updated",
            sessionId: "a",
            goal: null,
          }),
          source.commitEvent({
            type: "todo.updated",
            sessionId: "a",
            todos: [],
            visible: true,
          }),
          source.commitEvent({
            type: "context.window.updated",
            usage: {
              sessionId: "a",
              modelId: "test",
              currentTokens: 7,
              contextWindowTokens: 100,
              contextWindowRatio: 0.07,
              estimatedAt: "2026",
            },
          }),
        ];
        release.resolve();
        await initializing;
        await Promise.all(commits);
        const view = source.owner.read("a");
        expect(view.session.title).toBe("new title");
        expect(view.goal).toEqual({ status: "ready", value: null });
        expect(view.todo).toMatchObject({
          status: "ready",
          value: { visible: true },
        });
        expect(view.context).toMatchObject({
          status: "ready",
          value: { currentTokens: 7 },
        });
        expect(
          events.filter((event) => event.type === "session.unavailable"),
        ).toHaveLength(0);
      } finally {
        release.resolve();
        await initializing;
      }
    },
  );

  it("does not seed unopened sessions from auxiliary events and reads current metadata when explicitly opened", async () => {
    const reads = vi.spyOn(messages, "listPageBySession");
    const events: UiSessionRecoveryEvent[] = [];
    const source = new SourceSessionProjection({
      runtimeEpoch: "runtime",
      messageManager: messages,
      metadata: (id) => {
        const row = getDatabase()
          .prepare("SELECT title FROM session WHERE id = ?")
          .get(id) as { title: string };
        return Promise.resolve({
          id,
          title: row.title,
          createdAt: "2026",
          updatedAt: "2026",
        });
      },
      runs: () => Promise.resolve([]),
      prompts: () => Promise.resolve([]),
      publish: (event) => {
        events.push(event);
      },
    });
    projections.push(source);
    getDatabase()
      .prepare("UPDATE session SET title = 'latest' WHERE id = 'b'")
      .run();
    await source.commitEvent({
      type: "session.updated",
      session: {
        id: "b",
        title: "latest",
        createdAt: "2026",
        updatedAt: "2026",
        messages: [],
      },
    });
    await source.commitEvent({
      type: "todo.updated",
      sessionId: "b",
      todos: [],
      visible: true,
    });
    await source.commitEvent({
      type: "goal.updated",
      sessionId: "b",
      goal: null,
    });
    await source.commitEvent({
      type: "context.window.updated",
      usage: {
        sessionId: "b",
        modelId: "test",
        currentTokens: 1,
        contextWindowTokens: 100,
        contextWindowRatio: 0.01,
        estimatedAt: "2026",
      },
    });
    expect(reads).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    await expect(source.owner.ready("b")).rejects.toMatchObject({
      code: "SESSION_NOT_INITIALIZED",
    });
    await source.owner.initialize("b");
    expect(source.owner.read("b").session.title).toBe("latest");
    expect(reads).toHaveBeenCalledOnce();
  });

  async function message(
    id: string,
    sessionId = "a",
    runId?: string,
  ): Promise<void> {
    await messages.createMessage({
      id,
      sessionId,
      runId,
      role: "assistant",
      agent: "test",
    });
    await messages.appendPart(id, { type: "text", text: id });
  }

  it("T25 preserves extensible tool metadata and terminal prompt associations through live, view and old pages", async () => {
    const promptStore = new DatabasePromptSubmissionStore({
      now: () => ++clock,
    });
    await ledger.createPending({
      runId: "fixture-run",
      sessionId: "a",
      triggerSource: "user",
    });
    await ledger.markRunning("fixture-run");
    await promptStore.accept({
      clientRequestId: "fixture-request",
      promptId: "fixture-prompt",
      sessionId: "a",
      scopeKey: "/workspace",
      text: "fixture",
      userMessageId: "fixture-user",
      maxQueuedPrompts: 100,
    });
    await promptStore.claim("fixture-prompt");
    await promptStore.markRunning("fixture-prompt", "fixture-run");
    const { source, events } = projection(promptStore);
    await source.owner.initialize("a");
    const baseline = source.owner.read("a");
    await messages.createMessage({
      id: "fixture-user",
      sessionId: "a",
      runId: "fixture-run",
      role: "user",
      agent: "test",
    });
    await messages.appendPart("fixture-user", {
      type: "text",
      text: "fixture",
    });
    await message("fixture-assistant", "a", "fixture-run");
    // Opaque metadata is already supported. This does not introduce a future run schema or timing UI.
    const metadata = {
      execution: {
        id: "execution-1",
        runId: "fixture-run",
        callId: "fixture-call",
        stage: "completed",
      },
      modelRequests: [
        {
          id: "request-1",
          runId: "fixture-run",
          messageId: "fixture-assistant",
          step: 1,
        },
      ],
      sourceOrder: 2,
    };
    const tool = await messages.appendPart("fixture-assistant", {
      type: "tool",
      callId: "fixture-call",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "fixture.txt" },
        output: "exact tool output",
      },
      metadata,
    });
    await source.reasoning.update(
      {
        sessionId: "a",
        runId: "fixture-run",
        messageId: "fixture-assistant",
        partId: "fixture-thinking",
        metadata: { sourceOrder: 1, runId: "fixture-run" },
      },
      "persisted thought",
    );
    await source.reasoning.finish("fixture-thinking", "normal");
    await vi.waitFor(() => {
      expect(source.reasoning.pendingPartIds("a")).toEqual([]);
    });
    await promptStore.finish("fixture-prompt", {
      status: "succeeded",
      expectedRunId: "fixture-run",
    });
    const terminal = (
      await promptStore.listForSession("/workspace", "a", {
        messageIds: ["fixture-user"],
      })
    )[0];
    if (!terminal) throw new Error("Missing terminal prompt");
    const run = await ledger.markSucceeded("fixture-run");
    await source.owner.run("a", () => {
      source.commitEvent({
        type: "prompt.updated",
        prompt: promptRecordToUi(terminal),
      });
      source.commitEvent({ type: "run.updated", run: runToUiRun(run) });
      return Promise.resolve();
    });
    let live = baseline;
    for (const event of events)
      if (
        event.type === "session.changed" &&
        event.version.sessionRevision > live.version.sessionRevision
      ) {
        const next = applySessionChange(live, event);
        if (!next) throw new Error("Live revision gap");
        live = next;
      }
    const expected = source.owner.read("a");
    expect(live).toEqual(expected);
    const assistant = expected.session.messages.find(
      (item) => item.id === "fixture-assistant",
    );
    expect(assistant?.runId).toBe("fixture-run");
    expect(
      assistant?.parts.filter(
        (part) => part.type === "tool-call" || part.type === "tool-result",
      ),
    ).toEqual([
      {
        id: tool.id,
        type: "tool-call",
        metadata,
        call: {
          id: "fixture-call",
          name: "read",
          input: { path: "fixture.txt" },
          status: "completed",
        },
      },
      {
        id: tool.id,
        type: "tool-result",
        metadata,
        result: {
          callId: "fixture-call",
          output: "exact tool output",
          outputAvailable: true,
        },
      },
    ]);
    expect(expected.prompts).toContainEqual(
      expect.objectContaining({
        promptId: "fixture-prompt",
        clientRequestId: "fixture-request",
        userMessageId: "fixture-user",
        sessionId: "a",
        runId: "fixture-run",
        status: "succeeded",
        endedAt: expect.any(String),
      }),
    );
    await ledger.createPending({
      runId: "newer-run",
      sessionId: "a",
      triggerSource: "user",
    });
    const newer = await ledger.markRunning("newer-run");
    await source.owner.run("a", () => {
      source.commitEvent({ type: "run.updated", run: runToUiRun(newer) });
      return Promise.resolve();
    });
    for (let i = 0; i < 51; i++)
      await message(`later-${String(i)}`, "a", "newer-run");
    const recent = source.owner.read("a");
    expect(
      recent.session.messages.some((item) => item.id === "fixture-assistant"),
    ).toBe(false);
    const page = await source.history("a", recent.history.before, 200);
    expect(
      page.messages.find((item) => item.id === "fixture-assistant"),
    ).toEqual(assistant);
    expect(page.prompts).toEqual(expected.prompts);
    await source.reasoning.update(
      {
        sessionId: "a",
        runId: "newer-run",
        messageId: "later-50",
        partId: "unsaved-tail",
      },
      "not durable",
    );
    source.reasoning.dispose();
    source.owner.dispose();
    const rebuilt = projection(promptStore, "next-runtime").source;
    await rebuilt.owner.initialize("a");
    const next = rebuilt.owner.read("a");
    expect(next.version.runtimeEpoch).toBe("next-runtime");
    expect(
      next.session.messages
        .flatMap((item) => item.parts)
        .some((part) => part.id === "unsaved-tail"),
    ).toBe(false);
    const old = await rebuilt.history("a", next.history.before, 200);
    expect(
      old.messages.find((item) => item.id === "fixture-assistant"),
    ).toEqual(assistant);
    expect((await ledger.get("fixture-run"))?.status).toBe("succeeded");
  });

  it("T16 bounds selected-root recovery across 100 roots with 250 messages each", async () => {
    const db = getDatabase();
    const roots = Array.from({ length: 100 }, (_, index) => ({
      id: `root-${String(index).padStart(3, "0")}`,
      title: `Root ${String(index)}`,
      projectRoot: directory,
      createdAt: "2026-09-25",
      updatedAt: "2026-09-25",
      messages: [],
    }));
    const insertSession = db.prepare(
      "INSERT INTO session (id, project_id, project_root, title, status, created_at, updated_at, data) VALUES (?, 'project', ?, ?, 'active', 1, 1, '{}')",
    );
    const insertMessage = db.prepare(
      "INSERT INTO message (id, session_id, role, agent, created_at, updated_at, data) VALUES (?, ?, 'user', 'test', ?, ?, ?)",
    );
    const insertPart = db.prepare(
      "INSERT INTO part (id, message_id, session_id, type, order_index, created_at, updated_at, data) VALUES (?, ?, ?, 'text', 0, ?, ?, ?)",
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const root of roots) {
        insertSession.run(root.id, directory, root.title);
        for (let index = 0; index < 250; index++) {
          const id = `${root.id}-message-${String(index).padStart(3, "0")}`;
          const created = index + 1;
          insertMessage.run(
            id,
            root.id,
            created,
            created,
            JSON.stringify({
              id,
              sessionId: root.id,
              role: "user",
              agent: "test",
              time: { created },
            }),
          );
          insertPart.run(
            `${id}-part`,
            id,
            root.id,
            created,
            created,
            JSON.stringify({
              id: `${id}-part`,
              messageId: id,
              sessionId: root.id,
              type: "text",
              orderIndex: 0,
              text: "long history fixture ".repeat(16),
            }),
          );
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const reads: { sql: string; params: SqliteValue[]; rows: number }[] = [];
    const instrumented: DatabaseConnection = {
      path: db.path,
      exec: (sql) => db.exec(sql),
      close: () => {},
      pragma: (name) => db.pragma(name),
      prepare<Row>(sql: string): DatabaseStatement<Row> {
        const statement = db.prepare<Row>(sql);
        return {
          get: (...params) => statement.get(...params),
          run: (...params) => statement.run(...params),
          all: (...params) => {
            const rows = statement.all(...params);
            if (/FROM (message|part)\b/.test(sql))
              reads.push({ sql, params, rows: rows.length });
            return rows;
          },
        };
      },
    };
    const selected = "root-050";
    const selectedStore = createDatabaseMessageStore({ db: instrumented });
    const readAll = vi.spyOn(selectedStore, "listBySession");
    const backend = createInProcessUiBackendClient({
      bus,
      messageManager: createMessageManager({ bus, store: selectedStore }),
      workdir: directory,
      initialSnapshot: {
        activeSessionId: selected,
        sessions: roots,
        runs: [],
        permissions: [],
        status: { kind: "idle" },
      },
    });
    try {
      await backend.initialize();
      const recoveryStarted = performance.now();
      await backend.initializeSession(selected);
      const view = await backend.getSessionView({ sessionId: selected });
      const recoveryMs = performance.now() - recoveryStarted;
      expect(view.session.messages).toHaveLength(50);
      const history = await backend.getSessionHistory({
        sessionId: selected,
        before: view.history.before,
      });
      expect(history.messages).toHaveLength(50);
      expect(readAll).not.toHaveBeenCalled();
      const messageReads = reads.filter((read) =>
        /FROM message\b/.test(read.sql),
      );
      const partReads = reads.filter((read) => /FROM part\b/.test(read.sql));
      expect(messageReads.length).toBeGreaterThan(0);
      expect(partReads.length).toBeGreaterThan(0);
      for (const read of messageReads) {
        expect(read.sql).toMatch(/WHERE session_id = \?/);
        expect(read.sql).toMatch(/ORDER BY created_at DESC, id DESC LIMIT \?/);
        expect(read.params[0]).toBe(selected);
        expect(read.params.at(-1)).toBe(51);
        expect(read.rows).toBeLessThanOrEqual(51);
      }
      for (const read of partReads) {
        expect(read.params.length).toBeLessThanOrEqual(50);
        expect(
          read.params.every(
            (id) =>
              typeof id === "string" && id.startsWith(`${selected}-message-`),
          ),
        ).toBe(true);
        expect(read.rows).toBeLessThanOrEqual(50);
      }
      expect(await backend.getSessionIndex()).toHaveLength(100);
      if (process.env["OHBABY_RECOVERY_BENCH"] === "1") {
        const fileBytes = async (path: string): Promise<number> =>
          (await stat(path).catch(() => undefined))?.size ?? 0;
        console.info(
          "RECOVERY_BENCH",
          JSON.stringify({
            roots: roots.length,
            messages: roots.length * 250,
            messageQueries: messageReads.length,
            partQueries: partReads.length,
            messageRows: messageReads.map((read) => read.rows),
            partRows: partReads.map((read) => read.rows),
            viewBytes: Buffer.byteLength(JSON.stringify(view)),
            historyBytes: Buffer.byteLength(JSON.stringify(history)),
            recoveryMs,
            databaseBytes: await fileBytes(db.path),
            walBytes: await fileBytes(`${db.path}-wal`),
            maxRssKiB: process.resourceUsage().maxRSS,
            heapUsedBytes: process.memoryUsage().heapUsed,
            fixtureMessageAndPartWrites: roots.length * 250 * 2,
          }),
        );
      }
    } finally {
      await backend.dispose();
    }
  });

  it("blocks same-session writes behind the seed without blocking another SQLite session", async () => {
    await message("initial");
    const entered = gate();
    const release = gate();
    const read = store.listPageBySession.bind(store);
    vi.spyOn(store, "listPageBySession").mockImplementation(
      async (id, options) => {
        const page = await read(id, options);
        if (id === "a") {
          entered.resolve();
          await release.promise;
        }
        return page;
      },
    );
    const { source } = projection();
    const initializing = source.owner.initialize("a");
    await entered.promise;
    const completed = messages.updateMessage("initial", {
      finish: "stop",
      time: { ...(await store.getMessage("initial"))!.time, completed: 2000 },
    });
    try {
      await message("other", "b");
      expect(
        source.owner.read("b").session.messages.map((item) => item.id),
      ).toEqual(["other"]);
      expect(
        (await store.getMessage("initial"))?.time.completed,
      ).toBeUndefined();
      release.resolve();
      await initializing;
      await completed;
      expect(source.owner.read("a").session.messages[0]?.status).toBe(
        "completed",
      );
    } finally {
      release.resolve();
      await initializing;
      await completed;
    }
  });

  it("keeps a baseline at its old revision and queues history between a durable write and its projection", async () => {
    await message("existing");
    const { source } = projection();
    await source.owner.initialize("a");
    const baseline = source.owner.read("a");
    const entered = gate();
    const release = gate();
    const insert = store.insertMessage.bind(store);
    vi.spyOn(store, "insertMessage").mockImplementation(async (record) => {
      await insert(record);
      if (record.id === "new") {
        entered.resolve();
        await release.promise;
      }
    });
    const creating = messages.createMessage({
      id: "new",
      sessionId: "a",
      role: "assistant",
      agent: "test",
    });
    await entered.promise;
    let historyResolved = false;
    const history = source.history("a").then((page) => {
      historyResolved = true;
      return page;
    });
    try {
      expect(await store.getMessage("new")).toBeDefined();
      expect(source.owner.read("a")).toBe(baseline);
      await message("parallel", "b");
      expect(historyResolved).toBe(false);
      release.resolve();
      await creating;
      const page = await history;
      expect(page.messages.map((item) => item.id)).toEqual(["existing", "new"]);
      expect(page.version.sessionRevision).toBe(
        source.owner.read("a").version.sessionRevision,
      );
      expect(page.version.sessionRevision).toBeGreaterThan(
        baseline.version.sessionRevision,
      );
    } finally {
      release.resolve();
      await creating;
      await history;
    }
  });

  it.each(["running", "succeeded"] as const)(
    "seeds all 205 messages of the %s latest run beyond both page limits",
    async (status) => {
      await ledger.createPending({
        runId: "old-run",
        sessionId: "a",
        triggerSource: "user",
      });
      await ledger.markRunning("old-run");
      await ledger.markSucceeded("old-run");
      for (let i = 0; i < 60; i++)
        await message(`old-${String(i).padStart(3, "0")}`, "a", "old-run");
      await ledger.createPending({
        runId: "latest-run",
        sessionId: "a",
        triggerSource: "user",
      });
      await ledger.markRunning("latest-run");
      for (let i = 0; i < 205; i++)
        await message(
          `latest-${String(i).padStart(3, "0")}`,
          "a",
          "latest-run",
        );
      if (status === "succeeded") await ledger.markSucceeded("latest-run");
      const { source } = projection();
      await source.owner.initialize("a");
      const view = source.owner.read("a");
      expect(view.session.messages).toHaveLength(205);
      expect(view.session.messages[0]?.id).toBe("latest-000");
      expect(view.session.messages.at(-1)?.id).toBe("latest-204");
      expect(new Set(view.session.messages.map((item) => item.id)).size).toBe(
        205,
      );
      const recovered = new Map(
        view.session.messages.map((item) => [item.id, item]),
      );
      let before = view.history.before;
      let hasMore = view.history.hasMore;
      while (hasMore) {
        const history = await source.history("a", before, 50);
        for (const item of history.messages) recovered.set(item.id, item);
        before = history.before;
        hasMore = history.hasMore;
      }
      expect(recovered.size).toBe(265);
      expect(recovered.has("old-000")).toBe(true);
    },
  );

  it("does not expose a saved SQLite reasoning part before its delayed result commits", async () => {
    await message("assistant");
    const entered = gate();
    const release = gate();
    const save = store.saveReasoningPart.bind(store);
    vi.spyOn(store, "saveReasoningPart").mockImplementation(async (input) => {
      const result = await save(input);
      entered.resolve();
      await release.promise;
      return result;
    });
    const { source } = projection();
    await source.owner.initialize("a");
    await source.reasoning.update(
      {
        sessionId: "a",
        messageId: "assistant",
        partId: "thinking",
        metadata: { sourceOrder: 1 },
      },
      "private display",
    );
    await source.reasoning.finish("thinking", "normal");
    await entered.promise;
    try {
      const before = source.owner.read("a");
      const persisted = await store.getPart("thinking");
      expect(persisted?.type).toBe("reasoning");
      const history = await source.history("a");
      expect(history.version).toEqual(before.version);
      expect(
        history.messages[0]?.parts.filter((part) => part.type === "reasoning"),
      ).toEqual([
        expect.objectContaining({
          id: "thinking",
          text: "private display",
          saveState: "pending",
        }),
      ]);
      release.resolve();
      await vi.waitFor(() => {
        expect(source.reasoning.pendingPartIds("a")).toEqual([]);
      });
      const saved = await source.history("a");
      expect(saved.version.sessionRevision).toBeGreaterThan(
        before.version.sessionRevision,
      );
      expect(
        saved.messages[0]?.parts.filter((part) => part.type === "reasoning"),
      ).toEqual([
        expect.objectContaining({
          id: "thinking",
          text: "private display",
          saveState: "saved",
        }),
      ]);
    } finally {
      release.resolve();
    }
  });

  it("holds durable writes until a rebuild settles, keeps business after a view-only failure, and recovers the new facts", async () => {
    await message("before-rebuild");
    const { source, events } = projection();
    await source.owner.initialize("a");
    source.owner.markUnavailable("a", new Error("projection failure"));
    const entered = gate();
    const release = gate();
    const failingRead = vi
      .spyOn(store, "listPageBySession")
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        throw new Error("history temporarily unavailable");
      });
    const rebuilding = source.owner.rebuild("a");
    const rejected = expect(rebuilding).rejects.toThrow(
      "history temporarily unavailable",
    );
    await entered.promise;
    const writing = message("after-rebuild");
    await Promise.resolve();
    expect(await store.getMessage("after-rebuild")).toBeUndefined();
    release.resolve();
    await rejected;
    await writing;
    expect((await store.getMessage("after-rebuild"))?.id).toBe("after-rebuild");
    expect(() => source.owner.read("a")).toThrow(
      "history temporarily unavailable",
    );
    expect(events.some((event) => event.type === "session.changed")).toBe(
      false,
    );
    failingRead.mockRestore();
    await source.owner.rebuild("a");
    expect(
      source.owner.read("a").session.messages.map((item) => item.id),
    ).toEqual(["before-rebuild", "after-rebuild"]);
  });

  it("retains a contiguous history boundary when protected current-run messages surround queued users", async () => {
    const run = await ledger.createPending({
      runId: "current",
      sessionId: "a",
      triggerSource: "user",
    });
    await ledger.markRunning(run.runId);
    await message("first", "a", "current");
    for (let i = 0; i < 52; i++) {
      const id = `queued-${String(i).padStart(3, "0")}`;
      await messages.createMessage({
        id,
        sessionId: "a",
        role: "user",
        agent: "test",
      });
      await messages.appendPart(id, { type: "text", text: id });
    }
    await message("last", "a", "current");
    const { source } = projection();
    await source.owner.initialize("a");
    const view = source.owner.read("a");
    const all = new Map(
      view.session.messages.map((message) => [message.id, message]),
    );
    let before = view.history.before;
    let hasMore = view.history.hasMore;
    while (hasMore) {
      const page = await source.history("a", before, 50);
      for (const item of page.messages) all.set(item.id, item);
      before = page.before;
      hasMore = page.hasMore;
    }
    expect(all.size).toBe(54);
    expect(all.has("queued-000")).toBe(true);
    // A later live trim must keep this boundary contiguous as well.
    await message("new-last", "a", "current");
    const latest = source.owner.read("a");
    const history = await source.history("a", latest.history.before, 50);
    expect(history.messages.some((item) => item.id === "queued-000")).toBe(
      true,
    );
  });

  it("makes the first evicted hot message available through the new history boundary", async () => {
    await ledger.createPending({
      runId: "old-run",
      sessionId: "a",
      triggerSource: "user",
    });
    await ledger.markRunning("old-run");
    await ledger.markSucceeded("old-run");
    for (let i = 0; i < 50; i++)
      await message(`old-${String(i).padStart(3, "0")}`, "a", "old-run");
    const { source } = projection();
    await source.owner.initialize("a");
    expect(source.owner.read("a").history.hasMore).toBe(false);
    await ledger.createPending({
      runId: "new-run",
      sessionId: "a",
      triggerSource: "user",
    });
    const running = await ledger.markRunning("new-run");
    await source.owner.run("a", () => {
      source.commitEvent({ type: "run.updated", run: runToUiRun(running) });
      return Promise.resolve();
    });
    await message("new-000", "a", "new-run");
    const view = source.owner.read("a");
    expect(view.session.messages).toHaveLength(50);
    expect(view.session.messages.some((item) => item.id === "old-000")).toBe(
      false,
    );
    expect(view.history.hasMore).toBe(true);
    const history = await source.history("a", view.history.before, 50);
    expect(history.messages.map((item) => item.id)).toEqual(["old-000"]);
    expect(history.hasMore).toBe(false);
  });

  it("marks an evicted failed display part missing while later durable saves and messages continue", async () => {
    await message("assistant");
    const release = gate();
    const entered = gate();
    const save = store.saveReasoningPart.bind(store);
    vi.spyOn(store, "saveReasoningPart").mockImplementation(async (input) => {
      if (input.partId === "thinking-0") {
        entered.resolve();
        await release.promise;
        throw new Error("display write unavailable");
      }
      return save(input);
    });
    const { source, events } = projection();
    await source.owner.initialize("a");
    const tool = await messages.appendPart("assistant", {
      type: "tool",
      callId: "budget-call",
      tool: "read",
      state: {
        status: "completed",
        input: {},
        output: "tool output must survive",
      },
    });
    await source.reasoning.update(
      { sessionId: "a", messageId: "assistant", partId: "generating" },
      "active protocol-facing thought",
    );
    try {
      for (let i = 0; i < 257; i++) {
        const partId = `thinking-${String(i)}`;
        await source.reasoning.update(
          {
            sessionId: "a",
            messageId: "assistant",
            partId,
            metadata: { sourceOrder: i },
          },
          `part-${String(i)}`,
        );
        await source.reasoning.finish(partId, "normal");
      }
      await entered.promise;
      expect(source.owner.read("a").reasoningMissing).toBe(true);
      expect(
        source.owner
          .read("a")
          .session.messages[0]?.parts.some((part) => part.id === "thinking-0"),
      ).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === "session.changed" && event.reasoningMissing === true,
        ),
      ).toBe(true);
      expect(
        source.reasoning
          .snapshot("a")
          .parts.find((part) => part.partId === "generating")?.text,
      ).toBe("active protocol-facing thought");
      expect(source.owner.read("a").session.messages[0]?.parts).toContainEqual(
        expect.objectContaining({
          id: tool.id,
          type: "tool-result",
          result: {
            callId: "budget-call",
            output: "tool output must survive",
            outputAvailable: true,
          },
        }),
      );
      expect(source.owner.read("a").session.messages[0]?.parts).toContainEqual(
        expect.objectContaining({ type: "text", text: "assistant" }),
      );
      await message("continues", "a");
      expect(source.owner.read("a").session.messages.at(-1)?.id).toBe(
        "continues",
      );
      release.resolve();
      await vi.waitFor(() => {
        expect(source.reasoning.pendingPartIds("a")).toEqual(["generating"]);
      });
      const history = await source.history("a");
      expect(history.reasoningMissing).toBe(true);
      const reasoning = history.messages
        .find((item) => item.id === "assistant")
        ?.parts.filter((part) => part.type === "reasoning");
      expect(reasoning).toHaveLength(257);
      expect(
        reasoning
          ?.filter((part) => part.id !== "generating")
          .every((part) => part.saveState === "saved"),
      ).toBe(true);
      expect(reasoning?.find((part) => part.id === "generating")).toMatchObject(
        { text: "active protocol-facing thought", saveState: "pending" },
      );
      source.owner.markUnavailable("a", new Error("rebuild budget fixture"));
      await source.owner.rebuild("a");
      expect(source.owner.read("a").reasoningMissing).toBe(true);
      expect(
        source.owner
          .read("a")
          .session.messages.find((item) => item.id === "assistant")?.parts,
      ).toContainEqual(
        expect.objectContaining({
          id: tool.id,
          type: "tool-result",
          result: {
            callId: "budget-call",
            output: "tool output must survive",
            outputAvailable: true,
          },
        }),
      );
      expect(await store.getPart("thinking-0")).toBeUndefined();
    } finally {
      release.resolve();
    }
  });

  it("finishes a real lifecycle without page queries when reasoning storage fails, retaining the display failure", async () => {
    vi.spyOn(store, "saveReasoningPart").mockRejectedValue(
      new Error("display storage unavailable"),
    );
    let modelCalls = 0;
    const llmClient: LLMClientInstance = {
      config: {
        apiKeyEnv: "FAKE_API_KEY",
        baseUrl: "https://example.invalid/v1",
        interfaceProvider: "openai-compatible",
        maxTokens: 128,
        model: "fake",
        provider: "openai",
        temperature: 0,
      },
      provider: {
        client: {},
        id: "fake",
        kind: "openai-compatible",
        isAbortError: () => false,
        streamResponse() {
          modelCalls++;
          return Promise.resolve(
            (async function* () {
              await Promise.resolve();
              yield { reasoningTextDelta: "remember this display" };
              yield {
                textDelta: "successful answer",
                finishReason: "stop" as const,
              };
            })(),
          );
        },
      },
    };
    const backend = createInProcessUiBackendClient({
      bus,
      messageManager: messages,
      runLedger: ledger,
      llmClient,
      workdir: directory,
      initialSnapshot: {
        activeSessionId: "a",
        sessions: [
          {
            id: "a",
            title: "A",
            projectRoot: directory,
            messages: [],
            createdAt: "2026-09-25",
            updatedAt: "2026-09-25",
          },
        ],
        runs: [],
        permissions: [],
        status: { kind: "idle" },
      },
    });
    try {
      const receipt = await backend.submitPromptAccepted("answer", {
        sessionId: "a",
        clientRequestId: "no-page",
      });
      const completion = await backend.waitForPrompt(receipt.promptId);
      expect(completion.prompt.status).toBe("succeeded");
      const view = await backend.getSessionView!({ sessionId: "a" });
      const parts = view.session.messages.flatMap((item) => item.parts);
      expect(parts).toContainEqual(
        expect.objectContaining({ type: "text", text: "successful answer" }),
      );
      expect(parts).toContainEqual(
        expect.objectContaining({
          type: "reasoning",
          text: "remember this display",
          saveState: "failed",
          endReason: "normal",
        }),
      );
      expect((await ledger.listBySession("a"))[0]?.status).toBe("succeeded");
      expect(modelCalls).toBe(1);
      const saved = (await messages.listBySession("a")).flatMap(
        (item) => item.parts,
      );
      expect(saved.some((part) => part.type === "reasoning")).toBe(false);
    } finally {
      await backend.dispose();
    }
  });

  it("keeps unselected session queries pure and does not claim uninitialized control is idle", async () => {
    const goals = new InMemoryGoalPersistence();
    await goals.append("b", {
      actor: "user",
      type: "create",
      objective: "persisted driver",
      goalId: "goal-b",
    });
    const reads = vi.spyOn(goals, "list");
    const createLLMClient = vi.fn(() =>
      Promise.reject(new Error("query started model runtime")),
    );
    const backend = createInProcessUiBackendClient({
      bus,
      messageManager: messages,
      runLedger: ledger,
      goalPersistence: goals,
      createLLMClient,
      workdir: directory,
      initialSnapshot: {
        activeSessionId: "a",
        sessions: ["a", "b"].map((id) => ({
          id,
          title: id,
          projectRoot: directory,
          messages: [],
          createdAt: "2026-09-25",
          updatedAt: "2026-09-25",
        })),
        runs: [],
        permissions: [],
        status: { kind: "idle" },
      },
    });
    try {
      await backend.initialize();
      await backend.getSessionView!({ sessionId: "a" });
      const before = (await goals.list("b")).length;
      reads.mockClear();
      for (let i = 0; i < 3; i++) {
        await backend.getSnapshot();
        await backend.getSessionHistory!({ sessionId: "a" });
        await backend.getSessionControl!({ sessionId: "a" });
        await expect(
          backend.getSessionView!({ sessionId: "b" }),
        ).rejects.toThrow();
        await expect(
          backend.getSessionHistory!({ sessionId: "b" }),
        ).rejects.toThrow();
        await expect(
          backend.getSessionControl!({ sessionId: "b" }),
        ).rejects.toThrow();
      }
      expect(reads).not.toHaveBeenCalled();
      expect((await goals.list("b")).length).toBe(before);
      expect(createLLMClient).not.toHaveBeenCalled();
    } finally {
      await backend.dispose();
    }
  });
});

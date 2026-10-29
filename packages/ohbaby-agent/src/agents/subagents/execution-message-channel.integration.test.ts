import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createDatabaseMessageStore,
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../services/database/index.js";
import { INITIAL_MIGRATIONS } from "../../services/database/migrations.js";
import {
  createDatabaseRunLedger,
  createInMemoryRunLedger,
} from "../../runtime/run-ledger/index.js";
import {
  DatabaseCurrentRunInputStore,
  InMemoryCurrentRunInputStore,
} from "../../runtime/prompt-scheduler/current-run-inputs.js";
import { InMemoryPromptSubmissionStore } from "../../runtime/prompt-scheduler/in-memory-store.js";
import {
  DatabaseSubagentExecutionStore,
  InMemorySubagentExecutionStore,
} from "./execution-store.js";
import { createExecutionMessageChannel } from "./execution-message-channel.js";

const directories: string[] = [];
afterEach(async () => {
  closeDatabase();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

for (const backend of ["memory", "sqlite"] as const)
  describe(`${backend} execution messages`, () => {
    // The fixture selects real memory or SQLite implementations of the same ports.
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    async function fixture(legacySchema = false) {
      if (backend === "sqlite") {
        const directory = await mkdtemp(join(tmpdir(), "execution-messages-"));
        directories.push(directory);
        initDatabase({
          dbPath: join(directory, "agent.db"),
          ...(legacySchema
            ? {
                migrations: INITIAL_MIGRATIONS.filter(
                  (migration) => migration.version < "028",
                ),
              }
            : {}),
        });
        getDatabase()
          .prepare(
            `INSERT INTO ${schema.session.tableName}
        (id,project_id,working_directory,agent,title,status,created_at,updated_at,message_count,data)
        VALUES ('child','project','/repo','explore','test','active',1,1,0,'{}')`,
          )
          .run();
      }
      const ledger =
        backend === "sqlite"
          ? createDatabaseRunLedger()
          : createInMemoryRunLedger();
      const messages = createMessageManager({
        bus: createBus(),
        store:
          backend === "sqlite"
            ? createDatabaseMessageStore()
            : createInMemoryMessageStore(),
      });
      const executions =
        backend === "sqlite"
          ? new DatabaseSubagentExecutionStore({ db: getDatabase() })
          : new InMemorySubagentExecutionStore();
      const inputs =
        backend === "sqlite"
          ? new DatabaseCurrentRunInputStore({ db: getDatabase() })
          : new InMemoryCurrentRunInputStore({
              runLedger: ledger,
              promptStore: new InMemoryPromptSubmissionStore(),
              messageManager: messages,
            });
      const channel = createExecutionMessageChannel({
        inputs,
        executions,
        messages,
        runLedger: ledger,
      });
      async function execution(
        id: string,
        running = true,
      ): Promise<Awaited<ReturnType<typeof executions.start>>> {
        const { record } = await executions.accept({
          executionId: id,
          requestId: id,
          parentSessionId: "root",
          requesterScopeId: "primary",
          requesterRunId: "root-run",
          rootSessionId: "root",
          rootRunId: "root-run",
          subagentId: "agent",
          mode: "background",
          prompt: "Work",
          createdAt: 1,
        });
        await executions.bindChild(
          record,
          { sessionId: "child", contextScopeId: "agent" },
          2,
        );
        await ledger.createPending({
          runId: `${id}-run`,
          sessionId: "child",
          contextScopeId: "agent",
          triggerSource: "user",
        });
        if (running) await ledger.markRunning(`${id}-run`);
        return executions.start(record, `${id}-run`, 3);
      }
      return { ledger, messages, executions, inputs, channel, execution };
    }

    it("admits distinct messages to one execution and confirms them only after a successful request", async () => {
      const f = await fixture();
      const execution = await f.execution("first");
      let wakes = 0;
      const unsubscribe = f.inputs.subscribe("first-run", () => {
        wakes++;
      });
      try {
        expect(
          await f.channel.acceptExecutionMessage({
            execution,
            message: "First instruction",
            inputId: "one",
          }),
        ).toEqual({ accepted: true });
        expect(
          await f.channel.acceptExecutionMessage({
            execution,
            message: "Second instruction",
            inputId: "two",
          }),
        ).toEqual({ accepted: true });
        await f.channel.acceptExecutionMessage({
          execution,
          message: "First instruction",
          inputId: "one",
        });
        expect(wakes).toBe(2);
        expect(
          (await f.inputs.getMessages("first-run")).flatMap((message) =>
            message.parts
              .filter((part) => part.type === "text")
              .map((part) => part.text),
          ),
        ).toEqual(["First instruction", "Second instruction"]);
        expect((await f.ledger.get("first-run"))?.status).toBe("running");
        expect(await f.inputs.tryCloseForCompletion("first-run")).toBe(false);
        await f.messages.createMessage({
          id: "assistant",
          role: "assistant",
          agent: "explore",
          sessionId: "child",
          contextScopeId: "agent",
          runId: "first-run",
        });
        const request = {
          requestId: "request",
          runId: "first-run",
          messageId: "assistant",
          step: 1,
          attempt: 1,
          purpose: "agent-step" as const,
          startedAt: 10,
          outcome: "running" as const,
          inputIds: ["one", "two"],
        };
        await f.inputs.admitRequestAttempt(request);
        await expect(f.inputs.confirmRequestSuccess("request")).rejects.toThrow(
          /successful/,
        );
        await f.messages.updateMessage("assistant", {
          modelRequests: [{ ...request, outcome: "success", endedAt: 11 }],
        });
        expect(await f.inputs.confirmRequestSuccess("request")).toEqual([
          "one",
          "two",
        ]);
        expect(await f.inputs.listPending("first-run")).toEqual([]);
        expect(await f.inputs.tryCloseForCompletion("first-run")).toBe(true);
        expect(
          await f.channel.closeExecutionInputs({
            execution,
            reason: "stopped",
          }),
        ).toEqual([]);
      } finally {
        unsubscribe();
      }
    });

    it("keeps the original receipt after completion and rejects altered retries", async () => {
      const f = await fixture();
      const execution = await f.execution("first");
      await f.channel.acceptExecutionMessage({
        execution,
        message: "Original",
        inputId: "one",
      });
      await f.inputs.close("first-run", "stopped");
      await f.ledger.markCancelled("first-run", "stopped");
      await f.executions.finish(execution, {
        status: "interrupted",
        completedAt: 4,
      });
      expect(
        await f.channel.acceptExecutionMessage({
          execution,
          message: "Original",
          inputId: "one",
        }),
      ).toEqual({ accepted: true });
      expect(
        await f.channel.getExecutionMessage({
          parentSessionId: "root",
          subagentId: "agent",
          inputId: "one",
        }),
      ).toMatchObject({
        execution: { executionId: "first", status: "interrupted" },
      });
      expect(await f.messages.listBySession("child")).toHaveLength(1);
      await expect(
        f.channel.acceptExecutionMessage({
          execution,
          message: "Changed",
          inputId: "one",
        }),
      ).rejects.toThrow(/conflict/i);
      expect(
        await f.channel.getExecutionMessage({
          parentSessionId: "foreign",
          subagentId: "agent",
          inputId: "one",
        }),
      ).toBeUndefined();
      expect(
        await f.channel.getExecutionMessage({
          parentSessionId: "root",
          subagentId: "sibling",
          inputId: "one",
        }),
      ).toBeUndefined();
    });

    it("returns unaccepted when natural completion wins without persisting the late message", async () => {
      const f = await fixture();
      const execution = await f.execution("first");
      expect(await f.inputs.tryCloseForCompletion("first-run")).toBe(true);
      const channelWithoutLedger = createExecutionMessageChannel({
        inputs: f.inputs,
        executions: f.executions,
        messages: f.messages,
      });
      expect(
        await channelWithoutLedger.acceptExecutionMessage({
          execution,
          message: "Too late",
          inputId: "late",
        }),
      ).toEqual({ accepted: false });
      expect(await f.inputs.getInput("late")).toBeUndefined();
      expect(await f.messages.listBySession("child")).toEqual([]);
    });

    it("records unconsumed originals on stop, survives a new reader and never carries them into a later send", async () => {
      const f = await fixture();
      const first = await f.execution("first");
      await f.channel.acceptExecutionMessage({
        execution: first,
        message: "Unprocessed original",
        inputId: "old",
      });
      expect(
        await f.channel.closeExecutionInputs({
          execution: first,
          reason: "stopped",
        }),
      ).toEqual([
        { inputId: "old", text: "Unprocessed original", reason: "stopped" },
      ]);
      await f.ledger.markCancelled("first-run", "stopped");
      await f.executions.finish(first, {
        status: "interrupted",
        completedAt: 4,
      });
      const restored = createExecutionMessageChannel({
        inputs:
          backend === "sqlite"
            ? new DatabaseCurrentRunInputStore({ db: getDatabase() })
            : f.inputs,
        executions: f.executions,
        messages: f.messages,
        runLedger: f.ledger,
      });
      expect(await restored.readExecutionInputs({ execution: first })).toEqual([
        { inputId: "old", text: "Unprocessed original", reason: "stopped" },
      ]);
      const second = await f.execution("second");
      await restored.acceptExecutionMessage({
        execution: second,
        message: "New explicit instruction",
        inputId: "new",
      });
      expect(
        (await f.inputs.getMessages("second-run")).flatMap((message) =>
          message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text),
        ),
      ).toEqual(["New explicit instruction"]);
      const history = await f.inputs.filterModelHistory(
        await f.messages.listBySession("child"),
      );
      expect(JSON.stringify(history)).not.toContain("Unprocessed original");
      expect(
        await restored.closeExecutionInputs({
          execution: first,
          reason: "closed",
        }),
      ).toEqual([
        { inputId: "old", text: "Unprocessed original", reason: "stopped" },
      ]);
    });

    it("distinguishes a not-yet-ready ledger from a completed execution", async () => {
      const f = await fixture();
      const execution = await f.execution("first", false);
      await expect(
        f.channel.acceptExecutionMessage({
          execution,
          message: "Starting",
          inputId: "one",
        }),
      ).rejects.toThrow(/ready/i);
      expect(await f.inputs.getInput("one")).toBeUndefined();
      await f.ledger.markRunning("first-run");
      expect(
        await f.channel.acceptExecutionMessage({
          execution,
          message: "Starting",
          inputId: "one",
        }),
      ).toEqual({ accepted: true });
    });

    if (backend === "sqlite")
      it("upgrades old input constraints without changing existing persisted receipts", async () => {
        const f = await fixture(true);
        const execution = await f.execution("first");
        await f.inputs.acceptRuntimeInput({
          inputId: "old-result",
          source: "subagent-result",
          sourceId: "previous-execution",
          runId: "first-run",
          sessionId: "child",
          contextScopeId: "agent",
          message: {
            info: {
              id: "old-message",
              role: "user",
              agent: "subagent",
              runId: "first-run",
              sessionId: "child",
              contextScopeId: "agent",
              time: { created: 1 },
            },
            parts: [
              {
                id: "old-part",
                messageId: "old-message",
                sessionId: "child",
                contextScopeId: "agent",
                orderIndex: 0,
                type: "text",
                text: "Prior result",
              },
            ],
          },
        });
        const before = getDatabase()
          .prepare("SELECT * FROM current_run_input")
          .all();
        const dbPath = getDatabase().path;
        closeDatabase();
        initDatabase({ dbPath });
        expect(
          getDatabase().prepare("SELECT * FROM current_run_input").all(),
        ).toEqual(before);
        expect(getDatabase().prepare("PRAGMA foreign_key_check").all()).toEqual(
          [],
        );
        expect(
          getDatabase()
            .prepare<{ name: string }>("PRAGMA index_list(current_run_input)")
            .all()
            .map((index) => index.name),
        ).toContain("idx_current_run_input_run");
        expect(() =>
          getDatabase()
            .prepare("UPDATE current_run_input SET source = 'unknown'")
            .run(),
        ).toThrow(/CHECK/);
        const channel = createExecutionMessageChannel({
          inputs: new DatabaseCurrentRunInputStore({ db: getDatabase() }),
          executions: new DatabaseSubagentExecutionStore({ db: getDatabase() }),
          messages: createMessageManager({
            bus: createBus(),
            store: createDatabaseMessageStore(),
          }),
          runLedger: createDatabaseRunLedger(),
        });
        expect(
          await channel.acceptExecutionMessage({
            execution,
            message: "New source after upgrade",
            inputId: "new-message",
          }),
        ).toEqual({ accepted: true });
      });
  });

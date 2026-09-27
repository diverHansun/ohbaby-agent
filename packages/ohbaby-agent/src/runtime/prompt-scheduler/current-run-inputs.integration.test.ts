import { WorkspacePromptScheduler } from "./scheduler.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initDatabase,
  getDatabase,
  closeDatabase,
  schema,
} from "../../services/database/index.js";
import {
  createDatabaseRunLedger,
  createInMemoryRunLedger,
} from "../run-ledger/index.js";
import {
  createDatabaseMessageStore,
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { createBus } from "../../bus/index.js";
import { DatabasePromptSubmissionStore } from "./database-store.js";
import { InMemoryPromptSubmissionStore } from "./in-memory-store.js";
import {
  DatabaseCurrentRunInputStore,
  InMemoryCurrentRunInputStore,
} from "./current-run-inputs.js";
const dirs: string[] = [];
afterEach(async () => {
  closeDatabase();
  await Promise.all(
    dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
for (const backend of ["memory", "sqlite"] as const)
  describe(`${backend} current-run inputs`, () => {
    // Fixture return shape follows the selected persistence implementation.
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    async function fixture() {
      if (backend === "sqlite") {
        const dir = await mkdtemp(join(tmpdir(), "run-inputs-"));
        dirs.push(dir);
        initDatabase({ dbPath: join(dir, "agent.db") });
        getDatabase()
          .prepare(
            `INSERT INTO ${schema.session.tableName} (id,project_id,project_root,agent,title,status,created_at,updated_at,message_count,data) VALUES ('session','project','/repo','default','test','active',1,1,0,'{}')`,
          )
          .run();
      }
      const ledger =
        backend === "sqlite"
          ? createDatabaseRunLedger({ db: getDatabase() })
          : createInMemoryRunLedger();
      const queue =
        backend === "sqlite"
          ? new DatabasePromptSubmissionStore({ db: getDatabase() })
          : new InMemoryPromptSubmissionStore();
      const messageStore =
        backend === "sqlite"
          ? createDatabaseMessageStore({ db: getDatabase() })
          : createInMemoryMessageStore();
      const messages = createMessageManager({
        bus: createBus(),
        store: messageStore,
      });
      const inputs =
        backend === "sqlite"
          ? new DatabaseCurrentRunInputStore({ db: getDatabase() })
          : new InMemoryCurrentRunInputStore({
              runLedger: ledger,
              promptStore: queue as InMemoryPromptSubmissionStore,
              messageManager: messages,
            });
      await ledger.createPending({
        runId: "run-a",
        sessionId: "session",
        triggerSource: "user",
      });
      await ledger.markRunning("run-a");
      await queue.accept({
        promptId: "queued",
        clientRequestId: "submit",
        scopeKey: "workspace",
        sessionId: "session",
        userMessageId: "reserved-message",
        text: "Change the plan",
        maxQueuedPrompts: 10,
      });
      const steer = {
        promptId: "queued",
        expectedRunId: "run-a",
        clientRequestId: "steer-request",
        sessionId: "session",
        scopeKey: "workspace",
      };
      return { ledger, queue, messages, messageStore, inputs, steer };
    }
    it("atomically converts the queued receipt with original message identity and idempotent receipt", async () => {
      const f = await fixture();
      const first = await f.inputs.steerQueued(f.steer);
      expect(first.receipt).toMatchObject({
        acceptedTargetRunId: "run-a",
        userMessageId: "reserved-message",
      });
      expect(await f.inputs.steerQueued(f.steer)).toEqual(first);
      const exported = await f.queue.get("queued");
      Object.assign(exported?.steerReceipt ?? {}, {
        acceptedTargetRunId: "foreign-run",
      });
      expect(
        (await f.queue.get("queued"))?.steerReceipt?.acceptedTargetRunId,
      ).toBe("run-a");
      expect(await f.inputs.steerQueued(f.steer)).toEqual(first);
      expect((await f.queue.get("queued"))?.status).toBe("steered");
      expect(await f.queue.claim("queued")).toBeNull();
      const messages = await f.messages.listBySession("session");
      expect(messages).toHaveLength(1);
      expect(messages[0].info.runtimeInput?.inputId).toBe(
        first.receipt.inputId,
      );
      expect(messages[0].parts).toMatchObject([{ text: "Change the plan" }]);
      await expect(
        f.inputs.steerQueued({ ...f.steer, expectedRunId: "run-b" }),
      ).rejects.toThrow(/conflict/i);
      expect(await f.inputs.tryCloseForCompletion("run-a")).toBe(false);
    });
    it("makes normal finish and acceptance mutually exclusive and rejects active leases", async () => {
      const f = await fixture();
      await f.queue.acquireEditLease("queued", "editor", 60000);
      await expect(f.inputs.steerQueued(f.steer)).rejects.toThrow(/lease/i);
      expect(await f.inputs.tryCloseForCompletion("run-a")).toBe(true);
      await expect(f.inputs.steerQueued(f.steer)).rejects.toThrow();
      expect((await f.queue.get("queued"))?.status).toBe("queued");
      expect(await f.messages.listBySession("session")).toHaveLength(0);
    });
    it("freezes attempt membership, excludes late input, preserves unsent input after stop and filters it from later history", async () => {
      const f = await fixture();
      const { receipt } = await f.inputs.steerQueued(f.steer);
      await f.messages.createMessage({
        id: "assistant",
        role: "assistant",
        agent: "default",
        runId: "run-a",
        sessionId: "session",
      });
      const attempt = {
        requestId: "request-a",
        runId: "run-a",
        messageId: "assistant",
        step: 1,
        attempt: 1,
        purpose: "agent-step",
        startedAt: 0,
        outcome: "running" as const,
        inputIds: [receipt.inputId],
      };
      await f.inputs.admitRequestAttempt(attempt);
      await f.queue.accept({
        promptId: "later",
        clientRequestId: "submit-later",
        scopeKey: "workspace",
        sessionId: "session",
        userMessageId: "later-message",
        text: "Later instruction",
        maxQueuedPrompts: 10,
      });
      const later = await f.inputs.steerQueued({
        ...f.steer,
        promptId: "later",
        clientRequestId: "steer-later",
      });
      expect(
        await f.inputs.filterModelHistory(
          await f.messages.listBySession("session"),
        ),
      ).toMatchObject([{ info: { id: "assistant" } }]);
      await expect(f.inputs.confirmRequestSuccess("request-a")).rejects.toThrow(
        /success/i,
      );
      await f.messages.updateMessage("assistant", {
        modelRequests: [
          { ...attempt, outcome: "success", endedAt: Date.now() },
        ],
      });
      expect(await f.inputs.confirmRequestSuccess("request-a")).toEqual([
        receipt.inputId,
      ]);
      expect(
        (await f.inputs.listPending("run-a")).map((r) => r.inputId),
      ).toEqual([later.receipt.inputId]);
      await f.inputs.close("run-a", "stopped");
      await expect(
        f.inputs.admitRequestAttempt({
          ...attempt,
          requestId: "empty-after-stop",
          inputIds: [],
        }),
      ).rejects.toThrow(/closed|active/i);
      expect(
        (
          await f.inputs.filterModelHistory(
            await f.messages.listBySession("session"),
          )
        ).map((m) => m.info.id),
      ).toEqual(["reserved-message", "assistant"]);
      expect(await f.messages.listBySession("session")).toHaveLength(3);
    });
    it("serializes Steer against normal claim and does not admit foreign scope or duplicate changed request membership", async () => {
      const f = await fixture();
      await expect(
        f.inputs.steerQueued({ ...f.steer, scopeKey: "foreign" }),
      ).rejects.toThrow();
      const results = await Promise.allSettled([
        f.inputs.steerQueued(f.steer),
        f.queue.claim("queued"),
      ]);
      const current = await f.queue.get("queued");
      expect(["steered", "starting"]).toContain(current?.status);
      if (current?.status === "steered") {
        expect(results[1]).toMatchObject({ status: "fulfilled", value: null });
        expect(await f.messages.listBySession("session")).toHaveLength(1);
      } else {
        expect(results[0].status).toBe("rejected");
        expect(await f.messages.listBySession("session")).toHaveLength(0);
      }
    });
    it("keeps request membership immutable, rejects foreign owner IDs, and expires only unattempted observations", async () => {
      const f = await fixture();
      let wakes = 0;
      f.inputs.subscribe("run-a", () => {
        wakes++;
      });
      const message = {
        info: {
          id: "status-message",
          sessionId: "session",
          role: "user" as const,
          agent: "default",
          time: { created: 1 },
        },
        parts: [
          {
            id: "status-text",
            messageId: "status-message",
            sessionId: "session",
            orderIndex: 0,
            type: "text" as const,
            text: "Still waiting",
          },
        ],
      };
      const input = {
        inputId: "status",
        runId: "run-a",
        sessionId: "session",
        source: "subagent-status" as const,
        sourceId: "wait-1",
        message,
        observation: {
          waitGeneration: 1,
          reason: "deadline" as const,
          observedAt: 1,
        },
      };
      await f.inputs.acceptRuntimeInput(input);
      await f.inputs.acceptRuntimeInput(input);
      expect(wakes).toBe(1);
      await f.messages.createMessage({
        id: "assistant",
        role: "assistant",
        agent: "default",
        runId: "run-a",
        sessionId: "session",
      });
      const request = {
        requestId: "r1",
        runId: "run-a",
        messageId: "assistant",
        step: 1,
        attempt: 1,
        purpose: "agent-step",
        startedAt: 1,
        outcome: "running" as const,
        inputIds: ["status"],
      };
      await f.inputs.admitRequestAttempt(request);
      await expect(
        f.inputs.admitRequestAttempt({ ...request, inputIds: [] }),
      ).rejects.toThrow(/membership/i);
      await f.messages.createMessage({
        id: "assistant-2",
        role: "assistant",
        agent: "default",
        runId: "run-a",
        sessionId: "session",
      });
      await expect(
        f.inputs.admitRequestAttempt({ ...request, messageId: "assistant-2" }),
      ).rejects.toThrow(/owner/i);
      await f.inputs.dismissObservations("run-a", "expired");
      expect(wakes).toBe(1);
      expect((await f.inputs.getInput("status"))?.closedAt).toBeUndefined();
      const next = {
        ...input,
        inputId: "status-2",
        sourceId: "wait-2",
        message: {
          ...message,
          info: { ...message.info, id: "status-message-2" },
          parts: [
            {
              ...message.parts[0],
              id: "status-text-2",
              messageId: "status-message-2",
            },
          ],
        },
      };
      await f.inputs.acceptRuntimeInput(next);
      await f.inputs.dismissObservations("run-a", "expired");
      await f.inputs.dismissObservations("run-a", "expired");
      expect(wakes).toBe(3);
      expect(await f.inputs.getInput("status-2")).toMatchObject({
        closeReason: "expired",
      });
      expect(
        (await f.inputs.getInput("status-2"))?.processedRequestId,
      ).toBeUndefined();
    });
    it("rolls back message collisions without consuming the queued prompt", async () => {
      const f = await fixture();
      const existing = await f.messages.createMessage({
        id: "existing",
        sessionId: "session",
        role: "user",
        agent: "default",
      });
      await f.messageStore.appendPart({
        message: existing,
        partId: "reserved-message:steer-text",
        data: { type: "text", text: "Existing" },
        updatedAt: 1,
      });
      await expect(f.inputs.steerQueued(f.steer)).rejects.toThrow();
      expect((await f.queue.get("queued"))?.status).toBe("queued");
      expect(await f.inputs.getInput("steer:queued")).toBeUndefined();
      expect(
        await f.messageStore.getMessage("reserved-message"),
      ).toBeUndefined();
    });

    it("settles a converted queued waiter without executing another run and closes inputs on ledger recovery", async () => {
      const f = await fixture();
      const execute = vi.fn(() =>
        Promise.resolve({ status: "succeeded" as const }),
      );
      const scheduler = new WorkspacePromptScheduler({
        scopeKey: "workspace",
        store: f.queue,
        currentRunInputs: f.inputs,
        execute,
      });
      try {
        const waiting = scheduler.waitForCompletion("queued");
        await scheduler.steerQueued(f.steer);
        expect(await waiting).toMatchObject({
          status: "steered",
          userMessageId: "reserved-message",
        });
        expect(execute).not.toHaveBeenCalled();
        await f.ledger.markInterrupted();
        expect(await f.inputs.listPending("run-a")).toEqual([]);
        expect(await f.inputs.getInput("steer:queued")).toMatchObject({
          closeReason: "interrupted",
        });
        expect(
          await f.inputs.filterModelHistory(
            await f.messages.listBySession("session"),
          ),
        ).toEqual([]);
      } finally {
        scheduler.close();
      }
    });
    it("reprepares an unattempted observation when a concurrent real input is omitted", async () => {
      const f = await fixture();
      const message = {
        info: {
          id: "observation",
          sessionId: "session",
          role: "user" as const,
          agent: "default",
          time: { created: 1 },
        },
        parts: [
          {
            id: "observation-text",
            messageId: "observation",
            sessionId: "session",
            orderIndex: 0,
            type: "text" as const,
            text: "Wait timed out",
          },
        ],
      };
      await f.inputs.acceptRuntimeInput({
        inputId: "observation",
        runId: "run-a",
        sessionId: "session",
        source: "subagent-status",
        sourceId: "wait",
        message,
      });
      await f.messages.createMessage({
        id: "assistant",
        role: "assistant",
        agent: "default",
        runId: "run-a",
        sessionId: "session",
      });
      const request = {
        requestId: "observation-request",
        runId: "run-a",
        messageId: "assistant",
        step: 1,
        attempt: 1,
        purpose: "agent-step",
        startedAt: 1,
        outcome: "running" as const,
        inputIds: ["observation"],
      };
      const acceptance = f.inputs.steerQueued(f.steer);
      await expect(f.inputs.admitRequestAttempt(request)).rejects.toMatchObject(
        { name: "RuntimeInputSnapshotChangedError" },
      );
      const accepted = await acceptance;
      expect(
        (await f.inputs.getInput("observation"))?.firstAttemptRequestId,
      ).toBeUndefined();
      await f.inputs.admitRequestAttempt({
        ...request,
        inputIds: ["observation", accepted.receipt.inputId],
      });
      await f.queue.accept({
        promptId: "later",
        clientRequestId: "submit-later",
        scopeKey: "workspace",
        sessionId: "session",
        userMessageId: "later-message",
        text: "Later real input",
        maxQueuedPrompts: 10,
      });
      await f.inputs.steerQueued({
        ...f.steer,
        promptId: "later",
        clientRequestId: "steer-later",
      });
      await expect(
        f.inputs.admitRequestAttempt({
          ...request,
          requestId: "retry",
          attempt: 2,
          inputIds: ["observation", accepted.receipt.inputId],
        }),
      ).resolves.toBeUndefined();
    });

    if (backend === "sqlite")
      it("reopens immutable input membership and receipts after database restart", async () => {
        const f = await fixture();
        const accepted = await f.inputs.steerQueued(f.steer);
        await f.messages.createMessage({
          id: "assistant",
          role: "assistant",
          agent: "default",
          runId: "run-a",
          sessionId: "session",
        });
        await f.inputs.admitRequestAttempt({
          requestId: "persisted",
          runId: "run-a",
          messageId: "assistant",
          step: 1,
          attempt: 1,
          purpose: "agent-step",
          startedAt: 1,
          outcome: "running",
          inputIds: [accepted.receipt.inputId],
        });
        const path = join(dirs[dirs.length - 1], "agent.db");
        closeDatabase();
        initDatabase({ dbPath: path });
        const reopened = new DatabaseCurrentRunInputStore({
          db: getDatabase(),
        });
        expect((await reopened.steerQueued(f.steer)).receipt).toEqual(
          accepted.receipt,
        );
        expect(await reopened.getInput(accepted.receipt.inputId)).toMatchObject(
          { firstAttemptRequestId: "persisted" },
        );
        await reopened.close("run-a", "recovered");
        expect(
          (
            await reopened.filterModelHistory(
              await createDatabaseMessageStore({
                db: getDatabase(),
              }).listBySession("session"),
            )
          ).map((m) => m.info.id),
        ).toContain("reserved-message");
      });
  });

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
  type SteerQueuedPromptOutcome,
  type SteerQueuedPromptResult,
} from "./current-run-inputs.js";
function requireSteered(
  result: SteerQueuedPromptOutcome,
): SteerQueuedPromptResult {
  if (result.status !== "steered")
    throw new Error(`Unexpected steer result: ${result.reason}`);
  return result;
}
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
    async function fixture(skillName?: string) {
      if (backend === "sqlite") {
        const dir = await mkdtemp(join(tmpdir(), "run-inputs-"));
        dirs.push(dir);
        initDatabase({ dbPath: join(dir, "agent.db") });
        getDatabase()
          .prepare(
            `INSERT INTO ${schema.session.tableName} (id,project_id,working_directory,agent,title,status,created_at,updated_at,message_count,data) VALUES ('session','project','/repo','default','test','active',1,1,0,'{}')`,
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
        namingSource: skillName
          ? { skillName, request: "change", ...{ skillBodyExpanded: true } }
          : undefined,
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
    it("persists slash provenance on the actual steer body across store reopen", async () => {
      const f = await fixture("review");
      const result = requireSteered(await f.inputs.steerQueued(f.steer));
      expect(result.message.parts[0]?.metadata?.skillUsage).toEqual({
        name: "review",
        source: "slash",
      });
      const reopened =
        backend === "sqlite"
          ? createMessageManager({
              bus: createBus(),
              store: createDatabaseMessageStore({ db: getDatabase() }),
            })
          : f.messages;
      const messages = await reopened.listByIds("session", [
        result.message.info.id,
      ]);
      expect(messages[0]?.parts[0]?.metadata?.skillUsage).toEqual({
        name: "review",
        source: "slash",
      });
      expect(
        requireSteered(await f.inputs.steerQueued(f.steer)).message.parts,
      ).toEqual(messages[0]?.parts);
    });
    it("keeps a public naming hint separate from trusted slash body provenance", async () => {
      const f = await fixture();
      await f.queue.accept({
        promptId: "hint",
        clientRequestId: "hint",
        scopeKey: "workspace",
        sessionId: "session",
        userMessageId: "hint-message",
        text: "ordinary",
        namingSource: { skillName: "review", request: "ordinary" },
        maxQueuedPrompts: 10,
      });
      const result = requireSteered(
        await f.inputs.steerQueued({
          ...f.steer,
          promptId: "hint",
          clientRequestId: "hint-steer",
        }),
      );
      expect(result.message.parts[0]?.metadata?.skillUsage).toBeUndefined();
    });
    it("clears slash provenance when queued body is edited before steering", async () => {
      const f = await fixture("review");
      const lease = await f.queue.acquireEditLease("queued", "editor", 10000);
      await f.queue.commitEdit(
        "queued",
        lease.editLeaseId,
        "replacement",
        "editor",
      );
      const result = requireSteered(await f.inputs.steerQueued(f.steer));
      expect(result.message.parts[0]?.metadata?.skillUsage).toBeUndefined();
    });
    it("reads pending and closed Steer candidates without mutating records or waking execution", async () => {
      const f = await fixture();
      const { receipt } = requireSteered(await f.inputs.steerQueued(f.steer));
      expect(await f.inputs.listUnconsumedSteers("session")).toMatchObject([
        { inputId: receipt.inputId },
      ]);
      const wake = vi.fn();
      const unsubscribe = f.inputs.subscribe("run-a", wake);
      await f.inputs.close("run-a", "user-stop");
      wake.mockClear();
      const before = await f.inputs.getInput(receipt.inputId);
      const reader =
        backend === "sqlite"
          ? new DatabaseCurrentRunInputStore({ db: getDatabase() })
          : f.inputs;
      expect(await reader.listUnconsumedSteers("session")).toMatchObject([
        { inputId: receipt.inputId },
      ]);
      expect(await reader.listUnconsumedSteers("other")).toEqual([]);
      expect(await reader.listUnconsumedSteers("session")).toMatchObject([
        { inputId: receipt.inputId },
      ]);
      expect(await reader.getInput(receipt.inputId)).toEqual(before);
      expect(wake).not.toHaveBeenCalled();
      unsubscribe();
    });
    it.each(["error", "aborted"] as const)(
      "retains attempted unconfirmed Steer after a request ended with %s",
      async (outcome) => {
        const f = await fixture();
        const { receipt } = requireSteered(await f.inputs.steerQueued(f.steer));
        await f.messages.createMessage({
          id: "assistant-unsent",
          role: "assistant",
          agent: "default",
          runId: "run-a",
          sessionId: "session",
        });
        const request = {
          requestId: "failed-transport",
          runId: "run-a",
          messageId: "assistant-unsent",
          step: 1,
          attempt: 1,
          purpose: "agent-step" as const,
          startedAt: 1,
          outcome: "running" as const,
          inputIds: [receipt.inputId],
        };
        await f.inputs.admitRequestAttempt(request);
        await f.messages.updateMessage("assistant-unsent", {
          modelRequests: [{ ...request, outcome, endedAt: 2 }],
        });
        await f.inputs.close("run-a", "user-stop");
        expect(
          (await f.inputs.getInput(receipt.inputId))?.processedRequestId,
        ).toBeUndefined();
        expect(
          (await f.inputs.getInput(receipt.inputId))?.firstAttemptRequestId,
        ).toBe(request.requestId);
        expect(await f.inputs.listUnconsumedSteers("session")).toMatchObject([
          { inputId: receipt.inputId },
        ]);
      },
    );

    it("atomically converts the queued receipt with original message identity and idempotent receipt", async () => {
      const f = await fixture();
      const first = requireSteered(await f.inputs.steerQueued(f.steer));
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
    it("orders a converted Steer at acceptance time after newer persisted history", async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
      try {
        const f = await fixture();
        const queued = await f.queue.get("queued");
        if (!queued) throw new Error("expected queued prompt");
        const createdAt = queued.createdAt;
        clock.mockReturnValue(createdAt + 100);
        await f.messages.createMessage({
          sessionId: "session",
          role: "user",
          agent: "default",
        });
        clock.mockReturnValue(createdAt + 200);
        const accepted = requireSteered(await f.inputs.steerQueued(f.steer));
        const history = await f.messages.listBySession("session");
        expect(history.map((message) => message.info.id).at(-1)).toBe(
          "reserved-message",
        );
        expect(accepted.message.info.time.created).toBe(
          accepted.receipt.acceptedAt,
        );
        expect(accepted.receipt.acceptedAt).toBe(createdAt + 200);
        expect((await f.queue.get("queued"))?.createdAt).toBe(createdAt);
        clock.mockReturnValue(createdAt + 300);
        expect(await f.inputs.steerQueued(f.steer)).toEqual(accepted);
      } finally {
        clock.mockRestore();
      }
    });
    it("makes normal finish and acceptance mutually exclusive and rejects active leases", async () => {
      const f = await fixture();
      const lease = await f.queue.acquireEditLease("queued", "editor", 60000);
      await expect(f.inputs.steerQueued(f.steer)).rejects.toThrow(/lease/i);
      await f.queue.releaseEditLease("queued", lease.editLeaseId, "editor");
      expect(await f.inputs.tryCloseForCompletion("run-a")).toBe(true);
      await expect(f.inputs.steerQueued(f.steer)).resolves.toMatchObject({
        status: "not-steered",
        reason: "target-unavailable",
      });
      expect((await f.queue.get("queued"))?.status).toBe("queued");
      expect(await f.messages.listBySession("session")).toHaveLength(0);
    });
    it("seals final-step Steer admission without closing already accepted inputs or request delivery", async () => {
      const f = await fixture();
      const first = requireSteered(await f.inputs.steerQueued(f.steer));
      await f.queue.accept({
        promptId: "late",
        clientRequestId: "late-submit",
        scopeKey: "workspace",
        sessionId: "session",
        userMessageId: "late-message",
        text: "too late",
        maxQueuedPrompts: 10,
      });
      await f.inputs.sealSteer("run-a");
      const reader =
        backend === "sqlite"
          ? new DatabaseCurrentRunInputStore({ db: getDatabase() })
          : f.inputs;
      await expect(
        reader.steerQueued({
          ...f.steer,
          promptId: "late",
          clientRequestId: "late-steer",
        }),
      ).resolves.toMatchObject({
        status: "not-steered",
        reason: "target-sealed",
      });
      expect((await f.queue.get("late"))?.status).toBe("queued");
      expect(await reader.listPending("run-a")).toMatchObject([
        { inputId: first.receipt.inputId },
      ]);
      expect(await reader.steerQueued(f.steer)).toEqual(first);
      expect((await f.ledger.get("run-a"))?.status).toBe("running");
      expect(await reader.getMessages("run-a")).toHaveLength(1);
    });
    it("freezes attempt membership, excludes late input, preserves unsent input after stop and filters it from later history", async () => {
      const f = await fixture();
      const { receipt } = requireSteered(await f.inputs.steerQueued(f.steer));
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
        purpose: "agent-step" as const,
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
      const later = requireSteered(
        await f.inputs.steerQueued({
          ...f.steer,
          promptId: "later",
          clientRequestId: "steer-later",
        }),
      );
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
    it.each(["subagent-result", "subagent-message"] as const)(
      "retains failed %s attempts for audit without replaying them after close",
      async (source) => {
        const f = await fixture();
        await f.inputs.acceptRuntimeInput({
          inputId: "failed-input",
          source,
          sourceId: "source",
          runId: "run-a",
          sessionId: "session",
          message: {
            info: {
              id: "input-message",
              role: "user",
              agent: "default",
              runId: "run-a",
              sessionId: "session",
              time: { created: 1 },
            },
            parts: [
              {
                id: "input-part",
                messageId: "input-message",
                sessionId: "session",
                orderIndex: 0,
                type: "text",
                text: "Unprocessed prior input",
              },
            ],
          },
        });
        await f.messages.createMessage({
          id: "assistant",
          role: "assistant",
          agent: "default",
          runId: "run-a",
          sessionId: "session",
        });
        const request = {
          requestId: "failed-attempt",
          runId: "run-a",
          messageId: "assistant",
          step: 1,
          attempt: 1,
          purpose: "agent-step" as const,
          startedAt: 1,
          outcome: "running" as const,
          inputIds: ["failed-input"],
        };
        await f.inputs.admitRequestAttempt(request);
        await f.messages.updateMessage("assistant", {
          modelRequests: [{ ...request, outcome: "error", endedAt: 2 }],
        });
        await f.inputs.close("run-a", "stopped");
        const reader =
          backend === "sqlite"
            ? new DatabaseCurrentRunInputStore({ db: getDatabase() })
            : f.inputs;
        const input = await reader.getInput("failed-input");
        expect(input).toMatchObject({
          firstAttemptRequestId: "failed-attempt",
        });
        expect(typeof input?.closedAt).toBe("number");
        const stored = await f.messages.listBySession("session");
        expect(stored.map((message) => message.info.id)).toContain(
          "input-message",
        );
        expect(
          (await reader.filterModelHistory(stored)).map(
            (message) => message.info.id,
          ),
        ).toEqual(["assistant"]);
      },
    );
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
        expect(results[0]).toMatchObject({
          status: "fulfilled",
          value: { status: "not-steered", reason: "prompt-not-queued" },
        });
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
        purpose: "agent-step" as const,
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
        await f.ledger.markInterrupted({ recoverUnknownOwner: true });
        expect(await f.inputs.listPending("run-a")).toEqual([]);
        expect(await f.inputs.getInput("steer:queued")).toMatchObject({
          closeReason: "process-interrupted",
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
        purpose: "agent-step" as const,
        startedAt: 1,
        outcome: "running" as const,
        inputIds: ["observation"],
      };
      const acceptance = f.inputs.steerQueued(f.steer);
      await expect(f.inputs.admitRequestAttempt(request)).rejects.toMatchObject(
        { name: "RuntimeInputSnapshotChangedError" },
      );
      const accepted = requireSteered(await acceptance);
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
        const accepted = requireSteered(await f.inputs.steerQueued(f.steer));
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
        expect(
          requireSteered(await reopened.steerQueued(f.steer)).receipt,
        ).toEqual(accepted.receipt);
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

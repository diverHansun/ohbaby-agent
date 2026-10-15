import { SessionExecutionGate } from "../../adapters/session-execution.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createMessageManager,
  createInMemoryMessageStore,
  createDatabaseMessageStore,
} from "../../core/message/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import {
  createDatabaseRunLedger,
  createInMemoryRunLedger,
} from "../run-ledger/index.js";
import {
  DatabaseCurrentRunInputStore,
  InMemoryCurrentRunInputStore,
} from "./current-run-inputs.js";
import { DatabasePromptSubmissionStore } from "./database-store.js";
import { InMemoryPromptSubmissionStore } from "./in-memory-store.js";
import {
  WorkspacePromptScheduler,
  type WorkspacePromptSchedulerOptions,
} from "./scheduler.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const dirs: string[] = [];
const schedulers: WorkspacePromptScheduler[] = [];
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) scheduler.close();
  vi.restoreAllMocks();
  closeDatabase();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

for (const backend of ["memory", "sqlite"] as const)
  describe(`${backend} automatic steer`, () => {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    async function fixture(
      options: Partial<WorkspacePromptSchedulerOptions> = {},
    ) {
      if (backend === "sqlite") {
        const dir = await mkdtemp(join(tmpdir(), "auto-steer-"));
        dirs.push(dir);
        initDatabase({ dbPath: join(dir, "agent.db") });
        getDatabase()
          .prepare(
            "INSERT INTO session(id,project_id,project_root,agent,title,status,created_at,updated_at,message_count,data) VALUES ('session','project','/repo','default','test','active',1,1,0,'{}')",
          )
          .run();
      }
      const ledger =
        backend === "sqlite"
          ? createDatabaseRunLedger({ db: getDatabase() })
          : createInMemoryRunLedger();
      const queue =
        backend === "sqlite"
          ? new DatabasePromptSubmissionStore({
              db: getDatabase(),
              now: (): number => 100,
            })
          : new InMemoryPromptSubmissionStore({ now: (): number => 100 });
      const messages = createMessageManager({
        bus: createBus(),
        store:
          backend === "sqlite"
            ? createDatabaseMessageStore({ db: getDatabase() })
            : createInMemoryMessageStore(),
      });
      const inputs =
        backend === "sqlite"
          ? new DatabaseCurrentRunInputStore({
              db: getDatabase(),
              now: (): number => 100,
            })
          : new InMemoryCurrentRunInputStore({
              now: (): number => 100,
              runLedger: ledger,
              promptStore: queue as InMemoryPromptSubmissionStore,
              messageManager: messages,
            });
      await ledger.createPending({
        runId: "goal-run",
        sessionId: "session",
        triggerSource: "user",
      });
      await ledger.markRunning("goal-run");
      const executed: string[] = [];
      const gate = new SessionExecutionGate();
      gate.reserve("session", Symbol("goal"));
      const scheduler = new WorkspacePromptScheduler({
        scopeKey: "workspace",
        store: queue,
        currentRunInputs: inputs,
        executionGate: gate,
        resolveSteerTarget: (): { runId: string } => ({ runId: "goal-run" }),
        execute: (
          prompt,
        ): Promise<import("./types.js").PromptExecutionResult> => {
          executed.push(prompt.promptId);
          return Promise.resolve({ status: "succeeded" });
        },
        ...options,
      });
      schedulers.push(scheduler);
      return { ledger, queue, messages, inputs, scheduler, executed };
    }
    const submit = {
      sessionId: "session",
      text: "Change the plan",
      clientRequestId: "submit",
    };

    it("automatically steers the durable prompt and publishes its final state without starting another run", async () => {
      const updated: string[] = [];
      const steered: string[] = [];
      const f = await fixture({
        onUpdated: (prompt) => updated.push(prompt.status),
        onSteered: (result) => steered.push(result.receipt.inputId),
      });
      const accepted = await f.scheduler.accept(submit);
      expect(accepted).toMatchObject({
        record: { status: "steered", clientRequestId: "submit" },
        steer: {
          status: "steered",
          receipt: {
            acceptedTargetRunId: "goal-run",
            clientRequestId: "submit",
          },
        },
      });
      expect(updated).toEqual(["steered"]);
      expect(steered).toEqual([accepted.record.steerReceipt?.inputId]);
      expect(
        await f.scheduler.waitForCompletion(accepted.record.promptId),
      ).toMatchObject({ status: "steered" });
      expect(await f.inputs.listPending("goal-run")).toHaveLength(1);
      expect(await f.messages.listBySession("session")).toHaveLength(1);
      expect(f.executed).toEqual([]);
      expect(await f.scheduler.accept(submit)).toEqual(accepted);
    });

    it("keeps two successful same-millisecond steers in acceptance order despite reverse lexical ids", async () => {
      let id = 0;
      const f = await fixture({
        createPromptId: () => ["z-first", "a-second"][id++],
      });
      const first = await f.scheduler.accept(submit);
      const second = await f.scheduler.accept({
        ...submit,
        text: "Later detail",
        clientRequestId: "later",
      });
      expect(first.steer.status).toBe("steered");
      expect(second.steer.status).toBe("steered");
      expect(
        (await f.inputs.listPending("goal-run")).map((input) => input.sourceId),
      ).toEqual(["z-first", "a-second"]);
      expect(
        (await f.inputs.getMessages("goal-run")).map((message) =>
          message.parts
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(""),
        ),
      ).toEqual(["Change the plan", "Later detail"]);
      expect(second.record.steerReceipt?.acceptedAt).toBeGreaterThan(
        first.record.steerReceipt?.acceptedAt ?? 0,
      );
      expect(await f.scheduler.accept(submit)).toEqual(first);
    });

    it("orders an old manually steered prompt between runtime inputs at frozen time", async () => {
      const f = await fixture({ resolveSteerTarget: undefined });
      const queued = await f.scheduler.accept(submit);
      async function runtimeInput(id: string): Promise<void> {
        await f.inputs.acceptRuntimeInput({
          inputId: id,
          runId: "goal-run",
          sessionId: "session",
          source: "subagent-result",
          sourceId: id,
          message: {
            info: {
              id: `message:${id}`,
              role: "user",
              sessionId: "session",
              agent: "default",
              time: { created: 100 },
            },
            parts: [
              {
                id: `part:${id}`,
                messageId: `message:${id}`,
                sessionId: "session",
                orderIndex: 0,
                type: "text",
                text: id,
              },
            ],
          },
        });
      }
      await runtimeInput("z-first");
      const input = {
        promptId: queued.record.promptId,
        expectedRunId: "goal-run",
        sessionId: "session",
        scopeKey: "workspace",
        clientRequestId: "manual-old",
      };
      const receipt = await f.scheduler.steerQueued(input);
      await runtimeInput("a-last");
      expect(
        (await f.inputs.listPending("goal-run")).map((item) => item.sourceId),
      ).toEqual(["z-first", queued.record.promptId, "a-last"]);
      expect(await f.scheduler.steerQueued(input)).toEqual(receipt);
    });

    it("keeps an earlier queued item ahead of a later input with frozen time and reverse lexical ids", async () => {
      let target = false;
      let id = 0;
      const f = await fixture({
        createPromptId: () => ["z-first", "a-second"][id++],
        resolveSteerTarget: () => (target ? { runId: "goal-run" } : undefined),
      });
      const first = await f.scheduler.accept(submit);
      target = true;
      const second = await f.scheduler.accept({
        ...submit,
        text: "Later",
        clientRequestId: "later",
      });
      expect(first.steer).toEqual({
        status: "not-steered",
        reason: "no-goal-run",
      });
      expect(second.steer).toEqual({
        status: "not-steered",
        reason: "earlier-queued",
      });
      expect(
        (await f.queue.listQueued("workspace")).map(
          (prompt) => prompt.promptId,
        ),
      ).toEqual(["z-first", "a-second"]);
      expect(second.record.admissionOrder).toBeGreaterThan(
        first.record.admissionOrder ?? 0,
      );
      expect(await f.inputs.listPending("goal-run")).toEqual([]);
    });

    it.each(["target-sealed", "target-unavailable"] as const)(
      "preserves acceptance on %s",
      async (reason) => {
        const f = await fixture();
        if (reason === "target-sealed") await f.inputs.sealSteer("goal-run");
        else await f.inputs.close("goal-run", "interrupted");
        const accepted = await f.scheduler.accept(submit);
        expect(accepted).toMatchObject({
          record: { status: "queued" },
          steer: { status: "not-steered", reason },
        });
        expect(await f.inputs.listPending("goal-run")).toEqual([]);
        expect(await f.messages.listBySession("session")).toEqual([]);
      },
    );

    it("keeps an accepted record queryable after a real steer error without retrying the decision", async () => {
      const f = await fixture({
        resolveSteerTarget: () => {
          throw new Error("lookup failed");
        },
      });
      const accepted = await f.scheduler.accept(submit);
      expect(accepted).toMatchObject({
        record: { status: "queued" },
        steer: {
          status: "error",
          error: { message: "lookup failed", retryable: false },
        },
      });
      expect(await f.queue.get(accepted.record.promptId)).toEqual(
        accepted.record,
      );
      expect(await f.scheduler.accept(submit)).toEqual({
        record: accepted.record,
        steer: { status: "existing", promptId: accepted.record.promptId },
      });
    });

    it("reuses a persisted decision before capacity checks and does not retroactively steer a crash-recovered acceptance", async () => {
      const f = await fixture({ maxQueuedPrompts: 1 });
      const { record } = await f.queue.accept({
        ...submit,
        scopeKey: "workspace",
        promptId: "persisted",
        userMessageId: "persisted-message",
        maxQueuedPrompts: 1,
      });
      expect(await f.scheduler.accept(submit)).toEqual({
        record,
        steer: { status: "existing", promptId: "persisted" },
      });
      expect(await f.inputs.listPending("goal-run")).toEqual([]);
    });

    it("settles a retry waiter registered between acceptance and steer despite failing observers", async () => {
      const entered = deferred();
      const release = deferred();
      const f = await fixture({
        onUpdated: () => {
          throw new Error("projection");
        },
        onSteered: () => {
          throw new Error("steered projection");
        },
        onProjectionError: () => {
          throw new Error("error observer");
        },
      });
      f.inputs.setMessageCommitObserver(() => {
        throw new Error("message observer");
      });
      const steer = f.inputs.steerQueued.bind(f.inputs);
      vi.spyOn(f.inputs, "steerQueued").mockImplementation(async (input) => {
        entered.resolve();
        await release.promise;
        return steer(input);
      });
      const acceptance = f.scheduler.accept(submit);
      await entered.promise;
      const retry = await f.scheduler.accept(submit);
      expect(retry).toMatchObject({
        record: { status: "queued" },
        steer: { status: "existing" },
      });
      const waiter = f.scheduler.waitForCompletion(retry.record.promptId);
      release.resolve();
      expect(await acceptance).toMatchObject({
        record: { status: "steered" },
        steer: { status: "steered" },
      });
      expect(await waiter).toMatchObject({ status: "steered" });
      expect(await f.inputs.listPending("goal-run")).toHaveLength(1);
    });

    it("returns typed manual races but retains identity conflicts as errors", async () => {
      const f = await fixture({ resolveSteerTarget: undefined });
      const accepted = await f.scheduler.accept(submit);
      const input = {
        promptId: accepted.record.promptId,
        expectedRunId: "goal-run",
        scopeKey: "workspace",
        sessionId: "session",
        clientRequestId: "manual",
      };
      expect(await f.scheduler.steerQueued(input)).toMatchObject({
        status: "steered",
      });
      expect(
        await f.scheduler.steerQueued({
          ...input,
          clientRequestId: "different",
        }),
      ).toMatchObject({ status: "not-steered", reason: "prompt-not-queued" });
      await expect(
        f.scheduler.steerQueued({ ...input, sessionId: "other" }),
      ).rejects.toThrow(/conflict/i);
    });

    it("queries durable candidates after closure without relying on runtime state", async () => {
      const f = await fixture();
      const accepted = await f.scheduler.accept(submit);
      const receipt = accepted.record.steerReceipt;
      if (!receipt) throw new Error("Missing steer receipt");
      expect(await f.inputs.listUnconsumedSteers("session")).toMatchObject([
        { inputId: receipt.inputId },
      ]);
      const changed: string[] = [];
      f.inputs.setStateChangeObserver((sessionId) => {
        changed.push(sessionId);
        throw new Error("observer");
      });
      await f.inputs.close("goal-run", "failed");
      expect(changed).toEqual(["session"]);
      const reader =
        backend === "sqlite"
          ? new DatabaseCurrentRunInputStore({ db: getDatabase() })
          : f.inputs;
      expect(await reader.listUnconsumedSteers("session")).toMatchObject([
        { inputId: receipt.inputId, closedAt: expect.any(Number) as unknown },
      ]);
      expect(await reader.listUnconsumedSteers("other")).toEqual([]);
    });

    it("keeps attempts as unconfirmed across run closure until local successful persistence is confirmed", async () => {
      const f = await fixture();
      const accepted = await f.scheduler.accept(submit);
      const receipt = accepted.record.steerReceipt;
      if (!receipt) throw new Error("Missing steer receipt");
      const inputId = receipt.inputId;
      await f.messages.createMessage({
        id: "assistant",
        role: "assistant",
        agent: "default",
        runId: "goal-run",
        sessionId: "session",
      });
      const request = {
        requestId: "request",
        runId: "goal-run",
        messageId: "assistant",
        step: 1,
        attempt: 1,
        purpose: "agent-step" as const,
        startedAt: 1,
        outcome: "running" as const,
        inputIds: [inputId],
      };
      await f.inputs.admitRequestAttempt(request);
      await f.inputs.close("goal-run", "interrupted");
      expect(await f.inputs.listUnconsumedSteers("session")).toMatchObject([
        { inputId, firstAttemptRequestId: "request" },
      ]);
      await f.messages.updateMessage("assistant", {
        modelRequests: [{ ...request, outcome: "success", endedAt: 2 }],
      });
      const changed: string[] = [];
      f.inputs.setStateChangeObserver((sessionId) => {
        changed.push(sessionId);
        throw new Error("observer");
      });
      expect(await f.inputs.confirmRequestSuccess("request")).toEqual([
        inputId,
      ]);
      expect(changed).toEqual(["session"]);
      expect(await f.inputs.listUnconsumedSteers("session")).toEqual([]);
    });

    it("manual success settles the waiter despite both projection callbacks throwing", async () => {
      const f = await fixture({
        resolveSteerTarget: undefined,
        onUpdated: () => {
          throw new Error("updated");
        },
        onSteered: () => {
          throw new Error("steered");
        },
        onProjectionError: () => {
          throw new Error("observer");
        },
      });
      const accepted = await f.scheduler.accept(submit);
      const waiter = f.scheduler.waitForCompletion(accepted.record.promptId);
      const result = await f.scheduler.steerQueued({
        promptId: accepted.record.promptId,
        expectedRunId: "goal-run",
        scopeKey: "workspace",
        sessionId: "session",
        clientRequestId: "manual",
      });
      expect(result.status).toBe("steered");
      expect(await waiter).toMatchObject({ status: "steered" });
    });

    it("persists repeated resend children and rejects changing their parent under an idempotency key", async () => {
      const f = await fixture();
      const original = await f.scheduler.accept(submit);
      const child = {
        ...submit,
        clientRequestId: "resend:one",
        resendOfPromptId: original.record.promptId,
      };
      const first = await f.scheduler.accept(child);
      const second = await f.scheduler.accept({
        ...child,
        clientRequestId: "resend:two",
      });
      expect(first.record.resendOfPromptId).toBe(original.record.promptId);
      expect(second.record.userMessageId).not.toBe(first.record.userMessageId);
      expect(
        (
          await f.queue.listResendChildren(
            "workspace",
            original.record.promptId,
          )
        ).map((prompt) => prompt.promptId),
      ).toEqual([first.record.promptId, second.record.promptId]);
      await expect(
        f.scheduler.accept({ ...child, resendOfPromptId: "another-parent" }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await expect(
        f.queue.accept({
          ...child,
          scopeKey: "workspace",
          promptId: "unused",
          userMessageId: "unused-message",
          maxQueuedPrompts: 1,
          resendOfPromptId: "another-parent",
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });
  });

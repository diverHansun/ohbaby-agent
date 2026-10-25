import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBus } from "../../bus/index.js";
import {
  createDatabaseMessageStore,
  createInMemoryMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import {
  createDatabaseRunLedger,
  createInMemoryRunLedger,
} from "../../runtime/run-ledger/index.js";
import {
  InMemoryPromptSubmissionStore,
  DatabasePromptSubmissionStore,
} from "../../runtime/prompt-scheduler/index.js";
import {
  DatabaseCurrentRunInputStore,
  InMemoryCurrentRunInputStore,
} from "../../runtime/prompt-scheduler/current-run-inputs.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { projectUnconsumedSteers } from "./steer-recovery.js";

const dirs: string[] = [];
afterEach(async () => {
  closeDatabase();
  await Promise.all(
    dirs
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
for (const backend of ["memory", "sqlite"] as const)
  describe(`${backend} durable steer recovery`, () => {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    async function fixture() {
      if (backend === "sqlite") {
        const directory = await mkdtemp(join(tmpdir(), "steer-recovery-"));
        dirs.push(directory);
        initDatabase({ dbPath: join(directory, "agent.db") });
        getDatabase()
          .prepare(
            "INSERT INTO session (id,project_id,working_directory,agent,title,status,created_at,updated_at,message_count,data) VALUES ('session','project','/repo','default','test','active',1,1,0,'{}')",
          )
          .run();
      }
      const runs =
        backend === "sqlite"
          ? createDatabaseRunLedger({ db: getDatabase() })
          : createInMemoryRunLedger();
      const prompts =
        backend === "sqlite"
          ? new DatabasePromptSubmissionStore({ db: getDatabase() })
          : new InMemoryPromptSubmissionStore();
      let messageTime = Date.now() + 1000;
      const messages = createMessageManager({
        now: () => ++messageTime,
        bus: createBus(),
        store:
          backend === "sqlite"
            ? createDatabaseMessageStore({ db: getDatabase() })
            : createInMemoryMessageStore(),
      });
      const inputs =
        backend === "sqlite"
          ? new DatabaseCurrentRunInputStore({ db: getDatabase() })
          : new InMemoryCurrentRunInputStore({
              runLedger: runs,
              promptStore: prompts as InMemoryPromptSubmissionStore,
              messageManager: messages,
            });
      await runs.createPending({
        runId: "old",
        sessionId: "session",
        triggerSource: "user",
      });
      await runs.markRunning("old");
      await prompts.accept({
        promptId: "original",
        userMessageId: "original-message",
        clientRequestId: "original",
        text: "Preserve this original detail",
        sessionId: "session",
        scopeKey: "workspace",
        maxQueuedPrompts: 100,
      });
      const steered = await inputs.steerQueued({
        promptId: "original",
        expectedRunId: "old",
        clientRequestId: "steer-original",
        sessionId: "session",
        scopeKey: "workspace",
      });
      if (steered.status !== "steered")
        throw new Error("Fixture did not steer");
      const options = {
        sessionId: "session",
        scopeKey: "workspace",
        inputs,
        prompts,
        runs,
        messages,
      };
      return { ...options, options, inputId: steered.receipt.inputId };
    }
    it.each(["completed", "failed", "interrupted", "process-interrupted"])(
      "projects %s closures independently of transcript pagination",
      async (reason) => {
        const f = await fixture();
        expect(await projectUnconsumedSteers(f.options)).toEqual([]);
        for (let index = 0; index < 55; index++)
          await f.messages.createMessage({
            id: `later-${String(index)}`,
            role: "user",
            agent: "default",
            sessionId: "session",
          });
        await f.inputs.close("old", reason);
        expect(
          (
            await f.messages.listPageBySession("session", { limit: 10 })
          ).messages.map((message) => message.info.id),
        ).not.toContain("original-message");
        expect(await projectUnconsumedSteers(f.options)).toEqual([
          {
            inputId: f.inputId,
            promptId: "original",
            messageId: "original-message",
            text: "Preserve this original detail",
            state: "unconsumed",
          },
        ]);
      },
    );
    it("keeps attempted input unconfirmed until the durable success marker", async () => {
      const f = await fixture();
      await f.messages.createMessage({
        id: "assistant",
        role: "assistant",
        agent: "default",
        runId: "old",
        sessionId: "session",
      });
      const request = {
        requestId: "attempt",
        runId: "old",
        messageId: "assistant",
        step: 1,
        attempt: 1,
        purpose: "agent-step" as const,
        startedAt: 1,
        outcome: "running" as const,
        inputIds: [f.inputId],
      };
      await f.inputs.admitRequestAttempt(request);
      await f.inputs.close("old", "failed");
      expect(await projectUnconsumedSteers(f.options)).toMatchObject([
        { state: "unconfirmed" },
      ]);
      await f.messages.updateMessage("assistant", {
        modelRequests: [{ ...request, outcome: "success", endedAt: 2 }],
      });
      await f.inputs.confirmRequestSuccess("attempt");
      expect(await projectUnconsumedSteers(f.options)).toEqual([]);
    });
    it.each([false, true])(
      "restores a failed ordinary resend only without successful request facts (%s)",
      async (success) => {
        const f = await fixture();
        await f.inputs.close("old", "failed");
        await f.runs.markFailed("old", new Error("old ended"));
        await f.prompts.accept({
          promptId: "child",
          userMessageId: "new-message",
          clientRequestId: "resend:operation",
          resendOfPromptId: "original",
          text: "Preserve this original detail",
          sessionId: "session",
          scopeKey: "workspace",
          maxQueuedPrompts: 100,
        });
        expect(await projectUnconsumedSteers(f.options)).toEqual([]);
        await f.prompts.claim("child");
        await f.runs.createPending({
          runId: "new",
          sessionId: "session",
          triggerSource: "user",
        });
        await f.runs.markRunning("new");
        await f.prompts.markRunning("child", "new");
        await f.messages.createMessage({
          id: "new-assistant",
          role: "assistant",
          agent: "default",
          runId: "new",
          sessionId: "session",
        });
        if (success)
          await f.messages.updateMessage("new-assistant", {
            modelRequests: [
              {
                requestId: "success",
                runId: "new",
                messageId: "new-assistant",
                step: 1,
                attempt: 1,
                purpose: "agent-step",
                startedAt: 1,
                outcome: "success",
                endedAt: 2,
              },
            ],
          });
        await f.runs.markFailed("new", new Error("later step failed"));
        await f.prompts.finish("child", {
          status: "failed",
          error: {
            code: "FAILED",
            message: "later failure",
            source: "runtime",
            retryable: false,
          },
        });
        expect(await projectUnconsumedSteers(f.options)).toHaveLength(
          success ? 0 : 1,
        );
      },
    );
    it("hands recovery to an unprocessed steered child without reviving its ancestors", async () => {
      const f = await fixture();
      await f.inputs.close("old", "failed");
      await f.runs.markFailed("old", new Error("old ended"));
      await f.runs.createPending({
        runId: "new",
        sessionId: "session",
        triggerSource: "user",
      });
      await f.runs.markRunning("new");
      await f.prompts.accept({
        promptId: "child",
        userMessageId: "child-message",
        clientRequestId: "resend:child",
        resendOfPromptId: "original",
        text: "Preserve this original detail",
        sessionId: "session",
        scopeKey: "workspace",
        maxQueuedPrompts: 100,
      });
      const steered = await f.inputs.steerQueued({
        promptId: "child",
        expectedRunId: "new",
        clientRequestId: "resend:child",
        sessionId: "session",
        scopeKey: "workspace",
      });
      if (steered.status !== "steered") throw new Error("Child did not steer");
      await f.messages.createMessage({
        id: "late-assistant",
        role: "assistant",
        agent: "default",
        runId: "new",
        sessionId: "session",
      });
      const request = {
        requestId: "late-success",
        runId: "new",
        messageId: "late-assistant",
        step: 1,
        attempt: 1,
        purpose: "agent-step" as const,
        startedAt: 1,
        outcome: "running" as const,
        inputIds: [steered.receipt.inputId],
      };
      await f.inputs.admitRequestAttempt(request);
      await f.inputs.close("new", "user-stop");
      expect(await projectUnconsumedSteers(f.options)).toMatchObject([
        { promptId: "child", inputId: steered.receipt.inputId },
      ]);
      await f.prompts.accept({
        promptId: "grandchild",
        userMessageId: "grandchild-message",
        clientRequestId: "resend:grandchild",
        resendOfPromptId: "child",
        text: "Preserve this original detail",
        sessionId: "session",
        scopeKey: "workspace",
        maxQueuedPrompts: 100,
      });
      expect(await projectUnconsumedSteers(f.options)).toEqual([]);
      await f.prompts.retainOwnedQueued("workspace");
      expect(await projectUnconsumedSteers(f.options)).toEqual([]);
      await f.prompts.cancelQueued("grandchild");
      expect(await projectUnconsumedSteers(f.options)).toMatchObject([
        { promptId: "child", inputId: steered.receipt.inputId },
      ]);
      await f.messages.updateMessage("late-assistant", {
        modelRequests: [{ ...request, outcome: "success", endedAt: 2 }],
      });
      await f.inputs.confirmRequestSuccess("late-success");
      expect(await projectUnconsumedSteers(f.options)).toEqual([]);
    });
    it("preserves two explicit resend branches and rejects a broken child recovery chain", async () => {
      const f = await fixture();
      await f.inputs.close("old", "failed");
      await f.runs.createPending({
        runId: "branches",
        sessionId: "session",
        triggerSource: "user",
      });
      await f.runs.markRunning("branches");
      for (const promptId of ["branch-1", "branch-2"]) {
        await f.prompts.accept({
          promptId,
          userMessageId: `${promptId}-message`,
          clientRequestId: `resend:${promptId}`,
          resendOfPromptId: "original",
          text: "Preserve this original detail",
          sessionId: "session",
          scopeKey: "workspace",
          maxQueuedPrompts: 100,
        });
        const result = await f.inputs.steerQueued({
          promptId,
          expectedRunId: "branches",
          clientRequestId: `resend:${promptId}`,
          sessionId: "session",
          scopeKey: "workspace",
        });
        expect(result.status).toBe("steered");
      }
      await f.inputs.close("branches", "failed");
      expect(
        (await projectUnconsumedSteers(f.options)).map(
          (input) => input.promptId,
        ),
      ).toEqual(["branch-1", "branch-2"]);
      await f.messages.removeMessage("branch-1-message");
      await expect(projectUnconsumedSteers(f.options)).rejects.toThrow(
        /missing|out of scope/,
      );
    });
    it("keeps a retained resend as the only recovery action until it is cancelled", async () => {
      const f = await fixture();
      await f.inputs.close("old", "failed");
      await f.prompts.accept({
        promptId: "child",
        userMessageId: "child-message",
        clientRequestId: "resend:retained-child",
        resendOfPromptId: "original",
        text: "Preserve this original detail",
        sessionId: "session",
        scopeKey: "workspace",
        maxQueuedPrompts: 100,
      });
      await f.prompts.retainOwnedQueued("workspace");
      expect((await f.prompts.get("child"))?.status).toBe("retained");
      expect(await projectUnconsumedSteers(f.options)).toEqual([]);
      const lease = await f.prompts.acquireEditLease("child", "editor", 30_000);
      const resubmitted = await f.prompts.resubmitRetained({
        promptId: "child",
        operationId: "retained-resubmit",
        editLeaseId: lease.editLeaseId,
        ownerClientId: "editor",
        scopeKey: "workspace",
        maxQueuedPrompts: 100,
        text: "Preserve this original detail",
      });
      expect(resubmitted.record.resendOfPromptId).toBe("original");
      expect(await projectUnconsumedSteers(f.options)).toEqual([]);
      await f.prompts.retainOwnedQueued("workspace");
      await f.prompts.cancelQueued("child");
      expect(await projectUnconsumedSteers(f.options)).toMatchObject([
        { promptId: "original", inputId: f.inputId },
      ]);
    });
    it("a terminal legacy run supplies missing input closure without rewriting the input", async () => {
      const f = await fixture();
      await f.runs.markFailed("old", new Error("legacy failure"));
      if (backend === "sqlite")
        getDatabase()
          .prepare(
            "UPDATE run_ledger SET inputs_closed_at=NULL, inputs_close_reason=NULL WHERE run_id='old'",
          )
          .run();
      const before = await f.inputs.getInput(f.inputId);
      if (backend === "sqlite") expect(before?.closedAt).toBeUndefined();
      expect(await projectUnconsumedSteers(f.options)).toHaveLength(1);
      expect(await f.inputs.getInput(f.inputId)).toEqual(before);
    });
    if (backend === "sqlite")
      it("reopens the original text and recovery facts after process restart", async () => {
        const f = await fixture();
        await f.inputs.close("old", "process-interrupted");
        await f.runs.markRunInterrupted("old", "process-interrupted");
        const directory = dirs.at(-1);
        if (!directory) throw new Error("Database fixture path missing");
        const path = join(directory, "agent.db");
        closeDatabase();
        initDatabase({ dbPath: path });
        expect(
          await projectUnconsumedSteers({
            sessionId: "session",
            scopeKey: "workspace",
            inputs: new DatabaseCurrentRunInputStore({ db: getDatabase() }),
            prompts: new DatabasePromptSubmissionStore({ db: getDatabase() }),
            runs: createDatabaseRunLedger({ db: getDatabase() }),
            messages: createMessageManager({
              bus: createBus(),
              store: createDatabaseMessageStore({ db: getDatabase() }),
            }),
          }),
        ).toMatchObject([
          { text: "Preserve this original detail", state: "unconsumed" },
        ]);
      });
  });

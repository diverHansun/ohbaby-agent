import { afterEach, describe, expect, it, vi } from "vitest";
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
  DatabaseCurrentRunInputStore,
  InMemoryCurrentRunInputStore,
} from "../../runtime/prompt-scheduler/current-run-inputs.js";
import { InMemoryPromptSubmissionStore } from "../../runtime/prompt-scheduler/in-memory-store.js";
import { createRunInputCoordinator } from "../../runtime/prompt-scheduler/run-input-coordinator.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import {
  DatabaseShellJobStore,
  InMemoryShellJobStore,
} from "../../tools/shell-job-store.js";
import { shellJobFixture } from "../../tools/fixtures/shell-job.js";
import { createBackgroundTaskInputSource } from "./background-task-inputs.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase();
});
describe.each(["memory", "sqlite"] as const)(
  "%s background result delivery",
  (backend) => {
    // Return types follow the selected real persistence implementation.
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    async function setup() {
      if (backend === "sqlite") {
        initDatabase({ dbPath: ":memory:" });
        getDatabase()
          .prepare(
            "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
          )
          .run();
      }
      const ledger =
        backend === "sqlite"
          ? createDatabaseRunLedger({ db: getDatabase() })
          : createInMemoryRunLedger();
      const messages = createMessageManager({
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
              runLedger: ledger,
              messageManager: messages,
              promptStore: new InMemoryPromptSubmissionStore(),
            });
      const jobs =
        backend === "sqlite"
          ? new DatabaseShellJobStore()
          : new InMemoryShellJobStore();
      const port = (runId: string, contextScopeId: string | null = null) =>
        createRunInputCoordinator({
          runId,
          inputs,
          sources: [
            createBackgroundTaskInputSource({
              store: jobs,
              inputs,
              identity: { sessionId: "s", contextScopeId, runId },
            }),
          ],
        });
      await ledger.createPending({
        runId: "one",
        sessionId: "s",
        triggerSource: "user",
      });
      await ledger.markRunning("one");
      await jobs.insert(
        shellJobFixture({
          status: "completed",
          resultReadyAt: 10,
          noticeState: "pending",
          outputTail: "original result",
          cleanup: "confirmed",
        }),
      );
      async function saveSuccess(
        runId: string,
        requestId: string,
      ): Promise<void> {
        const pending = await inputs.getMessages(runId);
        await messages.createMessage({
          id: requestId,
          sessionId: "s",
          runId,
          role: "assistant",
          agent: "default",
        });
        const request = {
          requestId,
          messageId: requestId,
          runId,
          purpose: "agent-step" as const,
          step: 1,
          attempt: 1,
          startedAt: 100,
          outcome: "running" as const,
          inputIds: pending.map(
            (message) => message.info.runtimeInput?.inputId ?? "",
          ),
        };
        await inputs.admitRequestAttempt(request);
        await messages.updateMessage(requestId, {
          modelRequests: [{ ...request, outcome: "success", endedAt: 101 }],
        });
      }
      return { ledger, messages, inputs, jobs, port, saveSuccess };
    }
    it("replays frozen unconsumed results and repairs success recorded before acknowledgement", async () => {
      const s = await setup();
      const first = await s.port("one").beforeStep();
      expect(first).toHaveLength(1);
      expect(await s.inputs.filterModelHistory(first)).toEqual([]);
      await s.inputs.close("one", "failed");
      await s.ledger.createPending({
        runId: "two",
        sessionId: "s",
        triggerSource: "user",
      });
      await s.ledger.markRunning("two");
      await s.jobs.update("job", { outputTail: "late changed result" });
      const second = await s.port("two").beforeStep();
      expect(second).toHaveLength(1);
      expect(second[0].info.runtimeInput?.sourceId).toBe(
        first[0].info.runtimeInput?.sourceId,
      );
      expect(second[0].parts).toEqual(
        first[0].parts.map((part) => ({
          ...part,
          messageId: second[0].info.id,
          id: second[0].info.id + ":text",
        })),
      );
      await s.saveSuccess("two", "request");
      // Simulate death after successful request persistence, before source confirmation.
      await s.inputs.close("two", "done");
      await s.ledger.createPending({
        runId: "three",
        sessionId: "s",
        triggerSource: "user",
      });
      await s.ledger.markRunning("three");
      expect(await s.port("three").beforeStep()).toEqual([]);
      expect(
        (await s.inputs.getInput(second[0].info.runtimeInput?.inputId ?? ""))
          ?.processedRequestId,
      ).toBe("request");
      expect(await s.inputs.filterModelHistory(second)).toHaveLength(1);
    });
    it("repairs a successfully consumed input whose batch projection never bound", async () => {
      const s = await setup();
      vi.spyOn(s.jobs, "bindNoticeBatch").mockRejectedValueOnce(
        new Error("before bind"),
      );
      await expect(s.port("one").beforeStep()).rejects.toThrow("before bind");
      await s.saveSuccess("one", "request");
      await s.inputs.confirmRequestSuccess("request");
      expect(s.jobs.get("job")?.noticeInputId).toBeNull();
      await s.inputs.close("one", "done");
      await s.ledger.createPending({
        runId: "later",
        sessionId: "s",
        triggerSource: "user",
      });
      await s.ledger.markRunning("later");
      expect(await s.port("later").beforeStep()).toEqual([]);
      const input = (await s.inputs.listByRun("one"))[0];
      expect(s.jobs.get("job")).toMatchObject({
        noticeState: "accepted",
        noticeInputId: input.inputId,
      });
      if (backend === "sqlite")
        expect(
          s.jobs.listNoticeBatches({ sessionId: "s", contextScopeId: null }),
        ).toEqual([]);
    });
    it.runIf(backend === "sqlite")(
      "keeps a wake claim when a foreign run accepted before batch binding",
      async () => {
        const s = await setup();
        const batch = await s.jobs.allocateNoticeBatch({
          sessionId: "s",
          contextScopeId: null,
        });
        if (!batch) throw new Error("Missing batch");
        expect(await s.jobs.claimNoticeWake(batch, "rejected-wake", null)).toBe(
          true,
        );
        vi.spyOn(s.jobs, "bindNoticeBatch").mockRejectedValueOnce(
          new Error("binding unavailable"),
        );
        await expect(s.port("one").beforeStep()).rejects.toThrow(
          "binding unavailable",
        );
        expect(s.jobs.get("job")?.noticeInputId).toBeNull();
        expect(
          await s.inputs.listBySource("s", `background-task:${batch}`),
        ).toHaveLength(1);
        expect(
          await s.jobs.releaseUnstartedNoticeWake(batch, "rejected-wake"),
        ).toBe(false);
        await s.inputs.close("one", "failed");
        expect(
          await s.jobs.releaseUnstartedNoticeWake(batch, "rejected-wake"),
        ).toBe(false);
        expect(s.jobs.get("job")?.noticeWakeRunId).toBe("rejected-wake");
      },
    );
    it.runIf(backend === "sqlite")(
      "rejects wake admission when actual input acceptance wins before its transaction",
      async () => {
        const s = await setup();
        const batch = await s.jobs.allocateNoticeBatch({
          sessionId: "s",
          contextScopeId: null,
        });
        if (!batch) throw new Error("Missing batch");
        vi.spyOn(s.jobs, "bindNoticeBatch").mockRejectedValueOnce(
          new Error("before bind"),
        );
        await expect(s.port("one").beforeStep()).rejects.toThrow("before bind");
        expect(s.jobs.get("job")?.noticeInputId).toBeNull();
        expect(await s.jobs.claimNoticeWake(batch, "late-wake", null)).toBe(
          false,
        );
        await s.inputs.close("one", "failed");
        expect(await s.jobs.claimNoticeWake(batch, "late-wake", null)).toBe(
          false,
        );
        expect(s.jobs.get("job")?.noticeWakeRunId).toBeNull();
      },
    );
    it("recovers acceptance-before-binding without a duplicate message", async () => {
      const s = await setup();
      const spy = vi
        .spyOn(s.jobs, "bindNoticeBatch")
        .mockRejectedValueOnce(new Error("binding unavailable"));
      await expect(s.port("one").beforeStep()).rejects.toThrow(
        "binding unavailable",
      );
      expect(await s.inputs.listByRun("one")).toHaveLength(1);
      expect(await s.port("one").beforeStep()).toHaveLength(1);
      expect(await s.inputs.listByRun("one")).toHaveLength(1);
      expect(s.jobs.get("job")?.noticeState).toBe("accepted");
      spy.mockRestore();
    });
    it("admits one new batch, preserves finish barriers, and seals shared input only once", async () => {
      const s = await setup();
      for (let i = 0; i < 20; i++)
        await s.jobs.insert(
          shellJobFixture({
            jobId: `extra-${String(i)}`,
            status: "completed",
            resultReadyAt: 20,
            noticeState: "pending",
          }),
        );
      const reconcile = vi.fn(() => Promise.resolve());
      const seal = vi.spyOn(s.inputs, "sealSteer");
      const port = createRunInputCoordinator({
        runId: "one",
        inputs: s.inputs,
        sources: [
          { reconcile },
          createBackgroundTaskInputSource({
            store: s.jobs,
            inputs: s.inputs,
            identity: { sessionId: "s", contextScopeId: null, runId: "one" },
          }),
        ],
      });
      expect(await port.beforeStep(undefined, true)).toHaveLength(1);
      expect(seal).toHaveBeenCalledTimes(1);
      expect(await port.beforeFinish()).toBe("continue");
      expect(await s.inputs.listByRun("one")).toHaveLength(1);
      await s.saveSuccess("one", "request");
      await port.confirmRequestSuccess("request");
      expect(await port.beforeStep()).toHaveLength(1);
      expect(await s.inputs.listByRun("one")).toHaveLength(2);
      expect(reconcile).toHaveBeenCalledTimes(3);
    });
    it("does not deliver another child execution's retained result", async () => {
      const s = await setup();
      await s.jobs.update("job", {
        contextScopeId: "child",
        rootRunId: "old-child-run",
      });
      expect(await s.port("one", "child").beforeStep()).toEqual([]);
      expect(s.jobs.get("job")?.noticeState).toBe("pending");
    });
  },
);

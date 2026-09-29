import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { DatabasePromptSubmissionStore } from "./database-store.js";
import { InMemoryPromptSubmissionStore } from "./in-memory-store.js";
import type { PromptSubmissionRecord, PromptSubmissionStore } from "./types.js";

for (const kind of ["memory", "sqlite"] as const) {
  describe(`${kind} retained prompt admission`, () => {
    let directory: string;
    let now: number;
    let store: PromptSubmissionStore;
    beforeEach(async () => {
      now = 100;
      directory = await mkdtemp(join(tmpdir(), "retained-prompt-"));
      if (kind === "sqlite") {
        initDatabase({ dbPath: join(directory, "fixture.db") });
        getDatabase()
          .prepare(
            "INSERT INTO session(id,project_id,project_root,title,status,created_at,updated_at,data) VALUES('s','p','/w','test','active',1,1,'{}')",
          )
          .run();
      }
      const options = {
        ownerId: "owner",
        ownerPid: process.pid,
        now: (): number => now,
        isOwnerAlive: (pid: number): boolean => pid === process.pid,
      };
      store =
        kind === "sqlite"
          ? new DatabasePromptSubmissionStore(options)
          : new InMemoryPromptSubmissionStore(options);
    });
    afterEach(async () => {
      closeDatabase();
      await rm(directory, { recursive: true, force: true });
    });
    const accept = (
      id: string,
      maxQueuedPrompts = 100,
    ): ReturnType<PromptSubmissionStore["accept"]> =>
      store.accept({
        promptId: id,
        clientRequestId: id,
        scopeKey: "/w",
        sessionId: "s",
        userMessageId: `m-${id}`,
        text: id,
        maxQueuedPrompts,
      });
    const replace = (record: PromptSubmissionRecord): void => {
      if (store instanceof InMemoryPromptSubmissionStore)
        store.runtimeInputMemory.put(record);
      else
        getDatabase()
          .prepare(
            "UPDATE prompt_submission SET owner_id=?,owner_pid=? WHERE prompt_id=?",
          )
          .run(
            record.ownerId ?? null,
            record.ownerPid ?? null,
            record.promptId,
          );
    };

    it("recovers the original admission title from a cancelled row in only its own session and scope", async () => {
      await store.accept({
        promptId: "original-title",
        clientRequestId: "original-title",
        scopeKey: "/w",
        sessionId: "s",
        userMessageId: "original-title-message",
        text: "Original task",
        titleExpected: "Original task",
        maxQueuedPrompts: 100,
      });
      await store.cancelQueued("original-title");
      await accept("next");
      expect(await store.getSessionTitleExpected("/w", "s")).toBe(
        "Original task",
      );
      expect(
        await store.getSessionTitleExpected("/other", "s"),
      ).toBeUndefined();
      expect(
        await store.getSessionTitleExpected("/w", "another-session"),
      ).toBeUndefined();
    });

    it("invalidates naming source on changed retained resubmission without changing its receipt on replay", async () => {
      await store.accept({
        promptId: "edited",
        clientRequestId: "edited",
        scopeKey: "/w",
        sessionId: "s",
        userMessageId: "edited-message",
        text: "skill body",
        namingSource: { skillName: "review", request: "Old task" },
        maxQueuedPrompts: 100,
      });
      await store.retainOwnedQueued();
      const lease = await store.acquireEditLease("edited", "client", 1000);
      const input = {
        scopeKey: "/w",
        promptId: "edited",
        operationId: "edited-resend",
        editLeaseId: lease.editLeaseId,
        ownerClientId: "client",
        text: "New task",
        maxQueuedPrompts: 100,
      };
      const result = await store.resubmitRetained(input);
      expect(result.record.namingSource).toBeUndefined();
      expect((await store.resubmitRetained(input)).receipt).toEqual(
        result.receipt,
      );
      expect((await accept("plain")).record.namingSource).toBeUndefined();
    });

    it("keeps naming facts through replay and restart, but invalidates changed text", async () => {
      const namingSource = {
        skillName: "using-superpowers",
        request: "Fix switching",
      };
      const input = {
        promptId: "named",
        clientRequestId: "named",
        scopeKey: "/w",
        sessionId: "s",
        userMessageId: "m-named",
        text: "expanded skill",
        namingSource,
        maxQueuedPrompts: 100,
      };
      await store.accept(input);
      expect(
        (
          await store.accept({
            ...input,
            namingSource: { ...namingSource, request: "Wrong replay" },
          })
        ).record.namingSource,
      ).toEqual(namingSource);
      await store.retainOwnedQueued();
      if (kind === "sqlite") {
        closeDatabase();
        initDatabase({ dbPath: join(directory, "fixture.db") });
        store = new DatabasePromptSubmissionStore({
          ownerId: "owner",
          ownerPid: process.pid,
          now: (): number => now,
        });
      }
      expect(await store.listQueued("/w")).toEqual([]);
      const lease = await store.acquireEditLease("named", "client", 1000);
      const resent = await store.resubmitRetained({
        scopeKey: "/w",
        promptId: "named",
        operationId: "resend",
        editLeaseId: lease.editLeaseId,
        ownerClientId: "client",
        text: input.text,
        maxQueuedPrompts: 100,
      });
      expect(resent.record.namingSource).toEqual(namingSource);
      const edit = await store.acquireEditLease("named", "client", 1000);
      expect(
        (
          await store.commitEdit(
            "named",
            edit.editLeaseId,
            "New task",
            "client",
          )
        ).namingSource,
      ).toBeUndefined();
      await store.retainOwnedQueued();
      const second = await store.acquireEditLease("named", "client", 1000);
      const changed = await store.resubmitRetained({
        scopeKey: "/w",
        promptId: "named",
        operationId: "resend-changed",
        editLeaseId: second.editLeaseId,
        ownerClientId: "client",
        text: "Yet another task",
        maxQueuedPrompts: 100,
      });
      expect(changed.record.namingSource).toBeUndefined();
    });

    it("persists owner at acceptance and never claims another owner's head", async () => {
      const foreign = (await accept("a")).record;
      expect(foreign).toMatchObject({
        ownerId: "owner",
        ownerPid: process.pid,
        acceptedAt: foreign.createdAt,
      });
      replace({ ...foreign, ownerId: "another" });
      await accept("b");
      expect((await store.listQueued("/w")).map((p) => p.promptId)).toEqual([
        "b",
      ]);
      expect(await store.claim("a")).toBeNull();
      await store.claim("b");
      expect(await store.requeueBusy("b")).toMatchObject({
        ownerId: "owner",
        ownerPid: process.pid,
      });
    });

    it("retains only its queued records and resubmits one after newer admissions in the same millisecond", async () => {
      const original = (await accept("b")).record;
      const foreign = (await accept("c")).record;
      replace({ ...foreign, ownerId: "another" });
      expect(await store.retainOwnedQueued()).toBe(1);
      expect(await store.get("b")).toMatchObject({ status: "retained" });
      expect((await store.get("b"))?.endedAt).toBeUndefined();
      expect((await store.get("c"))?.status).toBe("queued");
      await accept("d");
      const lease = await store.acquireEditLease("b", "client", 1000);
      const input = {
        scopeKey: "/w",
        promptId: "b",
        operationId: "resend-b",
        editLeaseId: lease.editLeaseId,
        ownerClientId: "client",
        text: "edited",
        maxQueuedPrompts: 10,
      };
      const sent = await store.resubmitRetained(input);
      expect(sent.record).toMatchObject({
        promptId: "b",
        userMessageId: "m-b",
        createdAt: original.createdAt,
        status: "queued",
        text: "edited",
        ownerId: "owner",
      });
      expect((await store.listQueued("/w")).map((p) => p.promptId)).toEqual([
        "d",
        "b",
      ]);
      const again = await store.resubmitRetained({
        ...input,
        maxQueuedPrompts: 1,
      });
      expect(again.inserted).toBe(false);
      expect(again.receipt).toEqual(sent.receipt);
      await expect(
        store.resubmitRetained({ ...input, text: "different" }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(await store.getResubmissionReceipt("/w", "resend-b")).toEqual(
        sent.receipt,
      );
    });

    it("keeps retained text and owner when capacity or lease validation rejects", async () => {
      await accept("b");
      await store.retainOwnedQueued();
      const lease = await store.acquireEditLease("b", "client", 1000);
      await accept("d", 1);
      const input = {
        scopeKey: "/w",
        promptId: "b",
        operationId: "resend",
        editLeaseId: lease.editLeaseId,
        ownerClientId: "client",
        text: "draft",
        maxQueuedPrompts: 1,
      };
      await expect(store.resubmitRetained(input)).rejects.toMatchObject({
        code: "QUEUE_FULL",
      });
      expect(await store.get("b")).toMatchObject({
        status: "retained",
        text: "b",
        editLeaseId: lease.editLeaseId,
      });
      await store.cancelQueued("d");
      now = 1200;
      await expect(store.resubmitRetained(input)).rejects.toMatchObject({
        code: "PROMPT_EDIT_LEASE_LOST",
      });
      expect(
        await store.getResubmissionReceipt("/w", "resend"),
      ).toBeUndefined();
    });

    it("arbitrates new acceptance and resubmit against the final queue slot", async () => {
      await accept("b");
      await store.retainOwnedQueued();
      const lease = await store.acquireEditLease("b", "client", 1000);
      const results = await Promise.allSettled([
        accept("d", 1),
        store.resubmitRetained({
          scopeKey: "/w",
          promptId: "b",
          operationId: "r",
          editLeaseId: lease.editLeaseId,
          ownerClientId: "client",
          text: "b",
          maxQueuedPrompts: 1,
        }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await store.listQueued("/w")).toHaveLength(1);
    });

    it("preserves old operation receipts across repeated retain and resubmit cycles", async () => {
      await accept("b");
      await store.retainOwnedQueued();
      const lease = await store.acquireEditLease("b", "client", 1000);
      const firstInput = {
        scopeKey: "/w",
        promptId: "b",
        operationId: "first",
        editLeaseId: lease.editLeaseId,
        ownerClientId: "client",
        text: "one",
        maxQueuedPrompts: 1,
      };
      const first = await store.resubmitRetained(firstInput);
      await store.retainOwnedQueued();
      const nextLease = await store.acquireEditLease("b", "client", 1000);
      await store.resubmitRetained({
        ...firstInput,
        operationId: "second",
        editLeaseId: nextLease.editLeaseId,
        text: "two",
      });
      expect((await store.resubmitRetained(firstInput)).receipt).toEqual(
        first.receipt,
      );
      expect((await store.get("b"))?.text).toBe("two");
    });

    it.each(
      kind === "memory"
        ? [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
        : [0, -1, 1.5, NaN, Infinity],
    )(
      "preserves invalid owner PID %s until explicitly allowed offline",
      async (ownerPid) => {
        const queued = (await accept("invalid")).record;
        replace({ ...queued, ownerId: "unknown", ownerPid });
        expect(await store.recoverAllInterrupted()).toBe(0);
        expect((await store.get("invalid"))?.status).toBe("queued");
        expect(
          await store.recoverAllInterrupted({ recoverUnknownOwner: true }),
        ).toBe(1);
        expect((await store.get("invalid"))?.status).toBe("retained");
      },
    );

    it("cold recovery preserves live and unknown owners and closes only dead records", async () => {
      const dead = (await accept("dead")).record;
      const active = (await accept("active")).record;
      const unknown = (await accept("unknown")).record;
      await store.claim("active");
      replace({ ...dead, ownerId: "dead", ownerPid: process.pid + 1 });
      replace({
        ...active,
        status: "starting",
        ownerId: "dead",
        ownerPid: process.pid + 1,
      });
      replace({ ...unknown, ownerId: undefined, ownerPid: undefined });
      await accept("live");
      expect(await store.recoverAllInterrupted()).toBe(2);
      expect(await store.get("dead")).toMatchObject({ status: "retained" });
      expect(await store.get("active")).toMatchObject({
        status: "interrupted",
        endTimeSource: "recovery",
      });
      expect((await store.get("unknown"))?.status).toBe("queued");
      expect((await store.get("live"))?.status).toBe("queued");
      expect(await store.recoverAllInterrupted()).toBe(0);
    });

    it("scope-only recovery preserves this owner and another live owner in the same process", async () => {
      await accept("own");
      await store.claim("own");
      const foreign = (await accept("foreign")).record;
      replace({ ...foreign, ownerId: "other-live" });
      expect(await store.recoverInterrupted("/w")).toBe(0);
      expect((await store.get("own"))?.status).toBe("starting");
      expect((await store.get("foreign"))?.status).toBe("queued");
    });

    it("ordinary queued edits preserve admission owner and order", async () => {
      const first = (await accept("a")).record;
      await accept("b");
      const lease = await store.acquireEditLease("a", "client", 1000);
      now = 500;
      const edited = await store.commitEdit(
        "a",
        lease.editLeaseId,
        "edited",
        "client",
      );
      expect(edited).toMatchObject({
        ownerId: first.ownerId,
        ownerPid: first.ownerPid,
        acceptedAt: first.acceptedAt,
        admissionOrder: first.admissionOrder,
      });
      expect((await store.listQueued("/w")).map((p) => p.promptId)).toEqual([
        "a",
        "b",
      ]);
    });

    it("terminal retry preserves the first end time and result", async () => {
      await accept("b");
      await store.claim("b");
      await store.markRunning("b", "run");
      await store.finish("b", {
        status: "interrupted",
        expectedRunId: "run",
        endedAt: 110,
        error: {
          code: "USER_STOP",
          message: "Stopped",
          source: "runtime",
          retryable: false,
        },
      });
      now = 999;
      expect(
        await store.finish("b", { status: "succeeded", expectedRunId: "run" }),
      ).toMatchObject({ status: "interrupted", endedAt: 110 });
      await expect(
        store.finish("b", { status: "succeeded", expectedRunId: "other" }),
      ).rejects.toMatchObject({ code: "PROMPT_VERSION_CONFLICT" });
    });
  });
}

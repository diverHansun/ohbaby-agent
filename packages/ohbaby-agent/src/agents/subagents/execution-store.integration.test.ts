import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import {
  DatabaseSubagentExecutionStore,
  InMemorySubagentExecutionStore,
  type AcceptSubagentExecution,
  type SubagentExecutionStore,
} from "./execution-store.js";

const directories: string[] = [];
afterEach(async () => {
  closeDatabase();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function database(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "execution-ledger-"));
  directories.push(dir);
  const path = join(dir, "agent.db");
  initDatabase({ dbPath: path });
  return path;
}
const input = (
  overrides: Partial<AcceptSubagentExecution> = {},
): AcceptSubagentExecution => ({
  executionId: "exec-1",
  requestId: "call-1",
  parentSessionId: "parent",
  requesterScopeId: "main",
  requesterRunId: "request-run",
  rootSessionId: "parent",
  rootRunId: "root-run",
  subagentId: "agent",
  mode: "background",
  prompt: "do work",
  timeoutMs: 1000,
  createdAt: 1,
  ...overrides,
});
const lookup = {
  executionId: "exec-1",
  parentSessionId: "parent",
  requesterScopeId: "main",
};
for (const backend of ["memory", "sqlite"] as const)
  describe(`${backend} execution ledger`, () => {
    async function store(): Promise<SubagentExecutionStore> {
      if (backend === "memory") return new InMemorySubagentExecutionStore();
      await database();
      return new DatabaseSubagentExecutionStore({ db: getDatabase() });
    }
    it("accepts before child creation and preserves original receipt across retries and identity conflicts", async () => {
      const s = await store();
      const accepted = await s.accept(input());
      expect(accepted).toMatchObject({
        created: true,
        record: { executionId: "exec-1", status: "queued" },
      });
      expect(accepted.record.childSessionId).toBeUndefined();
      expect(
        await s.accept(input({ executionId: "retry-id", createdAt: 99 })),
      ).toEqual({ created: false, record: accepted.record });
      await expect(s.accept(input({ prompt: "different" }))).rejects.toThrow(
        /conflict/i,
      );
      await expect(s.accept(input({ requestId: "other" }))).rejects.toThrow(
        /conflict/i,
      );
      await s.accept(
        input({ executionId: "exec-2", requestId: "call-2", createdAt: 2 }),
      );
      expect(
        await s.list({ parentSessionId: "parent", subagentId: "agent" }),
      ).toHaveLength(2);
      expect(await s.get({ ...lookup, parentSessionId: "foreign" })).toBeNull();
      expect(
        await s.get({ ...lookup, requesterScopeId: "foreign" }),
      ).toBeNull();
    });
    it("binds identity once, claims terminal once, retains full output through artifact failure and records delivery separately", async () => {
      const s = await store();
      await s.accept(input());
      await expect(s.start(lookup, "run-1", 2)).rejects.toThrow();
      await s.bindChild(
        lookup,
        { sessionId: "child", contextScopeId: "child-scope" },
        2,
      );
      await s.bindChild(
        lookup,
        { sessionId: "child", contextScopeId: "child-scope" },
        3,
      );
      await expect(
        s.bindChild(
          lookup,
          { sessionId: "other", contextScopeId: "child-scope" },
          3,
        ),
      ).rejects.toThrow(/conflict/i);
      await s.start(lookup, "run-1", 4);
      await s.start(lookup, "run-1", 5);
      await expect(s.start(lookup, "run-2", 5)).rejects.toThrow(/conflict/i);
      const output = "完整 output".repeat(10000);
      const results = await Promise.all([
        s.finish(lookup, { status: "completed", output, completedAt: 6 }),
        s.finish(lookup, { status: "failed", error: "late", completedAt: 7 }),
      ]);
      expect(results.map((r) => r.claimed)).toEqual([true, false]);
      await s.updateArtifact(lookup, { state: "preparing" }, 8);
      await s.updateArtifact(lookup, { state: "error", error: "disk full" }, 9);
      expect(await s.get(lookup)).toMatchObject({
        status: "completed",
        output,
        delivery: {
          state: "pending",
          notificationId: "subagent-result:exec-1",
        },
        artifact: { state: "error", error: "disk full" },
      });
      await expect(s.markProcessed(lookup, "processed", 10)).rejects.toThrow();
      await s.markDelivered(lookup, "input-1", 11);
      await s.markDelivered(lookup, "input-1", 12);
      expect((await s.get(lookup))?.delivery).toMatchObject({
        state: "delivered",
        inputId: "input-1",
      });
      expect(
        (await s.get(lookup))?.delivery.processedRequestId,
      ).toBeUndefined();
      await expect(s.markDelivered(lookup, "input-2", 12)).rejects.toThrow(
        /conflict/i,
      );
      await s.markProcessed(lookup, "processed-1", 13);
      await s.markProcessed(lookup, "processed-1", 14);
      await expect(s.markProcessed(lookup, "processed-2", 14)).rejects.toThrow(
        /conflict/i,
      );
    });
    it("interrupts only unfinished root executions and prevents child creation or start after cancellation", async () => {
      const s = await store();
      await s.accept(input());
      await s.accept(input({ executionId: "done", requestId: "done" }));
      await s.finish(
        { ...lookup, executionId: "done" },
        { status: "completed", output: "done", completedAt: 2 },
      );
      await s.accept(
        input({
          executionId: "other",
          requestId: "other",
          rootRunId: "other-root",
        }),
      );
      expect(
        (await s.interruptRoot("root-run", "user stop", 3)).map(
          (r) => r.executionId,
        ),
      ).toEqual(["exec-1"]);
      await expect(
        s.bindChild(lookup, { sessionId: "child", contextScopeId: "scope" }, 4),
      ).rejects.toThrow(/terminal/i);
      await expect(s.start(lookup, "run", 4)).rejects.toThrow(/terminal/i);
      await s.finish(lookup, {
        status: "interrupted",
        reason: "user stop",
        completedAt: 3,
      });
      expect(
        await s.finish(lookup, {
          status: "completed",
          output: "late success",
          completedAt: 5,
        }),
      ).toMatchObject({
        claimed: false,
        record: {
          status: "interrupted",
          reason: "user stop",
          lateResult: { status: "completed", output: "late success" },
        },
      });
      expect((await s.get({ ...lookup, executionId: "done" }))?.status).toBe(
        "completed",
      );
      expect((await s.get({ ...lookup, executionId: "other" }))?.status).toBe(
        "queued",
      );
      expect(
        await s.list({ parentSessionId: "parent", rootRunId: "other-root" }),
      ).toHaveLength(1);
      await s.accept(
        input({
          executionId: "nested",
          requestId: "nested",
          parentSessionId: "child-requester",
          requesterRunId: "nested-run",
        }),
      );
      expect(
        (await s.listByRootRun("root-run")).map((r) => r.executionId).sort(),
      ).toEqual(["done", "exec-1", "nested"]);
    });
    it("keeps foreground results out of background delivery and paginates scoped history", async () => {
      const s = await store();
      await s.accept(input({ mode: "foreground" }));
      await s.finish(lookup, {
        status: "completed",
        output: "foreground",
        completedAt: 3,
      });
      expect((await s.get(lookup))?.delivery).toEqual({ state: "foreground" });
      await expect(s.markDelivered(lookup, "unexpected", 4)).rejects.toThrow();
      await s.accept(
        input({ executionId: "exec-2", requestId: "call-2", createdAt: 2 }),
      );
      await s.accept(
        input({
          executionId: "foreign",
          requestId: "foreign",
          requesterScopeId: "other",
          createdAt: 3,
        }),
      );
      const page = await s.list({
        parentSessionId: "parent",
        requesterScopeId: "main",
        limit: 1,
      });
      expect(page.map((r) => r.executionId)).toEqual(["exec-2"]);
      const next = await s.list({
        parentSessionId: "parent",
        requesterScopeId: "main",
        limit: 1,
        before: {
          createdAt: page[0].createdAt,
          executionId: page[0].executionId,
        },
      });
      expect(next.map((r) => r.executionId)).toEqual(["exec-1"]);
      await expect(
        s.list({ parentSessionId: "parent", limit: 0 }),
      ).rejects.toThrow();
    });
  });
it("reopens SQLite with full terminal result, pending intent and explicit accepted identity intact", async () => {
  const path = await database();
  const s = new DatabaseSubagentExecutionStore({ db: getDatabase() });
  await s.accept(input());
  await s.finish(lookup, {
    status: "failed",
    output: "full original",
    error: "failure",
    completedAt: 4,
  });
  await s.updateArtifact(
    lookup,
    { state: "ready", path: "/artifacts/result.txt", sizeBytes: 13 },
    5,
  );
  closeDatabase();
  initDatabase({ dbPath: path });
  const reopened = new DatabaseSubagentExecutionStore({ db: getDatabase() });
  expect(await reopened.get(lookup)).toMatchObject({
    executionId: "exec-1",
    requesterRunId: "request-run",
    rootRunId: "root-run",
    output: "full original",
    error: "failure",
    artifact: { state: "ready", path: "/artifacts/result.txt", sizeBytes: 13 },
    delivery: { state: "pending" },
  });
  expect((await reopened.accept(input({ executionId: "retry" }))).created).toBe(
    false,
  );
});

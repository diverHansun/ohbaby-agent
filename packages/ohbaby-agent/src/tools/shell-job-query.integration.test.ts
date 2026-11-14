import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../services/database/index.js";
import {
  DatabaseShellJobStore,
  InMemoryShellJobStore,
} from "./shell-job-store.js";
import { shellJobFixture } from "./fixtures/shell-job.js";
import { ShellJobRegistry } from "./shell-job-registry.js";
import { SHELL_JOB_STATUSES } from "./shell-job-query.js";

afterEach(closeDatabase);
describe.each(["memory", "sqlite"] as const)(
  "%s shell job pages",
  (backend) => {
    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    async function setup() {
      if (backend === "sqlite") {
        initDatabase({ dbPath: ":memory:" });
        for (const id of ["s", "child-session", "side"])
          getDatabase()
            .prepare(
              "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES(?,'p','/tmp','test','active',1,1,'{}')",
            )
            .run(id);
      }
      const store =
        backend === "sqlite"
          ? new DatabaseShellJobStore()
          : new InMemoryShellJobStore();
      await store.insert(
        shellJobFixture({
          jobId: "active-old",
          createdAt: 1,
          startedAt: 1,
          command: "Build Watch",
        }),
      );
      await store.insert(
        shellJobFixture({
          jobId: "done-new",
          createdAt: 20,
          endedAt: 30,
          status: "completed",
          cleanup: "confirmed",
          settledAt: 31,
          command: "build once",
        }),
      );
      await store.insert(
        shellJobFixture({
          jobId: "child",
          sessionId: "child-session",
          contextScopeId: "child",
          createdAt: 5,
          startedAt: 5,
          command: "build child",
        }),
      );
      await store.insert(
        shellJobFixture({
          jobId: "other-root",
          sessionId: "side",
          rootSessionId: "side",
          createdAt: 50,
        }),
      );
      await store.insert(
        shellJobFixture({
          jobId: "normal-foreground",
          mode: "foreground",
          createdAt: 60,
          status: "completed",
          cleanup: "confirmed",
          settledAt: 62,
        }),
      );
      await store.insert(
        shellJobFixture({
          jobId: "abnormal-foreground",
          mode: "foreground",
          createdAt: 2,
          endedAt: 3,
          status: "cancelled",
          cleanup: "unconfirmed",
          settledAt: null,
        }),
      );
      await store.insert(
        shellJobFixture({
          jobId: "starting",
          createdAt: 80,
          status: null,
          startedAt: null,
          pid: null,
          cleanup: null,
        }),
      );
      return store;
    }
    it("prioritizes responsibility, isolates the root, and pages without exposing startup placeholders", async () => {
      const store = await setup();
      const first = store.query({
        scope: { rootSessionId: "s" },
        limit: 2,
      });
      expect(first.rows.map((row) => row.jobId)).toEqual([
        "child",
        "abnormal-foreground",
      ]);
      expect(first).toMatchObject({
        hasMore: true,
        pendingStartCount: 1,
        filteredCount: 4,
        unconfirmedCount: 1,
        statusCounts: {
          running: 2,
          completed: 1,
          cancelled: 1,
          failed: 0,
          timed_out: 0,
          lost: 0,
        },
      });
      const second = store.query({
        scope: { rootSessionId: "s" },
        limit: 2,
        before: first.next,
      });
      expect(second.rows.map((row) => row.jobId)).toEqual([
        "active-old",
        "done-new",
      ]);
      expect(second.hasMore).toBe(false);
      expect(second.filteredCount).toBe(4);
    });
    it("keeps status and owner filters honest and lowers abandoned cleanup priority", async () => {
      const store = await setup();
      expect(
        store
          .query({
            scope: { rootSessionId: "s" },
            owner: { kind: "main" },
            limit: 20,
          })
          .rows.map((row) => row.jobId),
      ).not.toContain("child");
      const filtered = store.query({
        scope: { rootSessionId: "s" },
        owner: { kind: "main" },
        statuses: ["completed"],
        limit: 20,
      });
      expect(filtered.rows.map((row) => row.jobId)).toEqual(["done-new"]);
      expect(filtered.statusCounts.running).toBe(1);
      const active = store.query({
        scope: { rootSessionId: "s" },
        limit: 20,
      });
      expect(active.rows.map((row) => row.jobId)).toContain(
        "abnormal-foreground",
      );
      await store.update("abnormal-foreground", { trackingReleasedAt: 100 });
      expect(
        store
          .query({
            scope: { rootSessionId: "s" },
            limit: 20,
          })
          .rows.map((row) => row.jobId),
      ).toEqual(["child", "active-old", "done-new", "abnormal-foreground"]);
      expect(
        store
          .query({
            scope: { rootSessionId: "s" },
            statuses: ["cancelled"],
            limit: 20,
          })
          .rows.map((row) => row.jobId),
      ).toContain("abnormal-foreground");
    });
    it("reaches every task beyond the largest page and rejects unbounded page sizes", async () => {
      const store = await setup();
      for (let index = 0; index < 101; index++)
        await store.insert(
          shellJobFixture({
            jobId: `bulk-${String(index).padStart(3, "0")}`,
            sessionId: "side",
            rootSessionId: "side",
            createdAt: 1000 + index,
            startedAt: 1000 + index,
          }),
        );
      const first = store.query({
        scope: { rootSessionId: "side" },
        limit: 100,
      });
      expect(first.rows).toHaveLength(100);
      expect(first).toMatchObject({ hasMore: true, filteredCount: 102 });
      const second = store.query({
        scope: { rootSessionId: "side" },
        limit: 100,
        before: first.next,
      });
      expect(second.hasMore).toBe(false);
      const seen = new Set(
        [...first.rows, ...second.rows].map((row) => row.jobId),
      );
      expect(seen.size).toBe(102);
      expect(seen).toContain("bulk-000");
      expect(() =>
        store.query({
          scope: { rootSessionId: "s" },
          limit: 101,
        }),
      ).toThrow();
    });
    it("lists only the trusted owner and keeps unfinished cleanup visible", async () => {
      const store = await setup();
      await store.insert(
        shellJobFixture({
          jobId: "same-session-child",
          contextScopeId: "child",
        }),
      );
      await store.insert(
        shellJobFixture({ jobId: "foreign-main", sessionId: "child-session" }),
      );
      await store.insert(
        shellJobFixture({
          jobId: "finishing",
          status: "failed",
          cleanup: "confirmed",
          settledAt: null,
        }),
      );
      await store.insert(
        shellJobFixture({
          jobId: "released",
          status: "cancelled",
          cleanup: "unconfirmed",
          trackingReleasedAt: 50,
        }),
      );
      await store.insert(
        shellJobFixture({ jobId: "foreground-running", mode: "foreground" }),
      );
      const registry = new ShellJobRegistry({
        store,
        killTree: (): undefined => undefined,
      });
      const page = await registry.list("s", { includeFinished: false });
      expect(page.jobs.map((job) => job.jobId).sort()).toEqual([
        "abnormal-foreground",
        "active-old",
        "finishing",
      ]);
      expect(page).toMatchObject({
        filteredCount: 3,
        pendingStartCount: 1,
        hasMore: false,
      });
      const child = await registry.list("s", {}, "child");
      expect(child.jobs.map((job) => job.jobId)).toEqual([
        "same-session-child",
      ]);
      const foreignMain = await registry.list("child-session", {});
      expect(foreignMain.jobs.map((job) => job.jobId)).toEqual([
        "foreign-main",
      ]);
      for (const status of SHELL_JOB_STATUSES) {
        await store.insert(
          shellJobFixture({
            jobId: `status-${status}`,
            status,
            cleanup: "confirmed",
            settledAt: 10,
          }),
        );
        const exact = await registry.list("s", { status });
        expect(exact.jobs.length).toBeGreaterThan(0);
        expect(exact.jobs.every((job) => job.status === status)).toBe(true);
      }
      expect(
        (await registry.list("s", { status: "cancelled" })).jobs.map(
          (job) => job.jobId,
        ),
      ).toContain("released");
    });
    it("pages over 100 own tasks with bounded summaries and binds cursors to owner and filters", async () => {
      const store = await setup();
      for (let index = 0; index < 105; index++)
        await store.insert(
          shellJobFixture({
            jobId: `own-${String(index).padStart(3, "0")}`,
            sessionId: "side",
            rootSessionId: "side",
            command: "x".repeat(2000),
            description: "y".repeat(1000),
            outputPath: "/missing/log",
            outputTail: "private log content",
            startedAt: index + 100,
          }),
        );
      const registry = new ShellJobRegistry({
        store,
        killTree: (): undefined => undefined,
      });
      const first = await registry.list("side", { limit: 100 });
      expect(first).toMatchObject({ hasMore: true, filteredCount: 106 });
      expect(first.jobs).toHaveLength(100);
      // boundedText keeps the byte budget plus a visible truncation marker.
      expect(Buffer.byteLength(first.jobs[0].command)).toBeLessThanOrEqual(
        1027,
      );
      expect(
        Buffer.byteLength(first.jobs[0].description ?? ""),
      ).toBeLessThanOrEqual(515);
      expect(first.jobs[0]).not.toHaveProperty("outputTail");
      expect(first.jobs[0]).not.toHaveProperty("outputPath");
      expect(first.jobs[0]).not.toHaveProperty("outputFile");
      const second = await registry.list("side", {
        cursor: first.nextCursor,
        limit: 10,
        includeFinished: true,
      });
      expect(second.hasMore).toBe(false);
      expect(
        new Set([...first.jobs, ...second.jobs].map((job) => job.jobId)).size,
      ).toBe(106);
      for (const options of [
        { includeFinished: false },
        { status: "running" as const },
      ])
        await expect(
          registry.list("side", { ...options, cursor: first.nextCursor }),
        ).rejects.toThrow("cursor");
      await expect(
        registry.list("s", { cursor: first.nextCursor }),
      ).rejects.toThrow("cursor");
      await expect(
        registry.list("side", { cursor: first.nextCursor }, "child"),
      ).rejects.toThrow("cursor");
      await expect(
        registry.list("side", { cursor: "not-a-cursor" }),
      ).rejects.toThrow("cursor");
      // The store keeps the page bound; status/include_finished rules belong to task input.
      await expect(registry.list("side", { limit: 101 })).rejects.toThrow(
        "page limit",
      );
    });
    it("observes only the requested owner before querying and propagates refresh failures and cancellation", async () => {
      const store = await setup();
      const registry = new ShellJobRegistry({
        store,
        killTree: (): never => {
          throw new Error("list must not signal a process");
        },
        refreshOwner: async (sessionId, contextScopeId): Promise<void> => {
          expect([sessionId, contextScopeId]).toEqual(["s", null]);
          await store.update("abnormal-foreground", {
            cleanup: "confirmed",
            settledAt: 100,
          });
        },
      });
      const page = await registry.list("s", { includeFinished: false });
      expect(page.jobs.map((job) => job.jobId)).toEqual(["active-old"]);
      expect(store.get("child")?.status).toBe("running");
      const failing = new ShellJobRegistry({
        store,
        killTree: (): undefined => undefined,
        refreshOwner: (): never => {
          throw new Error("refresh unavailable");
        },
      });
      await expect(failing.list("s")).rejects.toThrow("refresh unavailable");
      const controller = new AbortController();
      controller.abort(new Error("list cancelled"));
      await expect(
        failing.list("s", { signal: controller.signal }),
      ).rejects.toThrow("list cancelled");
    });
  },
);

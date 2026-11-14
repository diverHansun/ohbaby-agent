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
  },
);

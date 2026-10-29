import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../services/database/index.js";
import { DatabaseSubagentInstanceStore } from "./database-store.js";
import { DatabaseSubagentExecutionStore } from "./execution-store.js";
import { createSubagentMonitor } from "./monitor.js";

describe("persisted subagent monitor", () => {
  it("reads running, terminal and closed records after reopen on a read-only SQLite connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "subagent-monitor-"));
    const path = join(directory, "agent.db");
    try {
      initDatabase({ dbPath: path });
      for (const id of ["root", "shared"])
        getDatabase()
          .prepare(
            `INSERT INTO ${schema.session.tableName}
          (id, project_id, working_directory, agent, title, status, created_at, updated_at, message_count, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            "project",
            "/workspace",
            "default",
            "Session",
            "active",
            1,
            1,
            0,
            "{}",
          );
      const instances = new DatabaseSubagentInstanceStore({
        db: getDatabase(),
      });
      const executions = new DatabaseSubagentExecutionStore({
        db: getDatabase(),
      });
      const store = createDatabaseMessageStore();
      const ids = ["running", "completed", "interrupted", "closed"] as const;
      for (const id of ids) {
        const status = id === "closed" ? "interrupted" : id;
        await instances.create({
          subagentId: id,
          parentSessionId: "root",
          sessionId: "shared",
          contextScopeId: id,
          role: "explore",
          name: id,
          initialPrompt: "Saved task",
          status,
          pendingQueue: [],
          createdAt: 1,
          updatedAt: 3,
          ...(id === "closed" ? { closedAt: 4 } : {}),
        });
        const { record } = await executions.accept({
          executionId: `${id}-execution`,
          requestId: `${id}-request`,
          parentSessionId: "root",
          requesterScopeId: "primary",
          requesterRunId: "root-run",
          rootSessionId: "root",
          rootRunId: "root-run",
          subagentId: id,
          mode: "background",
          prompt: "Saved task",
          createdAt: 1,
        });
        await executions.bindChild(
          record,
          { sessionId: "shared", contextScopeId: id },
          2,
        );
        await executions.start(record, `${id}-run`, 2);
        if (status !== "running")
          await executions.finish(record, {
            status,
            output: `Result ${id}`,
            completedAt: 3,
          });
        const message = {
          id: `${id}-message`,
          sessionId: "shared",
          contextScopeId: id,
          runId: `${id}-run`,
          role: "assistant",
          agent: "explore",
          time: { created: 3 },
        } as const;
        await store.insertMessage(message);
        await store.appendPart({
          message,
          partId: `${id}-text`,
          data: { type: "text", text: `Answer ${id}` },
          updatedAt: 3,
        });
        await store.appendPart({
          message,
          partId: `${id}-reasoning`,
          data: { type: "reasoning", text: `Saved reasoning ${id}` },
          updatedAt: 3,
        });
      }
      closeDatabase();
      initDatabase({ dbPath: path });
      const restoredInstances = new DatabaseSubagentInstanceStore({
        db: getDatabase(),
      });
      const restoredExecutions = new DatabaseSubagentExecutionStore({
        db: getDatabase(),
      });
      const messages = createMessageManager({
        bus: createBus(),
        store: createDatabaseMessageStore(),
      });
      const before = {
        instances: await restoredInstances.listByParent("root"),
        executions: await restoredExecutions.list({ parentSessionId: "root" }),
        messages: await messages.listBySession("shared"),
      };
      getDatabase().exec("PRAGMA query_only = ON");
      const monitor = createSubagentMonitor({
        instances: restoredInstances,
        executions: restoredExecutions,
        messages,
      });
      const result = await monitor({
        parentSessionId: "root",
        subagentIds: ids,
      });
      expect(result.targets.map((target) => target.error)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(
        result.targets.map((target) => target.executions[0].status),
      ).toEqual(["running", "completed", "interrupted", "interrupted"]);
      expect(result.targets[3].item?.closedAt).toBe(4);
      for (const target of result.targets) {
        expect(target.records[0].content).toContain(
          `Answer ${target.subagentId}`,
        );
        expect(target.records[0].content).toContain(
          `Saved reasoning ${target.subagentId}`,
        );
      }
      expect({
        instances: await restoredInstances.listByParent("root"),
        executions: await restoredExecutions.list({ parentSessionId: "root" }),
        messages: await messages.listBySession("shared"),
      }).toEqual(before);
    } finally {
      closeDatabase();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

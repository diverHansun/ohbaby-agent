import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createBus } from "../../bus/index.js";
import {
  createDatabaseMessageStore,
  createMessageManager,
} from "../../core/message/index.js";
import { NodeSqliteConnection } from "../../services/database/connection.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../../services/database/index.js";
import { repairInterruptedRunHistory } from "./history.js";

it("preserves the real tool result committed by another SQLite connection after recovery's read", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-recovery-cas-"));
  const path = join(root, "facts.db");
  let other: NodeSqliteConnection | undefined;
  let resume: (() => void) | undefined;
  let repair: Promise<void> | undefined;
  try {
    initDatabase({ dbPath: path });
    getDatabase()
      .prepare(
        "INSERT INTO session (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data) VALUES ('s', 'p', '/fixture', 'primary', 'fixture', 'active', 1, 1, 0, '{}')",
      )
      .run();
    const manager = createMessageManager({
      bus: createBus(),
      store: createDatabaseMessageStore(),
    });
    const message = await manager.createMessage({
      sessionId: "s",
      runId: "A",
      role: "assistant",
      agent: "primary",
    });
    const tool = await manager.appendPart(message.id, {
      type: "tool",
      callId: "call",
      tool: "write",
      state: { status: "running", input: {} },
    });
    other = new NodeSqliteConnection(path);
    const otherStore = createDatabaseMessageStore({ db: other });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let reached!: () => void;
    const read = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const getPart = manager.getPart.bind(manager);
    vi.spyOn(manager, "getPart").mockImplementationOnce(async (id) => {
      const stale = await getPart(id);
      reached();
      await paused;
      return stale;
    });
    repair = repairInterruptedRunHistory(manager, {
      sessionId: "s",
      runId: "A",
      reason: "user-stop",
      now: () => 456,
    });
    await read;
    const actual = await otherStore.updatePart(
      tool.id,
      {
        state: {
          status: "completed",
          input: {},
          output: "known committed result",
        },
        metadata: {
          execution: {
            runId: "A",
            phase: "ended",
            createdAt: 1,
            phaseStartedAt: 123,
            endedAt: 123,
          },
        },
      },
      123,
    );
    resume?.();
    await repair;
    expect(await manager.getPart(tool.id)).toEqual(actual);
  } finally {
    if (resume) resume();
    await repair?.catch(() => undefined);
    other?.close();
    closeDatabase();
    await rm(root, { recursive: true, force: true });
  }
});

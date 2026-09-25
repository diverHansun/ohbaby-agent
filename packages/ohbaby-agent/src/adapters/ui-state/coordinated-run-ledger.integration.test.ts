import type { UiSessionView } from "ohbaby-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  schema,
} from "../../services/database/index.js";
import { createDatabaseRunLedger } from "../../runtime/run-ledger/index.js";
import { SessionViewOwner } from "./session-view.js";
import { createCoordinatedRunLedger } from "./coordinated-run-ledger.js";

it("keeps real SQLite run transitions and history reads behind the same committed cut", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-run-cut-"));
  initDatabase({ dbPath: join(directory, "agent.db") });
  try {
    getDatabase()
      .prepare(
        `INSERT INTO ${schema.session.tableName} (id, project_id, project_root, agent, title, status, created_at, updated_at, message_count, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "session",
        "project",
        "/test",
        "default",
        "test",
        "active",
        1,
        1,
        0,
        "{}",
      );
    const source = createDatabaseRunLedger();
    const owner = new SessionViewOwner({
      runtimeEpoch: "epoch",
      seed: (sessionId): Promise<Omit<UiSessionView, "version">> =>
        Promise.resolve({
          session: {
            id: sessionId,
            title: "test",
            createdAt: "2026",
            updatedAt: "2026",
            messages: [],
          },
          runs: [],
          prompts: [],
          history: { hasMore: false },
          reasoningMissing: false,
          todo: { status: "ready", value: null },
          goal: { status: "ready", value: null },
          context: { status: "ready", value: null },
        }),
      publish: (): void => undefined,
    });
    const ledger = createCoordinatedRunLedger({
      ledger: source,
      coordinator: {
        run: (id, operation) => owner.run(id, operation),
        onCommitted: (record) => {
          owner.commit(record.sessionId, {
            runs: [
              {
                id: record.runId,
                sessionId: record.sessionId,
                status:
                  record.status === "pending"
                    ? { kind: "idle" }
                    : { kind: "running", runId: record.runId },
                startedAt: "2026",
                updatedAt: "2026",
              },
            ],
          });
        },
        onProjectionError: (id, error) => {
          owner.markUnavailable(id, error);
        },
      },
    });
    await ledger.createPending({
      runId: "run",
      sessionId: "session",
      triggerSource: "user",
    });
    const baseline = owner.read("session");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written!: () => void;
    const observed = new Promise<void>((resolve) => {
      written = resolve;
    });
    const mark = source.markRunning.bind(source);
    vi.spyOn(source, "markRunning").mockImplementation(async (id) => {
      const result = await mark(id);
      written();
      await blocked;
      return result;
    });
    const change = ledger.markRunning("run");
    await observed;
    expect((await source.get("run"))?.status).toBe("running");
    expect(owner.read("session")).toBe(baseline);
    let readFinished = false;
    const read = owner.run("session", async () => {
      readFinished = true;
      return {
        version: owner.read("session").version,
        record: await source.get("run"),
      };
    });
    await Promise.resolve();
    expect(readFinished).toBe(false);
    release();
    await change;
    expect(await read).toMatchObject({
      version: { sessionRevision: baseline.version.sessionRevision + 1 },
      record: { status: "running" },
    });
  } finally {
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

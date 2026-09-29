import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  initDatabase,
  closeDatabase,
  getDatabase,
  withTransaction,
} from "./index.js";

let directory: string;
afterEach(async () => {
  closeDatabase();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function setup(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "write-contention-"));
  const path = join(directory, "test.db");
  initDatabase({ dbPath: path });
  getDatabase().exec(
    "CREATE TABLE ordered_write (id INTEGER PRIMARY KEY, value TEXT)",
  );
  return path;
}
async function hold(path: string, ms: number): Promise<ChildProcess> {
  const child = fork(
    fileURLToPath(new URL("./testing/lock-holder.mjs", import.meta.url)),
    [path, String(ms)],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("message", () => {
      resolve();
    });
    child.once("error", reject);
  });
  return child;
}
it("yields during an independent write lock and commits FIFO without premature publication", async () => {
  const path = await setup();
  const holder = await hold(path, 450);
  const started = performance.now();
  const heartbeat = new Promise<number>((resolve) =>
    setTimeout(() => {
      resolve(performance.now() - started);
    }, 25),
  );
  const published: string[] = [];
  const write = (value: string): Promise<void> =>
    Promise.resolve(
      withTransaction((db) => {
        db.prepare("INSERT INTO ordered_write(value) VALUES (?)").run(value);
        return value;
      }),
    ).then((value) => {
      published.push(value);
    });
  const first = write("first");
  const second = write("second");
  const delay = await heartbeat;
  expect(published).toEqual([]);
  await Promise.all([first, second]);
  expect(delay).toBeLessThan(200);
  expect(published).toEqual(["first", "second"]);
  expect(
    getDatabase().prepare("SELECT value FROM ordered_write ORDER BY id").all(),
  ).toEqual([{ value: "first" }, { value: "second" }]);
  expect(holder.killed).toBe(false);
});
it("never replays a transaction body when it throws a busy error after entry", async () => {
  await setup();
  let calls = 0;
  const operation = (): Promise<number> =>
    withTransaction<number>((db) => {
      calls++;
      db.prepare("INSERT INTO ordered_write(value) VALUES (?)").run(
        "rolled-back",
      );
      throw Object.assign(new Error("database is locked"), {
        code: "SQLITE_BUSY",
      });
    });
  await expect(operation()).rejects.toThrow("database is locked");
  expect(calls).toBe(1);
  expect(getDatabase().prepare("SELECT * FROM ordered_write").all()).toEqual(
    [],
  );
});

import { createDatabaseSessionStore } from "../session/database-store.js";
import { createDatabaseMessageStore } from "../../core/message/database-store.js";
import { createDatabaseRunLedger } from "../../runtime/run-ledger/database.js";
import { DatabasePromptSubmissionStore } from "../../runtime/prompt-scheduler/database-store.js";
import { SnapshotStore } from "../../snapshot/store.js";
import { createWorkspaceRegistryStore } from "../workspace-registry/database-store.js";
import { createSqliteGoalPersistence } from "../../goals/persistence.js";
import { DatabaseSubagentInstanceStore } from "../../agents/subagents/database-store.js";
import { NodeSqliteConnection } from "./connection.js";

const writers = [
  "session insert",
  "session update",
  "session remove",
  "session commit",
  "message insert",
  "message update",
  "message reasoning",
  "message delete",
  "ledger pending",
  "ledger transition",
  "ledger claim",
  "prompt accept",
  "prompt finish",
  "snapshot checkpoint",
  "snapshot patch",
  "snapshot direct patch",
  "snapshot cursor",
  "snapshot delete",
  "workspace shared",
  "workspace injected",
  "goal",
  "subagent create",
  "subagent append",
  "subagent claim",
  "subagent update",
  "subagent finish",
  "subagent recover",
] as const;
it.each(writers)(
  "%s waits for contention without blocking or overtaking an earlier writer",
  async (name) => {
    const path = await setup();
    const db = getDatabase();
    const sessions = createDatabaseSessionStore();
    const session = {
      id: "s",
      projectId: "p",
      projectRoot: "/fixture",
      title: "test",
      agentName: "default",
      createdAt: 1,
      updatedAt: 1,
      status: "active" as const,
      stats: { messageCount: 0 },
      childrenIds: [],
      isSubagent: false,
    };
    await sessions.insert(session);
    const messages = createDatabaseMessageStore();
    const message = {
      id: "m",
      sessionId: "s",
      role: "assistant" as const,
      agent: "default",
      time: { created: 1 },
      parentId: "u",
      model: { providerId: "fixture", modelId: "fixture" },
    };
    await messages.insertMessage(message);
    const ledger = createDatabaseRunLedger();
    await ledger.createPending({
      runId: "r",
      sessionId: "s",
      triggerSource: "user",
    });
    const prompts = new DatabasePromptSubmissionStore();
    const prompt = {
      clientRequestId: "p",
      promptId: "p",
      sessionId: "s",
      scopeKey: "/fixture",
      text: "fixture",
      userMessageId: "u",
      maxQueuedPrompts: 10,
    };
    await prompts.accept(prompt);
    await prompts.claim("p");
    await prompts.markRunning("p", "r");
    const snapshots = new SnapshotStore({ db });
    const checkpoint = {
      checkpointId: "c",
      sessionId: "s",
      turnId: "t",
      workdir: "/fixture",
      preTreeRef: "ref",
      createdAt: 1,
    };
    await snapshots.createCheckpoint(checkpoint);
    const subagents = new DatabaseSubagentInstanceStore({
      isOwnerAlive: (): boolean => false,
    });
    const child: Parameters<DatabaseSubagentInstanceStore["create"]>[0] = {
      contextScopeId: "child",
      createdAt: 1,
      initialPrompt: "fixture",
      parentSessionId: "s",
      pendingQueue: [],
      role: "explore" as const,
      sessionId: "s",
      status: name === "subagent claim" ? "pending" : "running",
      subagentId: "a",
      updatedAt: 1,
      currentRunId: "r",
      ownerId: "dead",
      ownerPid: 999999,
    };
    await subagents.create(child);
    if (name === "ledger claim") await ledger.markCancelled("r");
    const injected =
      name === "workspace injected"
        ? new NodeSqliteConnection(path)
        : undefined;
    const operations: Record<(typeof writers)[number], () => unknown> = {
      "session insert": () => sessions.insert({ ...session, id: "s2" }),
      "session update": () => sessions.update("s", { title: "updated" }),
      "session remove": () => sessions.remove("s"),
      "session commit": () =>
        sessions.withTransaction(async (store) => {
          await store.update("s", { title: "transaction" });
        }),
      "message insert": () => messages.insertMessage({ ...message, id: "m2" }),
      "message update": () => messages.updateMessage("m", { finish: "stop" }),
      "message reasoning": () =>
        messages.saveReasoningPart({
          messageId: "m",
          partId: "reason",
          text: "reason",
          updatedAt: 2,
        }),
      "message delete": () => messages.deleteMessage("m"),
      "ledger pending": () =>
        ledger.createPending({
          runId: "r2",
          sessionId: "s",
          triggerSource: "user",
        }),
      "ledger transition": () => ledger.markRunning("r"),
      "ledger claim": () =>
        ledger.claimPendingRun({
          runId: "r2",
          sessionId: "s",
          triggerSource: "user",
        }),
      "prompt accept": () =>
        prompts.accept({
          ...prompt,
          promptId: "p2",
          clientRequestId: "p2",
          userMessageId: "u2",
        }),
      "prompt finish": () =>
        prompts.finish("p", { status: "succeeded", expectedRunId: "r" }),
      "snapshot checkpoint": () =>
        snapshots.createCheckpoint({ ...checkpoint, checkpointId: "c2" }),
      "snapshot patch": () =>
        snapshots.createPatchIfAbsent({
          patchId: "patch",
          checkpointId: "c",
          postTreeRef: "post",
          fileCount: 1,
          createdAt: 2,
        }),
      "snapshot direct patch": () =>
        snapshots.createPatch({
          patchId: "patch",
          checkpointId: "c",
          postTreeRef: "post",
          fileCount: 1,
          createdAt: 2,
        }),
      "snapshot cursor": () =>
        snapshots.updateCheckpointMessageCursor("c", {
          messageId: "m",
          sequence: 1,
        }),
      "snapshot delete": () => snapshots.deleteCheckpoint("c"),
      "workspace shared": () => createWorkspaceRegistryStore().open("/fixture"),
      "workspace injected": () =>
        createWorkspaceRegistryStore({ db: injected }).open("/fixture"),
      goal: () =>
        createSqliteGoalPersistence(db).append("s", {
          type: "create",
          goalId: "goal",
          objective: "fixture",
        }),
      "subagent create": () =>
        subagents.create({
          ...child,
          subagentId: "a2",
          contextScopeId: "child2",
        }),
      "subagent append": () =>
        subagents.appendPendingQueue("a", { prompt: "next" }, 2),
      "subagent claim": () =>
        subagents.claim("a", { status: "running", updatedAt: 2 }),
      "subagent update": () =>
        subagents.update("a", { output: "done", updatedAt: 2 }),
      "subagent finish": () =>
        subagents.finishRun("a", "r", { status: "completed", updatedAt: 2 }),
      "subagent recover": () => subagents.markInterrupted({ interruptedAt: 2 }),
    };
    const targetTable = name.startsWith("session")
      ? "session"
      : name === "message reasoning"
        ? "part"
        : name.startsWith("message")
          ? "message"
          : name.startsWith("ledger")
            ? "run_ledger"
            : name.startsWith("prompt")
              ? "prompt_submission"
              : name.includes("patch")
                ? "snapshot_patch"
                : name.startsWith("snapshot")
                  ? "snapshot_checkpoint"
                  : name.startsWith("workspace")
                    ? "workspace_registry"
                    : name === "goal"
                      ? "goal_record"
                      : "subagent_instance";
    db.exec(
      `CREATE TABLE write_audit (operation TEXT); CREATE TRIGGER audit_insert AFTER INSERT ON ${targetTable} BEGIN INSERT INTO write_audit VALUES ('insert'); END; CREATE TRIGGER audit_update AFTER UPDATE ON ${targetTable} BEGIN INSERT INTO write_audit VALUES ('update'); END; CREATE TRIGGER audit_delete AFTER DELETE ON ${targetTable} BEGIN INSERT INTO write_audit VALUES ('delete'); END;`,
    );
    await hold(path, 450);
    const start = performance.now();
    const heartbeat = new Promise<number>((resolve) =>
      setTimeout(() => {
        resolve(performance.now() - start);
      }, 25),
    );
    const publication: string[] = [];
    const first = withTransaction((connection) => {
      connection
        .prepare("INSERT INTO ordered_write(value) VALUES (?)")
        .run("first");
    }).then(() => publication.push("first"));
    const operation = Promise.resolve()
      .then(operations[name])
      .then(() => publication.push(name));
    const results = await Promise.allSettled([first, operation]);
    const delay = await heartbeat;
    injected?.close();
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    expect(delay).toBeLessThan(200);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM write_audit").get(),
    ).toEqual({ count: 1 });
    if (!injected) expect(publication).toEqual(["first", name]);
    process.stdout.write(
      `T08_WRITER ${JSON.stringify({ writer: name, heartbeatMs: delay, committedMutations: 1 })}\n`,
    );
  },
);

it("rejects a stale staged session replacement instead of losing another store update", async () => {
  await setup();
  const first = createDatabaseSessionStore();
  const second = createDatabaseSessionStore();
  await first.insert({
    id: "s",
    projectId: "p",
    projectRoot: "/fixture",
    title: "original",
    agentName: "default",
    createdAt: 1,
    updatedAt: 1,
    status: "active",
    stats: { messageCount: 0 },
    childrenIds: [],
    isSubagent: false,
  });
  let staged!: () => void;
  const stage = new Promise<void>((resolve) => {
    staged = resolve;
  });
  let resume!: () => void;
  const barrier = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const transaction = first.withTransaction(async (store) => {
    await store.update("s", { title: "staged" });
    staged();
    await barrier;
  });
  const rejected = expect(transaction).rejects.toThrow(
    "changed during transaction",
  );
  await stage;
  await second.update("s", { agentName: "new-agent" });
  resume();
  await rejected;
  expect(await second.get("s")).toMatchObject({
    title: "original",
    agentName: "new-agent",
  });
});

it("exhausts its finite admission budget, does not execute or publish, and lets later writes recover", async () => {
  const path = await setup();
  await hold(path, 5500);
  let calls = 0;
  let published = false;
  const start = performance.now();
  const write = withTransaction((db) => {
    calls++;
    db.prepare("INSERT INTO ordered_write(value) VALUES (?)").run("forbidden");
  }).then(() => {
    published = true;
  });
  const failure = expect(write).rejects.toMatchObject({
    name: "DatabaseBusyError",
  });
  const heartbeat = await new Promise<number>((resolve) =>
    setTimeout(() => {
      resolve(performance.now() - start);
    }, 25),
  );
  await failure;
  expect(performance.now() - start).toBeGreaterThanOrEqual(4900);
  expect(performance.now() - start).toBeLessThan(6000);
  expect(heartbeat).toBeLessThan(200);
  expect(calls).toBe(0);
  expect(published).toBe(false);
  await withTransaction((db) => {
    db.prepare("INSERT INTO ordered_write(value) VALUES (?)").run("recovered");
  });
  expect(
    getDatabase().prepare("SELECT value FROM ordered_write").all(),
  ).toEqual([{ value: "recovered" }]);
});

import { runWriteTransaction } from "./index.js";
it("rolls back a failed COMMIT without replaying the body and releases its FIFO slot", async () => {
  await setup();
  const db = getDatabase();
  let failCommit = true;
  let calls = 0;
  const connection = {
    path: db.path,
    prepare: db.prepare.bind(db),
    pragma: db.pragma.bind(db),
    close: (): void => {
      throw new Error("Fixture cannot close shared database");
    },
    exec(sql: string): void {
      if (sql === "COMMIT" && failCommit) {
        failCommit = false;
        throw Object.assign(new Error("database is locked"), {
          code: "SQLITE_BUSY",
        });
      }
      db.exec(sql);
    },
  };
  await expect(
    runWriteTransaction(connection, () => {
      calls++;
      db.prepare("INSERT INTO ordered_write(value) VALUES (?)").run(
        "rolled-back",
      );
    }),
  ).rejects.toThrow("database is locked");
  await runWriteTransaction(connection, () => {
    db.prepare("INSERT INTO ordered_write(value) VALUES (?)").run("next");
  });
  expect(calls).toBe(1);
  expect(db.prepare("SELECT value FROM ordered_write").all()).toEqual([
    { value: "next" },
  ]);
});

it("releases session staging ownership before an asynchronously waiting commit", async () => {
  const path = await setup();
  const store = createDatabaseSessionStore();
  await store.insert({
    id: "s",
    projectId: "p",
    projectRoot: "/fixture",
    title: "original",
    agentName: "default",
    createdAt: 1,
    updatedAt: 1,
    status: "active",
    stats: { messageCount: 0 },
    childrenIds: [],
    isSubagent: false,
  });
  await hold(path, 450);
  const db = getDatabase();
  const exec = db.exec.bind(db);
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    reached = resolve;
  });
  db.exec = (sql): void => {
    try {
      exec(sql);
    } catch (error) {
      if (sql === "BEGIN IMMEDIATE") reached();
      throw error;
    }
  };
  const transaction = store.withTransaction(async (scoped) => {
    await scoped.update("s", { title: "committed" });
  });
  await blocked;
  const result = await Promise.allSettled([store.get("s")]);
  await transaction;
  expect(result[0].status).toBe("fulfilled");
  expect(await store.get("s")).toMatchObject({ title: "committed" });
});

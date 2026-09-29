import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { NodeSqliteConnection } from "./connection.js";
import { beginDatabaseShutdown, runWriteTransaction } from "./index.js";
import {
  createDatabaseWriteBudget,
  withDatabaseWriteBudget,
} from "./write-budget.js";

async function lock(path: string, holdMs: number): Promise<ChildProcess> {
  const holder = fork(
    fileURLToPath(new URL("./testing/lock-holder.mjs", import.meta.url)),
    [path, String(holdMs)],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  await once(holder, "message");
  return holder;
}

async function stop(holder: ChildProcess): Promise<void> {
  if (holder.exitCode !== null || holder.signalCode !== null) return;
  const exit = once(holder, "exit");
  holder.kill("SIGKILL");
  await exit;
}

it("shares one critical-save budget across sequential real lock waits, and permits a new explicit attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "save-budget-"));
  const path = join(directory, "facts.db");
  const db = new NodeSqliteConnection(path);
  const holders: ChildProcess[] = [];
  db.exec("CREATE TABLE facts(value TEXT)");
  try {
    holders.push(await lock(path, 150));
    const budget = createDatabaseWriteBudget(500);
    await withDatabaseWriteBudget(budget, async () => {
      const firstWriteAt = performance.now();
      await runWriteTransaction(db, (connection) => {
        connection.prepare("INSERT INTO facts VALUES ('input-closed')").run();
      });
      const firstWriteMs = performance.now() - firstWriteAt;
      await new Promise((resolve) => setTimeout(resolve, 150));
      holders.push(await lock(path, 1000));
      const secondWriteAt = performance.now();
      await expect(
        runWriteTransaction(db, (connection) => {
          connection.prepare("INSERT INTO facts VALUES ('run-terminal')").run();
        }),
      ).rejects.toThrow(/Critical-save attempt deadline/);
      const totalWriteMs = firstWriteMs + performance.now() - secondWriteAt;
      expect(totalWriteMs).toBeGreaterThan(450);
      expect(totalWriteMs).toBeLessThan(650);
      await stop(holders[1]);
      // A nested fresh child budget cannot extend the original attempt or write late.
      await expect(
        withDatabaseWriteBudget(createDatabaseWriteBudget(), () =>
          runWriteTransaction(db, (connection) => {
            connection.prepare("INSERT INTO facts VALUES ('late')").run();
          }),
        ),
      ).rejects.toThrow(/Critical-save attempt deadline/);
    });
    expect(db.prepare("SELECT value FROM facts").all()).toEqual([
      { value: "input-closed" },
    ]);
    await withDatabaseWriteBudget(createDatabaseWriteBudget(), () =>
      runWriteTransaction(db, (connection) => {
        connection.prepare("INSERT INTO facts VALUES ('explicit-retry')").run();
      }),
    );
    expect(db.prepare("SELECT value FROM facts").all()).toEqual([
      { value: "input-closed" },
      { value: "explicit-retry" },
    ]);
  } finally {
    await Promise.all(holders.map(stop));
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("charges concurrent nested writes once to their shared parent allowance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "save-concurrent-budget-"));
  const path = join(directory, "facts.db");
  const db = new NodeSqliteConnection(path);
  const other = new NodeSqliteConnection(path);
  db.exec("CREATE TABLE facts(value TEXT)");
  const holders: ChildProcess[] = [];
  try {
    holders.push(await lock(path, 220));
    await withDatabaseWriteBudget(createDatabaseWriteBudget(400), async () => {
      await Promise.all(
        [db, other].map((connection) =>
          withDatabaseWriteBudget(createDatabaseWriteBudget(5000), () =>
            runWriteTransaction(connection, (transaction) => {
              transaction
                .prepare("INSERT INTO facts VALUES ('parallel')")
                .run();
            }),
          ),
        ),
      );
      holders.push(await lock(path, 80));
      await runWriteTransaction(db, (transaction) => {
        transaction
          .prepare("INSERT INTO facts VALUES ('after-parallel')")
          .run();
      });
    });
    expect(db.prepare("SELECT value FROM facts").all()).toEqual([
      { value: "parallel" },
      { value: "parallel" },
      { value: "after-parallel" },
    ]);
  } finally {
    await Promise.all(holders.map(stop));
    other.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("retains the absolute shutdown deadline while an attempt's DB clock is idle", async () => {
  const db = new NodeSqliteConnection(":memory:");
  try {
    await withDatabaseWriteBudget(createDatabaseWriteBudget(5000), async () => {
      beginDatabaseShutdown(Date.now() + 40, db);
      await runWriteTransaction(db, (connection) => {
        connection.exec("CREATE TABLE facts(value TEXT)");
      });
      await new Promise((resolve) => setTimeout(resolve, 70));
      await expect(
        runWriteTransaction(db, (connection) => {
          connection.prepare("INSERT INTO facts VALUES ('late')").run();
        }),
      ).rejects.toThrow(/shutdown deadline/);
      expect(db.prepare("SELECT * FROM facts").all()).toEqual([]);
    });
  } finally {
    db.close();
  }
});

it("expires a queued save promptly without allowing a later writer to overtake the FIFO", async () => {
  const directory = await mkdtemp(join(tmpdir(), "save-fifo-budget-"));
  const path = join(directory, "facts.db");
  const db = new NodeSqliteConnection(path);
  db.exec("CREATE TABLE facts(value TEXT)");
  const holder = await lock(path, 400);
  let first: Promise<void> | undefined;
  let third: Promise<void> | undefined;
  try {
    first = runWriteTransaction(db, (connection) => {
      connection.prepare("INSERT INTO facts VALUES ('first')").run();
    });
    const startedAt = performance.now();
    await expect(
      withDatabaseWriteBudget(createDatabaseWriteBudget(60), () =>
        runWriteTransaction(db, () => {
          throw new Error("expired operation must not run");
        }),
      ),
    ).rejects.toThrow(/Critical-save attempt deadline/);
    expect(performance.now() - startedAt).toBeLessThan(180);
    expect(db.prepare("SELECT * FROM facts").all()).toHaveLength(0);
    third = runWriteTransaction(db, (connection) => {
      connection.prepare("INSERT INTO facts VALUES ('third')").run();
    });
    await Promise.all([first, third]);
    expect(db.prepare("SELECT value FROM facts").all()).toEqual([
      { value: "first" },
      { value: "third" },
    ]);
  } finally {
    await stop(holder);
    await Promise.allSettled([first, third]);
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

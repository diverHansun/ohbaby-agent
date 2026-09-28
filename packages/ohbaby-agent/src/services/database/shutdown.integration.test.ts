import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { NodeSqliteConnection } from "./connection.js";
import { beginDatabaseShutdown, runWriteTransaction } from "./index.js";

it.each([
  { holdMs: 400, budgetMs: 80, commits: false },
  { holdMs: 50, budgetMs: 500, commits: true },
])(
  "shares one shutdown budget with a real independent SQLite lock ($holdMs ms lock/$budgetMs ms budget)",
  async ({ holdMs, budgetMs, commits }) => {
    const directory = await mkdtemp(join(tmpdir(), "shutdown-sqlite-"));
    const path = join(directory, "fixture.db");
    const db = new NodeSqliteConnection(path);
    db.exec("CREATE TABLE facts(value TEXT)");
    let holder: ChildProcess | undefined;
    try {
      holder = fork(
        fileURLToPath(new URL("./testing/lock-holder.mjs", import.meta.url)),
        [path, String(holdMs)],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      await once(holder, "message");
      const startedAt = Date.now();
      beginDatabaseShutdown(startedAt + budgetMs, db);
      const save = runWriteTransaction(db, (connection) => {
        connection.prepare("INSERT INTO facts VALUES ('final')").run();
      });
      if (commits) await save;
      else await expect(save).rejects.toThrow(/shutdown/i);
      expect(Date.now() - startedAt).toBeLessThan(budgetMs + 100);
      expect(db.prepare("SELECT * FROM facts").all()).toHaveLength(
        commits ? 1 : 0,
      );
      if (!commits) {
        await expect(
          runWriteTransaction(db, () => {
            throw new Error("must not execute");
          }),
        ).rejects.toThrow(/shutdown/i);
      }
    } finally {
      if (holder?.exitCode === null && holder.signalCode === null) {
        const exit = once(holder, "exit");
        holder.kill("SIGKILL");
        await exit;
      }
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  5000,
);

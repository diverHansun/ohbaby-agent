import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { initDatabase, closeDatabase, getDatabase } from "./index.js";
import { NodeSqliteConnection } from "./connection.js";

it.each(["reopen", "same-connection", "journal-mode"] as const)(
  "checks %s initialization under an independent writer and keeps runtime timeout separate",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "startup-contention-"));
    const dbPath = join(directory, "fixture.db");
    initDatabase({ dbPath, migrations: [] });
    if (mode !== "same-connection") closeDatabase();
    if (mode === "journal-mode") {
      const seed = new NodeSqliteConnection(dbPath);
      seed.exec("PRAGMA journal_mode = DELETE");
      seed.close();
    }
    const child = fork(
      fileURLToPath(new URL("./testing/lock-holder.mjs", import.meta.url)),
      [dbPath, "450"],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => {
        resolve();
      }),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("message", () => {
          resolve();
        });
        child.once("error", reject);
      });
      const started = performance.now();
      const initialize = (): void => {
        initDatabase({
          dbPath,
          migrations: [
            {
              version: "startup-lock-test",
              sql: "CREATE TABLE startup_probe (value TEXT)",
            },
          ],
        });
      };
      if (mode === "journal-mode") {
        // Baseline limitation: SQLite does not wait for this journal conversion.
        expect(initialize).toThrow("database is locked");
        expect(() => getDatabase()).toThrow("not initialized");
        await exited;
        initialize();
      } else {
        initialize();
        expect(performance.now() - started).toBeGreaterThan(200);
        expect(performance.now() - started).toBeLessThan(5000);
      }
      const elapsed = performance.now() - started;
      expect(
        getDatabase().prepare("SELECT version FROM migration").all(),
      ).toEqual([{ version: "startup-lock-test" }]);
      expect(getDatabase().pragma("busy_timeout")).toEqual([
        expect.objectContaining({ busy_timeout: 25 }),
      ]);
      process.stdout.write(
        JSON.stringify({
          startupMode: mode,
          elapsedMs: elapsed,
          runtimeBusyMs: 25,
          migrationWaitValidated: mode !== "journal-mode",
        }) + "\n",
      );
    } finally {
      await exited;
      closeDatabase();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("restores runtime busy timeout after a same-path migration failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "startup-failure-"));
  const dbPath = join(directory, "fixture.db");
  try {
    initDatabase({ dbPath, migrations: [] });
    expect(() => {
      initDatabase({
        dbPath,
        migrations: [{ version: "bad", sql: "INVALID MIGRATION SQL" }],
      });
    }).toThrow();
    expect(getDatabase().pragma("busy_timeout")).toEqual([
      expect.objectContaining({ busy_timeout: 25 }),
    ]);
    expect(
      getDatabase().prepare("SELECT version FROM migration").all(),
    ).toEqual([]);
  } finally {
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  }
});

import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../services/database/index.js";
import { NodeSqliteConnection } from "../services/database/connection.js";
import { DatabaseShellJobStore } from "./shell-job-store.js";
import { shellJobFixture } from "./fixtures/shell-job.js";

let directory: string | undefined;
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
    }
  }
  closeDatabase();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function setup(): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "shell-capacity-"));
  const dbPath = join(directory, "test.db");
  initDatabase({ dbPath });
  getDatabase()
    .prepare(
      "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
    )
    .run();
  return dbPath;
}

it("does not overbook an owner when independent backends reserve concurrently", async () => {
  const dbPath = await setup();
  for (const actor of ["a", "b", "c"]) {
    const child = fork(
      fileURLToPath(
        new URL("./fixtures/reserve-shell-jobs.ts", import.meta.url),
      ),
      [dbPath, actor],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    children.push(child);
    expect((await once(child, "message"))[0]).toEqual({ ready: true });
  }
  const results = children.map((child) => once(child, "message"));
  const exits = children.map((child) => once(child, "exit"));
  children.forEach((child) => {
    child.send("start");
  });
  const messages = await Promise.all(results);
  const counts = messages.map(
    ([value]) => (value as { accepted: number }).accepted,
  );
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(3);
  expect(new DatabaseShellJobStore().listByOwner("s", null)).toHaveLength(3);
  expect(await Promise.all(exits)).toEqual([
    [0, null],
    [0, null],
    [0, null],
  ]);
});

it("rechecks cancelled execution admission after waiting for another writer", async () => {
  const dbPath = await setup();
  const lock = new NodeSqliteConnection(dbPath);
  lock.exec("BEGIN IMMEDIATE");
  let admitted = true;
  const timer = setTimeout(() => {
    admitted = false;
    lock.exec("COMMIT");
  }, 40);
  const store = new DatabaseShellJobStore();
  try {
    await expect(
      store.insert(shellJobFixture(), {
        maxBackgroundJobs: 1,
        assertAdmitted: () => {
          if (!admitted) throw new Error("execution closed");
        },
      }),
    ).rejects.toThrow("execution closed");
    expect(store.get("job")).toBeNull();
  } finally {
    clearTimeout(timer);
    lock.close();
  }
});

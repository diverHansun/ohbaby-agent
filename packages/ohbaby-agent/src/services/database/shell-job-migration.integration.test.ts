import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  DatabaseUpgradeBlockedError,
  getDatabase,
  initDatabase,
} from "./index.js";
import { INITIAL_MIGRATIONS } from "./migrations.js";
import { NodeSqliteConnection } from "./connection.js";
import { DatabaseShellJobStore } from "../../tools/shell-job-store.js";

const directories: string[] = [];
afterEach(async () => {
  closeDatabase();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function legacy(
  through: "031" | "032",
): Promise<{ dbPath: string; backupPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-shell-migration-"));
  directories.push(directory);
  const dbPath = join(directory, "old.db");
  initDatabase({
    dbPath,
    migrations: INITIAL_MIGRATIONS.filter(
      (migration) => migration.version < through,
    ),
  });
  const db = getDatabase();
  db.prepare(
    "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','legacy','active',1,1,'{}')",
  ).run();
  db.prepare(
    "INSERT INTO run_ledger(run_id,session_id,trigger,status,created_at,started_at,ended_at) VALUES('r','s','user','succeeded',1,2,3)",
  ).run();
  db.prepare(
    "INSERT INTO message(id,session_id,role,agent,created_at,updated_at,data) VALUES('m','s','user','default',2,2,'{}')",
  ).run();
  db.prepare(
    "INSERT INTO current_run_input(input_id,run_id,session_id,source,source_id,message_id,accepted_at,data) VALUES('old-input','r','s','subagent-result','original-source','m',2,?)",
  ).run(
    JSON.stringify({
      text: "keep exactly 中文",
      processedRequestId: "original-request",
      acceptedAt: 2,
    }),
  );
  return { dbPath, backupPath: join(directory, "before-upgrade.db") };
}
describe("shell task offline schema upgrade", () => {
  it("upgrades a populated 030 database without changing old inputs and retains the pre-upgrade backup", async () => {
    const { dbPath, backupPath } = await legacy("031");
    const oldInput = getDatabase()
      .prepare("SELECT * FROM current_run_input")
      .get();
    initDatabase({ dbPath, migrationBackupPath: backupPath });
    const db = getDatabase();
    expect(db.prepare("SELECT * FROM current_run_input").get()).toEqual(
      oldInput,
    );
    expect(
      db
        .prepare<{ name: string }>("PRAGMA table_info(shell_job)")
        .all()
        .map((column) => column.name),
    ).toContain("workspace_key");
    expect(
      db
        .prepare<{ name: string }>("PRAGMA index_list(shell_job)")
        .all()
        .map((index) => index.name),
    ).toEqual(
      expect.arrayContaining([
        "idx_shell_job_owner_status",
        "idx_shell_job_root_history",
        "idx_shell_job_root_run",
        "idx_shell_job_notice_batch",
      ]),
    );
    expect(
      db
        .prepare<{ name: string }>("PRAGMA index_list(current_run_input)")
        .all()
        .map((index) => index.name),
    ).toContain("idx_current_run_input_source");
    db.prepare(
      "INSERT INTO message(id,session_id,role,created_at,updated_at,data) VALUES('background-message','s','user',4,4,'{}')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO current_run_input(input_id,run_id,session_id,source,source_id,message_id,accepted_at,data) VALUES('new-input','r','s','background-task-result','batch','background-message',4,'{}')",
        )
        .run(),
    ).not.toThrow();
    const backup = new NodeSqliteConnection(backupPath);
    try {
      expect(backup.prepare("SELECT * FROM current_run_input").get()).toEqual(
        oldInput,
      );
      expect(
        backup
          .prepare("SELECT name FROM sqlite_master WHERE name='shell_job'")
          .get(),
      ).toBeUndefined();
      expect(
        backup
          .prepare("SELECT version FROM migration WHERE version LIKE '032%'")
          .get(),
      ).toBeUndefined();
    } finally {
      backup.close();
    }
  });
  it.each(["placeholder", "unfinished-terminal"] as const)(
    "blocks 032 while an active backend owns a %s",
    async (kind) => {
      const { dbPath, backupPath } = await legacy("032");
      const db = getDatabase();
      db.prepare(
        `
        INSERT INTO shell_job(job_id,session_id,root_session_id,mode,command,cwd,shell,created_at,owner_pid,status,started_at,cleanup)
        VALUES('job','s','s','background','sleep 30','/tmp','/bin/sh',1,?,?,?,?)
      `,
      ).run(
        process.pid,
        kind === "placeholder" ? null : "cancelled",
        kind === "placeholder" ? null : 1,
        kind === "placeholder" ? null : "unconfirmed",
      );
      const readJob = db.prepare("SELECT * FROM shell_job WHERE job_id='job'");
      const oldJob = readJob.get();
      const oldInput = db.prepare("SELECT * FROM current_run_input").get();
      expect(() => {
        initDatabase({ dbPath, migrationBackupPath: backupPath });
      }).toThrow(DatabaseUpgradeBlockedError);
      expect(
        getDatabase()
          .prepare("SELECT version FROM migration WHERE version LIKE '032%'")
          .get(),
      ).toBeUndefined();
      expect(readJob.get()).toEqual(oldJob);
      expect(
        getDatabase().prepare("SELECT * FROM current_run_input").get(),
      ).toEqual(oldInput);
      db.prepare(
        "UPDATE shell_job SET status='cancelled',cleanup='confirmed',settled_at=5 WHERE job_id='job'",
      ).run();
      initDatabase({ dbPath, migrationBackupPath: backupPath });
      expect(
        getDatabase().prepare("SELECT * FROM current_run_input").get(),
      ).toEqual(oldInput);
      expect(new DatabaseShellJobStore().get("job")).toMatchObject({
        status: "cancelled",
        cleanup: "confirmed",
        settledAt: 5,
        promotedAt: null,
      });
    },
  );
});

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersistentUiBackendClient } from "../../adapters/ui-persistent.js";
import { readSessionRow } from "../session/database-store.js";
import {
  closeDatabase,
  DatabaseUpgradeBlockedError,
  getDatabase,
  initDatabase,
} from "./index.js";
import { INITIAL_MIGRATIONS } from "./migrations.js";
import { NodeSqliteConnection } from "./connection.js";

let directory: string;
let dbPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ohbaby-workspace-naming-"));
  dbPath = join(directory, "agent.db");
  vi.stubEnv("OHBABY_HOME", directory);
  initDatabase({
    dbPath,
    migrations: INITIAL_MIGRATIONS.filter(
      (migration) => migration.version < "026",
    ),
  });
  getDatabase().exec(`
    INSERT INTO session
      (id, project_id, project_root, project_directory, pending_project_root, status, created_at, updated_at)
    VALUES
      ('bound', 'global', '/repo/a', '/repo/a', NULL, 'active', 1, 1),
      ('unbound', 'global', '/repo/a', NULL, NULL, 'active', 1, 1),
      ('moving', 'global', '/repo/a', '/repo/b', '/repo/b', 'active', 1, 1);
  `);
  closeDatabase();
});

afterEach(async () => {
  closeDatabase();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function columnNames(): string[] {
  return getDatabase()
    .prepare<{ name: string }>("PRAGMA table_info(session)")
    .all()
    .map((column) => column.name);
}

async function writeDaemonPid(value: string): Promise<void> {
  await mkdir(join(directory, "server"), { recursive: true });
  await writeFile(join(directory, "server", "daemon.pid"), value);
}

describe("workspace naming migration", () => {
  it("renames all three columns without changing values and backs up a database at 025", async () => {
    initDatabase({ dbPath });
    expect(columnNames()).toEqual(
      expect.arrayContaining([
        "workspace_directory",
        "working_directory",
        "pending_working_directory",
      ]),
    );
    expect(columnNames()).not.toEqual(expect.arrayContaining(["project_root"]));
    expect(columnNames()).not.toContain("project_directory");
    expect(columnNames()).not.toContain("pending_project_root");
    expect(
      getDatabase()
        .prepare(
          "SELECT id, working_directory, workspace_directory, pending_working_directory FROM session ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "bound",
        working_directory: "/repo/a",
        workspace_directory: "/repo/a",
        pending_working_directory: null,
      },
      {
        id: "moving",
        working_directory: "/repo/a",
        workspace_directory: "/repo/b",
        pending_working_directory: "/repo/b",
      },
      {
        id: "unbound",
        working_directory: "/repo/a",
        workspace_directory: null,
        pending_working_directory: null,
      },
    ]);
    expect(readSessionRow(getDatabase(), "moving")).toMatchObject({
      workingDirectory: "/repo/a",
      workspaceDirectory: "/repo/b",
      pendingWorkingDirectory: "/repo/b",
    });
    const backups = (await readdir(directory)).filter((name) =>
      name.endsWith(".backup"),
    );
    expect(backups).toHaveLength(1);
    const backup = new NodeSqliteConnection(join(directory, backups[0]));
    try {
      expect(
        backup
          .prepare(
            "SELECT project_root, project_directory, pending_project_root FROM session WHERE id='moving'",
          )
          .get(),
      ).toEqual({
        project_root: "/repo/a",
        project_directory: "/repo/b",
        pending_project_root: "/repo/b",
      });
      expect(backup.prepare("SELECT count(*) n FROM migration").get()).toEqual({
        n: 25,
      });
      expect(backup.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      backup.close();
    }
    closeDatabase();
    initDatabase({ dbPath });
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".backup")),
    ).toEqual(backups);
  });

  it("blocks upgrade for a live other daemon before changing the schema", async () => {
    const writer = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) =>
      writer.once("exit", () => {
        resolve();
      }),
    );
    try {
      await writeDaemonPid(
        JSON.stringify({ pid: writer.pid, startedAt: 1, token: "old-daemon" }),
      );
      expect(() =>
        createPersistentUiBackendClient({ dbPath, workdir: directory }),
      ).toThrow(DatabaseUpgradeBlockedError);
      const untouched = new NodeSqliteConnection(dbPath);
      try {
        expect(
          untouched.prepare("SELECT count(*) n FROM migration").get(),
        ).toEqual({ n: 25 });
        expect(
          untouched
            .prepare<{ name: string }>("PRAGMA table_info(session)")
            .all()
            .map((column) => column.name),
        ).toContain("project_root");
      } finally {
        untouched.close();
      }
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".backup")),
      ).toEqual([]);
    } finally {
      writer.kill("SIGKILL");
      await exited;
    }
  });

  it.each(["missing", "self", "invalid", "partial"])(
    "upgrades with a %s daemon PID",
    async (kind) => {
      if (kind !== "missing")
        await writeDaemonPid(
          kind === "self"
            ? JSON.stringify({ pid: process.pid, startedAt: 1, token: "self" })
            : kind === "partial"
              ? `${String(process.pid)}bad`
              : "not-a-pid",
        );
      const client = createPersistentUiBackendClient({
        dbPath,
        workdir: directory,
      });
      try {
        expect(columnNames()).toContain("working_directory");
      } finally {
        await client.dispose();
      }
    },
  );
});

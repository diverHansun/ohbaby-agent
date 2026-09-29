import { spawn } from "node:child_process";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersistentUiBackendClient } from "../../adapters/ui-persistent.js";
import type { LLMClientInstance } from "../../core/llm-client/index.js";
import type { InterfaceProviderStreamEvent } from "../interface-providers/types.js";
import { closeDatabase, getDatabase, initDatabase } from "./index.js";
import { NodeSqliteConnection } from "./connection.js";
import { INITIAL_MIGRATIONS } from "./migrations.js";

const legacy = INITIAL_MIGRATIONS.filter((m) => m.version < "022");
const upgrade = INITIAL_MIGRATIONS.find(
  (m) => m.version === "022_retained_prompt_admission",
);
if (!upgrade) throw new Error("Missing retained admission migration");
describe("offline retained queue migration", () => {
  let directory: string;
  let dbPath: string;
  let backupPath: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "retained-upgrade-"));
    dbPath = join(directory, "legacy.db");
    backupPath = join(directory, "pre-upgrade.db");
    initDatabase({ dbPath, migrations: legacy });
    getDatabase().exec("PRAGMA wal_autocheckpoint=0");
    getDatabase()
      .prepare(
        "INSERT INTO session(id,project_id,project_root,title,status,created_at,updated_at,data) VALUES('s','p','/w','fixture','active',1,1,'{}')",
      )
      .run();
    getDatabase()
      .prepare(
        `INSERT INTO prompt_submission(prompt_id,scope_key,session_id,user_message_id,text,status,created_at,updated_at,client_request_id,reasoning_data,edit_lease_id,edit_lease_owner_id,edit_lease_expires_at)
      VALUES('q','/w','s','m','keep','queued',10,10,'request','{"enabled":true}','lease','client',20)`,
      )
      .run();
  });
  afterEach(async () => {
    closeDatabase();
    await rm(directory, { recursive: true, force: true });
  });

  function seedLegacyChild(): void {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO run_ledger(run_id,session_id,context_scope_id,trigger,status,created_at,started_at) VALUES('old-root','s',NULL,'user','running',1,2),('old-child','s','child','user','running',2,3),('finished-root','s',NULL,'user','succeeded',1,2)",
    ).run();
    for (const [id, status, root] of [
      ["old-current", "running", "old-root"],
      ["old-pending", "queued", "old-root"],
      ["finished", "completed", "finished-root"],
    ] as const)
      db.prepare(
        `INSERT INTO subagent_execution(execution_id,request_id,parent_session_id,requester_scope_id,requester_run_id,root_session_id,root_run_id,subagent_id,mode,prompt,created_at,status,child_session_id,child_scope_id,child_run_id,started_at,completed_at,updated_at,artifact,delivery)
        VALUES(?,?,'s','primary',?,'s',?,?,'background',?,1,?,?,?,?,?,?,2,'{"state":"none"}','{"state":"none"}')`,
      ).run(
        id,
        id,
        root,
        root,
        id === "finished" ? "done-instance" : "old-instance",
        `${id} prompt`,
        status,
        id === "old-current" ? "s" : null,
        id === "old-current" ? "child" : null,
        id === "old-current" ? "old-child" : null,
        status === "queued" ? null : 2,
        status === "completed" ? 4 : null,
      );
    db.prepare(
      `INSERT INTO subagent_instance(subagent_id,session_id,context_scope_id,parent_session_id,role,initial_prompt,status,pending_queue,current_input,current_run_id,created_at,updated_at)
      VALUES('old-instance','s','child','s','generic','old-current prompt','running',?,?,'old-child',1,2)`,
    ).run(
      JSON.stringify([
        {
          executionId: "old-pending",
          rootRunId: "old-root",
          prompt: "old-pending prompt",
        },
      ]),
      JSON.stringify({
        executionId: "old-current",
        rootRunId: "old-root",
        prompt: "old-current prompt",
      }),
    );
    db.prepare(
      `INSERT INTO subagent_instance(subagent_id,session_id,context_scope_id,parent_session_id,role,initial_prompt,status,pending_queue,current_input,last_run_id,output,created_at,updated_at,completed_at)
      VALUES('done-instance','s','finished-child','s','generic','finished prompt','completed','[ ]',NULL,'finished-run','original complete output',1,4,4)`,
    ).run();
  }

  it("retires offline ownerless child current and pending eligibility without changing terminal audit records", () => {
    seedLegacyChild();
    const db = getDatabase();
    const completed = db
      .prepare("SELECT * FROM subagent_execution WHERE execution_id='finished'")
      .get();
    const completedInstance = db
      .prepare(
        "SELECT * FROM subagent_instance WHERE subagent_id='done-instance'",
      )
      .get();
    initDatabase({ dbPath, migrationBackupPath: backupPath });
    closeDatabase();
    initDatabase({ dbPath });
    expect(
      getDatabase()
        .prepare(
          "SELECT status,current_input,current_run_id,last_run_id,pending_queue,owner_id,owner_pid FROM subagent_instance WHERE subagent_id='old-instance'",
        )
        .get(),
    ).toEqual({
      status: "interrupted",
      current_input: null,
      current_run_id: null,
      last_run_id: "old-child",
      pending_queue: "[]",
      owner_id: null,
      owner_pid: null,
    });
    for (const id of ["old-current", "old-pending"])
      expect(
        getDatabase()
          .prepare(
            "SELECT status,prompt,reason,artifact,delivery FROM subagent_execution WHERE execution_id=?",
          )
          .get(id),
      ).toEqual({
        status: "interrupted",
        prompt: `${id} prompt`,
        reason: "process-interrupted",
        artifact: '{"state":"none"}',
        delivery: '{"state":"none"}',
      });
    expect(
      getDatabase()
        .prepare(
          "SELECT * FROM subagent_execution WHERE execution_id='finished'",
        )
        .get(),
    ).toEqual(completed);
    expect(
      getDatabase()
        .prepare(
          "SELECT * FROM subagent_instance WHERE subagent_id='done-instance'",
        )
        .get(),
    ).toEqual(completedInstance);
    const backup = new NodeSqliteConnection(backupPath);
    try {
      expect(
        backup
          .prepare(
            "SELECT status,current_input,pending_queue FROM subagent_instance WHERE subagent_id='old-instance'",
          )
          .get(),
      ).toMatchObject({
        status: "running",
        current_input: expect.stringContaining("old-current") as unknown,
        pending_queue: expect.stringContaining("old-pending") as unknown,
      });
    } finally {
      backup.close();
    }
  });

  it("enters and sends once after schema commit and restart with ownerless child inputs", async () => {
    seedLegacyChild();
    getDatabase()
      .prepare(
        "UPDATE session SET project_root=?,agent='primary',data=? WHERE id='s'",
      )
      .run(directory, JSON.stringify({ reasoning: { enabled: false } }));
    getDatabase()
      .prepare("UPDATE prompt_submission SET scope_key=?")
      .run(directory);
    initDatabase({ dbPath, migrationBackupPath: backupPath });
    closeDatabase(); // Lost process after migration, before any session recovery.
    const streamResponse = vi.fn(
      (): Promise<AsyncIterable<InterfaceProviderStreamEvent>> =>
        Promise.resolve(
          (async function* (): AsyncGenerator<InterfaceProviderStreamEvent> {
            yield await Promise.resolve({
              textDelta: "fresh request only",
              finishReason: "stop",
            });
          })(),
        ),
    );
    const llmClient: LLMClientInstance = {
      provider: {
        id: "fake",
        kind: "openai-compatible",
        client: {},
        streamResponse,
        isAbortError: () => false,
      },
      config: {
        provider: "fake",
        model: "fake-model",
        apiKeyEnv: "FAKE_API_KEY",
        baseUrl: "https://example.invalid",
        interfaceProvider: "openai-compatible",
        temperature: 0,
        maxTokens: 128,
        modelProfiles: [
          {
            model: "fake-model",
            contextWindowTokens: 128000,
            reasoningCapabilities: {
              mode: "none",
              wire: "none",
              supportsDisabled: true,
            },
          },
        ],
      },
    };
    const client = createPersistentUiBackendClient({
      dbPath,
      workdir: directory,
      llmClient,
    });
    try {
      await client.initializeSession("s");
      if (!client.getSessionView)
        throw new Error("Session recovery view is unavailable");
      expect(
        (await client.getSessionView({ sessionId: "s" })).executionRecovery,
      ).toEqual({ status: "ready" });
      expect(streamResponse).not.toHaveBeenCalled();
      const completed = await client.submitPromptAndWait(
        "new independent request",
        { sessionId: "s" },
      );
      expect(completed.prompt.status).toBe("succeeded");
      expect(streamResponse).toHaveBeenCalledTimes(1);
      expect(
        getDatabase()
          .prepare("SELECT status FROM prompt_submission WHERE prompt_id='q'")
          .get(),
      ).toEqual({ status: "retained" });
      expect(
        getDatabase()
          .prepare(
            "SELECT status,pending_queue,current_input FROM subagent_instance WHERE subagent_id='old-instance'",
          )
          .get(),
      ).toEqual({
        status: "interrupted",
        pending_queue: "[]",
        current_input: null,
      });
    } finally {
      await client.dispose();
    }
  });

  it.each(["rootRunId", "childRunId"])(
    "uses exact %s evidence for legacy inputs and preserves unrelated pending content",
    (identity) => {
      seedLegacyChild();
      const db = getDatabase();
      db.prepare(
        "UPDATE subagent_instance SET current_input=?,pending_queue=? WHERE subagent_id='old-instance'",
      ).run(
        JSON.stringify({
          prompt: "old-current prompt",
          ...(identity === "rootRunId" ? { rootRunId: "old-root" } : {}),
        }),
        JSON.stringify([
          { rootRunId: "old-root", prompt: "old-pending prompt" },
          {
            executionId: "finished",
            rootRunId: "finished-root",
            prompt: "belongs to a different instance",
          },
          { prompt: "legacy unknown identity" },
        ]),
      );
      if (identity === "rootRunId")
        db.prepare(
          "UPDATE subagent_instance SET current_run_id=NULL WHERE subagent_id='old-instance'",
        ).run();
      initDatabase({ dbPath, migrationBackupPath: backupPath });
      const row = getDatabase()
        .prepare<{
          status: string;
          current_input: string | null;
          pending_queue: string;
        }>(
          "SELECT status,current_input,pending_queue FROM subagent_instance WHERE subagent_id='old-instance'",
        )
        .get();
      expect(row).toMatchObject({ status: "interrupted", current_input: null });
      expect(JSON.parse(row?.pending_queue ?? "null")).toEqual([
        {
          executionId: "finished",
          rootRunId: "finished-root",
          prompt: "belongs to a different instance",
        },
        { prompt: "legacy unknown identity" },
      ]);
    },
  );

  it("does not parse malformed child input or infer current-run identity from another child scope", () => {
    seedLegacyChild();
    const db = getDatabase();
    db.prepare(
      "UPDATE subagent_instance SET current_input='{malformed',pending_queue='[malformed' WHERE subagent_id='old-instance'",
    ).run();
    db.prepare(
      "UPDATE subagent_instance SET current_input=?,current_run_id='old-child',status='running' WHERE subagent_id='done-instance'",
    ).run(JSON.stringify({ prompt: "unknown input" }));
    const before = db
      .prepare("SELECT * FROM subagent_instance ORDER BY subagent_id")
      .all();
    initDatabase({ dbPath, migrationBackupPath: backupPath });
    expect(
      getDatabase()
        .prepare("SELECT * FROM subagent_instance ORDER BY subagent_id")
        .all(),
    ).toEqual(before);
  });

  it("retires an old pending child even when its root was already terminal", () => {
    seedLegacyChild();
    getDatabase()
      .prepare(
        "UPDATE run_ledger SET status='succeeded',ended_at=4 WHERE run_id='old-root'",
      )
      .run();
    getDatabase()
      .prepare(
        "UPDATE subagent_instance SET status='pending',current_input=NULL,current_run_id=NULL WHERE subagent_id='old-instance'",
      )
      .run();
    const root = getDatabase()
      .prepare("SELECT * FROM run_ledger WHERE run_id='old-root'")
      .get();
    initDatabase({ dbPath, migrationBackupPath: backupPath });
    expect(
      getDatabase()
        .prepare(
          "SELECT status,pending_queue FROM subagent_instance WHERE subagent_id='old-instance'",
        )
        .get(),
    ).toEqual({ status: "interrupted", pending_queue: "[]" });
    expect(
      getDatabase()
        .prepare(
          "SELECT status FROM subagent_execution WHERE execution_id='old-pending'",
        )
        .get(),
    ).toEqual({ status: "interrupted" });
    expect(
      getDatabase()
        .prepare("SELECT * FROM run_ledger WHERE run_id='old-root'")
        .get(),
    ).toMatchObject(root ?? {});
  });

  it("backs up committed WAL before atomically retaining legacy queued rows", async () => {
    expect((await stat(dbPath + "-wal")).size).toBeGreaterThan(0);
    const paths: string[] = [];
    initDatabase({
      dbPath,
      migrationBackupPath: backupPath,
      onMigrationBackup: (path) => paths.push(path),
    });
    expect(paths).toEqual([backupPath]);
    const backup = new NodeSqliteConnection(backupPath);
    try {
      expect(
        backup.prepare("SELECT status,text FROM prompt_submission").get(),
      ).toEqual({ status: "queued", text: "keep" });
      expect(backup.prepare("SELECT count(*) n FROM migration").get()).toEqual({
        n: 21,
      });
      expect(backup.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
    } finally {
      backup.close();
    }
    expect(
      getDatabase()
        .prepare(
          "SELECT status,created_at,accepted_at,owner_id,reasoning_data,edit_lease_id FROM prompt_submission",
        )
        .get(),
    ).toEqual({
      status: "retained",
      created_at: 10,
      accepted_at: 10,
      owner_id: null,
      reasoning_data: '{"enabled":true}',
      edit_lease_id: "lease",
    });
    expect(getDatabase().pragma("foreign_key_check")).toEqual([]);
    initDatabase({
      dbPath,
      migrationBackupPath: backupPath,
      onMigrationBackup: (path) => paths.push(path),
    });
    expect(paths).toEqual([backupPath]);
  });

  it("restores the offline backup to the original path after the upgraded database is closed", async () => {
    seedLegacyChild();
    const instances = getDatabase()
      .prepare("SELECT * FROM subagent_instance ORDER BY subagent_id")
      .all();
    const executions = getDatabase()
      .prepare("SELECT * FROM subagent_execution ORDER BY execution_id")
      .all();
    initDatabase({ dbPath, migrationBackupPath: backupPath });
    expect(
      getDatabase()
        .prepare("SELECT status FROM prompt_submission WHERE prompt_id='q'")
        .get(),
    ).toEqual({ status: "retained" });
    closeDatabase();
    // Restore only while every fixture connection is closed, including WAL sidecars.
    await rm(dbPath + "-wal", { force: true });
    await rm(dbPath + "-shm", { force: true });
    await copyFile(backupPath, dbPath);
    const restored = new NodeSqliteConnection(dbPath);
    try {
      expect(
        restored.prepare("SELECT count(*) n FROM migration").get(),
      ).toEqual({ n: 21 });
      expect(
        restored
          .prepare<{ name: string }>("PRAGMA table_info(prompt_submission)")
          .all()
          .some((column) => column.name === "accepted_at"),
      ).toBe(false);
      expect(
        restored
          .prepare(
            "SELECT status,owner_id,owner_pid,text FROM prompt_submission WHERE prompt_id='q'",
          )
          .get(),
      ).toEqual({
        status: "queued",
        owner_id: null,
        owner_pid: null,
        text: "keep",
      });
      expect(
        restored
          .prepare(
            "SELECT status,owner_id,owner_pid FROM run_ledger WHERE run_id='old-root'",
          )
          .get(),
      ).toEqual({ status: "running", owner_id: null, owner_pid: null });
      expect(
        restored
          .prepare("SELECT * FROM subagent_instance ORDER BY subagent_id")
          .all(),
      ).toEqual(instances);
      expect(
        restored
          .prepare("SELECT * FROM subagent_execution ORDER BY execution_id")
          .all(),
      ).toEqual(executions);
      expect(restored.pragma("integrity_check")).toEqual([
        { integrity_check: "ok" },
      ]);
      expect(restored.pragma("foreign_key_check")).toEqual([]);
    } finally {
      restored.close();
    }
  });

  it("refuses migration while a known old writer process lives, then succeeds after exit", async () => {
    const writer = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    const exited = new Promise<void>((resolve) =>
      writer.once("exit", () => {
        resolve();
      }),
    );
    try {
      getDatabase()
        .prepare(
          "INSERT INTO run_ledger(run_id,session_id,trigger,status,created_at,owner_id,owner_pid) VALUES('r','s','user','running',1,'old',?)",
        )
        .run(writer.pid ?? -1);
      expect(() => {
        initDatabase({ dbPath, migrationBackupPath: backupPath });
      }).toThrow(/writer|offline/i);
      expect(
        getDatabase().prepare("SELECT status FROM prompt_submission").get(),
      ).toEqual({ status: "queued" });
      writer.kill("SIGTERM");
      await exited;
      initDatabase({ dbPath, migrationBackupPath: backupPath });
      expect(
        getDatabase().prepare("SELECT status FROM prompt_submission").get(),
      ).toEqual({ status: "retained" });
      // Already migrated same-version initialization does not reject active owners.
      getDatabase()
        .prepare("UPDATE run_ledger SET owner_pid=?,status='running'")
        .run(process.pid);
      expect(() => {
        initDatabase({ dbPath });
      }).not.toThrow();
    } finally {
      if (writer.exitCode === null && writer.signalCode === null)
        writer.kill("SIGKILL");
      await exited;
    }
  });

  it("rolls schema, retained conversion and version back together after SQL failure", () => {
    seedLegacyChild();
    const instances = getDatabase()
      .prepare("SELECT * FROM subagent_instance ORDER BY subagent_id")
      .all();
    const executions = getDatabase()
      .prepare("SELECT * FROM subagent_execution ORDER BY execution_id")
      .all();
    expect(() => {
      initDatabase({
        dbPath,
        migrationBackupPath: backupPath,
        migrations: [
          ...legacy,
          { ...upgrade, sql: upgrade.sql + "\nINVALID SQL;" },
        ],
      });
    }).toThrow();
    expect(
      getDatabase()
        .prepare("SELECT * FROM subagent_instance ORDER BY subagent_id")
        .all(),
    ).toEqual(instances);
    expect(
      getDatabase()
        .prepare("SELECT * FROM subagent_execution ORDER BY execution_id")
        .all(),
    ).toEqual(executions);
    expect(
      getDatabase().prepare("SELECT status FROM prompt_submission").get(),
    ).toEqual({ status: "queued" });
    expect(
      getDatabase()
        .prepare("SELECT version FROM migration WHERE version=?")
        .get(upgrade.version),
    ).toBeUndefined();
    expect(
      getDatabase()
        .prepare<{ name: string }>("PRAGMA table_info(prompt_submission)")
        .all()
        .some((column) => column.name === "accepted_at"),
    ).toBe(false);
    initDatabase({
      dbPath,
      migrationBackupPath: join(directory, "retry-backup.db"),
    });
    expect(
      getDatabase().prepare("SELECT status FROM prompt_submission").get(),
    ).toEqual({ status: "retained" });
  });

  it("seals ownerless and dead-owner legacy activity durably before recovery can restart", () => {
    const db = getDatabase();
    for (const [id, owner, pid] of [
      ["unknown", null, null],
      ["dead", "old", -1],
    ] as const) {
      db.prepare(
        "INSERT INTO run_ledger(run_id,session_id,trigger,status,created_at,started_at,owner_id,owner_pid) VALUES(?,'s','user','running',1,2,?,?)",
      ).run(id, owner, pid);
      db.prepare(
        "INSERT INTO prompt_submission(prompt_id,scope_key,session_id,user_message_id,text,status,run_id,owner_id,owner_pid,created_at,updated_at) VALUES(?,'/w','s',?,'active','running',?,?,?,1,2)",
      ).run(`p-${id}`, `m-${id}`, id, owner, pid);
    }
    db.prepare(
      "INSERT INTO run_ledger(run_id,session_id,trigger,status,created_at,started_at,ended_at,error,inputs_closed_at,inputs_close_reason) VALUES('done','s','user','succeeded',1,2,3,'original',3,'completed')",
    ).run();
    db.prepare(
      "INSERT INTO prompt_submission(prompt_id,scope_key,session_id,user_message_id,text,status,run_id,created_at,updated_at,started_at,ended_at) VALUES('p-done','/w','s','m-done','completed','succeeded','done',1,3,2,3)",
    ).run();
    const completedRun = db
      .prepare("SELECT * FROM run_ledger WHERE run_id='done'")
      .get();
    const completedPrompt = db
      .prepare("SELECT * FROM prompt_submission WHERE prompt_id='p-done'")
      .get();
    initDatabase({ dbPath, migrationBackupPath: backupPath });
    // Simulate process loss immediately after schema commit, before runtime recovery.
    closeDatabase();
    initDatabase({ dbPath });
    for (const id of ["unknown", "dead"]) {
      expect(
        getDatabase()
          .prepare(
            "SELECT status,end_time_source,inputs_close_reason,ended_at FROM run_ledger WHERE run_id=?",
          )
          .get(id),
      ).toEqual({
        status: "interrupted",
        end_time_source: "recovery",
        inputs_close_reason: "process-interrupted",
        ended_at: expect.any(Number) as unknown,
      });
      expect(
        getDatabase()
          .prepare(
            "SELECT status,end_time_source,ended_at FROM prompt_submission WHERE prompt_id=?",
          )
          .get(`p-${id}`),
      ).toEqual({
        status: "interrupted",
        end_time_source: "recovery",
        ended_at: expect.any(Number) as unknown,
      });
    }
    expect(
      getDatabase()
        .prepare("SELECT * FROM run_ledger WHERE run_id='done'")
        .get(),
    ).toMatchObject(completedRun ?? {});
    expect(
      getDatabase()
        .prepare("SELECT * FROM prompt_submission WHERE prompt_id='p-done'")
        .get(),
    ).toMatchObject(completedPrompt ?? {});
    expect(
      getDatabase()
        .prepare(
          "SELECT prompt_id FROM prompt_submission WHERE status='queued'",
        )
        .all(),
    ).toEqual([]);
    expect(
      getDatabase()
        .prepare(
          "SELECT owner_id,owner_pid FROM prompt_submission WHERE prompt_id='p-unknown'",
        )
        .get(),
    ).toEqual({ owner_id: null, owner_pid: null });
  });

  it("preserves every old constraint and rejects unknown states", () => {
    getDatabase()
      .prepare("UPDATE prompt_submission SET status='steered',steer_receipt=?")
      .run(JSON.stringify({ clientRequestId: "steer" }));
    initDatabase({ dbPath, migrationBackupPath: backupPath });
    const db = getDatabase();
    expect(
      db.prepare("SELECT status,steer_receipt FROM prompt_submission").get(),
    ).toEqual({
      status: "steered",
      steer_receipt: '{"clientRequestId":"steer"}',
    });
    expect(() =>
      db.prepare("UPDATE prompt_submission SET status='mystery'").run(),
    ).toThrow();
    const indexes = db
      .prepare<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='index'",
      )
      .all()
      .map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_prompt_submission_scope_client_request",
        "idx_prompt_steer_request",
        "idx_prompt_submission_scope_status_order",
        "idx_prompt_submission_session_status_order",
        "idx_subagent_execution_child_run",
      ]),
    );
    expect(
      db.prepare("PRAGMA foreign_key_list(prompt_submission)").all(),
    ).toEqual([
      expect.objectContaining({ table: "session", on_delete: "CASCADE" }),
    ]);
  });

  it("fresh and upgraded schemas match without manufacturing messages", () => {
    initDatabase({ dbPath, migrationBackupPath: backupPath });
    const schema = getDatabase()
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name",
      )
      .all();
    closeDatabase();
    initDatabase({ dbPath: join(directory, "fresh.db") });
    expect(
      getDatabase()
        .prepare(
          "SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name",
        )
        .all(),
    ).toEqual(schema);
    expect(
      getDatabase().prepare("SELECT COUNT(*) n FROM prompt_submission").get(),
    ).toEqual({ n: 0 });
  });
});

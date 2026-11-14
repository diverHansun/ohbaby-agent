import { afterEach, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../database/index.js";
import { DatabaseShellJobStore } from "../../tools/shell-job-store.js";
import { ShellJobRecovery } from "../../tools/shell-job-recovery.js";
import { assertRewindShellOwners } from "./rewind-shell.js";
import { SessionRunBusyError } from "../../runtime/run-ledger/errors.js";

afterEach(() => {
  closeDatabase();
});

it.each([
  { tool: "task_output", taskAction: undefined, allowed: true },
  { tool: "task_kill", taskAction: undefined, allowed: true },
  { tool: "task", taskAction: "output", allowed: true },
  { tool: "task", taskAction: "stop", allowed: true },
  { tool: "task", taskAction: "list", allowed: false },
  { tool: "task", taskAction: undefined, allowed: false },
  { tool: "task", taskAction: "stop", cleanup: "unconfirmed", allowed: false },
  { tool: "task", taskAction: "stop", jobId: "another-job", allowed: false },
  {
    tool: "task",
    taskAction: "output",
    scope: "another-scope",
    allowed: false,
  },
  {
    tool: "task_kill",
    taskAction: undefined,
    scope: "another-scope",
    allowed: false,
  },
  {
    tool: "task",
    taskAction: "stop",
    sessionId: "another-session",
    allowed: false,
  },
])("checks cleanup receipt ownership and action: %j", (receipt) => {
  initDatabase({ dbPath: ":memory:" });
  const db = getDatabase();
  const insertSession = db.prepare(
    "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES(?,'p','/tmp','test','active',1,1,'{}')",
  );
  insertSession.run("s");
  insertSession.run("another-session");
  db.prepare(
    "INSERT INTO run_ledger(run_id,session_id,trigger,status,created_at,owner_pid,owner_id,context_scope_id) VALUES('r','s','user','succeeded',1,?,'foreign','scope')",
  ).run(process.pid);
  const insertMessage = db.prepare(
    "INSERT INTO message(id,session_id,context_scope_id,role,created_at,updated_at,data) VALUES(?,?,?,'assistant',1,1,?)",
  );
  insertMessage.run("start", "s", "scope", JSON.stringify({ runId: "r" }));
  insertMessage.run(
    "receipt",
    receipt.sessionId ?? "s",
    receipt.scope ?? "scope",
    "{}",
  );
  const insertPart = db.prepare(
    "INSERT INTO part(id,message_id,session_id,type,created_at,updated_at,data) VALUES(?,?,?,'tool',1,1,?)",
  );
  insertPart.run(
    "start-part",
    "start",
    "s",
    JSON.stringify({
      tool: "bash",
      state: {
        input: { run_in_background: true },
        metadata: { jobId: "job", cleanup: "unconfirmed" },
      },
    }),
  );
  const assertOwners = (): void => {
    assertRewindShellOwners(db, "s", ["r"], "current");
  };
  expect(assertOwners).toThrow(SessionRunBusyError);
  insertPart.run(
    "receipt-part",
    "receipt",
    receipt.sessionId ?? "s",
    JSON.stringify({
      tool: receipt.tool,
      state: {
        metadata: {
          jobId: receipt.jobId ?? "job",
          taskAction: receipt.taskAction,
          cleanup: receipt.cleanup ?? "confirmed",
        },
      },
    }),
  );
  if (receipt.allowed) expect(assertOwners).not.toThrow();
  else expect(assertOwners).toThrow(SessionRunBusyError);
});

it("defers to persisted shell job ownership instead of conflicting legacy receipts", async () => {
  initDatabase({ dbPath: ":memory:" });
  const db = getDatabase();
  db.prepare(
    "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
  ).run();
  db.prepare(
    "INSERT INTO run_ledger(run_id,session_id,trigger,status,created_at,owner_pid,owner_id) VALUES('r','s','user','succeeded',1,?,'foreign')",
  ).run(process.pid);
  db.prepare(
    "INSERT INTO message(id,session_id,role,created_at,updated_at,data) VALUES('m','s','assistant',1,1,?)",
  ).run(JSON.stringify({ runId: "r" }));
  db.prepare(
    "INSERT INTO part(id,message_id,session_id,type,created_at,updated_at,data) VALUES('p','m','s','tool',1,1,?)",
  ).run(
    JSON.stringify({
      tool: "bash",
      state: { input: { run_in_background: true }, metadata: { jobId: "j" } },
    }),
  );
  db.prepare(
    "INSERT INTO shell_job(job_id,session_id,root_session_id,root_run_id,mode,command,cwd,shell,created_at,owner_pid,owner_id,status,output_bytes,output_truncated) VALUES('j','s','s','r','background','sleep','/tmp','/bin/sh',1,?,'foreign','running',0,0)",
  ).run(process.pid);
  db.prepare(
    "INSERT INTO part(id,message_id,session_id,type,order_index,created_at,updated_at,data) VALUES('receipt','m','s','tool',1,1,1,?)",
  ).run(
    JSON.stringify({
      tool: "task_output",
      state: { metadata: { jobId: "j", cleanup: "confirmed" } },
    }),
  );
  expect(() => {
    assertRewindShellOwners(db, "s", ["r"], "current");
  }).not.toThrow();
  const recovery = new ShellJobRecovery({
    store: new DatabaseShellJobStore({ db }),
    backend: { ownerId: "current", pid: process.pid, startToken: null },
  });
  await expect(recovery.assertCanManage("j")).rejects.toMatchObject({
    code: "SHELL_JOB_OTHER_BACKEND",
  });
});
it("blocks a live foreign owner with an unsettled persisted shell job", async () => {
  initDatabase({ dbPath: ":memory:" });
  const db = getDatabase();
  db.prepare(
    "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
  ).run();
  db.prepare(
    "INSERT INTO shell_job(job_id,session_id,root_session_id,root_run_id,mode,command,cwd,shell,created_at,owner_pid,owner_id,status,output_bytes,output_truncated) VALUES('j','s','s','r','background','sleep','/tmp','/bin/sh',1,?,'foreign','running',0,0)",
  ).run(process.pid);
  const recovery = new ShellJobRecovery({
    store: new DatabaseShellJobStore({ db }),
    backend: { ownerId: "current", pid: process.pid, startToken: null },
  });
  await expect(recovery.assertCanManage("j")).rejects.toMatchObject({
    code: "SHELL_JOB_OTHER_BACKEND",
  });
  db.prepare(
    "UPDATE shell_job SET status='completed',cleanup='confirmed',settled_at=2 WHERE job_id='j'",
  ).run();
  await expect(recovery.assertCanManage("j")).resolves.toBeUndefined();
});
it("blocks an unsettled child-run job owned by a live foreign backend", async () => {
  initDatabase({ dbPath: ":memory:" });
  const db = getDatabase();
  const insertSession = db.prepare(
    "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES(?,'p','/tmp','test','active',1,1,'{}')",
  );
  insertSession.run("parent");
  insertSession.run("child");
  db.prepare(
    `INSERT INTO subagent_execution(execution_id,request_id,parent_session_id,requester_scope_id,requester_run_id,root_session_id,root_run_id,subagent_id,mode,prompt,created_at,status,child_session_id,child_run_id,updated_at,artifact,delivery) VALUES('e','request','parent','scope','parent-run','parent','parent-run','agent','background','work',1,'running','child','child-run',1,'{}','{}')`,
  ).run();
  db.prepare(
    `INSERT INTO shell_job(job_id,session_id,root_session_id,root_run_id,run_id,mode,command,cwd,shell,created_at,owner_pid,owner_id,status,output_bytes,output_truncated) VALUES('j','child','parent','child-run','child-run','background','sleep','/tmp','/bin/sh',1,?,'foreign','running',0,0)`,
  ).run(process.pid);
  const store = new DatabaseShellJobStore({ db });
  const recovery = new ShellJobRecovery({
    store,
    backend: { ownerId: "current", pid: process.pid, startToken: null },
  });
  expect(store.listByRootRun("child-run")).toHaveLength(1);
  await expect(recovery.assertCanManage("j")).rejects.toMatchObject({
    code: "SHELL_JOB_OTHER_BACKEND",
  });
  db.prepare(
    "UPDATE shell_job SET status='completed',cleanup='confirmed',settled_at=2 WHERE job_id='j'",
  ).run();
  await expect(recovery.assertCanManage("j")).resolves.toBeUndefined();
});

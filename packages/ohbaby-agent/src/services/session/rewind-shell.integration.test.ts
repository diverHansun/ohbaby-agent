import { afterEach, expect, it } from "vitest";
import { closeDatabase, getDatabase, initDatabase } from "../database/index.js";
import { assertRewindShellOwners } from "./rewind-shell.js";

afterEach(() => {
  closeDatabase();
});
it("blocks rewind for a live foreign owner with an unsettled persisted shell job", () => {
  initDatabase({ dbPath: ":memory:" });
  const db = getDatabase();
  db.prepare(
    "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
  ).run();
  db.prepare(
    "INSERT INTO shell_job(job_id,session_id,root_session_id,root_run_id,mode,command,cwd,shell,created_at,owner_pid,owner_id,status,output_bytes,output_truncated) VALUES('j','s','s','r','background','sleep','/tmp','/bin/sh',1,?,'foreign','running',0,0)",
  ).run(process.pid);
  expect(() => {
    assertRewindShellOwners(db, "s", ["r"], "current");
  }).toThrow();
  db.prepare(
    "UPDATE shell_job SET status='completed',cleanup='confirmed',settled_at=2 WHERE job_id='j'",
  ).run();
  expect(() => {
    assertRewindShellOwners(db, "s", ["r"], "current");
  }).not.toThrow();
});
it("blocks rewind for an unsettled child-run job owned by a live foreign backend", () => {
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
  expect(() => {
    assertRewindShellOwners(db, "parent", ["parent-run"], "current");
  }).toThrow();
  db.prepare(
    "UPDATE shell_job SET status='completed',cleanup='confirmed',settled_at=2 WHERE job_id='j'",
  ).run();
  expect(() => {
    assertRewindShellOwners(db, "parent", ["parent-run"], "current");
  }).not.toThrow();
});

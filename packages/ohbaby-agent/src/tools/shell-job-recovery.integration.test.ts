import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { shellJobFixture } from "./fixtures/shell-job.js";
import {
  closeDatabase,
  getDatabase,
  initDatabase,
} from "../services/database/index.js";
import { readProcessIdentity } from "../shell/process-identity.js";
import { probeProcessTree } from "../shell/process.js";
import { ShellJobRecovery } from "./shell-job-recovery.js";
import { DatabaseShellJobStore } from "./shell-job-store.js";

async function startProcess(): Promise<ChildProcess> {
  const child = spawn("/bin/sleep", ["30"], {
    detached: true,
    stdio: "ignore",
  });
  await once(child, "spawn");
  return child;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "native shell recovery with SQLite",
  () => {
    it("recovers a registered group after its owner exits, without killing an unrelated process", async () => {
      initDatabase({ dbPath: ":memory:" });
      getDatabase()
        .prepare(
          "INSERT INTO session(id,project_id,working_directory,title,status,created_at,updated_at,data) VALUES('s','p','/tmp','test','active',1,1,'{}')",
        )
        .run();
      const children: ChildProcess[] = [];
      try {
        const owner = await startProcess();
        children.push(owner);
        const target = await startProcess();
        children.push(target);
        const unrelated = await startProcess();
        children.push(unrelated);
        if (!owner.pid || !target.pid) throw new Error("Process missing PID");
        const ownerIdentity = await readProcessIdentity(owner.pid);
        const targetIdentity = await readProcessIdentity(target.pid);
        const currentIdentity = await readProcessIdentity(process.pid);
        if (
          ownerIdentity.state !== "present" ||
          targetIdentity.state !== "present" ||
          currentIdentity.state !== "present"
        )
          throw new Error("Native process identity unavailable");
        const store = new DatabaseShellJobStore();
        await store.insert(
          shellJobFixture({
            ownerPid: owner.pid,
            ownerStartToken: ownerIdentity.startToken,
            pid: target.pid,
            pgid: target.pid,
            processStartToken: targetIdentity.startToken,
          }),
        );
        await stopProcess(owner);
        const recovery = new ShellJobRecovery({
          store,
          backend: {
            ownerId: "recovering",
            pid: process.pid,
            startToken: currentIdentity.startToken,
          },
        });
        const result = await recovery.recover("job");
        expect(result).toMatchObject({
          status: "lost",
          cleanup: "confirmed",
          outputComplete: false,
          noticeState: "pending",
          recoveryClaim: null,
        });
        expect(result.settledAt).not.toBeNull();
        expect(probeProcessTree(target)).toBe("stopped");
        expect(probeProcessTree(unrelated)).toBe("running");
      } finally {
        await Promise.all(children.map(stopProcess));
        closeDatabase();
      }
    });
  },
);

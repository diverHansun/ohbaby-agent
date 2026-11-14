import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { readProcessIdentity } from "./process-identity.js";

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "native process identity",
  () => {
    it("reads stable birth identity and process group, then observes its disappearance", async () => {
      const child = spawn("/bin/sleep", ["30"], {
        detached: true,
        stdio: "ignore",
      });
      const exited = once(child, "exit");
      try {
        await once(child, "spawn");
        const pid = child.pid;
        if (pid === undefined) throw new Error("Child has no PID after spawn");
        const first = await readProcessIdentity(pid);
        expect(first).toMatchObject({
          state: "present",
          pid: child.pid,
          pgid: child.pid,
        });
        expect(await readProcessIdentity(pid)).toEqual(first);
        child.kill("SIGTERM");
        await exited;
        expect(await readProcessIdentity(pid)).toEqual({
          state: "absent",
        });
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        await exited;
      }
    });
  },
);

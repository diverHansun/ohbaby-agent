import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { killTree, probeProcessTree } from "./process.js";

async function fixture(
  code: string,
): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  const child = spawn(process.execPath, ["-e", code], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await once(child.stdout, "data");
  return child;
}

async function reap(child: ChildProcess): Promise<void> {
  if (child.pid && probeProcessTree(child) !== "stopped") {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* Already gone. */
    }
  }
  if (child.exitCode === null && child.signalCode === null)
    await once(child, "exit");
  child.stdout?.destroy();
  child.stderr?.destroy();
}

describe.skipIf(process.platform === "win32")(
  "owned POSIX process groups",
  () => {
    it("confirms a real TERM-cooperative process group", async () => {
      const child = await fixture(
        'console.log("ready"); setInterval(() => {}, 1000);',
      );
      try {
        expect(await killTree(child)).toEqual({ status: "confirmed" });
        expect(child.signalCode).toBe("SIGTERM");
        expect(probeProcessTree(child)).toBe("stopped");
      } finally {
        await reap(child);
      }
    });

    it("escalates a TERM-ignoring process even after both output pipes close", async () => {
      const child = await fixture(`
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      console.log('ready');
      fs.closeSync(1); fs.closeSync(2);
      setInterval(() => {}, 1000);
    `);
      try {
        await Promise.all(
          [child.stdout, child.stderr].map(async (stream) => {
            stream.resume();
            if (!stream.readableEnded) await once(stream, "end");
          }),
        );
        expect(probeProcessTree(child)).toBe("running");
        expect(await killTree(child)).toEqual({ status: "confirmed" });
        expect(child.signalCode).toBe("SIGKILL");
      } finally {
        await reap(child);
      }
    });

    it("terminates a live same-group child after the group leader already exited", async () => {
      const child = await fixture(`
      const { spawn } = require('node:child_process');
      const c = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      c.once('message', () => { console.log('ready'); process.exit(0); });
    `);
      try {
        if (child.exitCode === null) await once(child, "exit");
        expect(child.exitCode).toBe(0);
        expect(probeProcessTree(child)).toBe("running");
        expect(await killTree(child, { exited: () => true })).toMatchObject({
          status: "confirmed",
        });
        expect(probeProcessTree(child)).toBe("stopped");
      } finally {
        await reap(child);
      }
    });

    it("confirms a stopped group while a separate fixture group keeps its pipes open", async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `
      const { spawn } = require('node:child_process');
      const c = spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      c.once('message', () => console.log(c.pid));
      setInterval(() => {}, 1000);
    `,
        ],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let helperPid: number | undefined;
      try {
        const data: unknown = (await once(child.stdout, "data"))[0];
        helperPid = Number(String(data).trim());
        expect(Number.isSafeInteger(helperPid)).toBe(true);
        const result = await killTree(child);
        expect(result.status).toBe("confirmed");
        expect(child.stdout.readableEnded).toBe(false);
        expect(probeProcessTree(child)).toBe("stopped");
      } finally {
        if (helperPid) {
          try {
            process.kill(-helperPid, "SIGKILL");
          } catch {
            /* Already gone. */
          }
        }
        await reap(child);
      }
    });
  },
);

it.skipIf(process.platform === "win32" || !existsSync("/bin/zsh"))(
  "confirms 50 owned zsh TERM fixtures without transient probe failures becoming final",
  async () => {
    for (let iteration = 0; iteration < 50; iteration += 1) {
      const child = spawn(
        "/bin/zsh",
        ["-c", 'printf "ready\\n"; sleep 30; echo x'],
        {
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      try {
        await once(child.stdout, "data");
        expect(
          await killTree(child),
          `owned fixture ${String(iteration)}`,
        ).toEqual({ status: "confirmed" });
        expect(probeProcessTree(child)).toBe("stopped");
      } finally {
        await reap(child);
      }
    }
  },
  30_000,
);

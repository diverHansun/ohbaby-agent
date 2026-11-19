import { afterEach, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { createTerminalPty, type TerminalPty } from "./pty.js";

import * as processTree from "./process-tree.js";
import { execFileSync } from "node:child_process";

const opened: TerminalPty[] = [];
const windows = process.platform === "win32";
// These tests exercise POSIX session inspection, process groups and signals.
const itPosix = it.skipIf(windows);
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((pty) => pty.terminate()));
});
async function open(shellPath = "/bin/sh"): Promise<{
  pty: TerminalPty;
  pid: number;
  shell: string;
  waitFor: (pattern: RegExp) => Promise<string>;
}> {
  const { pty, shell } = await createTerminalPty({
    directory: tmpdir(),
    cols: 80,
    rows: 24,
    env: { ...process.env, SHELL: shellPath, PS1: "" },
  });
  opened.push(pty);
  let output = "";
  pty.onData((data) => {
    output += data;
  });
  const waitFor = async (pattern: RegExp): Promise<string> => {
    const until = Date.now() + 5000;
    while (!pattern.test(output)) {
      if (Date.now() > until)
        throw new Error(
          `PTY output did not match ${String(pattern)}: ${output}`,
        );
      await delay(10);
    }
    return output;
  };
  if (!windows) {
    pty.write("stty -echo\r");
    return { pty, pid: pty.pid, shell, waitFor };
  }
  // ConPTY publishes its child PID after startup. Ask the running shell for it.
  const pidMarker = /PTY-(\d+)-PID/;
  pty.write("Write-Output ('PTY-{0}-PID' -f $PID)\r");
  const pid = Number(matchOutput(await waitFor(pidMarker), pidMarker)[1]);
  expect(pid).toBeGreaterThan(0);
  return { pty, pid, shell, waitFor };
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
it("runs actual UTF-8 commands in the requested directory and applies terminal size", async () => {
  const { pty, shell, waitFor } = await open();
  pty.resize(101, 35);
  if (windows) {
    expect(shell).toMatch(/^(?:pwsh|powershell)$/);
    pty.write(
      "Write-Output ('RESULT:{0}:{1}:{2}:中文' -f $PWD.Path, [Console]::WindowWidth, [Console]::WindowHeight)\r",
    );
    const output = await waitFor(/RESULT:.*:101:35:中文/);
    expect(output).toContain(`RESULT:${tmpdir()}:101:35:中文`);
    return;
  }
  expect(shell).toBe("sh");
  pty.write("printf 'RESULT:%s:中文\\n' \"$PWD\"; stty size\r");
  const output = await waitFor(/35 101/);
  expect(output).toContain(`RESULT:${tmpdir().replace(/\/$/, "")}:中文`);
});
it("reports a natural shell exit once with its actual code", async () => {
  const { pty, pid } = await open();
  const exits: number[] = [];
  pty.onExit(({ exitCode }) => exits.push(exitCode));
  pty.write("exit 7\r");
  await expect.poll(() => exits, { timeout: 5_000 }).toEqual([7]);
  await pty.terminate();
  expect(exits).toEqual([7]);
  await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
});
it("cleans a paused shell and shares simultaneous termination", async () => {
  const { pty, pid, waitFor } = await open();
  pty.write(
    windows ? "Write-Output ('RE' + 'ADY')\r" : "printf 'RE%s\\n' ADY\r",
  );
  await waitFor(/READY/);
  pty.pause();
  const first = pty.terminate();
  expect(pty.terminate()).toBe(first);
  await first;
  await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
});
itPosix("kills an ignoring child after the shell exits first, and frees its listening port", async () => {
  const { pty, waitFor } = await open();
  const command = `${JSON.stringify(process.execPath)} -e 'process.on("SIGHUP",()=>{});const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>console.log("CHILD:"+process.pid+":"+s.address().port));' &`;
  pty.write(command + "\r");
  const output = await waitFor(/CHILD:\d+:\d+/);
  const [, pidText, portText] = matchOutput(output, /CHILD:(\d+):(\d+)/);
  const child = Number(pidText);
  expect(await pty.inspectChildren()).toEqual(
    expect.arrayContaining([expect.objectContaining({ pid: child })]),
  );
  await pty.terminate();
  expect(alive(child)).toBe(false);
  expect(alive(pty.pid)).toBe(false);
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(portText), "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
});
itPosix("escalates when the shell itself ignores hangup", async () => {
  const { pty, waitFor } = await open();
  pty.write("trap '' HUP; printf 'TRAPPED\\n'\r");
  await waitFor(/TRAPPED\r?\n/);
  await pty.terminate();
  expect(alive(pty.pid)).toBe(false);
});

itPosix("retains captured children after failed cleanup so a later attempt can finish", async () => {
  const { pty, waitFor } = await open();
  pty.write(
    `${JSON.stringify(process.execPath)} -e 'process.on("SIGHUP",()=>{});setInterval(()=>{},1000);console.log("RETRY:"+process.pid)' &\r`,
  );
  const output = await waitFor(/RETRY:\d+/);
  const child = Number(matchOutput(output, /RETRY:(\d+)/)[1]);
  const signal = processTree.signalTerminalProcess;
  vi.spyOn(processTree, "signalTerminalProcess").mockImplementation(
    (member, kind) => {
      if (member.pid === child && kind === "SIGKILL")
        throw new Error("simulated permission failure");
      signal(member, kind);
    },
  );
  await expect(pty.terminate()).rejects.toThrow("Terminal cleanup failed");
  expect(alive(pty.pid)).toBe(false);
  expect(alive(child)).toBe(true);
  vi.restoreAllMocks();
  await pty.terminate();
  expect(alive(child)).toBe(false);
}, 10000);

function matchOutput(output: string, pattern: RegExp): RegExpExecArray {
  const match = pattern.exec(output);
  if (!match) throw new Error("Expected PTY output marker was missing");
  return match;
}

itPosix("cleans an observed background child after the shell naturally exits", async () => {
  const { pty, waitFor } = await open();
  pty.write(
    `${JSON.stringify(process.execPath)} -e 'process.on("SIGHUP",()=>{});setInterval(()=>{},1000);console.log("NATURAL:"+process.pid)' &\r`,
  );
  const output = await waitFor(/NATURAL:\d+/);
  const child = Number(matchOutput(output, /NATURAL:(\d+)/)[1]);
  expect(await pty.inspectChildren()).toEqual(
    expect.arrayContaining([expect.objectContaining({ pid: child })]),
  );
  const exited = new Promise<void>((resolve) => {
    pty.onExit(() => {
      resolve();
    });
  });
  pty.write("exit 0\r");
  await exited;
  expect(alive(pty.pid)).toBe(false);
  expect(alive(child)).toBe(true);
  await pty.terminate();
  expect(alive(child)).toBe(false);
});

itPosix.each(["/bin/sh", "/bin/zsh"])(
  "cleans unobserved jobs from %s after natural exit without touching another terminal or a detached process",
  async (shellPath) => {
    const { pty, waitFor } = await open(shellPath);
    const other = await open();
    if (shellPath === "/bin/zsh") pty.write("unsetopt CHECK_JOBS\r");
    const children: number[] = [];
    let detached = 0;
    const ports: number[] = [];
    try {
      for (const marker of ["FIRST", "SECOND"]) {
        pty.write(
          `${JSON.stringify(process.execPath)} -e 'process.on("SIGHUP",()=>{});const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>console.log("${marker}:"+process.pid+":"+s.address().port));' &\r`,
        );
        const output = await waitFor(new RegExp(`${marker}:\\d+:\\d+`));
        const match = matchOutput(
          output,
          new RegExp(`${marker}:(\\d+):(\\d+)`),
        );
        children.push(Number(match[1]));
        ports.push(Number(match[2]));
      }
      const groups = execFileSync(
        "/bin/ps",
        ["-p", children.join(","), "-o", "pgid="],
        { encoding: "utf8" },
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(new Set(groups).size).toBe(2);
      expect(groups).not.toContain(pty.pid);
      pty.write(
        `${JSON.stringify(process.execPath)} -e 'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});c.unref();console.log("DETACHED:"+c.pid)'\r`,
      );
      detached = Number(
        matchOutput(await waitFor(/DETACHED:\d+/), /DETACHED:(\d+)/)[1],
      );
      const exited = new Promise<void>((resolve) => {
        pty.onExit(() => {
          resolve();
        });
      });
      pty.write("exit 0\r");
      await exited;
      await pty.terminate();
      expect(children.map(alive)).toEqual([false, false]);
      expect(alive(other.pty.pid)).toBe(true);
      expect(alive(detached)).toBe(true);
      const { createServer } = await import("node:net");
      for (const port of ports) {
        const server = createServer();
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", resolve);
        });
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
      }
    } finally {
      for (const pid of [...children, detached])
        if (pid && alive(pid)) process.kill(pid, "SIGKILL");
    }
  },
  15000,
);

itPosix("leaves cleanup retryable when process-session inspection fails", async () => {
  const { pty } = await open();
  vi.spyOn(processTree, "readProcessTable").mockRejectedValue(
    new Error("session inspection unavailable"),
  );
  await expect(pty.terminate()).rejects.toThrow(
    "session inspection unavailable",
  );
  expect(alive(pty.pid)).toBe(true);
  vi.restoreAllMocks();
  await pty.terminate();
  expect(alive(pty.pid)).toBe(false);
});
itPosix("never reopens a session number after a complete scan proved it empty", async () => {
  const { pty } = await open();
  const other = await open();
  await pty.terminate();
  const unrelated = (await processTree.readProcessTable()).find(
    ({ pid }) => pid === other.pty.pid,
  );
  if (!unrelated) throw new Error("Other terminal must remain alive");
  vi.spyOn(processTree, "readProcessTable").mockResolvedValue([
    { ...unrelated, parentPid: 1, sessionId: pty.pid },
  ]);
  expect(await pty.inspectChildren()).toEqual([]);
  expect(alive(other.pty.pid)).toBe(true);
});

itPosix("rescans a seemingly empty session before sealing when a successor was absent from the first process sample", async () => {
  const { pty, waitFor } = await open();
  pty.write(
    `${JSON.stringify(process.execPath)} -e 'process.on("SIGHUP",()=>{});setInterval(()=>{},1000);console.log("SUCCESSOR:"+process.pid)' &\r`,
  );
  const child = Number(
    matchOutput(await waitFor(/SUCCESSOR:\d+/), /SUCCESSOR:(\d+)/)[1],
  );
  try {
    const exited = new Promise<void>((resolve) => {
      pty.onExit(() => {
        resolve();
      });
    });
    pty.write("exit 0\r");
    await exited;
    vi.spyOn(processTree, "readProcessTable").mockResolvedValueOnce([]);
    await pty.terminate();
    expect(alive(child)).toBe(false);
  } finally {
    vi.restoreAllMocks();
    if (alive(child)) process.kill(child, "SIGKILL");
  }
});

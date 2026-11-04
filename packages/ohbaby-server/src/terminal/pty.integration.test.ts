import { afterEach, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { createTerminalPty, type TerminalPty } from "./pty.js";

import * as processTree from "./process-tree.js";

const opened: TerminalPty[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((pty) => pty.terminate()));
});
async function open(): Promise<{
  pty: TerminalPty;
  shell: string;
  waitFor: (pattern: RegExp) => Promise<string>;
}> {
  const { pty, shell } = await createTerminalPty({
    directory: tmpdir(),
    cols: 80,
    rows: 24,
    env: { ...process.env, SHELL: "/bin/sh", PS1: "" },
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
  pty.write("stty -echo\r");
  return { pty, shell, waitFor };
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
  expect(shell).toBe("sh");
  pty.resize(101, 35);
  pty.write("printf 'RESULT:%s:中文\\n' \"$PWD\"; stty size\r");
  const output = await waitFor(/35 101/);
  expect(output).toContain(`RESULT:${tmpdir().replace(/\/$/, "")}:中文`);
});
it("reports a natural shell exit once with its actual code", async () => {
  const { pty } = await open();
  const exits: number[] = [];
  pty.onExit(({ exitCode }) => exits.push(exitCode));
  pty.write("exit 7\r");
  await expect.poll(() => exits).toEqual([7]);
  await pty.terminate();
  expect(exits).toEqual([7]);
  expect(alive(pty.pid)).toBe(false);
});
it("cleans a paused shell and shares simultaneous termination", async () => {
  const { pty, waitFor } = await open();
  pty.write("printf 'READY\\n'\r");
  await waitFor(/READY\r?\n/);
  pty.pause();
  const first = pty.terminate();
  expect(pty.terminate()).toBe(first);
  await first;
  expect(alive(pty.pid)).toBe(false);
});
it("kills an ignoring child after the shell exits first, and frees its listening port", async () => {
  const { pty, waitFor } = await open();
  const command = `${JSON.stringify(process.execPath)} -e 'process.on("SIGHUP",()=>{});const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>console.log("CHILD:"+process.pid+":"+s.address().port));' &`;
  pty.write(command + "\r");
  const output = await waitFor(/CHILD:\d+:\d+/);
  const [, pidText, portText] = matchOutput(output, /CHILD:(\d+):(\d+)/);
  const child = Number(pidText);
  expect(await pty.inspectChildren()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ pid: child, name: "node" }),
    ]),
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
it("escalates when the shell itself ignores hangup", async () => {
  const { pty, waitFor } = await open();
  pty.write("trap '' HUP; printf 'TRAPPED\\n'\r");
  await waitFor(/TRAPPED\r?\n/);
  await pty.terminate();
  expect(alive(pty.pid)).toBe(false);
});

it("retains captured children after failed cleanup so a later attempt can finish", async () => {
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

it("cleans an observed background child after the shell naturally exits", async () => {
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

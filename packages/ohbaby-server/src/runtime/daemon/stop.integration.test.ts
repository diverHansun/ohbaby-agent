import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import { stopDaemonFromState } from "./main.js";
import { resolveDaemonScope } from "./scope.js";

const sourceUrl = (path: string): string => pathToFileURL(resolve(path)).href;

async function reap(child: ChildProcess | undefined): Promise<void> {
  if (child?.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
}

it
  .skipIf(process.platform === "win32")
  .each(["SIGTERM", "SIGINT", "SIGHUP"] as const)(
  "waits for real %s process exit after cleanup rather than accepting the signal receipt",
  async (signal) => {
    const home = await mkdtemp(join(tmpdir(), "daemon-stop-confirm-"));
    const scope = await resolveDaemonScope({
      homeDirectory: home,
      workdir: home,
    });
    await mkdir(join(scope.pidFilePath, ".."), { recursive: true });
    const fixture = join(home, "daemon.mjs");
    const supervisorUrl = pathToFileURL(
      resolve("packages/ohbaby-server/src/runtime/daemon/supervisor.ts"),
    ).href;
    await writeFile(
      fixture,
      `import { Supervisor } from ${JSON.stringify(supervisorUrl)};
    const supervisor = new Supervisor({ pidFilePath: ${JSON.stringify(scope.pidFilePath)}, stateFilePath: ${JSON.stringify(scope.stateFilePath)}, bootstrap: () => ({ connection: {host:'127.0.0.1',port:1234,authToken:'fixture'}, start:async()=>{}, stop:()=>new Promise(resolve=>setTimeout(resolve,150)) }) });
    await supervisor.start(); setInterval(()=>{},1000); process.send('ready');`,
    );
    let child: ChildProcess | undefined;
    try {
      child = fork(fixture, [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      await once(child, "message");
      const started = Date.now();
      const result = await stopDaemonFromState({
        homeDirectory: home,
        workdir: home,
        kill: (pid) => process.kill(pid, signal),
        timeoutMs: 2000,
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(100);
      expect(result).toMatchObject({
        processExit: "confirmed",
        cleanup: "confirmed",
      });
    } finally {
      if (child?.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      await rm(home, { recursive: true, force: true });
    }
  },
  10000,
);

it.each([
  { mode: "clean", code: 0, phrase: "daemon stopped" },
  { mode: "incomplete", code: 1, phrase: "cleanup unconfirmed" },
  { mode: "unknown", code: 1, phrase: "cleanup unknown" },
  { mode: "alive", code: 1, phrase: "exit unconfirmed" },
  { mode: "absent", code: 0, phrase: "daemon not-running" },
])(
  "uses real authenticated HTTP and process exit for the CLI $mode result",
  async ({ mode, code, phrase }) => {
    const home = await mkdtemp(join(tmpdir(), "daemon-cli-confirm-"));
    const scope = await resolveDaemonScope({
      homeDirectory: home,
      workdir: home,
    });
    const daemonFixture = join(home, "daemon.mjs");
    const observerFixture = join(home, "observer.mjs");
    let daemon: ChildProcess | undefined;
    let observer: ChildProcess | undefined;
    try {
      await writeFile(
        daemonFixture,
        `
      import { createServer } from 'node:http';
      import { Supervisor } from ${JSON.stringify(sourceUrl("packages/ohbaby-server/src/runtime/daemon/supervisor.ts"))};
      const connection={host:'127.0.0.1',port:0,authToken:'fixture-token'};
      const server=createServer((req,res)=>{
        if(req.url!='/api/shutdown'||req.headers.authorization!='Bearer fixture-token'){res.writeHead(403);res.end();return;}
        res.end('accepted');
        if(${JSON.stringify(mode)}==='alive') return;
        if(${JSON.stringify(mode)}==='unknown') {setTimeout(()=>process.exit(0),80);return;}
        setImmediate(()=>void supervisor.stopAndExit());
      });
      const supervisor=new Supervisor({pidFilePath:${JSON.stringify(scope.pidFilePath)},stateFilePath:${JSON.stringify(scope.stateFilePath)},shutdownTimeoutMs:500,
        bootstrap:()=>({connection,start:async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));connection.port=server.address().port;},stop:async()=>{await new Promise(r=>setTimeout(r,100));server.close();return ${mode === "incomplete" ? "{status:'unconfirmed',errors:['raw child still active']}" : "{status:'confirmed',errors:[]}"};}})});
      await supervisor.start();setInterval(()=>{},1000);process.send('ready');
    `,
      );
      if (mode !== "absent") {
        daemon = fork(daemonFixture, [], {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        await once(daemon, "message");
      }
      await writeFile(
        observerFixture,
        `
      import { createServeCommand } from ${JSON.stringify(sourceUrl("packages/ohbaby-cli/src/cli/commands/serve.ts"))};
      import { stopDaemonFromState } from ${JSON.stringify(sourceUrl("packages/ohbaby-server/src/runtime/daemon/stop.ts"))};
      let code=0;
      const command=createServeCommand({stdout:process.stdout,stderr:process.stderr,setExitCode(value){code=value},stopDaemonFromState:()=>stopDaemonFromState({homeDirectory:${JSON.stringify(home)},workdir:${JSON.stringify(home)},timeoutMs:800})});
      await command.handler({action:'stop'});process.exitCode=code;
    `,
      );
      observer = fork(observerFixture, [], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "inherit", "ipc"],
      });
      let output = "";
      observer.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const [exitCode] = (await once(observer, "exit")) as readonly unknown[];
      expect(exitCode).toBe(code);
      expect(output).toContain(phrase);
      if (mode === "alive") expect(daemon?.exitCode).toBeNull();
      else if (daemon) {
        if (daemon.exitCode === null && daemon.signalCode === null)
          await once(daemon, "exit");
        expect(daemon.exitCode).toBe(mode === "incomplete" ? 1 : 0);
      }
    } finally {
      await reap(observer);
      await reap(daemon);
      await rm(home, { recursive: true, force: true });
    }
  },
  10000,
);

it("shares the host final-save deadline with an independent SQLite writer and confirms its failed exit externally", async () => {
  const home = await mkdtemp(join(tmpdir(), "daemon-locked-final-save-"));
  const scope = await resolveDaemonScope({
    homeDirectory: home,
    workdir: home,
  });
  const dbPath = join(home, "facts.db");
  const fixture = join(home, "daemon.mjs");
  let daemon: ChildProcess | undefined;
  let locker: ChildProcess | undefined;
  try {
    await writeFile(
      fixture,
      `
      import { Supervisor } from ${JSON.stringify(sourceUrl("packages/ohbaby-server/src/runtime/daemon/supervisor.ts"))};
      import { NodeSqliteConnection } from ${JSON.stringify(sourceUrl("packages/ohbaby-agent/src/services/database/connection.ts"))};
      import { beginDatabaseShutdown,runWriteTransaction } from ${JSON.stringify(sourceUrl("packages/ohbaby-agent/src/services/database/index.ts"))};
      const db=new NodeSqliteConnection(${JSON.stringify(dbPath)});db.exec('CREATE TABLE facts(value TEXT)');
      const supervisor=new Supervisor({pidFilePath:${JSON.stringify(scope.pidFilePath)},stateFilePath:${JSON.stringify(scope.stateFilePath)},shutdownTimeoutMs:900,
        bootstrap:()=>({connection:{host:'127.0.0.1',port:1234,authToken:'fixture'},start:async()=>{},stop:async(options)=>{
          beginDatabaseShutdown(options.deadlineAt,db);
          try {await runWriteTransaction(db,c=>c.prepare("INSERT INTO facts VALUES ('final')").run());}finally{db.close();}
        }})});
      await supervisor.start();process.on('message',()=>void supervisor.stopAndExit());process.send('ready');
    `,
    );
    daemon = fork(fixture, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    await once(daemon, "message");
    locker = fork(
      resolve(
        "packages/ohbaby-agent/src/services/database/testing/lock-holder.mjs",
      ),
      [dbPath, "2400"],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    await once(locker, "message");
    const started = Date.now();
    const result = await stopDaemonFromState({
      homeDirectory: home,
      workdir: home,
      timeoutMs: 1700,
      requestShutdown: () => {
        daemon?.send("stop");
        return Promise.resolve();
      },
    });
    expect(Date.now() - started).toBeLessThan(1600);
    expect(result.processExit).toBe("confirmed");
    // The same deadline also bounds report publication. A slow runner may
    // observe an exit after the report budget was exhausted.
    expect(["unconfirmed", "unknown"]).toContain(result.cleanup);
    if (result.cleanup === "unconfirmed") {
      expect(result.reason).toMatch(/deadline|shutdown/i);
    }
    if (daemon.exitCode === null && daemon.signalCode === null)
      await once(daemon, "exit");
    expect(daemon.exitCode).toBe(1);

    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const database = new DatabaseSync(dbPath, { readOnly: true });
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS writes FROM facts").get(),
      ).toEqual({ writes: 0 });
    } finally {
      database.close();
    }
  } finally {
    await reap(locker);
    await reap(daemon);
    await rm(home, { recursive: true, force: true });
  }
}, 10000);

async function childMessage(child: ChildProcess): Promise<unknown> {
  return Promise.race([
    once(child, "message").then(([message]) => message as unknown),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(
        `daemon fixture exited before responding: ${String(code ?? signal)}`,
      );
    }),
  ]);
}

it("sweeps legacy files, keeps a single report, and logs the unclean previous run after a forced exit", async () => {
  const home = await mkdtemp(join(tmpdir(), "daemon-cleanup-lifecycle-"));
  const profile = join(home, ".ohbaby");
  const server = join(profile, "server");
  const fixture = join(home, "daemon.mjs");
  let daemon: ChildProcess | undefined;
  try {
    await mkdir(server, { recursive: true });
    await Promise.all(
      [
        ...Array.from(
          { length: 5 },
          (_, i) => `daemon-state.json.shutdown-old-${String(i)}.json`,
        ),
        "daemon-state.json.123.tmp",
        "daemon-state.json.123.unique.tmp",
      ].map((filename) => writeFile(join(server, filename), "")),
    );
    await writeFile(
      fixture,
      `
      import { createProcessLogger } from ${JSON.stringify(sourceUrl("packages/ohbaby-agent/src/observability/process-logger.ts"))};
      import { startDaemonServer } from ${JSON.stringify(sourceUrl("packages/ohbaby-server/src/runtime/daemon/main.ts"))};
      const daemon = await startDaemonServer({
        workdir: ${JSON.stringify(home)},
        dbPath: ${JSON.stringify(join(home, "data.sqlite"))},
        host: "127.0.0.1", port: 0,
        diagnosticsFactory: (context) => createProcessLogger({ ...context, role: "serve" }),
      });
      process.send(daemon.diagnosticsFilePath);
    `,
    );
    const start = async (): Promise<string> => {
      daemon = fork(fixture, [], {
        env: { ...process.env, OHBABY_HOME: profile },
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      const path = await childMessage(daemon);
      expect(typeof path).toBe("string");
      return String(path);
    };
    const stop = async (signal?: NodeJS.Signals): Promise<void> => {
      if (!daemon) throw new Error("daemon fixture was never started");
      const exited = once(daemon, "exit");
      if (signal) {
        daemon.kill(signal);
      } else {
        await expect(
          stopDaemonFromState({ homeDirectory: home, workdir: home }),
        ).resolves.toMatchObject({
          processExit: "confirmed",
          cleanup: "confirmed",
        });
      }
      expect((await exited)[0]).toBe(0);
      expect((await readdir(server)).sort()).toEqual([
        "daemon-shutdown.json",
        "daemon-state.json",
      ]);
    };
    await start();
    expect((await readdir(server)).sort()).toEqual([
      "daemon-state.json",
      "daemon.pid",
    ]);
    await stop(process.platform === "win32" ? undefined : "SIGTERM");
    await start();
    await stop();
    await start();
    const pid = daemon?.pid;
    await reap(daemon);
    expect(
      JSON.parse(await readFile(join(server, "daemon-state.json"), "utf8")),
    ).toMatchObject({ pid, status: "running" });
    const logPath = await start();
    await stop();
    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string });
    expect(records.map((line) => line.event)).toContain(
      "server.previous_run.unclean",
    );
    const previousRuns = records.filter(
      (line) => line.event === "server.previous_run.unclean",
    );
    expect(previousRuns).toHaveLength(1);
    expect(previousRuns[0]).toMatchObject({
      event: "server.previous_run.unclean",
      previousPid: pid,
      previousStatus: "running",
    });
  } finally {
    await reap(daemon);
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

it("only allows one real process to take over the same stale PID lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ohbaby-pid-recovery-"));
  const pidPath = join(directory, "daemon.pid");
  const staleRead = join(directory, "read");
  const resume = join(directory, "resume");
  const fixture = join(directory, "contender.mjs");
  let first: ChildProcess | undefined;
  let winner: ChildProcess | undefined;
  try {
    await writeFile(
      pidPath,
      JSON.stringify({ pid: 10_001, startedAt: 1, token: "stale" }),
    );
    await writeFile(
      fixture,
      `
      import { existsSync, writeFileSync } from "node:fs";
      import { FilePidFile } from ${JSON.stringify(sourceUrl("packages/ohbaby-server/src/runtime/daemon/pid-file.ts"))};
      const [path, observed, resume, side] = process.argv.slice(2);
      let paused = false;
      const file = new FilePidFile(path, Date.now, () => process.pid, (pid) => {
        if (pid !== 10001) return true;
        if (side === "first" && !paused) {
          paused = true;
          writeFileSync(observed, "");
          const cell = new Int32Array(new SharedArrayBuffer(4));
          const deadline = Date.now() + 6000;
          while (!existsSync(resume)) {
            if (Date.now() >= deadline) throw new Error("fixture deadline");
            Atomics.wait(cell, 0, 0, 5);
          }
        }
        return false;
      });
      try {
        const lock = await file.acquire();
        process.on("message", async () => {
          await lock.release();
          process.disconnect();
        });
        process.send({ status: "acquired", record: lock.record });
      } catch (error) {
        process.send({ status: error.name }, () => process.disconnect());
      }
    `,
    );
    const contender = (side: string): ChildProcess =>
      fork(fixture, [pidPath, staleRead, resume, side], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
    first = contender("first");
    const firstResult = childMessage(first);
    await vi.waitFor(() => access(staleRead), { timeout: 6000 });
    winner = contender("winner");
    const result = await childMessage(winner);
    expect(result).toMatchObject({
      status: "acquired",
      record: { pid: winner.pid },
    });
    await writeFile(resume, "");
    expect(await firstResult).toEqual({ status: "DaemonAlreadyRunningError" });
    expect(JSON.parse(await readFile(pidPath, "utf8"))).toMatchObject({
      pid: winner.pid,
    });
    const exited = once(winner, "exit");
    winner.send("release");
    expect((await exited)[0]).toBe(0);
    expect((await readdir(directory)).sort()).toEqual([
      "contender.mjs",
      "read",
      "resume",
    ]);
  } finally {
    await reap(first);
    await reap(winner);
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

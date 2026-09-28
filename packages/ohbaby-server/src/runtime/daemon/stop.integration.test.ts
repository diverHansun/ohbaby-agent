import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
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

it.each(
  process.platform === "win32"
    ? (["SIGTERM", "SIGINT"] as const)
    : (["SIGTERM", "SIGINT", "SIGHUP"] as const),
)(
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
      else if (daemon)
        expect(daemon.exitCode).toBe(mode === "incomplete" ? 1 : 0);
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
      const supervisor=new Supervisor({pidFilePath:${JSON.stringify(scope.pidFilePath)},stateFilePath:${JSON.stringify(scope.stateFilePath)},shutdownTimeoutMs:240,
        bootstrap:()=>({connection:{host:'127.0.0.1',port:1234,authToken:'fixture'},start:async()=>{},stop:async(options)=>{
          beginDatabaseShutdown(options.deadlineAt,db);
          try {await runWriteTransaction(db,c=>c.prepare("INSERT INTO facts VALUES ('final')").run());}finally{db.close();}
        }})});
      await supervisor.start();setInterval(()=>{},1000);process.send('ready');
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
      [dbPath, "1000"],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    await once(locker, "message");
    const started = Date.now();
    const result = await stopDaemonFromState({
      homeDirectory: home,
      workdir: home,
      timeoutMs: 1200,
      kill: (pid) => process.kill(pid, "SIGTERM"),
    });
    expect(Date.now() - started).toBeLessThan(700);
    expect(result).toMatchObject({
      processExit: "confirmed",
      cleanup: "unconfirmed",
    });
    expect(result.reason).toMatch(/deadline|shutdown/i);
    expect(daemon.exitCode).toBe(1);
  } finally {
    await reap(locker);
    await reap(daemon);
    await rm(home, { recursive: true, force: true });
  }
}, 10000);

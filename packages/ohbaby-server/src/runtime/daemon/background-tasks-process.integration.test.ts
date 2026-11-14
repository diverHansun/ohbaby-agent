import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  UiPromptCompletion,
  UiShellJobCommandClient,
  UiShellJobList,
  UiShellJobOutput,
  UiShellJobReadClient,
} from "ohbaby-sdk";
import { NodeSqliteConnection } from "../../../../ohbaby-agent/src/services/database/connection.js";
import type { CleanupResult } from "../../../../ohbaby-agent/src/runtime/shutdown.js";
import type { CurrentRunInputRecord } from "../../../../ohbaby-agent/src/runtime/prompt-scheduler/current-run-inputs.js";
import type { AgentStepRequestRecord } from "../../../../ohbaby-agent/src/core/message/types.js";
import { readProcessIdentity } from "../../../../ohbaby-agent/src/shell/process-identity.js";
import { probeProcessTree } from "../../../../ohbaby-agent/src/shell/process.js";
import { createRemoteUiBackendClient } from "../../protocols/jsonrpc/client.js";

// Separate Node processes matter here: two adapters in one test worker share
// process handles and the database singleton, hiding the ownership boundary.
const sourceUrl = (path: string): string => pathToFileURL(resolve(path)).href;
const childScript = `
  const {createPersistentUiBackendClient, closePersistentUiBackendDatabase} = await import(${JSON.stringify(sourceUrl("packages/ohbaby-agent/src/adapters/ui-persistent.ts"))});
  const {getDatabase} = await import(${JSON.stringify(sourceUrl("packages/ohbaby-agent/src/services/database/index.ts"))});
  const {McpManager} = await import(${JSON.stringify(sourceUrl("packages/ohbaby-agent/src/mcp/index.ts"))});
  McpManager.prototype.getAllTools = async () => [];
  const options = JSON.parse(process.env.OHBABY_PROCESS_TEST);
  const calls = [];
  const requests = [];
  const llmClient = {
    config: {provider:"openai", model:"test-model", interfaceProvider:"openai-compatible", baseUrl:"https://example.invalid/v1", maxTokens:256, contextWindowTokens:128000},
    provider: {
      id:"openai", kind:"openai-compatible", client:{}, isAbortError:()=>false,
      async streamResponse(request) {
        const call = request.purpose === "agent-step" ? calls.shift() : undefined;
        if (request.purpose === "agent-step") requests.push(JSON.stringify(request.messages));
        return (async function*() {
          yield call ? {finishReason:"tool_calls", toolCallDeltas:[{id:crypto.randomUUID(), index:0, name:"bash", argumentsDelta:JSON.stringify(call)}]} : {textDelta:"Process fixture finished", finishReason:"stop"};
        })();
      }
    }
  };
  const backend = createPersistentUiBackendClient({dbPath:options.dbPath,workdir:options.workdir,llmClient,enableSnapshots:false});
  await backend.initialize();
  await backend.setPermission({level:"full-access"});
  let server;
  if (options.web) {
    const {createDaemonHttpServer} = await import(${JSON.stringify(sourceUrl("packages/ohbaby-server/src/runtime/daemon/server.ts"))});
    server = createDaemonHttpServer({backend,authToken:options.token,host:"127.0.0.1",port:0});
    await server.start();
  }
  process.on("message", async ({id, method, args}) => {
    try {
      let result;
      if (method === "queue") result = calls.push(...args);
      else if (method === "requests") result = requests;
      else if (method === "jobs") result = getDatabase().prepare("SELECT * FROM shell_job").all();
      else if (method === "shutdown") {
        await server?.stop();
        result = await backend.dispose();
        closePersistentUiBackendDatabase();
      } else result = await backend[method](...args);
      process.send({id, result}, () => { if (method === "shutdown") process.disconnect(); });
    } catch (error) {
      process.send({id, error:{message:error.message, code:error.code}});
    }
  });
  process.send({ready:true, port:server?.port});
`;

interface JobRecord {
  job_id: string;
  root_session_id: string;
  command: string;
  status: string;
  stop_reason: string | null;
  cleanup: string | null;
  pid: number | null;
  pgid: number | null;
  process_start_token: string | null;
  started_at: number | null;
  ended_at: number | null;
  notice_state: string | null;
  run_id: string;
  timeout_ms: number | null;
  output_bytes: number;
}

class BackendProcess {
  readonly child: ChildProcess;
  readonly ready: Promise<{ port?: number }>;
  readonly exited: Promise<void>;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private stderr = "";

  constructor(options: {
    home: string;
    workdir: string;
    dbPath: string;
    web: boolean;
    token: string;
  }) {
    this.child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childScript],
      {
        env: {
          ...process.env,
          OHBABY_HOME: options.home,
          OHBABY_PROCESS_TEST: JSON.stringify(options),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8000);
    });
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.child.once("error", rejectReady);
      this.child.on("message", (message: unknown) => {
        const value = message as {
          ready?: boolean;
          port?: number;
          id: string;
          result?: unknown;
          error?: { message: string; code?: string };
        };
        if (value.ready) {
          resolveReady({ port: value.port });
          return;
        }
        const request = this.pending.get(value.id);
        if (!request) return;
        this.pending.delete(value.id);
        if (value.error)
          request.reject(
            Object.assign(new Error(value.error.message), {
              code: value.error.code,
            }),
          );
        else request.resolve(value.result);
      });
      this.child.once("exit", () => {
        rejectReady(new Error(this.stderr || "Backend exited before ready"));
      });
    });
    this.exited = new Promise((resolveExit) => {
      this.child.once("exit", () => {
        for (const request of this.pending.values())
          request.reject(new Error(this.stderr || "Backend exited"));
        this.pending.clear();
        resolveExit();
      });
    });
  }

  async call<T>(method: string, ...args: unknown[]): Promise<T> {
    await this.ready;
    const id = randomUUID();
    return new Promise<T>((resolveResult, reject) => {
      this.pending.set(id, {
        resolve: (value) => {
          resolveResult(value as T);
        },
        reject,
      });
      this.child.send({ id, method, args }, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async kill(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGKILL");
    await this.exited;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const timeout = setTimeout(() => this.child.kill("SIGKILL"), 10000);
    try {
      const result = await this.call<CleanupResult>("shutdown");
      await this.exited;
      expect(result).toEqual({ status: "confirmed", errors: [] });
      expect(this.child.signalCode).toBeNull();
    } finally {
      clearTimeout(timeout);
    }
  }
}

const fixtures: {
  root: string;
  dbPath: string;
  children: BackendProcess[];
  clients: ReturnType<typeof createRemoteUiBackendClient>[];
}[] = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const fixture of fixtures.splice(0)) {
    const errorCount = errors.length;
    for (const result of await Promise.allSettled(
      fixture.clients.map((client) => client.dispose()),
    ))
      if (result.status === "rejected") errors.push(result.reason);
    for (const child of fixture.children) {
      try {
        await child.stop();
      } catch (error) {
        errors.push(error);
        await child.kill();
      }
    }
    // Failure cleanup is restricted to this fixture's recorded identities.
    const db = new NodeSqliteConnection(fixture.dbPath);
    try {
      const jobs = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='shell_job'",
        )
        .get()
        ? db.prepare<JobRecord>("SELECT * FROM shell_job").all()
        : [];
      for (const job of jobs) {
        try {
          if (!job.pid || job.pgid !== job.pid || !job.process_start_token)
            continue;
          const pid = job.pid;
          if (probeProcessTree({ pid }) === "stopped") continue;
          const identity = await readProcessIdentity(pid);
          if (
            identity.state === "present" &&
            identity.startToken === job.process_start_token &&
            identity.pgid === job.pgid
          ) {
            try {
              process.kill(-job.pgid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                throw error;
            }
            await expect
              .poll(() => probeProcessTree({ pid }), {
                timeout: 3000,
              })
              .toBe("stopped");
          } else
            errors.push(
              new Error(
                `Unconfirmed fixture group ${String(pid)}; retained ${fixture.root}`,
              ),
            );
        } catch (error) {
          errors.push(error);
        }
      }
    } catch (error) {
      errors.push(error);
    } finally {
      db.close();
      if (errors.length === errorCount)
        await rm(fixture.root, { recursive: true, force: true });
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Background fixture cleanup failed");
});

type RemoteShellClient = ReturnType<typeof createRemoteUiBackendClient> &
  UiShellJobReadClient &
  UiShellJobCommandClient;
interface BackendEndpoint {
  process: BackendProcess;
  client?: RemoteShellClient;
}
interface ProcessFixture {
  dbPath: string;
  workdir: string;
  start(web: boolean): Promise<BackendEndpoint>;
}

async function createFixture(): Promise<ProcessFixture> {
  const root = await mkdtemp(join(tmpdir(), "ohbaby-shell-process-"));
  const home = join(root, "home");
  const workdir = join(root, "work");
  await mkdir(home);
  await mkdir(workdir);
  await writeFile(join(home, ".skip-auto-migrate"), "");
  const fixture = {
    root,
    dbPath: join(root, "state.db"),
    children: [] as BackendProcess[],
    clients: [] as ReturnType<typeof createRemoteUiBackendClient>[],
  };
  fixtures.push(fixture);
  return {
    dbPath: fixture.dbPath,
    workdir,
    async start(web: boolean): Promise<BackendEndpoint> {
      const token = randomUUID();
      const process = new BackendProcess({
        home,
        workdir,
        dbPath: fixture.dbPath,
        web,
        token,
      });

      fixture.children.push(process);
      const { port } = await process.ready;
      const client = port
        ? createRemoteUiBackendClient({ authToken: token, port })
        : undefined;
      if (client) {
        fixture.clients.push(client);
        await client.getSnapshot();
        await client.setPermission({ level: "full-access" });
      }
      return {
        process,
        client,
      };
    },
  };
}

/** Links actual durable consumption to one frozen batch, not the launch receipt. */
function consumedNotice(
  dbPath: string,
  jobId: string,
  statusLine: string,
): CurrentRunInputRecord {
  const db = new NodeSqliteConnection(dbPath);
  try {
    const job = db
      .prepare<{
        notice_batch_id: string;
        notice_input_id: string;
        notice_payload: string;
      }>(
        "SELECT notice_batch_id, notice_input_id, notice_payload FROM shell_job WHERE job_id=?",
      )
      .get(jobId);
    if (!job?.notice_input_id)
      throw new Error(
        `Notice has not been accepted: ${JSON.stringify(job)}; inputs=${JSON.stringify(db.prepare("SELECT source,source_id,data FROM current_run_input").all())}`,
      );
    expect(job.notice_payload).toContain(`Task ${jobId}:`);
    expect(job.notice_payload).toContain(statusLine);
    const row = db
      .prepare<{
        data: string;
      }>("SELECT data FROM current_run_input WHERE input_id=?")
      .get(job.notice_input_id);
    if (!row) throw new Error("Missing notice input");
    const input = JSON.parse(row.data) as CurrentRunInputRecord;
    expect(input).toMatchObject({
      inputId: job.notice_input_id,
      source: "background-task-result",
      sourceId: `background-task:${job.notice_batch_id}`,
    });
    expect(typeof input.processedRequestId).toBe("string");
    const requests = db
      .prepare<{
        data: string;
      }>(
        "SELECT request.value AS data FROM message, json_each(message.data, '$.modelRequests') AS request WHERE json_extract(request.value, '$.requestId')=?",
      )
      .all(input.processedRequestId ?? "");
    expect(requests).toHaveLength(1);
    const request = JSON.parse(requests[0].data) as AgentStepRequestRecord;
    expect(request).toMatchObject({
      outcome: "success",
      runId: input.runId,
    });
    expect(request.inputIds).toContain(input.inputId);
    expect(
      db
        .prepare<{
          count: number;
        }>(
          "SELECT count(*) AS count FROM current_run_input WHERE session_id=? AND source='background-task-result' AND source_id=?",
        )
        .get(input.sessionId, input.sourceId)?.count,
    ).toBe(1);
    return input;
  } finally {
    db.close();
  }
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "independent backend background ownership",
  () => {
    it.each([true, false])(
      "keeps a live %s Web owner's jobs read-only, and recovers after SIGKILL",
      async (ownerIsWeb) => {
        const fixture = await createFixture();
        const owner = await fixture.start(ownerIsWeb);
        await owner.process.call("queue", {
          command: "printf OWNER_READY; sleep 90",
          run_in_background: true,
        });
        const completion = owner.client
          ? await owner.client.submitPromptAndWait(
              "Start owner background task.",
            )
          : await owner.process.call<UiPromptCompletion>(
              "submitPromptAndWait",
              "Start owner background task.",
            );
        const rootSessionId = completion.prompt.sessionId;
        const peer = await fixture.start(!ownerIsWeb);
        if (peer.client) await peer.client.selectSession(rootSessionId);
        else await peer.process.call("selectSession", rootSessionId);
        const list = (): Promise<UiShellJobList> =>
          peer.client
            ? peer.client.listShellJobs({ rootSessionId })
            : peer.process.call<UiShellJobList>("listShellJobs", {
                rootSessionId,
              });
        const initial = await list();
        expect(initial.rows).toHaveLength(1);
        const jobId = initial.rows[0].jobId;
        expect(initial.rows[0]).toMatchObject({
          status: "running",
          managedByCurrentBackend: false,
          canStop: false,
        });
        await expect
          .poll(
            async () => {
              const result = peer.client
                ? await peer.client.getShellJobOutput({ rootSessionId, jobId })
                : await peer.process.call<UiShellJobOutput>(
                    "getShellJobOutput",
                    { rootSessionId, jobId },
                  );
              expect(result.source).toBe("saved");
              return result.output;
            },
            { timeout: 5000 },
          )
          .toContain("OWNER_READY");
        await expect(
          peer.client
            ? peer.client.stopShellJob({ rootSessionId, jobId })
            : peer.process.call("stopShellJob", { rootSessionId, jobId }),
        ).rejects.toMatchObject({ code: "SHELL_JOB_OTHER_BACKEND" });
        await expect(
          peer.client
            ? peer.client.archiveSession({ sessionId: rootSessionId })
            : peer.process.call("archiveSession", { sessionId: rootSessionId }),
        ).rejects.toMatchObject({ code: "SHELL_JOB_OTHER_BACKEND" });
        expect((await list()).rows[0]?.status).toBe("running");

        await peer.process.call("queue", {
          command: "printf PEER_READY; sleep 90",
          run_in_background: true,
        });
        if (peer.client)
          await peer.client.submitPromptAndWait("Start peer background task.", {
            sessionId: rootSessionId,
          });
        else
          await peer.process.call(
            "submitPromptAndWait",
            "Start peer background task.",
            { sessionId: rootSessionId },
          );
        const records = await peer.process.call<JobRecord[]>("jobs");
        const owned = records.find((row) =>
          row.command.includes("OWNER_READY"),
        );
        const other = records.find((row) => row.command.includes("PEER_READY"));
        if (!owned?.pid || !other?.pid)
          throw new Error("Expected registered owner and peer processes");
        expect(owned.status).toBe("running");
        expect(other.status).toBe("running");
        await owner.client?.dispose();
        await owner.process.kill();
        const recovering = await fixture.start(ownerIsWeb);
        const recovered = await recovering.process.call<JobRecord[]>("jobs");
        expect(
          recovered.find((row) => row.job_id === owned.job_id),
        ).toMatchObject({
          status: "lost",
          cleanup: "confirmed",
          notice_state: "pending",
        });
        expect(
          recovered.find((row) => row.job_id === other.job_id),
        ).toMatchObject({ status: "running" });
        expect(await readProcessIdentity(owned.pid)).toEqual({
          state: "absent",
        });
        expect((await readProcessIdentity(other.pid)).state).toBe("present");
        // No autonomous model request for startup lost; next legal user turn consumes it.
        expect(await recovering.process.call<string[]>("requests")).toEqual([]);
        await recovering.process.call("selectSession", rootSessionId);
        const replay = await recovering.process.call<UiPromptCompletion>(
          "submitPromptAndWait",
          "Check prior task results.",
          { sessionId: rootSessionId },
        );
        expect(replay.prompt).toMatchObject({
          sessionId: rootSessionId,
          status: "succeeded",
        });
        const consumed = consumedNotice(fixture.dbPath, jobId, "Status: lost");
        expect(
          (await recovering.process.call<string[]>("requests")).join("\n"),
        ).toContain("Status: lost");
        await recovering.process.call(
          "submitPromptAndWait",
          "Confirm there are no new task results.",
          { sessionId: rootSessionId },
        );
        expect(
          consumedNotice(fixture.dbPath, jobId, "Status: lost")
            .processedRequestId,
        ).toBe(consumed.processedRequestId);
        await recovering.client?.dispose();
        await recovering.process.stop();
        expect((await readProcessIdentity(other.pid)).state).toBe("present");
        await peer.client?.dispose();
        await peer.process.stop();
        expect(await readProcessIdentity(other.pid)).toEqual({
          state: "absent",
        });
        const db = new NodeSqliteConnection(fixture.dbPath);
        try {
          expect(
            db
              .prepare<JobRecord>("SELECT * FROM shell_job WHERE job_id=?")
              .get(other.job_id),
          ).toMatchObject({
            status: "cancelled",
            stop_reason: "shutdown",
            cleanup: "confirmed",
          });
        } finally {
          db.close();
        }
      },
      60000,
    );
  },
);

it.skipIf(
  process.env.OHBABY_RUN_BACKGROUND_LONG !== "1" ||
    process.platform === "win32",
)(
  "keeps an explicit background command beyond ten real minutes and stops only the requested job",
  async () => {
    const fixture = await createFixture();
    const { process: backend, client } = await fixture.start(true);
    if (!client) throw new Error("Expected HTTP client");
    const calls = [
      {
        command: "printf LONG_READY; sleep 900",
        run_in_background: true,
      },
      {
        command: "printf SIBLING_READY; sleep 900",
        run_in_background: true,
      },
      {
        command:
          "while :; do printf 'tick\\n' >> redirected.log; sleep 1; done",
        run_in_background: true,
        timeout: 60000,
      },
      {
        command: "printf FORE_READY; sleep 180",
        run_in_background: false,
      },
    ];
    await backend.call("queue", ...calls.slice(0, 3));
    const completion = await client.submitPromptAndWait(
      "Start the three background tasks and finish this turn.",
    );
    expect(completion.prompt.status).toBe("succeeded");
    const rootSessionId = completion.prompt.sessionId;
    const started = await backend.call<JobRecord[]>("jobs");
    const longJob = started.find((row) => row.command === calls[0].command);
    const siblingJob = started.find((row) => row.command === calls[1].command);
    const redirected = started.find((row) => row.command === calls[2].command);
    if (
      !longJob?.started_at ||
      !longJob.pid ||
      !siblingJob?.pid ||
      !redirected?.started_at
    )
      throw new Error("Expected three registered tasks");
    expect(started.filter((row) => row.status === "running")).toHaveLength(3);
    const longStartedAt = longJob.started_at;
    // The owner turn is closed. The 60-second result must wake its own new run.
    await expect
      .poll(
        () =>
          consumedNotice(
            fixture.dbPath,
            redirected.job_id,
            "Status: timed_out: timeout",
          ),
        { timeout: 75000, interval: 1000 },
      )
      .toHaveProperty("processedRequestId");
    const timedOut = (await backend.call<JobRecord[]>("jobs")).find(
      (row) => row.job_id === redirected.job_id,
    );
    expect(timedOut).toMatchObject({
      status: "timed_out",
      stop_reason: "timeout",
      cleanup: "confirmed",
      output_bytes: 0,
    });
    expect(
      (timedOut?.ended_at ?? 0) - redirected.started_at,
    ).toBeGreaterThanOrEqual(59000);
    const proof = consumedNotice(
      fixture.dbPath,
      redirected.job_id,
      "Status: timed_out: timeout",
    );
    const wakeDb = new NodeSqliteConnection(fixture.dbPath);
    try {
      expect(
        wakeDb
          .prepare<{
            trigger: string;
          }>("SELECT trigger FROM run_ledger WHERE run_id=?")
          .get(proof.runId)?.trigger,
      ).toBe("background-task");
    } finally {
      wakeDb.close();
    }
    expect((await backend.call<string[]>("requests")).join("\n")).toContain(
      "0 bytes captured",
    );
    expect(
      (await readFile(join(fixture.workdir, "redirected.log"), "utf8")).split(
        "tick",
      ).length,
    ).toBeGreaterThan(40);

    await backend.call("queue", calls[3]);
    expect(
      (
        await client.submitPromptAndWait(
          "Run the pure foreground timeout check.",
          { sessionId: rootSessionId },
        )
      ).prompt.status,
    ).toBe("succeeded");
    const foreground = (await backend.call<JobRecord[]>("jobs")).find(
      (row) => row.command === calls[3].command,
    );
    if (!foreground?.started_at) throw new Error("Expected foreground task");
    expect(foreground).toMatchObject({
      status: "timed_out",
      timeout_ms: 120000,
      cleanup: "confirmed",
      notice_state: "suppressed",
    });
    expect(
      (foreground.ended_at ?? 0) - foreground.started_at,
    ).toBeGreaterThanOrEqual(119000);
    expect((await backend.call<string[]>("requests")).join("\n")).toContain(
      "FORE_READY",
    );
    expect(
      consumedNotice(
        fixture.dbPath,
        redirected.job_id,
        "Status: timed_out: timeout",
      ).processedRequestId,
    ).toBe(proof.processedRequestId);

    // Main Stop owns this new foreground run, not either earlier background job.
    await backend.call("queue", {
      command: "printf ABORT_READY; sleep 30",
      run_in_background: false,
    });
    const aborted = client.submitPromptAndWait(
      "Start the foreground command to be stopped.",
      { sessionId: rootSessionId },
    );
    let foregroundRun: string | undefined;
    await expect
      .poll(
        async () => {
          const job = (await backend.call<JobRecord[]>("jobs")).find((row) =>
            row.command.includes("ABORT_READY"),
          );
          foregroundRun = job?.run_id;
          return job?.status;
        },
        { timeout: 10000 },
      )
      .toBe("running");
    if (!foregroundRun) throw new Error("Missing foreground run");
    await client.abortRun(foregroundRun);
    expect((await aborted).prompt.status).toBe("interrupted");
    expect(
      (await backend.call<JobRecord[]>("jobs")).find((row) =>
        row.command.includes("ABORT_READY"),
      ),
    ).toMatchObject({ status: "cancelled", cleanup: "confirmed" });
    expect(
      (await client.listShellJobs({ rootSessionId })).rows.filter(
        (row) => row.status === "running",
      ),
    ).toHaveLength(2);

    // Wall-clock evidence, intentionally opt-in so normal preflight remains fast.
    while (Date.now() - longStartedAt < 610000) {
      await new Promise((resolveWait) =>
        setTimeout(
          resolveWait,
          Math.min(10000, 610000 - (Date.now() - longStartedAt)),
        ),
      );
      const snapshot = await client.listShellJobs({ rootSessionId });
      expect(
        snapshot.rows.filter((row) => row.status === "running"),
      ).toHaveLength(2);
    }
    expect(await readProcessIdentity(longJob.pid)).toMatchObject({
      state: "present",
      startToken: longJob.process_start_token,
    });
    expect(await readProcessIdentity(siblingJob.pid)).toMatchObject({
      state: "present",
      startToken: siblingJob.process_start_token,
    });
    const beforeStop = await client.listShellJobs({ rootSessionId });
    const target = beforeStop.rows.find(
      (row) => row.command === calls[0].command,
    );
    const sibling = beforeStop.rows.find(
      (row) => row.command === calls[1].command,
    );
    if (!target || !sibling) throw new Error("Missing background tasks");
    expect(target).toMatchObject({ status: "running", timeoutMs: null });
    expect(
      (await client.stopShellJob({ rootSessionId, jobId: target.jobId }))
        .outcome,
    ).toBe("accepted");
    await expect
      .poll(
        async () =>
          (
            await client.getShellJobOutput({
              rootSessionId,
              jobId: target.jobId,
            })
          ).job.cleanup,
      )
      .toBe("confirmed");
    expect(
      (
        await client.getShellJobOutput({
          rootSessionId,
          jobId: target.jobId,
        })
      ).job,
    ).toMatchObject({ status: "cancelled", stopReason: "user" });
    expect(
      (
        await client.getShellJobOutput({
          rootSessionId,
          jobId: sibling.jobId,
        })
      ).job.status,
    ).toBe("running");
    expect(await readProcessIdentity(longJob.pid)).toEqual({ state: "absent" });
    expect(await readProcessIdentity(siblingJob.pid)).toMatchObject({
      state: "present",
      startToken: siblingJob.process_start_token,
    });
    await expect
      .poll(
        () =>
          consumedNotice(
            fixture.dbPath,
            target.jobId,
            "Status: cancelled: user",
          ),
        { timeout: 10000 },
      )
      .toHaveProperty("processedRequestId");
    const stoppedNotice = consumedNotice(
      fixture.dbPath,
      target.jobId,
      "Status: cancelled: user",
    );
    const followup = await client.submitPromptAndWait(
      "Confirm there are no new task results.",
      { sessionId: rootSessionId },
    );
    expect(followup.prompt).toMatchObject({
      sessionId: rootSessionId,
      status: "succeeded",
    });
    expect(
      consumedNotice(fixture.dbPath, target.jobId, "Status: cancelled: user")
        .processedRequestId,
    ).toBe(stoppedNotice.processedRequestId);
  },
  660000,
);

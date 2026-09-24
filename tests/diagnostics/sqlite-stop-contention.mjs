import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const repository = process.cwd();
const root = await mkdtemp(join(tmpdir(), "ohbaby-sqlite-stop-"));
const profile = join(root, "profile");
const workspace = join(root, "workspace");
const home = join(root, "home");
const dbPath = join(profile, "ohbaby.db");
const authToken = `test-${randomUUID()}`;
const clientId = `test-${randomUUID()}`;
const noLock = process.argv.includes("--no-lock");
const noQueuedWrite = process.argv.includes("--lock-without-queued-write");
const requestedHoldMs = Number(process.argv.find((value) => value.startsWith("--hold-ms="))?.slice("--hold-ms=".length) ?? "2500");
const idleBeforeLockMs = Number(process.argv.find((value) => value.startsWith("--idle-ms="))?.slice("--idle-ms=".length) ?? "0");
if (!Number.isInteger(requestedHoldMs) || requestedHoldMs < 100 || requestedHoldMs > 5000) {
  throw new Error("--hold-ms must be an integer from 100 to 5000");
}
if (!Number.isInteger(idleBeforeLockMs) || idleBeforeLockMs < 0 || idleBeforeLockMs > 5000) {
  throw new Error("--idle-ms must be an integer from 0 to 5000");
}
let serve;
let lockDb;
let provider;
let providerRequestSeen;
let report;
let serveUrl;
let stopStartedAt;
let providerResponseClosedAt;

function within(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function rpc(url, method, params = [], timeoutMs = 20000) {
  const start = performance.now();
  const response = await fetch(new URL("/api/rpc", url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      "x-ohbaby-directory": workspace,
    },
    body: JSON.stringify({ id: randomUUID(), clientId, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  return { elapsedMs: Math.round(performance.now() - start), httpStatus: response.status, ...body };
}

try {
  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);

  let providerSeenResolve;
  providerRequestSeen = new Promise((resolve) => { providerSeenResolve = resolve; });
  provider = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    for await (const _chunk of request) { /* consume request */ }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    response.once("close", () => { providerResponseClosedAt = performance.now(); });
    response.write(": test model response held open\n\n");
    providerSeenResolve();
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerPort = provider.address().port;

  await writeFile(join(profile, "model.json"), JSON.stringify({
    apiConfig: { apiKeyEnv: "OHBABY_SQLITE_STOP_TEST_KEY", baseUrl: `http://127.0.0.1:${providerPort}/v1` },
    defaultModel: "fake-model",
    models: [{ model: "fake-model", contextWindowTokens: 128000, reasoningCapabilities: { mode: "none", wire: "none", supportsDisabled: true } }],
    llmParams: { maxTokens: 128, temperature: 0 },
    provider: "fake-openai",
  }));

  const environment = {
    ...process.env,
    APPDATA: join(root, "appdata"),
    HOME: home,
    LOCALAPPDATA: join(root, "localappdata"),
    NODE_ENV: "production",
    OHBABY_DB_PATH: dbPath,
    OHBABY_HOME: profile,
    OHBABY_SQLITE_STOP_TEST_KEY: "fixture-only-key",
    OHBABY_STORAGE_ROOT: join(root, "storage"),
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
  };
  delete environment.OHBABY_DEBUG;

  serve = spawn("pnpm", ["--filter", "ohbaby-cli", "start", "serve", "--port", "0", "--no-open", "--auth-token", authToken, "--db-path", dbPath], {
    cwd: repository,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let serveStdout = "";
  let serveStderr = "";
  serve.stdout.on("data", (chunk) => { serveStdout += chunk.toString(); });
  serve.stderr.on("data", (chunk) => { serveStderr += chunk.toString(); });
  const url = await within(new Promise((resolve, reject) => {
    const inspect = () => {
      const match = /ohbaby web ready: (http:\/\/127\.0\.0\.1:\d+)/.exec(serveStdout);
      if (match) resolve(match[1]);
    };
    serve.stdout.on("data", inspect);
    serve.once("exit", (code) => reject(new Error(`serve exited ${code}; stderr=${serveStderr.slice(-800)}`)));
    inspect();
  }), 30000, "serve startup").catch((error) => {
    const output = `${serveStdout.slice(-600)}\n${serveStderr.slice(-600)}`.replaceAll(authToken, "<redacted>");
    throw new Error(`${error.message}; output=${output}`);
  });
  serveUrl = url;

  const initialized = await rpc(url, "initializeClient", [{ startupSessionMode: { type: "fresh" } }]);
  if (!initialized.ok) throw new Error(`initializeClient: ${initialized.error?.message}`);
  const first = await rpc(url, "submitPromptAccepted", ["Hold the fake model response open for a Stop timing test."]);
  if (!first.ok) throw new Error(`submitPromptAccepted: ${first.error?.message}`);
  await within(providerRequestSeen, 15000, "fake model request");
  const snapshot = await rpc(url, "getSnapshot");
  if (!snapshot.ok) throw new Error(`getSnapshot: ${snapshot.error?.message}`);
  const activeRun = snapshot.result.runs.find((run) => run.status?.kind === "running");
  if (!activeRun) throw new Error(`no active run; run statuses=${JSON.stringify(snapshot.result.runs.map((run) => run.status))}`);
  if (idleBeforeLockMs > 0) await new Promise((resolve) => setTimeout(resolve, idleBeforeLockMs));

  let queued;
  if (!noLock) {
    lockDb = new DatabaseSync(dbPath);
    lockDb.exec("BEGIN IMMEDIATE");
    if (!noQueuedWrite) {
      queued = rpc(url, "submitPromptAccepted", ["Second prompt held behind the fake SQLite writer.", { sessionId: activeRun.sessionId }], 30000);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  const stopStarted = performance.now();
  stopStartedAt = stopStarted;
  const stop = rpc(url, "abortRun", [activeRun.id], 30000);
  const lockHoldAfterStopMs = noLock ? 0 : requestedHoldMs;
  let lockReleasedMs = 0;
  if (lockDb) {
    await new Promise((resolve) => setTimeout(resolve, lockHoldAfterStopMs));
    lockReleasedMs = Math.round(performance.now() - stopStarted);
    lockDb.exec("ROLLBACK");
    lockDb.close();
    lockDb = undefined;
  }

  const [stopResult, queuedResult] = await Promise.all([stop, queued]);
  const providerStreamCloseElapsedMs = providerResponseClosedAt === undefined ? null : Math.round(providerResponseClosedAt - stopStartedAt);
  report = {
    test: noLock ? "real serve Stop without SQLite lock" : noQueuedWrite ? "real serve Stop with held writer but no queued write" : "real serve Stop behind SQLite writer",
    stopTargetMs: 1000,
    lockHoldAfterStopMs,
    idleBeforeLockMs,
    lockReleasedMs,
    stopElapsedMs: Math.round(performance.now() - stopStarted),
    stopRpcElapsedMs: stopResult.elapsedMs,
    providerStreamCloseElapsedMs,
    stopSignalProxyWithinTarget: providerStreamCloseElapsedMs !== null && providerStreamCloseElapsedMs <= 1000,
    stopOk: stopResult.ok,
    stopError: stopResult.ok ? undefined : stopResult.error?.message,
    queuedRpcElapsedMs: queuedResult?.elapsedMs ?? null,
    queuedOk: queuedResult?.ok ?? null,
    baselineSnapshotMs: snapshot.elapsedMs,
    observedRunStatusBeforeLock: activeRun.status.kind,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!stopResult.ok || providerStreamCloseElapsedMs === null || providerStreamCloseElapsedMs > 1000) process.exitCode = 1;

} catch (error) {
  console.error(JSON.stringify({ test: noLock ? "real serve Stop without SQLite lock" : noQueuedWrite ? "real serve Stop with held writer but no queued write" : "real serve Stop behind SQLite writer", error: error.message }));
  process.exitCode = 2;
} finally {
  if (lockDb) {
    try { lockDb.exec("ROLLBACK"); } catch { /* best effort */ }
    lockDb.close();
  }
  if (serveUrl) {
    await fetch(new URL("/api/shutdown", serveUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined);
  }
  if (serve?.exitCode === null && serve?.signalCode === null) {
    try { process.kill(-serve.pid, "SIGTERM"); } catch { /* already stopped */ }
  }
  await within(new Promise((resolve) => {
    if (!serve || serve.exitCode !== null || serve.signalCode !== null) resolve();
    else serve.once("exit", resolve);
  }), 3000, "serve stop").catch(() => {
    try { process.kill(-serve.pid, "SIGKILL"); } catch { /* already stopped */ }
  });
  provider?.closeAllConnections();
  await within(new Promise((resolve) => provider?.close(resolve) ?? resolve()), 2000, "fake provider stop").catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

/** Compiled Web + real remote PTY + HTTP + SQLite. UI input is driven separately. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const cli = resolve("packages/ohbaby-cli/dist/bin.js");
if (process.argv[2] === "--attach-tui") {
  const manifest = JSON.parse(await readFile(process.argv[3], "utf8"));
  const child = spawn(
    process.execPath,
    [
      cli,
      "--remote-port",
      String(manifest.port),
      "--remote-auth-token",
      manifest.token,
      "--resume",
      manifest.sessions.tui,
    ],
    { cwd: manifest.workspace, env: manifest.env, stdio: "inherit" },
  );
  await writeFile(join(manifest.root, "tui.pid"), String(child.pid));
  const code = await new Promise((done) => child.once("exit", done));
  await rm(join(manifest.root, "tui.pid"), { force: true });
  process.exit(code ?? 1);
}
const responseLoss = process.argv[2] === "--response-loss";
assert.ok(
  process.argv.length === 2 || (responseLoss && process.argv.length === 3),
  "Use no arguments, --response-loss, or --attach-tui <manifest>",
);
await access(cli);
await access(resolve("packages/ohbaby-cli/dist/web/index.html"));
const root = await mkdtemp(join(tmpdir(), "ohbaby-improve4-ui-e2e-"));
const workspace = join(root, "workspace");
const profile = join(root, "profile");
const dbPath = join(root, "fixture.db");
const manifestPath = join(root, "manifest.json");
const events = [];
const requests = [];
const failures = [];
const held = new Map();
const sessions = {};
let child;
let state;
let closing;
let closed = false;
let seedPrompts = [];
const droppedResponses = new Map();
const successfulOperations = new Map();
const publicPort = () => faultProxy?.address()?.port ?? state.port;
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
  ),
);
const env = {
  ...inherited,
  HOME: join(root, "home"),
  USERPROFILE: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  OHBABY_HOME: profile,
  OHBABY_DB_PATH: dbPath,
  OHBABY_STORAGE_ROOT: join(root, "storage"),
  OHBABY_LOG_DIR: join(root, "logs"),
  OHBABY_I4_FIXTURE_KEY: "fixture-only",
  OHBABY_TUI_NO_ANIM: "1",
  NO_COLOR: "1",
};
function record(type, detail = {}) {
  const row = { type, at: new Date().toISOString(), ...detail };
  events.push(row);
  console.log("I4_EVENT " + JSON.stringify(row));
}
// Optional wire fault: the production server commits normally, while the client
// receives an incomplete HTTP body. No production transport code is replaced.
const faultProxy = responseLoss
  ? createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const headers = { ...request.headers, host: `127.0.0.1:${state.port}` };
        if (headers.origin) headers.origin = `http://127.0.0.1:${state.port}`;
        let payload;
        if (body.length) {
          try {
            payload = JSON.parse(body.toString());
          } catch {}
        }
        const resubmit = /\/v1\/prompts\/[^/]+\/resubmit$/.test(request.url)
          ? payload
          : payload?.method === "resubmitRetainedPrompt"
            ? payload.params?.[0]
            : undefined;
        const upstream = httpRequest(
          `http://127.0.0.1:${state.port}${request.url}`,
          { method: request.method, headers },
          async (result) => {
            if (!resubmit) {
              response.writeHead(result.statusCode, result.headers);
              result.pipe(response);
              return;
            }
            try {
              const parts = [];
              for await (const part of result) parts.push(part);
              const reply = Buffer.concat(parts);
              if (result.statusCode >= 200 && result.statusCode < 300) {
                const parsed = JSON.parse(reply.toString());
                const receipt = parsed.receipt ?? parsed.result;
                const previous = successfulOperations.get(resubmit.operationId);
                if (previous) {
                  assert.deepEqual(
                    resubmit,
                    previous.input,
                    "Receipt replay changed the request",
                  );
                  assert.deepEqual(
                    receipt,
                    previous.receipt,
                    "Receipt replay changed the result",
                  );
                  record("receipt-replay-pass", {
                    text: resubmit.text,
                    operationId: resubmit.operationId,
                    receipt,
                  });
                } else
                  successfulOperations.set(resubmit.operationId, {
                    input: resubmit,
                    receipt,
                  });
                const fault = droppedResponses.get(resubmit.text);
                if (fault) {
                  droppedResponses.delete(resubmit.text);
                  await until(
                    () =>
                      readDb().prompts.some(
                        (p) =>
                          p.text === resubmit.text && p.status === fault.status,
                      ),
                    "Prompt did not commit the expected state before response loss",
                  );
                  record("response-truncated-after-commit", {
                    text: resubmit.text,
                    status: fault.status,
                    operationId: resubmit.operationId,
                    receipt,
                  });
                  const brokenHeaders = {
                    ...result.headers,
                    "content-length": String(reply.length),
                  };
                  delete brokenHeaders["transfer-encoding"];
                  response.writeHead(result.statusCode, brokenHeaders);
                  response.write("{");
                  await delay(10);
                  response.destroy();
                  return;
                }
              }
              response.writeHead(result.statusCode, result.headers);
              response.end(reply);
            } catch (error) {
              failures.push(String(error));
              record("proxy-failure", { message: String(error) });
              response.destroy();
            }
          },
        );
        upstream.on("error", () => response.destroy());
        response.on("close", () => upstream.destroy());
        upstream.end(body);
      } catch (error) {
        failures.push(String(error));
        record("proxy-failure", { message: String(error) });
        response.destroy();
      }
    })
  : undefined;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(predicate, message, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await delay(30);
  }
  throw new Error(message);
}
function chunk(response, content) {
  response.write(
    "data: " +
      JSON.stringify({
        id: "i4",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      }) +
      "\n\n",
  );
}
function finish(response, text) {
  if (response.destroyed) return;
  chunk(response, text);
  response.write(
    "data: " +
      JSON.stringify({
        id: "i4",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }) +
      "\n\n",
  );
  response.end("data: [DONE]\n\n");
}
function readDb() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      prompts: db
        .prepare("SELECT * FROM prompt_submission ORDER BY created_at, rowid")
        .all(),
      runs: db
        .prepare("SELECT * FROM run_ledger ORDER BY created_at, rowid")
        .all(),
      messageIds: db
        .prepare("SELECT id FROM message")
        .all()
        .map((r) => r.id),
    };
  } finally {
    db.close();
  }
}
function summary() {
  const value = readDb();
  return {
    prompts: value.prompts.map((p) => ({
      id: p.prompt_id,
      text: p.text,
      status: p.status,
      sessionId: p.session_id,
      userMessageId: p.user_message_id,
      runId: p.run_id,
      createdAt: p.created_at,
      acceptedAt: p.accepted_at,
      admissionOrder: p.admission_order,
      ownerId: p.owner_id,
    })),
    runs: value.runs.map((r) => ({
      id: r.run_id,
      status: r.status,
      sessionId: r.session_id,
    })),
    requests: [...requests],
  };
}
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer fixture-only");
    let raw = "";
    for await (const c of request) raw += c;
    const body = JSON.parse(raw);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    if (
      raw.includes("Generate a concise title for a coding-agent chat session.")
    ) {
      finish(
        response,
        raw.includes("I4_TUI") ? "I4 TUI fixture" : "I4 Web fixture",
      );
      return;
    }
    const user = body.messages.findLast((m) => m.role === "user");
    const marker = JSON.stringify(user).match(/I4_(?:WEB|TUI)_[A-Z_]+/)?.[0];
    assert.ok(
      marker,
      "Expected the fixture marker in the actual last user input",
    );
    requests.push(marker);
    record("provider-request", { marker, number: requests.length });
    if (marker.endsWith("_HOLD")) {
      held.set(marker, response);
      chunk(response, `${marker}_STARTED`);
      response.once("close", () => {
        held.delete(marker);
        record("provider-closed", { marker });
      });
    } else finish(response, `${marker}_OK`);
  } catch (error) {
    failures.push(String(error));
    record("provider-failure", { message: String(error) });
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
async function api(path, method = "GET", body, client = "i4-seeder") {
  const response = await fetch(`http://127.0.0.1:${state.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${state.authToken}`,
      "x-ohbaby-client-id": client,
      "x-ohbaby-directory": workspace,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  assert.ok(
    response.ok,
    `${method} ${path}: ${response.status} ${JSON.stringify(result)}`,
  );
  return result;
}
async function start() {
  child = spawn(process.execPath, [cli, "serve", "--port", "0", "--no-open"], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => {
    output += c;
  });
  child.stderr.on("data", (c) => {
    output += c;
  });
  await until(async () => {
    if (child.exitCode !== null)
      throw new Error(
        "Compiled daemon exited: " +
          output.replace(/token=[^\s&]+/g, "token=[redacted]"),
      );
    try {
      const next = JSON.parse(
        await readFile(join(profile, "server/daemon-state.json"), "utf8"),
      );
      if (next.pid === child.pid && /ohbaby web ready:/.test(output)) {
        state = next;
        return true;
      }
    } catch {}
    return false;
  }, "Daemon readiness timeout");
  const html = await (await fetch(`http://127.0.0.1:${state.port}/`)).text();
  const builtHtml = await readFile(
    resolve("packages/ohbaby-cli/dist/web/index.html"),
    "utf8",
  );
  for (const [, asset] of builtHtml.matchAll(
    /(?:src|href)="([^"]+\.(?:js|css))"/g,
  )) {
    assert.ok(
      html.includes(asset.split("/").at(-1)),
      "Served asset differs from compiled Web",
    );
    assert.equal(
      (await fetch(new URL(asset, `http://127.0.0.1:${state.port}`))).ok,
      true,
    );
  }
  await writeFile(
    manifestPath,
    JSON.stringify({
      root,
      workspace,
      dbPath,
      env,
      sessions,
      port: publicPort(),
      token: state.authToken,
    }),
    { mode: 0o600 },
  );
  record("ready", {
    url: `http://127.0.0.1:${publicPort()}`,
    pid: child.pid,
    manifestPath,
  });
}
async function stopTui() {
  try {
    const pid = Number(await readFile(join(root, "tui.pid"), "utf8"));
    if (alive(pid)) process.kill(pid, "SIGTERM");
    await until(() => !alive(pid), "Owned remote TUI did not exit");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
async function stopDaemon(signal = "SIGTERM") {
  if (child?.exitCode !== null) return;
  child.kill(signal);
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    "Owned daemon did not exit",
  );
  assert.equal(alive(child.pid), false);
}
async function seed(kind) {
  const id = `i4-seeder-${kind}`;
  await api("/v1/clients", "POST", { clientId: id }, id);
  const created = await api("/v1/sessions", "POST", {}, id);
  sessions[kind] = created.session.id;
  for (const suffix of ["HOLD", "B", "C", "E"]) {
    await api(
      "/v1/prompts",
      "POST",
      {
        clientRequestId: randomUUID(),
        sessionId: sessions[kind],
        text: `I4_${kind.toUpperCase()}_${suffix}`,
      },
      id,
    );
    if (suffix === "HOLD")
      await until(
        () => requests.includes(`I4_${kind.toUpperCase()}_HOLD`),
        "Hold request missing",
      );
  }
}
async function close() {
  if (closing) return closing;
  closing = (async () => {
    await stopTui();
    if (faultProxy) {
      faultProxy.closeAllConnections();
      await new Promise((done) => faultProxy.close(done));
    }
    await stopDaemon();
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
    let listening = false;
    try {
      await fetch(`http://127.0.0.1:${state.port}`, {
        signal: AbortSignal.timeout(500),
      });
      listening = true;
    } catch {}
    assert.equal(listening, false, "Owned daemon port remains open");
    await rm(join(profile, "server"), { recursive: true, force: true });
    record("cleanup-pass", {
      pidReleased: true,
      portReleased: true,
      credentialsRemoved: true,
      root,
    });
    await writeFile(
      join(root, "evidence.json"),
      JSON.stringify({ events, requests, failures, final: summary() }, null, 2),
      { mode: 0o600 },
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        root,
        workspace,
        dbPath,
        sessions,
        cleanup: "complete",
      }),
      { mode: 0o600 },
    );
    closed = true;
  })();
  return closing;
}
try {
  await Promise.all(
    [workspace, profile, env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME].map(
      (p) => mkdir(p, { recursive: true }),
    ),
  );
  await writeFile(join(profile, ".skip-auto-migrate"), "");
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  await writeFile(
    join(profile, "model.json"),
    JSON.stringify({
      provider: "fixture",
      defaultModel: "fixture",
      apiConfig: {
        apiKeyEnv: "OHBABY_I4_FIXTURE_KEY",
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        interfaceProvider: "openai-compatible",
      },
      llmParams: {
        maxTokens: 256,
        contextWindowTokens: 128000,
        temperature: 0,
      },
    }),
  );
  if (faultProxy)
    await new Promise((done) => faultProxy.listen(0, "127.0.0.1", done));
  await start();
  await seed("web");
  await seed("tui");
  seedPrompts = readDb().prompts;
  await writeFile(
    manifestPath,
    JSON.stringify({
      root,
      workspace,
      dbPath,
      env,
      sessions,
      port: publicPort(),
      token: state.authToken,
    }),
    { mode: 0o600 },
  );
  record("seeded", { sessions, ...summary() });
  console.log(
    "I4_COMMANDS inspect; assert {statuses:{text:status},requests:{marker:count}}; restart; release {marker}; drop-response {text,status}; ui {evidence}; quit. Each is a JSON line with command.",
  );
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    try {
      const input = JSON.parse(line);
      if (input.command === "quit") {
        lines.close();
        break;
      }
      if (input.command === "inspect") record("database", summary());
      else if (input.command === "drop-response") {
        assert.ok(
          faultProxy,
          "Start with --response-loss to inject a wire fault",
        );
        assert.equal(typeof input.text, "string");
        droppedResponses.set(input.text, {
          status: input.status ?? "succeeded",
        });
        record("response-loss-armed", {
          text: input.text,
          status: input.status ?? "succeeded",
        });
      } else if (input.command === "restart") {
        await stopTui();
        await stopDaemon("SIGKILL");
        const count = requests.length;
        await start();
        for (const [kind, sessionId] of Object.entries(sessions)) {
          const binding = await api(
            "/v1/clients",
            "POST",
            {
              clientId: `i4-recovery-${kind}`,
              startupIntent: { resumeSessionId: sessionId },
            },
            `i4-recovery-${kind}`,
          );
          const query = new URLSearchParams({
            runtimeEpoch: binding.runtimeEpoch ?? binding.permissionEpoch,
            bindingGeneration: String(binding.bindingGeneration),
          });
          await until(async () => {
            try {
              await api(
                `/v1/sessions/${sessionId}/view?${query}`,
                "GET",
                undefined,
                `i4-recovery-${kind}`,
              );
              return true;
            } catch (error) {
              if (
                String(error).includes("Session view has not been initialized")
              )
                return false;
              throw error;
            }
          }, "Session view did not initialize after client registration");
        }
        assert.equal(
          requests.length,
          count,
          "Cold restart auto-executed queued input",
        );
        record("cold-restart-pass", summary());
      } else if (input.command === "release") {
        const response = held.get(input.marker);
        assert.ok(response, "Missing held request");
        finish(response, `${input.marker}_RELEASED`);
      } else if (input.command === "ui") {
        assert.ok(
          input.evidence &&
            Object.values(input.evidence).every((v) => v === true),
          "UI evidence must contain only verified true checks",
        );
        record("ui-evidence", input.evidence);
      } else if (input.command === "assert") {
        await until(() => {
          const rows = readDb().prompts;
          return Object.entries(input.statuses ?? {}).every(([text, status]) =>
            rows.some((p) => p.text === text && p.status === status),
          );
        }, "Expected prompt states not durable");
        assert.deepEqual(failures, []);
        const counts = Object.fromEntries(
          [...new Set(requests)].map((marker) => [
            marker,
            requests.filter((x) => x === marker).length,
          ]),
        );
        if (input.requests)
          assert.deepEqual(
            counts,
            input.requests,
            "Unexpected model request counts",
          );
        const db = readDb();
        for (const original of seedPrompts) {
          const current = db.prompts.find(
            (p) => p.prompt_id === original.prompt_id,
          );
          assert.ok(current, "Original prompt vanished");
          assert.equal(
            current.user_message_id,
            original.user_message_id,
            "Resubmit duplicated user message identity",
          );
          const messageCount = db.messageIds.filter(
            (id) => id === original.user_message_id,
          ).length;
          assert.ok(messageCount <= 1, "Duplicate user message identity");
          if (current.status === "succeeded") assert.equal(messageCount, 1);
        }
        for (const p of db.prompts.filter((p) => p.status === "succeeded"))
          assert.equal(
            db.runs.filter((r) => r.run_id === p.run_id).length,
            1,
            "Expected one durable run for executed prompt",
          );
        record("assert-pass", { assertions: input, ...summary() });
      } else throw new Error("Unknown command");
    } catch (error) {
      failures.push(String(error));
      record("command-failure", { message: String(error) });
    }
  }
} finally {
  await close();
}
if (!closed || failures.length) process.exitCode = 1;

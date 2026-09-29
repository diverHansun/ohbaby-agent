/** Isolated compiled Web fixture. Drive the actual UI separately; no browser mocks. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const cli = resolve("packages/ohbaby-cli/dist/bin.js");
await access(cli);
const root = await mkdtemp(join(tmpdir(), "ohbaby-improve41-web-"));
const workspace = join(root, "workspace");
const profile = join(root, "profile");
const dbPath = join(root, "fixture.db");
const manifestPath = join(root, "manifest.json");
const inherited = Object.fromEntries(
  ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "SHELL"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
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
  OHBABY_I41_FIXTURE_KEY: "fixture-only",
  OHBABY_TUI_NO_ANIM: "1",
  NO_COLOR: "1",
};
const events = [],
  requests = [],
  failures = [],
  sessions = {};
const held = new Set();
let child, state, closing;
let dropNextCommand = false;
function record(type, detail = {}) {
  const event = { type, at: new Date().toISOString(), ...detail };
  events.push(event);
  console.log("I41_EVENT " + JSON.stringify(event));
}
async function until(predicate, description, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(description);
}
// Keep one browser origin across owned daemon restarts. Optional response loss
// happens after the real server completes; production handlers are untouched.
const proxy = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    let payload;
    if (body.length) {
      try {
        payload = JSON.parse(body.toString());
      } catch {}
    }
    const invocation =
      request.method === "POST" && request.url === "/v1/commands"
        ? payload
        : payload?.method === "executeCommand"
          ? payload.params?.[0]
          : undefined;
    const drop = Boolean(invocation && dropNextCommand);
    if (drop) dropNextCommand = false;
    if (invocation)
      record("command-request", { invocation, dropResponse: drop });
    const headers = { ...request.headers, host: `127.0.0.1:${state.port}` };
    if (headers.origin) headers.origin = `http://127.0.0.1:${state.port}`;
    const upstream = httpRequest(
      `http://127.0.0.1:${state.port}${request.url}`,
      { method: request.method, headers },
      async (result) => {
        if (!invocation) {
          response.writeHead(result.statusCode, result.headers);
          result.pipe(response);
          return;
        }
        try {
          const parts = [];
          for await (const part of result) parts.push(part);
          const reply = Buffer.concat(parts);
          record("command-response", {
            clientInvocationId: invocation.clientInvocationId,
            status: result.statusCode,
            reply: JSON.parse(reply.toString()),
          });
          if (drop && result.statusCode >= 200 && result.statusCode < 300) {
            const brokenHeaders = {
              ...result.headers,
              "content-length": String(reply.length),
            };
            delete brokenHeaders["transfer-encoding"];
            response.writeHead(result.statusCode, brokenHeaders);
            response.write("{");
            await delay(10);
            response.destroy();
            record("command-response-lost", {
              clientInvocationId: invocation.clientInvocationId,
            });
          } else {
            response.writeHead(result.statusCode, result.headers);
            response.end(reply);
          }
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
});
const publicPort = () => proxy.address().port;
function send(response, delta, finish_reason = null) {
  if (response.destroyed) return;
  response.write(
    "data: " +
      JSON.stringify({
        id: "i41",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason }],
      }) +
      "\n\n",
  );
}
function finish(response, text) {
  send(response, { content: text });
  send(response, {}, "stop");
  response.end("data: [DONE]\n\n");
}
function tool(response, name, args) {
  send(response, {
    tool_calls: [
      {
        index: 0,
        id: "call_" + randomUUID(),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  send(response, {}, "tool_calls");
  response.end("data: [DONE]\n\n");
}
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer fixture-only");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const auxiliary = !body.tools?.length;
    requests.push({ auxiliary, body });
    if (auxiliary) {
      assert.equal(body.messages.length, 2);
      assert.equal(body.prompt_cache_key, undefined);
      record("title-request", {
        maxTokens: body.max_tokens ?? body.max_completion_tokens,
        input: body.messages[1].content,
      });
      finish(
        response,
        /I41_SKILL/.test(raw)
          ? "检查会话切换"
          : /I41_A/.test(raw)
            ? "验收会话 A"
            : /I41_B(?:[^A-Z_]|$)/.test(raw)
              ? "验收会话 B"
              : "会话验收",
      );
      return;
    }
    const lastUserIndex = body.messages.findLastIndex((m) => m.role === "user");
    const text = JSON.stringify(body.messages[lastUserIndex]?.content ?? "");
    const toolResult = body.messages
      .slice(lastUserIndex + 1)
      .some((m) => m.role === "tool");
    record("run-request", {
      marker: text.match(/I41_[A-Z_]+/)?.[0],
      toolResult,
    });
    if (toolResult && text.includes("I41_CHILD_JOB")) {
      finish(
        response,
        Array.from(
          { length: 40 },
          (_, i) => `第 ${i + 1} 项：这是子会话阅读和滚动的验收内容。`,
        ).join("\n\n"),
      );
    } else if (toolResult) {
      finish(
        response,
        "验收工具已完成。保留真实输入、输出和错误，历史可以继续查看。",
      );
    } else if (text.includes("I41_HOLD")) {
      send(response, { content: "任务正在进行，可以停止或切换会话。" });
      held.add(response);
      response.on("close", () => held.delete(response));
    } else if (text.includes("I41_CHILD_JOB")) {
      tool(response, "bash", { command: "printf 'I41_CHILD_TOOL\\n'" });
    } else if (text.includes("I41_CHILD_NEXT")) {
      const id = body.messages
        .slice(0, lastUserIndex)
        .filter((message) => message.role === "tool")
        .map((message) => String(message.content))
        .join("\n")
        .match(/subagent_id:\s*(subagent_[a-zA-Z0-9_]+)/)?.[1];
      assert.ok(id, "No prior subagent identity for continuation");
      tool(response, "subagent_run", {
        subagent_id: id,
        description: "继续检查第二个任务",
        prompt: "I41_CHILD_JOB 第二次任务",
        mode: "foreground",
      });
    } else if (text.includes("I41_CHILD")) {
      tool(response, "subagent_run", {
        name: "稳定的验收子会话",
        description: "检查第一个任务",
        prompt: "I41_CHILD_JOB 第一次任务",
        mode: "foreground",
      });
    } else if (text.includes("I41_BASH")) {
      tool(response, "bash", {
        command: "printf 'I41_EXPECTED_FAILURE\\n' >&2; exit 7",
      });
    } else if (text.includes("I41_STATUS_TOOL")) {
      tool(response, "subagent_status", {});
    } else {
      finish(response, "I41_OK：会话验收完成。");
    }
  } catch (error) {
    failures.push(String(error));
    record("provider-failure", { message: String(error) });
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
function database(query, ...params) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}
function summary() {
  return {
    sessions: database("SELECT id,title,parent_id FROM session"),
    prompts: database(
      "SELECT prompt_id,session_id,status,client_request_id FROM prompt_submission ORDER BY created_at",
    ),
    runs: database(
      "SELECT run_id,session_id,status FROM run_ledger ORDER BY created_at",
    ),
    subagents: database("SELECT * FROM subagent_instance").map((row) => ({
      id: row.subagent_id,
      name: row.name,
      description: row.description,
    })),
    titleRequests: requests.filter((r) => r.auxiliary).length,
    mainRequests: requests.filter((r) => !r.auxiliary).length,
    failures,
  };
}
async function api(path, method = "GET", body) {
  const response = await fetch(`http://127.0.0.1:${state.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${state.authToken}`,
      "x-ohbaby-client-id": "i41-seeder",
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
async function saveManifest() {
  await writeFile(
    manifestPath,
    JSON.stringify({
      root,
      workspace,
      dbPath,
      sessions,
      port: publicPort(),
      token: state.authToken,
    }),
    { mode: 0o600 },
  );
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
        "Owned daemon exited: " +
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
  const built = await readFile(
    resolve("packages/ohbaby-cli/dist/web/index.html"),
    "utf8",
  );
  for (const [, asset] of built.matchAll(
    /(?:src|href)="([^"]+\.(?:js|css))"/g,
  )) {
    assert.ok(
      html.includes(asset.split("/").at(-1)),
      "Served assets differ from build",
    );
    assert.equal(
      (await fetch(new URL(asset, `http://127.0.0.1:${state.port}`))).ok,
      true,
    );
  }
  await saveManifest();
  record("ready", {
    url: `http://127.0.0.1:${publicPort()}`,
    daemonPort: state.port,
    pid: child.pid,
    manifestPath,
  });
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await until(
    () => child.exitCode !== null || child.signalCode !== null,
    "Owned daemon did not exit",
  );
}
async function close() {
  if (closing) return closing;
  closing = (async () => {
    await stop();
    proxy.closeAllConnections();
    await new Promise((done) => proxy.close(done));
    for (const response of held) response.destroy();
    provider.closeAllConnections();
    await new Promise((done) => provider.close(done));
    if (state) {
      let listening = false;
      try {
        await fetch(`http://127.0.0.1:${state.port}`, {
          signal: AbortSignal.timeout(500),
        });
        listening = true;
      } catch {}
      assert.equal(listening, false, "Owned daemon port remains open");
    }
    await rm(join(profile, "server"), { recursive: true, force: true });
    const final = state ? summary() : undefined;
    record("cleanup", {
      root,
      pidReleased:
        !child || child.exitCode !== null || child.signalCode !== null,
    });
    await writeFile(
      join(root, "evidence.json"),
      JSON.stringify({ events, requests, final }, null, 2),
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
  })();
  return closing;
}
try {
  await Promise.all(
    [workspace, profile, env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME].map(
      (p) => mkdir(p, { recursive: true }),
    ),
  );
  const skill = join(workspace, ".agents", "skills", "i41-review");
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: i41-review\ndescription: Review a supplied task in this isolated acceptance fixture.\n---\n\n" +
      "Fixture guidance. Preserve the user request.\n".repeat(100),
  );
  await writeFile(join(profile, ".skip-auto-migrate"), "");
  await new Promise((done) => provider.listen(0, "127.0.0.1", done));
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  await writeFile(
    join(profile, "model.json"),
    JSON.stringify({
      provider: "fixture",
      defaultModel: "fixture",
      apiConfig: {
        apiKeyEnv: "OHBABY_I41_FIXTURE_KEY",
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        interfaceProvider: "openai-compatible",
      },
      llmParams: {
        maxTokens: 1024,
        contextWindowTokens: 128000,
        temperature: 0,
      },
    }),
  );
  await start();
  await api("/v1/clients", "POST", { clientId: "i41-seeder" });
  for (const label of ["A", "B"]) {
    const created = await api("/v1/sessions", "POST", {});
    sessions[label] = created.session.id;
    await api("/v1/prompts", "POST", {
      sessionId: created.session.id,
      clientRequestId: randomUUID(),
      text: `I41_${label} 健康切换验收`,
    });
    await until(
      () =>
        database(
          "SELECT status FROM prompt_submission WHERE session_id=?",
          created.session.id,
        ).some((p) => p.status === "succeeded"),
      "Seed prompt did not finish",
    );
    await until(
      () =>
        database(
          "SELECT title FROM session WHERE id=?",
          created.session.id,
        ).some((session) => session.title === `验收会话 ${label}`),
      "Seed title did not finish",
    );
  }
  assert.equal(requests.filter((request) => request.auxiliary).length, 2);
  await saveManifest();
  record("seeded", { sessions });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    try {
      const input = JSON.parse(line);
      if (input.command === "quit") {
        lines.close();
        break;
      }
      if (input.command === "inspect") record("database", summary());
      else if (input.command === "drop-next-command") {
        dropNextCommand = true;
        record("command-response-loss-armed");
      } else if (input.command === "release")
        for (const response of held) finish(response, "I41_RELEASED");
      else if (input.command === "restart") {
        await stop();
        await start();
      } else if (input.command === "legacy") {
        await stop();
        const db = new DatabaseSync(dbPath);
        let count = 0;
        try {
          for (const row of db
            .prepare(
              "SELECT id,data FROM part WHERE type='tool' AND session_id=?",
            )
            .all(input.sessionId)) {
            const data = JSON.parse(row.data);
            if (data.metadata?.execution) {
              delete data.metadata.execution;
              db.prepare("UPDATE part SET data=? WHERE id=?").run(
                JSON.stringify(data),
                row.id,
              );
              count++;
            }
          }
        } finally {
          db.close();
        }
        record("legacy-fixture", { count, sessionId: input.sessionId });
        await start();
      } else if (input.command === "record") {
        assert.equal(typeof input.observation, "string");
        record("ui-observation", { observation: input.observation });
      } else if (input.command === "assert-command-loss") {
        assert.equal(typeof input.clientInvocationId, "string");
        const calls = events.filter(
          (event) =>
            event.type === "command-request" &&
            event.invocation.clientInvocationId === input.clientInvocationId,
        );
        const replies = events.filter(
          (event) =>
            event.type === "command-response" &&
            event.clientInvocationId === input.clientInvocationId,
        );
        const losses = events.filter(
          (event) =>
            event.type === "command-response-lost" &&
            event.clientInvocationId === input.clientInvocationId,
        );
        assert.equal(calls.length, 1, "Command was replayed or never sent");
        assert.equal(replies.length, 1, "Missing upstream handler completion");
        assert.equal(
          losses.length,
          1,
          "Expected one actual response truncation",
        );
        assert.equal(replies[0].status, 200);
        assert.equal(replies[0].reply.status, input.status ?? "completed");
        if (input.skill === true) {
          const receipt = replies[0].reply.promptReceipt;
          assert.ok(receipt, "Accepted skill response lacks prompt receipt");
          assert.equal(
            receipt.clientRequestId,
            calls[0].invocation.clientRequestId,
          );
          const prompts = database(
            "SELECT prompt_id,session_id,user_message_id,status FROM prompt_submission WHERE client_request_id=?",
            receipt.clientRequestId,
          );
          assert.equal(prompts.length, 1, "Skill prompt was duplicated");
          assert.equal(prompts[0].prompt_id, receipt.promptId);
          assert.equal(prompts[0].session_id, receipt.sessionId);
          assert.equal(prompts[0].user_message_id, receipt.userMessageId);
          if (input.promptStatus)
            assert.equal(prompts[0].status, input.promptStatus);
          assert.equal(typeof input.marker, "string");
          assert.equal(
            events.filter(
              (event) =>
                event.type === "run-request" && event.marker === input.marker,
            ).length,
            1,
            "Skill run was replayed or never started",
          );
        }
        record("command-loss-asserted", {
          clientInvocationId: input.clientInvocationId,
          skill: input.skill === true,
          promptStatus: input.promptStatus,
        });
      } else throw new Error("Unknown fixture command");
    } catch (error) {
      failures.push(String(error));
      record("command-failure", { message: String(error) });
    }
  }
} finally {
  await close();
}
assert.deepEqual(failures, []);

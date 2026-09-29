/** Current compiled CLI, owned profile/provider. Browser/PTY input stays real. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const cli = resolve("packages/ohbaby-cli/dist/bin.js");
if (process.argv[2] === "--attach-tui") {
  const manifest = JSON.parse(await readFile(process.argv[3], "utf8"));
  const child = spawn(process.execPath, [cli], {
    cwd: manifest.workspace,
    env: manifest.env,
    stdio: "inherit",
  });
  await writeFile(join(manifest.root, "tui.pid"), String(child.pid));
  const code = await new Promise((done) => child.once("exit", done));
  await rm(join(manifest.root, "tui.pid"), { force: true });
  process.exit(code ?? 1);
}
const tui = process.argv.includes("--tui");
const root = await mkdtemp(join(tmpdir(), "ohbaby-progress-e2e-"));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const workspace = join(root, "workspace");
const profile = join(root, "profile");
const dbPath = join(root, "fixture.db");
const gates = new Map();
const events = [];
const failures = [];
let scenario;
let child;
let state;
let stopped = false;
function gate(name) {
  if (!gates.has(name)) {
    let release;
    const promise = new Promise((r) => {
      release = r;
    });
    gates.set(name, { promise, release });
  }
  return gates.get(name);
}
function record(type, data = {}) {
  const row = { type, at: performance.now(), ...data };
  events.push(row);
  console.log("T5_EVENT " + JSON.stringify(row));
}
function chunk(response, delta, finish = null) {
  response.write(
    "data: " +
      JSON.stringify({
        id: "t5",
        object: "chat.completion.chunk",
        created: 0,
        model: "fixture",
        choices: [{ index: 0, delta, finish_reason: finish }],
      }) +
      "\n\n",
  );
}
function finish(response, text) {
  if (text) chunk(response, { content: text });
  chunk(response, {}, "stop");
  response.end("data: [DONE]\n\n");
}
const definitions = {
  approval: () => [
    [
      "write",
      {
        file_path: join(workspace, "a.txt"),
        content: "A_APPROVED",
        expected_mtime_ms: statSync(join(workspace, "a.txt")).mtimeMs,
      },
    ],
    ["read", { file_path: join(workspace, "b.txt") }],
  ],
  conflict: () => [
    ["read", { file_path: join(workspace, "a.txt") }],
    [
      "write",
      {
        file_path: join(workspace, "a.txt"),
        content: "CHANGED",
        expected_mtime_ms: statSync(join(workspace, "a.txt")).mtimeMs,
      },
    ],
    ["read", { file_path: join(workspace, "a.txt") }],
    ["read", { file_path: join(workspace, "b.txt") }],
  ],
  slow: () => [
    [
      "bash",
      {
        command: `node '${join(workspace, "gate.cjs")}' '${join(workspace, "release")}'`,
        timeout: 60000,
      },
    ],
    ["read", { file_path: join(workspace, "b.txt") }],
  ],
  timeout: () => [
    [
      "bash",
      {
        command: `node '${join(workspace, "gate.cjs")}' '${join(workspace, "never-release")}'`,
        timeout: 300,
      },
    ],
  ],
};
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let raw = "";
    for await (const c of request) raw += c;
    const body = JSON.parse(raw);
    assert.equal(request.headers.authorization, "Bearer fixture-only");
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    if (
      raw.includes("Write a short conversation title that identifies the user's task.")
    ) {
      finish(response, "Task 5 fixture");
      return;
    }
    assert.ok(
      scenario,
      "Select scenario on runner stdin before submitting a prompt",
    );
    const current = scenario;
    current.requests++;
    if (!current.promptId) {
      const active = readDb().prompts.filter(
        (p) =>
          !current.previousPrompts.includes(p.prompt_id) &&
          p.status === "running",
      );
      assert.equal(
        active.length,
        1,
        "Expected one new running prompt for this scenario",
      );
      current.promptId = active[0].prompt_id;
      current.runId = active[0].run_id;
    }
    record("provider", { scenario: current.name, request: current.requests });
    response.once("close", () =>
      record("provider-close", {
        scenario: current.name,
        request: current.requests,
      }),
    );
    if (current.requests > 1) {
      const results = body.messages
        .filter((m) => m.role === "tool")
        .filter((m) => String(m.tool_call_id).startsWith(current.prefix));
      assert.deepEqual(
        results.map((m) => m.tool_call_id),
        current.calls.map((_, i) => `${current.prefix}${i}`),
      );
      const rows = readDb().parts.filter((p) =>
        String(p.callId).startsWith(current.prefix),
      );
      assert.equal(rows.length, current.calls.length);
      assert.ok(
        rows.every((p) => p.metadata?.execution?.phase === "ended"),
        "Model continued before durable terminals",
      );
      current.resultOrder = results.map((r) => r.tool_call_id);
      finish(response, `T5_FINAL_${current.name}`);
      return;
    }
    if (current.name === "timing" || current.name === "stop") {
      chunk(response, { reasoning_content: "fixture reasoning, no body yet" });
      record("reasoning", { scenario: current.name });
      await gate("text").promise;
      if (response.destroyed) return;
      chunk(response, { content: "T5_FIRST_BODY" });
      record("first-text", { scenario: current.name });
      await gate("finish").promise;
      if (!response.destroyed) finish(response, " T5_FINAL_timing");
      return;
    }
    current.calls = definitions[current.name]();
    chunk(response, {
      tool_calls: current.calls.map(([name, args], index) => ({
        index,
        id: `${current.prefix}${index}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      })),
    });
    chunk(response, {}, "tool_calls");
    response.end("data: [DONE]\n\n");
  } catch (error) {
    failures.push(String(error));
    record("failure", { message: String(error) });
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
function readDb() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      parts: db
        .prepare("SELECT data FROM part WHERE type='tool' ORDER BY rowid")
        .all()
        .map((r) => JSON.parse(r.data)),
      prompts: db
        .prepare("SELECT * FROM prompt_submission ORDER BY created_at")
        .all(),
      runs: db.prepare("SELECT * FROM run_ledger ORDER BY created_at").all(),
    };
  } finally {
    db.close();
  }
}
const safeInheritedEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
  ),
);
const env = {
  ...safeInheritedEnv,
  HOME: join(root, "home"),
  USERPROFILE: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  OHBABY_HOME: profile,
  OHBABY_DB_PATH: dbPath,
  OHBABY_STORAGE_ROOT: join(root, "storage"),
  OHBABY_LOG_DIR: join(root, "logs"),
  NO_COLOR: "1",
};
if (process.argv.includes("--no-animation")) env.OHBABY_TUI_NO_ANIM = "1";
const manifestPath = join(root, "manifest.json");
let closing;
async function close() {
  if (closing) return closing;
  closing = (async () => {
    for (const g of gates.values()) g.release();
    await writeFile(join(workspace, "release"), "release");
    if (child?.exitCode === null) {
      const stopper = spawn(process.execPath, [cli, "serve", "stop"], {
        cwd: workspace,
        env,
        stdio: "ignore",
      });
      await Promise.race([
        new Promise((r) => stopper.once("exit", r)),
        delay(15000),
      ]);
      if (stopper.exitCode === null) stopper.kill("SIGTERM");
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise((r) => child.once("exit", r)),
          delay(5000),
        ]);
      }
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise((r) => child.once("exit", r));
      }
    }
    if (tui) {
      try {
        const pid = Number(await readFile(join(root, "tui.pid"), "utf8"));
        if (alive(pid)) {
          process.kill(pid, "SIGTERM");
          for (let i = 0; i < 100 && alive(pid); i++) await delay(25);
        }
        assert.equal(alive(pid), false, "Owned TUI did not exit");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    provider.closeAllConnections();
    await new Promise((r) => provider.close(r));
    if (state?.port) {
      let live = false;
      try {
        await fetch(`http://127.0.0.1:${state.port}/`, {
          signal: AbortSignal.timeout(500),
        });
        live = true;
      } catch {}
      assert.equal(live, false, "Owned daemon port remains open");
    }
    for (const marker of ["release", "never-release"]) {
      try {
        const pid = Number(
          await readFile(join(workspace, marker + ".pid"), "utf8"),
        );
        assert.equal(alive(pid), false, "Owned Bash fixture still alive");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await writeFile(
      join(root, "evidence.json"),
      JSON.stringify({ events, failures }, null, 2),
      { mode: 0o600 },
    );
    record("closed", { root, failures: failures.length });
    stopped = true;
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
  await writeFile(join(profile, ".env"), "T5_FIXTURE_KEY=fixture-only\n", {
    mode: 0o600,
  });
  await writeFile(join(workspace, "a.txt"), "ORIGINAL");
  await writeFile(join(workspace, "b.txt"), "B_FAST_SENTINEL");
  await writeFile(
    join(workspace, "gate.cjs"),
    "const fs=require('node:fs'); fs.writeFileSync(process.argv[2]+'.pid',String(process.pid)); process.stdout.write('T5_CHILD_STARTED\\n'); const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t);process.stdout.write('T5_CHILD_DONE\\n')}},25);",
  );
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const port = provider.address().port;
  await writeFile(
    join(profile, "model.json"),
    JSON.stringify({
      provider: "fixture",
      defaultModel: "fixture",
      apiConfig: {
        apiKeyEnv: "T5_FIXTURE_KEY",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        interfaceProvider: "openai-compatible",
      },
      llmParams: {
        maxTokens: 2048,
        contextWindowTokens: 128000,
        temperature: 0,
      },
    }),
  );
  await writeFile(
    manifestPath,
    JSON.stringify({ root, workspace, dbPath, env }),
    { mode: 0o600 },
  );
  if (!tui) {
    child = spawn(
      process.execPath,
      [cli, "serve", "--port", "0", "--no-open"],
      { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    // Keep raw startup output private: it may contain the local auth URL.
    let output = "";
    child.stdout.on("data", (c) => {
      output += c;
    });
    child.stderr.on("data", (c) => {
      output += c;
    });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        state = JSON.parse(
          await readFile(join(profile, "server/daemon-state.json"), "utf8"),
        );
        if (state.pid === child.pid) break;
      } catch {}
      if (child.exitCode !== null)
        throw new Error("Compiled daemon exited before ready");
      await delay(25);
    }
    assert.equal(state?.pid, child.pid);
    await writeFile(join(root, "daemon-private.json"), JSON.stringify(state), {
      mode: 0o600,
    });
    record("ready", {
      mode: "compiled-default-serve",
      url: `http://127.0.0.1:${state.port}`,
      manifestPath,
      privateAuthPath: join(root, "daemon-private.json"),
    });
  } else
    record("ready", {
      mode: "compiled-default-tui",
      manifestPath,
      launch: `node scripts/run-execution-progress-e2e.mjs --attach-tui ${manifestPath}`,
    });
  console.log(
    "T5_COMMANDS scenario(name=approval|conflict|slow|timeout|timing|stop), release(name=text|finish|tool), check(stage=waiting|executing|terminal), quit; one JSON line each",
  );
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    try {
      const input = JSON.parse(line);
      if (input.command === "quit") {
        lines.close();
        break;
      }
      if (input.command === "scenario") {
        assert.ok(
          definitions[input.name] || ["timing", "stop"].includes(input.name),
        );
        for (const g of gates.values()) g.release();
        gates.clear();
        await rm(join(workspace, "release"), { force: true });
        let previousPrompts = [];
        try {
          previousPrompts = readDb().prompts.map((p) => p.prompt_id);
        } catch {}
        scenario = {
          previousPrompts,
          name: input.name,
          prefix: `t5_${randomUUID()}_`,
          requests: 0,
          calls: [],
        };
        record("scenario-ready", {
          name: scenario.name,
          prompt: `Run Task 5 ${scenario.name} fixture`,
        });
      } else if (input.command === "release") {
        if (input.name === "tool")
          await writeFile(join(workspace, "release"), "release");
        else gate(input.name).release();
        record("released", { name: input.name });
      } else if (input.command === "check") {
        assert.ok(scenario);
        assert.deepEqual(failures, []);
        const db = readDb();
        const tools = db.parts.filter((p) =>
          String(p.callId).startsWith(scenario.prefix),
        );
        if (input.stage === "waiting") {
          assert.equal(scenario.requests, 1);
          if (scenario.name === "approval") {
            assert.equal(
              tools[0]?.metadata?.execution?.executionStartedAt,
              undefined,
            );
            assert.equal(tools[1]?.state.status, "completed");
            assert.match(tools[1]?.state.output, /B_FAST_SENTINEL/);
          } else if (scenario.name === "conflict") {
            assert.equal(
              tools[2]?.metadata?.execution?.executionStartedAt,
              undefined,
            );
            assert.equal(tools[3]?.state.status, "completed");
          }
        } else if (input.stage === "executing") {
          assert.equal(scenario.requests, 1);
          assert.ok(
            tools.some((p) => p.metadata?.execution?.phase === "executing"),
          );
        } else if (input.stage === "terminal") {
          assert.equal(tools.length, scenario.calls.length);
          assert.ok(
            tools.every((p) => p.metadata?.execution?.phase === "ended"),
          );
          if (scenario.name === "timeout") {
            assert.equal(tools.length, 1);
            assert.equal(tools[0].state.metadata?.status, "timed_out");
            assert.equal(tools[0].metadata?.execution?.outcome, "timed-out");
            assert.equal(tools[0].metadata?.execution?.cleanup, "confirmed");
          }
          if (scenario.calls.length) assert.equal(scenario.requests, 2);
          if (["approval", "slow", "conflict"].includes(scenario.name))
            assert.ok(
              tools.every((p) => p.state.status === "completed"),
              "Expected successful real tools",
            );
          const prompt = db.prompts.find(
            (p) => p.prompt_id === scenario.promptId,
          );
          assert.ok(
            prompt &&
              prompt.run_id === scenario.runId &&
              prompt.ended_at !== null &&
              ["succeeded", "cancelled", "failed", "interrupted"].includes(
                prompt.status,
              ),
            "This scenario has no durable terminal prompt",
          );
          if (scenario.name === "stop")
            assert.equal(prompt.status, "cancelled");
          else assert.equal(prompt.status, "succeeded");
        } else throw new Error("Unknown checkpoint");
        record("checkpoint-pass", {
          scenario: scenario.name,
          stage: input.stage,
          requests: scenario.requests,
          resultOrder: scenario.resultOrder,
          tools: tools.map((p) => ({
            callId: p.callId,
            tool: p.tool,
            status: p.state.status,
            execution: p.metadata?.execution,
          })),
          promptStatuses: db.prompts.map((p) => ({
            status: p.status,
            createdAt: p.created_at,
            endedAt: p.ended_at,
          })),
        });
      } else throw new Error("Unknown command");
    } catch (error) {
      failures.push(String(error));
      record("command-failure", { message: String(error) });
    }
  }
} finally {
  await close();
}
if (!stopped || failures.length) process.exitCode = 1;

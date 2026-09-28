/** Current compiled CLI, owned profile/provider. Browser/PTY input stays real. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { statSync, appendFileSync } from "node:fs";
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
const conversationUi = process.argv.includes("--conversation-ui");
const root = await mkdtemp(join(tmpdir(), "ohbaby-subagents-e2e-"));
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
const childStreams = new Map();
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
  appendFileSync(join(root, "events.jsonl"), JSON.stringify(row) + "\n", {
    mode: 0o600,
  });
  console.log("I3_EVENT " + JSON.stringify(row));
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
const provider = createServer(async (request, response) => {
  try {
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
      finish(response, "Improve 3 fixture");
      return;
    }
    const user = body.messages
      .filter((m) => m.role === "user")
      .map((m) =>
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      );
    if (conversationUi && user.at(-1)?.startsWith("I31_FOLLOWUP_A")) {
      chunk(response, {
        reasoning_content:
          "Continue the same child after its queued instruction.",
      });
      finish(response, "FOLLOWUP_A_COMPLETE");
      return;
    }
    const childSide = ["A", "B", "C"].find((side) =>
      user.some((text) => text.startsWith(`I3_CHILD_${side}`)),
    );
    if (childSide) {
      record("child-request", { side: childSide });
      if (
        process.argv.includes("--approval") &&
        childSide === "C" &&
        !body.messages.some(
          (m) => m.role === "tool" && m.tool_call_id === "i3_child_write",
        )
      ) {
        if (conversationUi) await gate("approval").promise;
        const file = join(workspace, "a.txt");
        chunk(response, {
          tool_calls: [
            {
              index: 0,
              id: "i3_child_write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  file_path: file,
                  content: "CHILD_C_APPROVED",
                  expected_mtime_ms: statSync(file).mtimeMs,
                }),
              },
            },
          ],
        });
        chunk(response, {}, "tool_calls");
        response.end("data: [DONE]\n\n");
        return;
      }
      chunk(response, {
        reasoning_content: `Full reasoning for child ${childSide}`,
      });
      if (conversationUi) {
        for (const text of [
          `Child ${childSide} is `,
          "reading the task. ",
          "Waiting for the controlled release.",
        ]) {
          chunk(response, { content: text });
          await delay(150);
        }
      }
      childStreams.set(childSide, response);
      await gate(childSide).promise;
      childStreams.delete(childSide);
      if (!response.destroyed)
        finish(
          response,
          childSide === "C"
            ? "REPORT_C_BEGIN\n" +
                "中文完整结果\n".repeat(4000) +
                "REPORT_C_END"
            : `REPORT_${childSide}_FULL`,
        );
      return;
    }
    if (user.at(-1)?.includes("I3_ORDINARY")) {
      finish(response, "I3_ORDINARY_DONE");
      record("ordinary-request");
      return;
    }
    if (!scenario) scenario = { requests: 0, outputs: [] };
    scenario.requests++;
    record("parent-request", { request: scenario.requests });
    const calls = body.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.tool_calls ?? []);
    const sendTools = (specs) => {
      chunk(response, {
        tool_calls: specs.map(([name, args], index) => ({
          index,
          id: `i3_${scenario.requests}_${index}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        })),
      });
      chunk(response, {}, "tool_calls");
      response.end("data: [DONE]\n\n");
    };
    if (!calls.some((call) => call.function.name === "subagent_run")) {
      const requiredTools = conversationUi
        ? ["subagent_run", "todo_write"]
        : ["subagent_run"];
      if (
        requiredTools.some(
          (name) => !body.tools.some((tool) => tool.function.name === name),
        )
      ) {
        sendTools([["select_tools", { tools: requiredTools }]]);
        return;
      }
      if (
        conversationUi &&
        !calls.some((call) => call.function.name === "todo_write")
      ) {
        sendTools([
          [
            "todo_write",
            {
              todos: [
                { content: "Inspect child A progress", status: "in_progress" },
                { content: "Review queued child follow-up", status: "pending" },
              ],
            },
          ],
        ]);
        return;
      }
      sendTools(
        ["A", "B", "C"].map((side) => [
          "subagent_run",
          {
            role: "generic",
            prompt: `I3_CHILD_${side}`,
            description: `Child ${side}`,
          },
        ]),
      );
      return;
    }
    if (
      conversationUi &&
      !calls.some((call) => call.function.arguments?.includes("I31_FOLLOWUP_A"))
    ) {
      const first = readDb().executions.find(
        (execution) => execution.prompt === "I3_CHILD_A",
      );
      if (!first) throw new Error("First child missing before continuation");
      sendTools([
        [
          "subagent_run",
          {
            subagent_id: first.subagent_id,
            prompt:
              "I31_FOLLOWUP_A Please continue with one concise final answer.",
            description: "Child A follow-up",
            mode: "background",
          },
        ],
      ]);
      return;
    }
    const input = user.join("\n");
    const all = readDb().executions;
    if (
      all.length === (conversationUi ? 4 : 3) &&
      all.every((e) => e.status === "completed") &&
      input.includes("Complete result:")
    ) {
      const path = /Complete result: ([^\n]+\.output)/.exec(input)?.[1];
      if (!calls.some((call) => call.function.name === "read")) {
        sendTools([["read", { file_path: path }]]);
        return;
      }
      finish(response, "I3_FINAL_A_B_C_AND_STEER");
      return;
    }
    finish(
      response,
      input.includes("REPORT_A_FULL")
        ? "I3_A_RECEIVED_STILL_WAITING"
        : input.includes("I3_STEER")
          ? "I3_STEER_RECEIVED"
          : "I3_WAITING_FOR_CHILDREN",
    );
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
      executions: db
        .prepare("SELECT * FROM subagent_execution ORDER BY created_at")
        .all()
        .map((r) => ({
          ...r,
          executionId: r.execution_id,
          delivery: JSON.parse(r.delivery),
          artifact: JSON.parse(r.artifact),
        })),
      inputs: db
        .prepare("SELECT data FROM current_run_input ORDER BY accepted_at")
        .all()
        .map((r) => JSON.parse(r.data)),
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
    if (child?.exitCode === null && child.signalCode === null) {
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
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([
          new Promise((r) => child.once("exit", r)),
          delay(5000),
        ]);
      }
      if (child.exitCode === null && child.signalCode === null) {
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
      launch: `node scripts/run-subagent-continuation-e2e.mjs --attach-tui ${manifestPath}`,
    });
  console.log(
    "I3_COMMANDS release(name=A|B|C), check(stage=waiting|partial|terminal), quit",
  );
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    try {
      const input = JSON.parse(line);
      if (input.command === "quit") {
        lines.close();
        break;
      }
      if (input.command === "release") {
        gate(input.name).release();
        record("released", { name: input.name });
      } else if (input.command === "progress") {
        const stream = childStreams.get(input.name);
        assert.ok(stream, "Child stream must be active");
        chunk(stream, { reasoning_content: " Additional live thought." });
        chunk(stream, { content: " LIVE_PROGRESS_" + input.name });
        record("progress", { name: input.name });
      } else if (input.command === "check") {
        const db = readDb();
        assert.deepEqual(failures, []);
        if (conversationUi) {
          assert.ok(
            db.parts.some(
              (part) =>
                part.tool === "todo_write" && part.state.status === "completed",
            ),
          );
          assert.equal(db.executions.length, 4);
          const a = db.executions.filter(
            (execution) =>
              execution.prompt.startsWith("I3_CHILD_A") ||
              execution.prompt.startsWith("I31_FOLLOWUP_A"),
          );
          assert.equal(
            new Set(a.map((execution) => execution.subagent_id)).size,
            1,
          );
          assert.equal(
            new Set(a.map((execution) => execution.child_user_message_id)).size,
            2,
          );
          assert.deepEqual(
            a.map((execution) => execution.delegation_sequence).sort(),
            [1, 2],
          );
          if (input.stage === "waiting") {
            assert.equal(
              db.executions.filter((e) => e.status === "running").length,
              3,
            );
            assert.equal(
              db.executions.filter((e) => e.status === "queued").length,
              1,
            );
            assert.equal(db.prompts[0].status, "running");
          } else if (input.stage === "terminal") {
            assert.ok(
              db.executions.every(
                (e) =>
                  e.status === "completed" && e.delivery.state === "processed",
              ),
            );
            assert.equal(
              db.prompts.filter((prompt) => prompt.status === "succeeded")
                .length,
              2,
            );
            assert.ok(
              db.parts.some(
                (part) =>
                  part.tool === "read" && part.state.status === "completed",
              ),
            );
          } else throw new Error("Unknown stage");
          record("conversation-identity-checked", { stage: input.stage });
          continue;
        }
        assert.equal(db.executions.length, 3);
        assert.ok(db.executions.every((e) => e.mode === "background"));
        if (input.stage === "waiting") {
          assert.ok(db.executions.every((e) => e.status === "running"));
          assert.equal(db.prompts[0].status, "running");
        } else if (input.stage === "partial") {
          assert.equal(
            db.executions.filter((e) => e.status === "completed").length,
            1,
          );
          assert.equal(
            db.executions.filter((e) => e.delivery.state === "processed")
              .length,
            1,
          );
          assert.equal(db.prompts[0].status, "running");
          assert.ok(
            db.inputs.some(
              (i) => i.source === "user-steer" && i.processedRequestId,
            ),
          );
          assert.ok(
            db.prompts.some(
              (p) => p.status === "queued" && p.text.includes("I3_ORDINARY"),
            ),
          );
        } else if (input.stage === "terminal") {
          assert.ok(
            db.executions.every(
              (e) =>
                e.status === "completed" && e.delivery.state === "processed",
            ),
          );
          const large = db.executions.find(
            (e) => Buffer.byteLength(e.output) > 51200,
          );
          assert.equal(large.artifact.state, "ready");
          assert.equal(
            await readFile(large.artifact.path, "utf8"),
            large.output,
          );
          assert.ok(!large.artifact.path.startsWith(workspace));
          assert.equal(
            db.prompts.filter((p) => p.status === "steered").length,
            1,
          );
          assert.equal(
            db.prompts.filter((p) => p.status === "succeeded").length,
            2,
          );
          assert.equal(
            db.parts.filter((p) => p.tool === "subagent_status").length,
            0,
          );
          if (process.argv.includes("--approval"))
            assert.equal(
              await readFile(join(workspace, "a.txt"), "utf8"),
              "CHILD_C_APPROVED",
            );
          assert.ok(
            db.parts.some(
              (p) => p.tool === "read" && p.state.status === "completed",
            ),
          );
        } else throw new Error("Unknown stage");
        record("checkpoint-pass", {
          stage: input.stage,
          requests: scenario.requests,
          executions: db.executions.map((e) => ({
            executionId: e.executionId,
            status: e.status,
            delivery: e.delivery.state,
          })),
          prompts: db.prompts.map((p) => ({
            status: p.status,
            runId: p.run_id,
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

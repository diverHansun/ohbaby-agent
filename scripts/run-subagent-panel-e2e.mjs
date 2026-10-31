#!/usr/bin/env node
/** Real compiled Web/Host/SDK fixture; only the OpenAI-compatible model is scripted.
 * Start after building: node scripts/run-subagent-panel-e2e.mjs
 * Use the printed prompts in the browser. stdin: status, tick, finish (assert), quit.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repository, "packages/ohbaby-cli/dist/bin.js");
const compiledIndex = join(
  repository,
  "packages/ohbaby-cli/dist/web/index.html",
);
await Promise.all([access(cli), access(compiledIndex)]);
assert.equal(
  process.argv.length,
  2,
  "Usage: node scripts/run-subagent-panel-e2e.mjs",
);
const root = await mkdtemp(join(tmpdir(), "ohbaby-subagent-panel-e2e-"));
const workspace = join(root, "workspace");
const profile = join(root, "profile");
const databasePath = join(root, "fixture.db");
const historySteps = 26;
const requests = [];
const failures = [];
const heldResponses = new Set();
let daemon;
let state;
let finishRequested = false;
let startupOutput = "";
let lines;
let interrupted = false;
let streamTick = 0;
const env = {
  // A fixture must not inherit the developer's credentials or profile overrides.
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) &&
        !key.startsWith("OHBABY_"),
    ),
  ),
  HOME: join(root, "home"),
  USERPROFILE: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  APPDATA: join(root, "appdata"),
  LOCALAPPDATA: join(root, "localappdata"),
  OHBABY_HOME: profile,
  OHBABY_DB_PATH: databasePath,
  OHBABY_STORAGE_ROOT: join(root, "storage"),
  OHBABY_LOG_DIR: join(root, "logs"),
  NO_COLOR: "1",
};
const prompts = {
  PANEL_START:
    "Create Reader (26 real read calls and long history), Runner (held stream), and Approval (real bash permission).",
  PANEL_SEND_READER:
    "Send a second execution to the existing Reader; use before closing Reader.",
  PANEL_CLOSE_READER:
    "Close Reader; verify removal from the open-instance list and selected conversation.",
  PANEL_OTHER_SESSION:
    "In a new session, create Other reader; verify session isolation, then return to the first session.",
  PANEL_RUNNING:
    "Create a fresh held Runner after stopping/closing the original Runner.",
  PANEL_HOLD:
    "Hold the primary response without spawning a child; queue and Steer PANEL_FAIL, then Stop run and verify the existing Runner stays active. stdin tick updates both live streams.",
  PANEL_CLOSE_RUNNING:
    "Close the latest open Runner through the real agent tool.",
  PANEL_SEND_RUNNING:
    "Send a message to the latest Runner while it is running; verify a delivery receipt without a new execution entry.",
  PANEL_CAPACITY:
    "Spawn seven held Capacity runners; verify the six-execution limit rejects excess calls without entry links. Run after the core scenario; quit cleans them up.",
  PANEL_FAIL:
    "Send to a nonexistent instance through the real agent tool; verify the failed tool card has no entry link.",
  PANEL_TEAM:
    "In a new session, spawn seven Workers in one turn: six start, the seventh is refused by the six-slot limit. Each Worker reads its own section and reports; results wake the parent, which summarizes them.",
  PANEL_TEAM_RETRY:
    "After the team finishes, spawn Worker 7 again; it starts because the six slots were returned.",
};
function record(type, data = {}) {
  console.log(`PANEL_EVENT ${JSON.stringify({ type, ...data })}`);
}
function content(message) {
  return typeof message?.content === "string"
    ? message.content
    : (message?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}
function calls(messages) {
  return messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.tool_calls ?? []);
}
function chunk(response, delta, finish = null) {
  response.write(
    `data: ${JSON.stringify({
      id: "panel-fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "panel-fixture",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish
        ? {
            usage: {
              prompt_tokens: 1200,
              completion_tokens: 100,
              total_tokens: 1300,
            },
          }
        : {}),
    })}\n\n`,
  );
}
function finish(response, text) {
  if (text) chunk(response, { content: text });
  chunk(response, {}, "stop");
  response.end("data: [DONE]\n\n");
}
async function holdResponse(response, kind) {
  heldResponses.add(response);
  record("held-stream", { kind });
  await new Promise((done) => response.once("close", done));
  heldResponses.delete(response);
  record("held-stream-closed", { kind });
}
function tools(response, body, specs, id) {
  const available = new Set(
    (body.tools ?? []).map((tool) => tool.function.name),
  );
  const missing = [...new Set(specs.map(([name]) => name))].filter(
    (name) => !available.has(name),
  );
  if (missing.length) {
    assert.ok(
      available.has("select_tools"),
      `Cannot select tools: ${missing.join(", ")}`,
    );
    specs = [["select_tools", { tools: missing }]];
    id += "_select";
  }
  chunk(response, {
    tool_calls: specs.map(([name, args], index) => ({
      index,
      id: `${id}_${index}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    })),
  });
  chunk(response, {}, "tool_calls");
  response.end("data: [DONE]\n\n");
}
function spawnSpec(name, kind) {
  return [
    "agent",
    {
      action: "spawn",
      name,
      role: "generic",
      timeout_ms: 1_800_000,
      description: `${name}: real compiled panel acceptance`,
      prompt: `PANEL_CHILD_${kind} ${name}\n${kind === "APPROVAL" ? "Run approval.cjs after user approval; it writes only the isolated approved.txt sentinel." : "Read only fixture.txt; do not change workspace files."} This is an isolated browser acceptance task.`,
    },
  ];
}
function previousAgent(messages, name) {
  const call = calls(messages).findLast((call) => {
    if (call.function.name !== "agent") return false;
    const args = JSON.parse(call.function.arguments);
    return args.action === "spawn" && args.name === name;
  });
  const receipt = messages.find(
    (message) => message.role === "tool" && message.tool_call_id === call?.id,
  );
  const id = /^agent_id: (.+)$/m.exec(content(receipt))?.[1];
  assert.ok(id, `No ${name} receipt in this session; submit PANEL_START first`);
  return id;
}
async function childResponse(response, body, kind) {
  const messages = body.messages;
  const followupIndex = messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      content(message).startsWith("PANEL_CHILD_FOLLOWUP"),
  );
  if (followupIndex >= 0) {
    chunk(response, {
      reasoning_content:
        "Reuse the same instance and confirm its earlier reading context.",
    });
    finish(
      response,
      "READER_FOLLOWUP_COMPLETE\n\nThe same Reader retained its earlier conversation. This is a new execution in that instance.",
    );
    return;
  }
  if (kind === "RUNNER") {
    chunk(response, {
      reasoning_content: `Inspecting ${kind.toLowerCase()} progress before the manual stop.`,
    });
    chunk(response, {
      content: `${kind}_STREAM_ACTIVE\n\nThis stream stays open until Stop or Close cancels the real child execution. The fixture is waiting without polling or additional model requests.`,
    });
    await holdResponse(response, kind);
    return;
  }
  if (kind === "APPROVAL") {
    const result = messages.find(
      (message) =>
        message.role === "tool" && message.tool_call_id === "panel_approval_0",
    );
    if (!result) {
      chunk(response, {
        content:
          "The next step runs approval.cjs in the isolated workspace and requires your approval.",
      });
      tools(
        response,
        body,
        [
          [
            "bash",
            {
              command: "node approval.cjs",
              description: "Write the isolated panel approval sentinel",
            },
          ],
        ],
        "panel_approval",
      );
    } else {
      record("approval-result", {
        approved: content(result).includes("PANEL_BASH_APPROVED"),
      });
      finish(
        response,
        `APPROVAL_COMPLETE\n\nThe production bash tool returned:\n\n\`\`\`text\n${content(result)}\n\`\`\``,
      );
    }
    return;
  }
  const reads = messages.filter(
    (message) =>
      message.role === "tool" &&
      /^panel_read_\d+_0$/.test(message.tool_call_id ?? ""),
  );
  if (kind === "WORKER") {
    const name = /^PANEL_CHILD_WORKER (Worker \d+)/m.exec(
      messages.map(content).join("\n"),
    )?.[1];
    assert.ok(name, "Worker name missing from its prompt");
    const index = Number(name.split(" ")[1]);
    // Keep the six workers visibly active in the panel for a few seconds.
    await delay(1_500);
    if (reads.length < 3) {
      const step = reads.length + 1;
      chunk(response, {
        content: `${name}: reading section ${index}, step ${step}/3.\n\n`,
      });
      tools(
        response,
        body,
        [
          [
            "read",
            {
              file_path: "fixture.txt",
              offset: (index - 1) * 30 + (step - 1) * 10 + 1,
              limit: 10,
            },
          ],
        ],
        `panel_read_${step}`,
      );
      return;
    }
    assert.ok(
      reads.every((message) => content(message).includes("PANEL_SOURCE_")),
      "Real read output did not reach the worker",
    );
    record("worker-complete", { name, readCalls: reads.length });
    finish(
      response,
      `WORKER_COMPLETE ${name}\n\nSection ${index} verified through ${reads.length} real read calls.`,
    );
    return;
  }
  const count = kind === "OTHER" ? 2 : historySteps;
  if (reads.length < count) {
    const step = reads.length + 1;
    chunk(response, {
      reasoning_content: `Reading section ${step}/${count}; preserving the full production tool transcript.`,
    });
    chunk(response, {
      content: `### Reading checkpoint ${step}\n\nChecking source lines and recording a reproducible result. This paragraph creates useful scroll history for panel cache and tab switching checks.\n\n`,
    });
    tools(
      response,
      body,
      [
        [
          "read",
          { file_path: "fixture.txt", offset: (step - 1) * 10 + 1, limit: 20 },
        ],
      ],
      `panel_read_${step}`,
    );
  } else {
    assert.ok(
      reads.every((message) => content(message).includes("PANEL_SOURCE_")),
      "Real read output did not reach model",
    );
    record("reader-complete", { kind, readCalls: reads.length });
    finish(
      response,
      `${kind}_COMPLETE\n\n` +
        Array.from(
          { length: 20 },
          (_, i) =>
            `### Finding ${i + 1}\n\nThe real read tool returned numbered source lines. This retained paragraph is useful when scrolling upward, switching instances, reopening the panel, and verifying restoration of reading position.\n\n- Source verified: PANEL_SOURCE_${String(i + 1).padStart(3, "0")}\n- No workspace files were modified by this reader.\n`,
        ).join("\n"),
    );
  }
}
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer panel-fixture-only");
    let raw = "";
    for await (const value of request) raw += value;
    const body = JSON.parse(raw);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    if (
      raw.includes(
        "Write a short conversation title that identifies the user's task.",
      )
    ) {
      finish(
        response,
        raw.includes("PANEL_OTHER_SESSION")
          ? "Other session fixture"
          : "Subagent panel acceptance",
      );
      return;
    }
    const messages = body.messages;
    const child = messages.find(
      (message) =>
        message.role === "user" &&
        /^PANEL_CHILD_(READER|RUNNER|APPROVAL|OTHER|WORKER)\b/.test(
          content(message),
        ),
    );
    if (child) {
      const kind = /^PANEL_CHILD_(\w+)/.exec(content(child))[1];
      requests.push({ kind });
      await childResponse(response, body, kind);
      return;
    }
    const commandIndex = messages.findLastIndex(
      (message) =>
        message.role === "user" &&
        /^PANEL_(START|SEND_READER|CLOSE_READER|OTHER_SESSION|RUNNING|HOLD|CLOSE_RUNNING|SEND_RUNNING|CAPACITY|FAIL|TEAM_RETRY|TEAM)\b/.test(
          content(message),
        ),
    );
    if (commandIndex < 0) {
      finish(
        response,
        "Enter one of the PANEL_* prompts printed by the fixture.",
      );
      return;
    }
    const command = /^PANEL_(\w+)/.exec(content(messages[commandIndex]))[1];
    const id = `panel_command_${commandIndex}_${command}`;
    const alreadyCalled = calls(messages).some(
      (call) =>
        call.id.startsWith(id + "_action_") && !call.id.includes("_select"),
    );
    requests.push({ kind: "parent", command });
    if (alreadyCalled) {
      // A delivered worker result wakes the parent: summarize what arrived.
      const delivered = [
        ...new Set(
          messages
            .slice(commandIndex)
            .flatMap((message) => [
              ...content(message).matchAll(/WORKER_COMPLETE (Worker \d+)/g),
            ])
            .map((match) => match[1]),
        ),
      ].sort((a, b) => Number(a.split(" ")[1]) - Number(b.split(" ")[1]));
      if (command.startsWith("TEAM") && delivered.length > 0) {
        record("team-summary", { delivered });
        finish(
          response,
          `PANEL_${command}_SUMMARY\n\nDelivered results so far: ${delivered.length} (${delivered.join(", ")}).`,
        );
        return;
      }
      // Expected agent rejections are real tool receipts, not provider failures.
      if (["SEND_RUNNING", "CAPACITY", "FAIL", "TEAM"].includes(command)) {
        finish(
          response,
          messages
            .filter(
              (message) =>
                message.role === "tool" &&
                message.tool_call_id?.startsWith(id + "_action_") &&
                !message.tool_call_id.includes("_select"),
            )
            .map(content)
            .join("\n\n"),
        );
        return;
      }
      finish(
        response,
        `PANEL_${command}_ACCEPTED\n\nOpen the Subagents panel to inspect the real instances, execution history, and tool output.`,
      );
      return;
    }
    record("command", { command });
    if (command === "HOLD") {
      chunk(response, {
        reasoning_content:
          "Keeping the primary response open for the queue, Steer, and Stop checks.",
      });
      chunk(response, {
        content:
          "PANEL_HOLD_STREAM_ACTIVE\n\nThis is the primary response. Queue PANEL_FAIL and Steer it into this run, then use Stop run. The existing background Runner should keep streaming; its next tick confirms it is still active.",
      });
      await holdResponse(response, "PARENT_HOLD");
      return;
    }
    let specs;
    if (command === "START")
      specs = [
        spawnSpec("Reader", "READER"),
        spawnSpec("Runner", "RUNNER"),
        spawnSpec("Approval", "APPROVAL"),
      ];
    else if (command === "OTHER_SESSION")
      specs = [spawnSpec("Other reader", "OTHER")];
    else if (command === "RUNNING") specs = [spawnSpec("Runner", "RUNNER")];
    else if (command === "TEAM")
      specs = Array.from({ length: 7 }, (_, index) =>
        spawnSpec(`Worker ${index + 1}`, "WORKER"),
      );
    else if (command === "TEAM_RETRY")
      specs = [spawnSpec("Worker 7", "WORKER")];
    else if (command === "CAPACITY")
      specs = Array.from({ length: 7 }, (_, index) =>
        spawnSpec(`Capacity ${index + 1}`, "RUNNER"),
      );
    else if (command === "SEND_RUNNING" || command === "FAIL")
      specs = [
        [
          "agent",
          {
            action: "send",
            agent_id:
              command === "SEND_RUNNING"
                ? previousAgent(messages, "Runner")
                : "panel-nonexistent-agent",
            message: "Retain this message and continue the current task.",
          },
        ],
      ];
    else if (command === "SEND_READER")
      specs = [
        [
          "agent",
          {
            action: "send",
            agent_id: previousAgent(messages, "Reader"),
            message:
              "PANEL_CHILD_FOLLOWUP\nConfirm retained history in a second execution.",
          },
        ],
      ];
    else
      specs = [
        [
          "agent",
          {
            action: "close",
            agent_id: previousAgent(
              messages,
              command === "CLOSE_READER" ? "Reader" : "Runner",
            ),
          },
        ],
      ];
    tools(response, body, specs, id + "_action");
  } catch (error) {
    failures.push(String(error));
    record("provider-failure", { message: String(error) });
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
function snapshot() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      instances: db
        .prepare(
          "SELECT subagent_id AS id, name, status, parent_session_id AS parent, closed_at AS closedAt FROM subagent_instance ORDER BY created_at",
        )
        .all(),
      executions: db
        .prepare(
          "SELECT execution_id AS id, subagent_id AS agentId, status, mode, prompt, reason FROM subagent_execution ORDER BY created_at",
        )
        .all(),
      tools: db
        .prepare("SELECT data FROM part WHERE type='tool' ORDER BY rowid")
        .all()
        .map((row) => {
          const part = JSON.parse(row.data);
          return { name: part.tool, status: part.state?.status };
        }),
      requestCount: requests.length,
      heldStreams: heldResponses.size,
      failures,
    };
  } finally {
    db.close();
  }
}
async function verifyScenario() {
  const evidence = snapshot();
  assert.deepEqual(failures, []);
  const reader = evidence.instances.find((item) => item.name === "Reader");
  const runner = evidence.instances.find((item) => item.name === "Runner");
  const approval = evidence.instances.find((item) => item.name === "Approval");
  const other = evidence.instances.find((item) => item.name === "Other reader");
  const executions = (instance) =>
    evidence.executions.filter((item) => item.agentId === instance?.id);
  assert.ok(
    reader && runner && approval,
    "PANEL_START must create all three instances",
  );
  assert.ok(
    executions(reader).filter((item) => item.status === "completed").length >=
      2,
    "PANEL_SEND_READER must complete a second execution",
  );
  assert.ok(reader.closedAt, "PANEL_CLOSE_READER must close Reader");
  assert.ok(
    executions(runner).some((item) =>
      ["cancelled", "interrupted"].includes(item.status),
    ),
    "Stop Runner from the UI",
  );
  assert.ok(
    executions(approval).some((item) => item.status === "completed"),
    "Resolve the bash approval",
  );
  assert.equal(
    await readFile(join(workspace, "approved.txt"), "utf8"),
    "PANEL_BASH_APPROVED\n",
  );
  assert.ok(
    other &&
      other.parent !== reader.parent &&
      executions(other).some((item) => item.status === "completed"),
    "Run PANEL_OTHER_SESSION in a separate session",
  );
  assert.ok(
    evidence.tools.filter(
      (tool) => tool.name === "read" && tool.status === "completed",
    ).length >= historySteps,
    "Real read history is missing",
  );
  return evidence;
}
function runCli(args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", cli, ...args], {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (value) => {
      output += value;
    });
    child.stderr.on("data", () => {});
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI ${args.join(" ")} timed out`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      done({ code, output });
    });
  });
}
async function waitUntil(check, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(message);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
async function assertPortReleased(port) {
  const probe = createNetServer();
  await new Promise((done, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", done);
  });
  await new Promise((done, reject) =>
    probe.close((error) => (error ? reject(error) : done())),
  );
}
async function cleanup() {
  const errors = [];
  const attempt = async (action) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  if (daemon) {
    await attempt(async () => {
      const result = await runCli(["serve", "stop"]);
      assert.equal(result.code, 0);
      assert.match(result.output, /daemon (stopped|not-running)/);
    });
    // Terminate only this script's owned child if graceful stop failed.
    if (alive(daemon.pid)) daemon.kill("SIGTERM");
    await attempt(async () => {
      try {
        await waitUntil(
          () => !alive(daemon.pid),
          "Owned daemon remained alive",
          5_000,
        );
      } catch {
        daemon.kill("SIGKILL");
        await waitUntil(
          () => !alive(daemon.pid),
          "Owned daemon survived SIGKILL",
          5_000,
        );
      }
    });
    await attempt(async () => {
      const status = await runCli(["serve", "status"]);
      assert.equal(status.code, 0);
      assert.match(status.output, /daemon status: (stopped|not-running)/);
    });
    await attempt(async () => {
      try {
        await access(join(profile, "server/daemon.pid"));
        throw new Error("Daemon pid lock remains");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    });
  }
  for (const response of heldResponses) response.destroy();
  provider.closeAllConnections();
  if (provider.listening) await new Promise((done) => provider.close(done));
  if (state?.port) await attempt(() => assertPortReleased(state.port));
  assert.equal(errors.length, 0, errors.map(String).join("; "));
  record("cleanup-pass", {
    daemonStopped: !daemon || !alive(daemon.pid),
    portReleased: true,
    providerClosed: !provider.listening,
  });
}
function onInterrupt() {
  interrupted = true;
  lines?.close();
}
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onInterrupt);
let failure;
try {
  await Promise.all(
    [
      profile,
      workspace,
      env.HOME,
      env.XDG_CONFIG_HOME,
      env.XDG_DATA_HOME,
      env.APPDATA,
      env.LOCALAPPDATA,
    ].map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(join(profile, ".skip-auto-migrate"), "");
  await writeFile(
    join(profile, ".env"),
    "PANEL_FIXTURE_KEY=panel-fixture-only\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(workspace, "fixture.txt"),
    Array.from(
      { length: 300 },
      (_, i) =>
        `PANEL_SOURCE_${String(i + 1).padStart(3, "0")} Reproducible read result for execution history, tool expansion, scroll restoration, and instance isolation.`,
    ).join("\n") + "\n",
  );
  await writeFile(
    join(workspace, "approval.cjs"),
    "require('node:fs').writeFileSync('approved.txt','PANEL_BASH_APPROVED\\n'); console.log('PANEL_BASH_APPROVED');\n",
  );
  await new Promise((done, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", done);
  });
  await writeFile(
    join(profile, "model.json"),
    JSON.stringify({
      provider: "panel-fixture",
      defaultModel: "panel-fixture",
      apiConfig: {
        apiKeyEnv: "PANEL_FIXTURE_KEY",
        baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
        interfaceProvider: "openai-compatible",
      },
      llmParams: {
        maxTokens: 8192,
        contextWindowTokens: 128000,
        temperature: 0,
      },
    }),
  );
  daemon = spawn(
    process.execPath,
    ["--no-warnings", cli, "serve", "--port", "0", "--no-open"],
    { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  daemon.stdout.on("data", (value) => {
    startupOutput += value;
  });
  daemon.stderr.on("data", (value) => {
    startupOutput += value;
  });
  daemon.on("error", (error) => {
    failures.push(String(error));
  });
  await waitUntil(async () => {
    assert.equal(
      daemon.exitCode,
      null,
      `Daemon exited before readiness: ${startupOutput}`,
    );
    try {
      state = JSON.parse(
        await readFile(join(profile, "server/daemon-state.json"), "utf8"),
      );
    } catch {
      return false;
    }
    return state.pid === daemon.pid && /ohbaby web ready:/.test(startupOutput);
  }, "Compiled serve did not become ready");
  const url = /ohbaby web ready: (http:\/\/127\.0\.0\.1:\d+[^\s]*)/.exec(
    startupOutput,
  )[1];
  const page = await fetch(url);
  assert.ok(page.ok);
  const html = await page.text();
  const index = await readFile(compiledIndex, "utf8");
  for (const [, asset] of index.matchAll(
    /(?:src|href)="([^"]+\.(?:js|css))"/g,
  )) {
    assert.ok(
      html.includes(basename(asset)),
      "Served HTML differs from compiled assets",
    );
    assert.ok(
      (await fetch(new URL(asset, url))).ok,
      `Compiled asset missing: ${asset}`,
    );
  }
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({ root, workspace, databasePath, url, pid: daemon.pid }),
    { mode: 0o600 },
  );
  console.log(
    `PANEL_READY ${JSON.stringify({ url, root, workspace, databasePath, pid: daemon.pid })}`,
  );
  console.log(`PANEL_PROMPTS ${JSON.stringify(prompts)}`);
  console.log(
    "PANEL_STDIN status = backend snapshot; tick = append a numbered marker to held streams; finish = verify core scenario and cleanup; quit = cleanup only. Finish requires START, UI Stop Runner, approve bash, SEND_READER, CLOSE_READER, and OTHER_SESSION in a new session.",
  );
  lines = createInterface({ input: process.stdin });
  if (!interrupted)
    for await (const line of lines) {
      const command = line.trim();
      if (command === "status") record("status", snapshot());
      else if (command === "tick") {
        const marker = `PANEL_STREAM_TICK_${++streamTick}`;
        let delivered = 0;
        for (const response of heldResponses) {
          if (response.destroyed || response.writableEnded) continue;
          chunk(response, { content: `\n\n${marker}` });
          delivered++;
        }
        record("stream-tick", { marker, delivered });
      } else if (command === "finish" || command === "quit") {
        finishRequested = command === "finish";
        lines.close();
        break;
      } else if (command) record("unknown-stdin", { command });
    }
  if (finishRequested) record("backend-pass", await verifyScenario());
} catch (error) {
  failure = error;
} finally {
  lines?.close();
  process.stdin.pause();
  await cleanup().catch((error) => {
    failure = failure
      ? new AggregateError([failure, error], "Scenario and cleanup failed")
      : error;
  });
  process.removeListener("SIGINT", onInterrupt);
  process.removeListener("SIGTERM", onInterrupt);
}
if (failure) {
  console.error(
    `PANEL_FAIL ${String(failure)}; isolated evidence retained at ${root}`,
  );
  if (failure instanceof AggregateError)
    for (const error of failure.errors) console.error(String(error));
  process.exitCode = 1;
} else {
  await rm(root, { recursive: true, force: true });
  record("done", { verified: finishRequested, temporaryRootRemoved: true });
}

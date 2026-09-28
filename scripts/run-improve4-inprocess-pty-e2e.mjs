/** Default compiled TUI acceptance. Drive the --launch process in a real PTY. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const cli = resolve("packages/ohbaby-cli/dist/bin.js");
if (process.argv[2] === "--launch") {
  const manifest = JSON.parse(await readFile(process.argv[3], "utf8"));
  const args = process.argv[4] === "--continue" ? ["--continue"] : [];
  assert.ok(
    process.argv.length === 4 || (process.argv.length === 5 && args.length),
  );
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: manifest.workspace,
    env: manifest.env,
    stdio: "inherit",
  });
  await writeFile(
    join(manifest.root, "tui.json"),
    JSON.stringify({ pid: child.pid, args }),
  );
  const exit = await new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  await writeFile(
    join(manifest.root, "tui-exit.json"),
    JSON.stringify({ pid: child.pid, ...exit }),
  );
  process.exit(exit.code ?? 1);
}
assert.equal(
  process.argv.length,
  2,
  "Use no arguments, or --launch <manifest> [--continue]",
);
const root = await mkdtemp(join(tmpdir(), "ohbaby-improve4-inprocess-"));
const workspace = join(root, "workspace");
const profile = join(root, "profile");
const dbPath = join(root, "fixture.db");
const manifestPath = join(root, "manifest.json");
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
  ),
);
const env = {
  ...inherited,
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
const events = [],
  requests = [],
  failures = [];
const held = new Map();
let snapshotBeforeSteer;
let snapshotBeforeExit;
async function globalDaemonMetadata() {
  try {
    const info = await stat(
      join(homedir(), ".ohbaby", "server", "daemon-state.json"),
    );
    return { inode: info.ino, size: info.size, mtime: info.mtimeMs };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
const daemonMetadataBefore = await globalDaemonMetadata();
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const record = (type, detail = {}) => {
  const event = { type, at: new Date().toISOString(), ...detail };
  events.push(event);
  console.log("I4_LOCAL " + JSON.stringify(event));
};
async function until(fn, message) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(30);
  }
  throw new Error(message);
}
function rows() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      prompts: db
        .prepare(
          "SELECT prompt_id AS id, text, status, session_id AS sessionId, user_message_id AS userMessageId, run_id AS runId, owner_pid AS ownerPid, accepted_at AS acceptedAt FROM prompt_submission ORDER BY rowid",
        )
        .all(),
      runs: db
        .prepare(
          "SELECT run_id AS id, session_id AS sessionId, status, owner_pid AS ownerPid FROM run_ledger ORDER BY rowid",
        )
        .all(),
    };
  } finally {
    db.close();
  }
}
function counts() {
  return Object.fromEntries(
    [...new Set(requests)].map((m) => [
      m,
      requests.filter((r) => r === m).length,
    ]),
  );
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
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer fixture-only");
    let raw = "";
    for await (const piece of request) raw += piece;
    const body = JSON.parse(raw);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    if (
      raw.includes("Generate a concise title for a coding-agent chat session.")
    ) {
      finish(response, "I4 local fixture");
      return;
    }
    const marker = JSON.stringify(
      body.messages.findLast((m) => m.role === "user"),
    ).match(/I4_LOCAL_[A-Z_]+/)?.[0];
    assert.ok(marker, "Expected an actual local fixture user message");
    requests.push(marker);
    record("provider-request", { marker });
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
    response.destroy();
  }
});
async function localProof() {
  const launch = JSON.parse(await readFile(join(root, "tui.json"), "utf8"));
  assert.ok(alive(launch.pid), "Default TUI must still be alive");
  const current = rows();
  assert.ok(
    current.prompts.some((p) => p.ownerPid === launch.pid),
    "Expected SQLite ownership by the actual TUI PID",
  );
  assert.ok(launch.args.every((arg) => arg === "--continue"));
  let descendants = "";
  try {
    descendants = execFileSync("pgrep", ["-P", String(launch.pid)], {
      encoding: "utf8",
    });
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  assert.equal(
    descendants.trim(),
    "",
    "Default TUI unexpectedly spawned a child process",
  );
  let listeners = "";
  try {
    listeners = execFileSync(
      "lsof",
      ["-nP", "-a", "-p", String(launch.pid), "-iTCP", "-sTCP:LISTEN", "-Fpn"],
      { encoding: "utf8" },
    );
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  assert.equal(
    listeners.trim(),
    "",
    "Default TUI unexpectedly opened a listening socket",
  );
  assert.deepEqual(
    await globalDaemonMetadata(),
    daemonMetadataBefore,
    "Default TUI changed global daemon state metadata",
  );
  for (const stateFile of [
    join(profile, "server", "daemon-state.json"),
    join(env.XDG_DATA_HOME, "ohbaby", "server", "daemon-state.json"),
  ]) {
    await assert.rejects(access(stateFile), /ENOENT/);
  }
  record("inprocess-proof", {
    pid: launch.pid,
    args: launch.args,
    ownDatabaseOwner: true,
    noChildren: true,
    noListener: true,
    globalDaemonStateUnchanged: true,
  });
}
try {
  await Promise.all(
    [workspace, profile, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  await writeFile(join(profile, ".skip-auto-migrate"), "");
  await new Promise((done) => provider.listen(0, "127.0.0.1", done));
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
  await writeFile(
    manifestPath,
    JSON.stringify({ root, workspace, env, dbPath }),
    { mode: 0o600 },
  );
  record("ready", { root, manifestPath });
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    try {
      const command = JSON.parse(line);
      if (command.command === "quit") {
        input.close();
        break;
      }
      if (command.command === "inspect")
        record("database", { ...rows(), counts: counts() });
      else if (command.command === "local-proof") await localProof();
      else if (command.command === "before-steer") {
        snapshotBeforeSteer = rows();
        record("before-steer", snapshotBeforeSteer);
      } else if (command.command === "steer-proof") {
        assert.ok(snapshotBeforeSteer);
        const before = snapshotBeforeSteer.prompts.find(
          (p) => p.text === "I4_LOCAL_A_HOLD",
        );
        const current = rows();
        const after = current.prompts.find((p) => p.id === before.id);
        assert.equal(after.runId, before.runId);
        assert.equal(after.status, "running");
        assert.equal(
          current.prompts.find((p) => p.text === "I4_LOCAL_STEER").status,
          "steered",
        );
        assert.ok(
          held.has("I4_LOCAL_A_HOLD"),
          "Steer aborted the active provider request",
        );
        assert.equal(
          requests.length,
          1,
          "Steer prematurely started another model request",
        );
        record("steer-proof", {
          rootRunIdUnchanged: true,
          providerStillOpen: true,
          ...current,
        });
      } else if (command.command === "before-exit") {
        snapshotBeforeExit = rows();
        record("before-exit", snapshotBeforeExit);
      } else if (command.command === "exit-proof") {
        const exit = JSON.parse(
          await readFile(join(root, "tui-exit.json"), "utf8"),
        );
        assert.equal(exit.code, 0);
        assert.equal(alive(exit.pid), false);
        record("exit-proof", { ...exit, ...rows() });
      } else if (command.command === "retained-proof") {
        assert.ok(snapshotBeforeExit);
        const old = snapshotBeforeExit.prompts.find(
          (p) => p.text === "I4_LOCAL_RETAIN",
        );
        const retained = rows().prompts.find((p) => p.id === old.id);
        assert.equal(retained.status, "retained");
        assert.equal(retained.userMessageId, old.userMessageId);
        assert.equal(requests.includes("I4_LOCAL_RETAIN"), false);
        record("retained-proof", {
          retained,
          unchangedIdentity: true,
          noAutomaticExecution: true,
        });
      } else if (command.command === "assert") {
        await until(
          () =>
            Object.entries(command.statuses ?? {}).every(([text, status]) =>
              rows().prompts.some(
                (p) => p.text === text && p.status === status,
              ),
            ),
          "Expected durable prompt states",
        );
        assert.deepEqual(failures, []);
        if (command.requests) assert.deepEqual(counts(), command.requests);
        record("assert-pass", { ...rows(), counts: counts() });
      } else if (command.command === "ui") {
        assert.ok(
          command.evidence &&
            Object.values(command.evidence).every((v) => v === true),
        );
        record("ui-evidence", command.evidence);
      } else throw new Error("Unknown command");
    } catch (error) {
      failures.push(String(error));
      record("command-failure", { message: String(error) });
    }
  }
} finally {
  try {
    const launch = JSON.parse(await readFile(join(root, "tui.json"), "utf8"));
    if (alive(launch.pid)) {
      process.kill(launch.pid, "SIGTERM");
      await until(() => !alive(launch.pid), "Owned TUI did not exit");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  await rm(join(profile, "server"), { recursive: true, force: true });
  record("cleanup-pass", { root });
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify({ events, requests, failures }, null, 2),
    { mode: 0o600 },
  );
  await writeFile(
    manifestPath,
    JSON.stringify({ root, workspace, dbPath, cleanup: "complete" }),
    { mode: 0o600 },
  );
}
process.exitCode = failures.length ? 1 : 0;

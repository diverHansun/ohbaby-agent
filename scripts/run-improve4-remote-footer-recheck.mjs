/** Reopen an existing isolated improve-4 SQLite fixture with the latest compiled remote TUI. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const previous = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(
  previous.cleanup,
  "complete",
  "Recheck only a fully stopped fixture",
);
const root = previous.root;
const profile = join(root, "profile");
const cli = resolve("packages/ohbaby-cli/dist/bin.js");
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
    ),
  ),
  HOME: join(root, "home"),
  USERPROFILE: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  OHBABY_HOME: profile,
  OHBABY_DB_PATH: previous.dbPath,
  OHBABY_STORAGE_ROOT: join(root, "storage"),
  OHBABY_LOG_DIR: join(root, "logs"),
  OHBABY_I4_FIXTURE_KEY: "fixture-only",
  OHBABY_TUI_NO_ANIM: "1",
  NO_COLOR: "1",
};
let modelRequests = 0;
const provider = createServer((request, response) => {
  if (request.url?.endsWith("/chat/completions")) modelRequests++;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      object: "list",
      data: [{ id: "fixture", object: "model" }],
    }),
  );
});
await new Promise((done) => provider.listen(0, "127.0.0.1", done));
const modelPath = join(profile, "model.json");
const model = JSON.parse(await readFile(modelPath, "utf8"));
await writeFile(
  modelPath,
  JSON.stringify({
    ...model,
    apiConfig: {
      ...model.apiConfig,
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    },
  }),
);
const daemon = spawn(
  process.execPath,
  [cli, "serve", "--port", "0", "--no-open"],
  { cwd: previous.workspace, env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
daemon.stdout.on("data", (chunk) => {
  output += chunk;
});
daemon.stderr.on("data", (chunk) => {
  output += chunk;
});
let state;
let tui;
let tuiExitCode;
try {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null)
      throw Error("Compiled daemon exited before readiness");
    try {
      const value = JSON.parse(
        await readFile(join(profile, "server/daemon-state.json"), "utf8"),
      );
      if (value.pid === daemon.pid && output.includes("ohbaby web ready:")) {
        state = value;
        break;
      }
    } catch {}
    await delay(50);
  }
  assert.ok(state, "Daemon readiness timeout");
  console.log(
    "FOOTER_RECHECK_READY " +
      JSON.stringify({
        sessionId: previous.sessions.tui,
        daemonPid: daemon.pid,
      }),
  );
  tui = spawn(
    process.execPath,
    [
      cli,
      "--remote-port",
      String(state.port),
      "--remote-auth-token",
      state.authToken,
      "--resume",
      previous.sessions.tui,
    ],
    { cwd: previous.workspace, env, stdio: "inherit" },
  );
  tuiExitCode = await new Promise((done) => tui.once("exit", done));
  assert.equal(tuiExitCode, 0);
  assert.equal(
    modelRequests,
    0,
    "Footer recheck must not submit any model request",
  );
} finally {
  if (tui && tui.exitCode === null && tui.signalCode === null)
    tui.kill("SIGTERM");
  if (daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill("SIGTERM");
    await new Promise((done) => daemon.once("exit", done));
  }
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  await rm(join(profile, "server"), { recursive: true, force: true });
  const evidence = {
    tuiExitCode,
    modelRequests,
    daemonExited: daemon.exitCode !== null || daemon.signalCode !== null,
    providerClosed: true,
    credentialsRemoved: true,
  };
  await writeFile(
    join(root, "footer-recheck.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log("FOOTER_RECHECK_CLEANUP " + JSON.stringify(evidence));
}

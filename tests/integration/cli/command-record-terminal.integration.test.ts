import { spawn, spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireCliPackageBuildLock } from "./package-build-lock";

interface ChildResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

const repoRoot = process.cwd();
const agentEntry = join(
  repoRoot,
  "packages",
  "ohbaby-agent",
  "dist",
  "index.js",
);
const cliEntry = join(repoRoot, "packages", "ohbaby-cli", "dist", "bin.js");
let releasePackageBuildLock: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const lock = await acquireCliPackageBuildLock();
  releasePackageBuildLock = lock.release;
  if (process.env.OHBABY_TEST_SKIP_PACKAGE_BUILD === "1") {
    return;
  }
  const result = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    [
      "-r",
      "--filter",
      "ohbaby-sdk",
      "--filter",
      "ohbaby-agent",
      "--filter",
      "ohbaby-server",
      "--filter",
      "ohbaby-cli",
      "--sort",
      "build",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      windowsHide: true,
    },
  );

  expect(
    result.status,
    `Command-record package build failed\nerror:\n${String(result.error)}\nstdout:\n${String(result.stdout)}\nstderr:\n${String(result.stderr)}`,
  ).toBe(0);
}, 420_000);

afterAll(async () => {
  await releasePackageBuildLock?.();
  releasePackageBuildLock = undefined;
});

describe("default command record terminal behavior", () => {
  it("keeps production stdout and stderr clean through command execution and dispose", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-command-record-"));
    const home = join(root, "home");
    const profile = join(root, "profile");
    const workspace = join(root, "workspace");
    const logRoot = join(root, "logs");
    const resultPath = join(root, "result.json");
    const childScript = join(root, "exercise-command.mjs");
    await mkdir(profile, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(profile, "model.json"),
      JSON.stringify({
        apiConfig: {
          apiKeyEnv: "OHBABY_PROCESS_TEST_API_KEY",
          baseUrl: "http://127.0.0.1:9/v1",
        },
        defaultModel: "fake-model",
        llmParams: { maxTokens: 128, temperature: 0 },
        provider: "fake-openai",
      }),
      "utf8",
    );
    await writeFile(
      childScript,
      `import { writeFile } from "node:fs/promises";
import { buildCoreAPIImpl, createProcessLogger } from ${JSON.stringify(pathToFileURL(agentEntry).href)};

const diagnostics = await createProcessLogger({
  logDirectory: process.env.OHBABY_LOG_DIR,
  role: "tui",
  workspaceRoot: process.cwd(),
});
const events = [];
const host = await buildCoreAPIImpl({
  diagnosticsFilePath: diagnostics.logFilePath,
  inProcess: true,
  logger: diagnostics.logger,
});
const unsubscribe = host.callbacks.subscribeEvents((event) => events.push(event));
try {
  await host.core.executeCommand({
    argv: [],
    clientInvocationId: "process_regression_1",
    commandId: "status",
    path: ["status"],
    raw: "/status",
    rawArgs: "",
    surface: "tui",
  });
  await writeFile(process.env.OHBABY_TEST_RESULT_PATH, JSON.stringify(events));
} finally {
  unsubscribe();
  await host.dispose();
  await diagnostics.dispose();
}
`,
      "utf8",
    );

    const environment = createIsolatedEnvironment(root, home, profile, {
      OHBABY_LOG_DIR: logRoot,
      OHBABY_PROCESS_TEST_API_KEY: "test-only-key",
      OHBABY_TEST_RESULT_PATH: resultPath,
    });

    try {
      const result = await runChild(childScript, workspace, environment);
      expect(
        result.code,
        `child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).not.toContain("ui.command.");
      expect(result.stderr).not.toContain("ui.command.");
      const files = await readdir(join(logRoot, "tui"));
      expect(files).toHaveLength(1);
      const logFilePath = join(logRoot, "tui", files[0] ?? "missing");
      const log = await readFile(logFilePath, "utf8");
      expect(log).toContain('"event":"diagnostics.started"');
      expect(log).not.toContain("test-only-key");
      const events = await readFile(resultPath, "utf8");
      expect(events).toContain(logFilePath);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);

  it("keeps the actual serve process terminal clean through RPC command and shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-command-record-serve-"));
    const home = join(root, "home");
    const profile = join(root, "profile");
    const workspace = join(root, "workspace");
    const logRoot = join(root, "logs");
    const authToken = "command-record-process-token";
    await Promise.all([
      mkdir(profile, { recursive: true }),
      mkdir(workspace, { recursive: true }),
    ]);
    await writeFile(
      join(profile, "model.json"),
      JSON.stringify({
        apiConfig: {
          apiKeyEnv: "OHBABY_PROCESS_TEST_API_KEY",
          baseUrl: "http://127.0.0.1:9/v1",
        },
        defaultModel: "fake-model",
        llmParams: { maxTokens: 128, temperature: 0 },
        provider: "fake-openai",
      }),
      "utf8",
    );

    const environment = createIsolatedEnvironment(root, home, profile, {
      OHBABY_LOG_DIR: logRoot,
      OHBABY_PROCESS_TEST_API_KEY: "test-only-key",
    });
    const child = spawn(
      process.execPath,
      [
        cliEntry,
        "serve",
        "--port",
        "0",
        "--no-open",
        "--auth-token",
        authToken,
      ],
      {
        cwd: workspace,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const ready = waitForServeReady(child, () => stdout);
    const closed = waitForChildClose(child, () => ({ stderr, stdout }));

    try {
      const readyUrl = await ready;
      const rpcUrl = new URL("/api/rpc", readyUrl);
      const response = await fetch(rpcUrl, {
        body: JSON.stringify({
          clientId: "client_process_test",
          id: "rpc_process_test",
          method: "executeCommand",
          params: [
            {
              argv: [],
              clientInvocationId: "serve_process_regression_1",
              commandId: "status",
              path: ["status"],
              raw: "/status",
              rawArgs: "",
              surface: "web",
            },
          ],
        }),
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
          "x-ohbaby-directory": workspace,
        },
        method: "POST",
      });
      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(200);
      expect(responseBody).toContain('"ok":true');

      const shutdown = await fetch(new URL("/api/shutdown", readyUrl), {
        headers: { authorization: `Bearer ${authToken}` },
        method: "POST",
      });
      expect(shutdown.status, await shutdown.text()).toBe(200);

      const result = await closed;
      expect(
        result.code,
        `serve failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
      expect(result.stdout).not.toContain("ui.command.");
      expect(result.stderr).not.toContain("ui.command.");
      expect(result.stderr).toBe("");
      const diagnosticsPath = /diagnostics: ([^\n]+)/u.exec(result.stdout)?.[1];
      expect(diagnosticsPath).toBeTypeOf("string");
      expect(diagnosticsPath).toContain(join(logRoot, "serve"));
      const log = await readFile(diagnosticsPath ?? "missing", "utf8");
      const records = log
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { readonly event?: string });
      expect(records.map((record) => record.event)).toEqual(
        expect.arrayContaining([
          "diagnostics.started",
          "migration.config.completed",
          "migration.data.completed",
          "server.started",
          "server.stopped",
        ]),
      );
      expect(log).not.toContain("test-only-key");
      expect(log).not.toContain(authToken);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed.catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);
});

function createIsolatedEnvironment(
  root: string,
  home: string,
  profile: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    APPDATA: join(root, "appdata"),
    HOME: home,
    LOCALAPPDATA: join(root, "localappdata"),
    NODE_ENV: "production",
    OHBABY_DB_PATH: join(profile, "ohbaby.db"),
    OHBABY_HOME: profile,
    OHBABY_STORAGE_ROOT: join(root, "storage"),
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    ...overrides,
  };
  delete environment.OHBABY_DEBUG;
  return environment;
}

function waitForServeReady(
  child: ReturnType<typeof spawn>,
  readStdout: () => string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error("serve process did not report readiness within 30 seconds"),
      );
    }, 30_000);
    const inspectStdout = (): void => {
      const match = /ohbaby web ready: (http:\/\/127\.0\.0\.1:\d+[^\s]*)/u.exec(
        readStdout(),
      );
      if (!match?.[1]) return;
      clearTimeout(timeout);
      resolve(match[1]);
    };
    child.stdout?.on("data", inspectStdout);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(`serve process exited before readiness with ${String(code)}`),
      );
    });
  });
}

function waitForChildClose(
  child: ReturnType<typeof spawn>,
  readStreams: () => Pick<ChildResult, "stderr" | "stdout">,
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("serve process did not close within 30 seconds"));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, ...readStreams() });
    });
  });
}

function runChild(
  script: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildResult> {
  const child = spawn(process.execPath, [script], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("command record child timed out after 30 seconds"));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr, stdout });
    });
  });
}

import { spawn, spawnSync } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

interface CliResult {
  readonly code: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface CapturedRequest {
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
  readonly method: string | undefined;
  readonly url: string | undefined;
}

const cleanupDirectories: string[] = [];
const TITLE_GENERATION_PROMPT_MARKER =
  "Generate a concise title for a coding-agent chat session.";
const CLI_BIN_PATH = join(
  process.cwd(),
  "packages",
  "ohbaby-cli",
  "dist",
  "bin.js",
);

beforeAll(() => {
  const buildArgs = [
    "-r",
    "--filter",
    "ohbaby-sdk",
    "--filter",
    "ohbaby-agent",
    "--filter",
    "ohbaby-cli",
    "--sort",
    "build",
  ];
  const processInput = commandProcessInput(pnpmCommand(), buildArgs);
  const result = spawnSync(processInput.command, processInput.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  expect(
    result.status,
    `CLI package build failed\nerror:\n${String(result.error)}\nstdout:\n${String(result.stdout)}\nstderr:\n${String(result.stderr)}`,
  ).toBe(0);
}, 120_000);

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function tempHome(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirectories.push(directory);
  await mkdir(join(directory, ".ohbaby-agent"), { recursive: true });
  return directory;
}

async function writeModelConfig(input: {
  readonly apiKeyEnv: string;
  readonly baseUrl: string;
  readonly home: string;
}): Promise<void> {
  await writeFile(
    join(input.home, ".ohbaby-agent", "model.json"),
    JSON.stringify(
      {
        apiConfig: {
          apiKeyEnv: input.apiKeyEnv,
          baseUrl: input.baseUrl,
        },
        defaultModel: "fake-model",
        llmParams: {
          maxTokens: 128,
          temperature: 0,
        },
        provider: "fake-openai",
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function startFakeOpenAiServer(): Promise<{
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
  readonly requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404);
        response.end("not found");
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(rawBody) as Record<string, unknown>,
        method: request.method,
        url: request.url,
      });

      response.writeHead(200, {
        "cache-control": "no-cache",
        "content-type": "text/event-stream; charset=utf-8",
      });
      writeSse(response, {
        choices: [
          {
            delta: { content: "fake smoke ok" },
            finish_reason: null,
            index: 0,
          },
        ],
        created: 0,
        id: "chatcmpl_fake",
        model: "fake-model",
        object: "chat.completion.chunk",
      });
      writeSse(response, {
        choices: [
          {
            delta: {},
            finish_reason: "stop",
            index: 0,
          },
        ],
        created: 0,
        id: "chatcmpl_fake",
        model: "fake-model",
        object: "chat.completion.chunk",
      });
      writeSse(response, {
        choices: [],
        created: 0,
        id: "chatcmpl_fake",
        model: "fake-model",
        object: "chat.completion.chunk",
        usage: {
          completion_tokens: 3,
          prompt_tokens: 1,
          total_tokens: 4,
        },
      });
      response.end("data: [DONE]\n\n");
    },
  );

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    requests,
  };
}

function writeSse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function isTitleGenerationRequest(request: CapturedRequest): boolean {
  return JSON.stringify(request.body).includes(TITLE_GENERATION_PROMPT_MARKER);
}

async function runCliProcess(input: {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}): Promise<CliResult> {
  const child = spawn(
    process.execPath,
    ["--no-warnings", CLI_BIN_PATH, ...input.args],
    {
      cwd: input.cwd ?? process.cwd(),
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("CLI process timed out"));
    }, input.timeoutMs ?? 10_000);

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

function pnpmCommand(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function commandProcessInput(
  command: string,
  args: readonly string[],
): { readonly args: readonly string[]; readonly command: string } {
  if (process.platform !== "win32") {
    return { args, command };
  }

  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      [command, ...args].map(quoteWindowsCommandArgument).join(" "),
    ],
  };
}

function quoteWindowsCommandArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"&|<>^]/.test(argument)) {
    return argument;
  }
  return `"${argument.replaceAll('"', '\\"')}"`;
}

function childEnv(input: {
  readonly dbPath: string;
  readonly home: string;
  readonly patch?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPDATA: join(input.home, "appdata"),
    HOME: input.home,
    NO_COLOR: "1",
    OHBABY_DB_PATH: input.dbPath,
    USERPROFILE: input.home,
    XDG_DATA_HOME: join(input.home, "xdg"),
    ...(input.patch ?? {}),
  };
}

describe("CLI prompt process smoke", () => {
  it("streams a prompt through a local OpenAI-compatible fake server", async () => {
    const server = await startFakeOpenAiServer();
    const home = await tempHome("ohbaby-cli-home-");
    const dbPath = join(home, "state", "agent.db");
    try {
      await writeModelConfig({
        apiKeyEnv: "FAKE_OPENAI_API_KEY",
        baseUrl: server.baseUrl,
        home,
      });

      const result = await runCliProcess({
        args: ["run", "hello"],
        cwd: home,
        env: childEnv({
          dbPath,
          home,
          patch: { FAKE_OPENAI_API_KEY: "fake-key" },
        }),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("fake smoke ok");
      expect(result.stderr).toBe("");
      const mainRequests = server.requests.filter(
        (request) => !isTitleGenerationRequest(request),
      );
      const titleRequests = server.requests.filter(isTitleGenerationRequest);
      expect(mainRequests).toHaveLength(1);
      expect(titleRequests).toHaveLength(1);

      const mainRequest = mainRequests[0];
      expect(mainRequest).toMatchObject({
        authorization: "Bearer fake-key",
        method: "POST",
        url: "/v1/chat/completions",
      });
      expect(mainRequest.body).toMatchObject({
        max_tokens: 128,
        model: "fake-model",
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0,
      });
      const messages = mainRequest.body.messages;
      expect(Array.isArray(messages) ? messages.at(-1) : null).toMatchObject({
        content: "hello",
        role: "user",
      });

      const titleRequest = titleRequests[0];
      expect(titleRequest.body).toMatchObject({
        max_tokens: 512,
        model: "fake-model",
        stream: true,
        temperature: 0.2,
      });
    } finally {
      await server.close();
    }
  });

  it("exits non-zero with a readable error when the configured API key is missing", async () => {
    const home = await tempHome("ohbaby-cli-missing-key-");
    const dbPath = join(home, "state", "agent.db");
    const missingKeyName = "OHBABY_TEST_MISSING_API_KEY";
    const env = childEnv({ dbPath, home });
    delete env[missingKeyName];
    await writeModelConfig({
      apiKeyEnv: missingKeyName,
      baseUrl: "http://127.0.0.1:9/v1",
      home,
    });

    const result = await runCliProcess({
      args: ["run", "hello"],
      cwd: home,
      env,
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(missingKeyName);
    expect(result.stderr).toContain("API key");
    expect(result.stdout).toBe("");
  });
});

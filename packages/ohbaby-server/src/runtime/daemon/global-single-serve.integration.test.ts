import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  UiPromptReceipt,
  UiPromptResubmissionReceipt,
  UiPromptSubmission,
} from "ohbaby-sdk";
import { NodeSqliteConnection } from "../../../../ohbaby-agent/src/services/database/connection.js";
import { createRemoteUiBackendClient } from "../../protocols/jsonrpc/client.js";

interface ChildReady {
  readonly pid: number;
  readonly reused: boolean;
  readonly url: string;
}

const children: ChildProcessWithoutNullStreams[] = [];
const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child).catch(() => undefined);
    }
  }
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function spawnServe(input: {
  readonly authToken?: string;
  readonly blockingProvider?: {
    readonly gatePath: string;
    readonly startedPath: string;
  };
  readonly failingProvider?: {
    readonly message: string;
    readonly status: number;
  };
  readonly dataHome?: string;
  readonly dbPath?: string;
  readonly homeDirectory: string;
  readonly workdir: string;
}): ChildProcessWithoutNullStreams {
  const mainUrl = pathToFileURL(
    resolve("packages/ohbaby-server/src/runtime/daemon/main.ts"),
  ).href;
  const script = `
    const { startDaemonServer } = await import(${JSON.stringify(mainUrl)});
    const options = JSON.parse(process.env.OHBABY_TEST_INPUT);
    const { blockingProvider, failingProvider, ...serverOptions } = options;
    let llmClient;
    if (blockingProvider) {
      const { appendFileSync, existsSync } = await import("node:fs");
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      llmClient = {
        config: {
          modelProfiles:[{model:"fake-model",contextWindowTokens:128000,reasoningCapabilities:{mode:"none",wire:"none",supportsDisabled:true}}],
          apiKeyEnv: "FAKE_API_KEY",
          baseUrl: "https://example.invalid/v1",
          interfaceProvider: "openai-compatible",
          maxTokens: 128,
          model: "fake-model",
          provider: "fake",
          temperature: 0,
        },
        provider: {
          client: { kind: "fake" },
          id: "fake",
          isAbortError: (error) => error instanceof Error && error.name === "AbortError",
          kind: "openai-compatible",
          async streamResponse(request) {
            if (JSON.stringify(request.messages).includes("Write a short conversation title")) {
              return (async function* () {
                yield { textDelta: "Process E2E", finishReason: "stop" };
              })();
            }
            appendFileSync(blockingProvider.startedPath, "started\\n");
            return (async function* () {
              while (!existsSync(blockingProvider.gatePath)) {
                if (request.signal?.aborted) {
                  const error = new Error("provider request aborted");
                  error.name = "AbortError";
                  throw error;
                }
                await delay(10);
              }
              yield { textDelta: "done", finishReason: "stop" };
            })();
          },
        },
      };
    } else if (failingProvider) {
      llmClient = {
        config: {
          modelProfiles:[{model:"fake-model",contextWindowTokens:128000,reasoningCapabilities:{mode:"none",wire:"none",supportsDisabled:true}}],
          apiKeyEnv: "FAKE_API_KEY",
          baseUrl: "https://example.invalid/v1",
          interfaceProvider: "openai-compatible",
          maxTokens: 128,
          model: "fake-model",
          provider: "fake",
          temperature: 0,
        },
        provider: {
          client: { kind: "fake" },
          id: "fake",
          isAbortError: () => false,
          kind: "openai-compatible",
          async streamResponse(request) {
            if (JSON.stringify(request.messages).includes("Write a short conversation title")) {
              return (async function* () {
                yield { textDelta: "Process failure", finishReason: "stop" };
              })();
            }
            const error = new Error(failingProvider.message);
            error.status = failingProvider.status;
            error.headers = { "retry-after-ms": "0" };
            throw error;
          },
        },
      };
    }
    const server = await startDaemonServer({ ...serverOptions, ...(llmClient ? { llmClient } : {}), defaultPort: 0, packageVersion: "0.1.7" });
    process.stdout.write("OHBABY_TEST_READY " + JSON.stringify({ pid: process.pid, reused: server.reused, url: server.url }) + "\\n");
    if (!server.reused) {
      await new Promise((resolveStop) => {
        process.once("SIGTERM", () => {
          void server.stop().finally(resolveStop);
        });
      });
    }
  `;
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    OHBABY_TEST_INPUT: JSON.stringify(input),
  };
  if (input.dataHome !== undefined) {
    if (process.platform === "win32") {
      childEnvironment.APPDATA = input.dataHome;
      childEnvironment.LOCALAPPDATA = input.dataHome;
      delete childEnvironment.XDG_DATA_HOME;
    } else {
      childEnvironment.XDG_DATA_HOME = input.dataHome;
    }
  }
  const child = spawn(process.execPath, ["--import", "tsx", "--eval", script], {
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function waitForReady(
  child: ChildProcessWithoutNullStreams,
): Promise<ChildReady> {
  return new Promise((resolveReady, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for child serve: ${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const line = stdout
        .split("\n")
        .find((candidate) => candidate.startsWith("OHBABY_TEST_READY "));
      if (!line) {
        return;
      }
      clearTimeout(timeout);
      try {
        resolveReady(
          JSON.parse(line.slice("OHBABY_TEST_READY ".length)) as ChildReady,
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (stdout.trim().length === 0) {
        clearTimeout(timeout);
        reject(
          new Error(
            `Child serve exited before ready (code ${String(code)}): ${stderr}`,
          ),
        );
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for child process to exit"));
    }, 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

async function waitForStarted(path: string, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const started = await readFile(path, "utf8").catch(() => "");
    if (started.trim().split("\n").filter(Boolean).length >= count) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${String(count)} prompt starts`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

async function createServerSession(
  origin: string,
  headers: Record<string, string>,
): Promise<string> {
  const response = await fetch(`${origin}/v1/sessions`, {
    body: JSON.stringify({}),
    headers,
    method: "POST",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    readonly session: { readonly id: string };
  };
  return body.session.id;
}

async function snapshotPrompts(
  origin: string,
  headers: Record<string, string>,
): Promise<readonly UiPromptSubmission[]> {
  const response = await fetch(`${origin}/v1/snapshot`, { headers });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    readonly snapshot: { readonly prompts?: readonly UiPromptSubmission[] };
  };
  return body.snapshot.prompts ?? [];
}

async function waitForPromptStatus(
  origin: string,
  headers: Record<string, string>,
  promptId: string,
  status: UiPromptSubmission["status"],
): Promise<UiPromptSubmission> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const prompt = (await snapshotPrompts(origin, headers)).find(
      (candidate) => candidate.promptId === promptId,
    );
    if (prompt?.status === status) return prompt;
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out waiting for ${promptId} ${status}: ${prompt?.status ?? "missing"}`,
      );
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
}

async function acquirePromptLease(
  origin: string,
  headers: Record<string, string>,
  promptId: string,
): Promise<string> {
  const response = await fetch(
    `${origin}/v1/prompts/${encodeURIComponent(promptId)}/edit-lease`,
    {
      headers,
      method: "POST",
      body: JSON.stringify({}),
    },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    readonly lease: { readonly editLeaseId: string };
  };
  return body.lease.editLeaseId;
}

async function resubmitRetained(
  origin: string,
  headers: Record<string, string>,
  promptId: string,
  input: {
    readonly editLeaseId: string;
    readonly operationId: string;
    readonly text: string;
  },
): Promise<UiPromptResubmissionReceipt> {
  const response = await fetch(
    `${origin}/v1/prompts/${encodeURIComponent(promptId)}/resubmit`,
    {
      headers,
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  const body = (await response.json()) as {
    readonly receipt: UiPromptResubmissionReceipt;
  };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.receipt;
}

async function startedCount(path: string): Promise<number> {
  return (await readFile(path, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean).length;
}

describe("global single serve across real processes", () => {
  it("migrates legacy platform data before a direct server start opens SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-real-data-migrate-"));
    cleanupDirectories.push(root);
    const repo = join(root, "repo");
    const dataHome = join(root, "data");
    const legacyDataRoot = join(dataHome, "ohbaby-agent");
    const legacyDatabasePath = join(legacyDataRoot, "ohbaby-agent.db");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(legacyDataRoot, { recursive: true });
    const legacyDatabase = new NodeSqliteConnection(legacyDatabasePath);
    legacyDatabase.exec("CREATE TABLE migration_probe (value TEXT NOT NULL)");
    legacyDatabase.exec(
      "INSERT INTO migration_probe (value) VALUES ('preserved')",
    );
    legacyDatabase.close();

    const child = spawnServe({
      dataHome,
      homeDirectory: join(root, "home"),
      workdir: repo,
    });
    await waitForReady(child);

    const migratedDatabase = new NodeSqliteConnection(
      join(dataHome, "ohbaby", "ohbaby.db"),
    );
    try {
      expect(
        migratedDatabase
          .prepare<{
            readonly value: string;
          }>("SELECT value FROM migration_probe")
          .get()?.value,
      ).toBe("preserved");
    } finally {
      migratedDatabase.close();
    }
    await expect(readFile(legacyDatabasePath)).resolves.toBeInstanceOf(Buffer);
    child.kill("SIGTERM");
    await waitForExit(child);
  }, 20_000);

  it("reuses the first listener when started from another repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-real-global-serve-"));
    cleanupDirectories.push(root);
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await mkdir(join(repoA, ".git"), { recursive: true });
    await mkdir(join(repoB, ".git"), { recursive: true });
    const common = {
      dbPath: join(root, "agent.db"),
      homeDirectory: join(root, "home"),
    };

    const firstChild = spawnServe({ ...common, workdir: repoA });
    const first = await waitForReady(firstChild);
    expect(first.reused).toBe(false);

    const secondChild = spawnServe({ ...common, workdir: repoB });
    const second = await waitForReady(secondChild);
    await waitForExit(secondChild);

    expect(second.reused).toBe(true);
    expect(second.pid).not.toBe(first.pid);
    expect(new URL(second.url).origin).toBe(new URL(first.url).origin);
    expect(new URL(second.url).hash).toContain("directory=");
    expect(firstChild.exitCode).toBeNull();

    firstChild.kill("SIGTERM");
    await waitForExit(firstChild);
  }, 20_000);

  it("admits ten concurrent sessions and keeps the eleventh durable through a real daemon process", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ohbaby-real-prompt-concurrency-"),
    );
    cleanupDirectories.push(root);
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const authToken = "process-e2e-token";
    const gatePath = join(root, "release");
    const startedPath = join(root, "started.log");
    const child = spawnServe({
      authToken,
      blockingProvider: { gatePath, startedPath },
      dbPath: join(root, "agent.db"),
      homeDirectory: join(root, "home"),
      workdir: repo,
    });
    const ready = await waitForReady(child);
    const origin = new URL(ready.url).origin;
    const headers = {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      "x-ohbaby-client-id": "process_client",
      "x-ohbaby-directory": repo,
    };
    const registered = await fetch(`${origin}/v1/clients`, {
      body: JSON.stringify({ clientId: "process_client" }),
      headers,
      method: "POST",
    });
    expect(registered.status).toBe(200);

    const receipts: {
      readonly clientRequestId: string;
      readonly promptId: string;
    }[] = [];
    const sessionIds: string[] = [];
    for (let index = 1; index <= 11; index += 1) {
      const sessionId = await createServerSession(origin, headers);
      sessionIds.push(sessionId);
      const response = await fetch(`${origin}/v1/prompts`, {
        body: JSON.stringify({
          clientRequestId: `process_request_${String(index)}`,
          sessionId,
          text: `process prompt ${String(index)}`,
        }),
        headers,
        method: "POST",
      });
      expect(response.status).toBe(202);
      const receipt = (await response.json()) as {
        readonly clientRequestId: string;
        readonly promptId: string;
      };
      expect(receipt.clientRequestId).toBe(`process_request_${String(index)}`);
      receipts.push(receipt);
    }

    const retried = await fetch(`${origin}/v1/prompts`, {
      body: JSON.stringify({
        clientRequestId: "process_request_11",
        sessionId: sessionIds[10],
        text: "process prompt 11",
      }),
      headers,
      method: "POST",
    });
    expect(retried.status).toBe(202);
    await expect(retried.json()).resolves.toMatchObject({
      clientRequestId: "process_request_11",
      promptId: receipts[10]?.promptId,
    });

    await waitForStarted(startedPath, 10);
    const queuedSnapshot = await fetch(`${origin}/v1/snapshot`, { headers });
    const queuedBody = (await queuedSnapshot.json()) as {
      readonly snapshot: {
        readonly prompts?: readonly {
          readonly promptId: string;
          readonly clientRequestId: string;
          readonly status: string;
        }[];
      };
    };
    expect(
      queuedBody.snapshot.prompts?.find(
        (prompt) => prompt.promptId === receipts[10]?.promptId,
      ),
    ).toMatchObject({
      clientRequestId: "process_request_11",
      status: "queued",
    });

    await writeFile(gatePath, "release", "utf8");
    await waitForStarted(startedPath, 11);
    child.kill("SIGTERM");
    await waitForExit(child);
  }, 20_000);

  it("retains queued work after a crash and explicitly resubmits one original prompt idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-real-prompt-recovery-"));
    cleanupDirectories.push(root);
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const authToken = "process-recovery-token";
    const gatePath = join(root, "release");
    const startedPath = join(root, "started.log");
    const common = {
      authToken,
      blockingProvider: { gatePath, startedPath },
      dbPath: join(root, "agent.db"),
      homeDirectory: join(root, "home"),
      workdir: repo,
    };
    const firstChild = spawnServe(common);
    const first = await waitForReady(firstChild);
    const firstOrigin = new URL(first.url).origin;
    const headers = {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      "x-ohbaby-client-id": "recovery_client",
      "x-ohbaby-directory": repo,
    };
    await fetch(`${firstOrigin}/v1/clients`, {
      body: JSON.stringify({ clientId: "recovery_client" }),
      headers,
      method: "POST",
    });
    const sessionIds: string[] = [];
    let activePromptId = "";
    let queuedPromptId = "";
    let queuedReceipt: UiPromptReceipt | undefined;
    for (let index = 1; index <= 11; index += 1) {
      const sessionId = await createServerSession(firstOrigin, headers);
      sessionIds.push(sessionId);
      const response = await fetch(`${firstOrigin}/v1/prompts`, {
        body: JSON.stringify({
          clientRequestId: `recovery_request_${String(index)}`,
          sessionId,
          text: `recovery prompt ${String(index)}`,
        }),
        headers,
        method: "POST",
      });
      expect(response.status).toBe(202);
      const receipt = (await response.json()) as UiPromptReceipt;
      if (index === 1) {
        activePromptId = receipt.promptId;
      }
      if (index === 11) {
        queuedPromptId = receipt.promptId;
        queuedReceipt = receipt;
      }
    }
    await waitForStarted(startedPath, 10);
    firstChild.kill("SIGKILL");
    await waitForExit(firstChild);

    await writeFile(gatePath, "release", "utf8");
    const secondChild = spawnServe(common);
    const second = await waitForReady(secondChild);
    const secondOrigin = new URL(second.url).origin;
    await fetch(`${secondOrigin}/v1/clients`, {
      body: JSON.stringify({ clientId: "recovery_client" }),
      headers,
      method: "POST",
    });
    const sessionHeaders: Record<string, Record<string, string>> = {};
    for (let index = 1; index <= 11; index += 1) {
      const sessionId = sessionIds[index - 1];
      const clientId = `recovery_view_${String(index)}`;
      const scopedHeaders = {
        ...headers,
        "x-ohbaby-client-id": clientId,
      };
      sessionHeaders[sessionId] = scopedHeaders;
      const registered = await fetch(`${secondOrigin}/v1/clients`, {
        body: JSON.stringify({
          clientId,
          startupIntent: { resumeSessionId: sessionId },
        }),
        headers: scopedHeaders,
        method: "POST",
      });
      expect(registered.status).toBe(200);
    }
    const deadline = Date.now() + 10_000;
    let statuses: string[] = [];
    for (;;) {
      statuses = await Promise.all(
        Array.from({ length: 11 }, async (_unused, zeroBasedIndex) => {
          const sessionId = sessionIds[zeroBasedIndex];
          const response = await fetch(`${secondOrigin}/v1/snapshot`, {
            headers: sessionHeaders[sessionId],
          });
          const body = (await response.json()) as {
            readonly snapshot: {
              readonly prompts?: readonly {
                readonly promptId: string;
                readonly status: string;
              }[];
            };
          };
          const prompt = body.snapshot.prompts?.[0];
          if (zeroBasedIndex === 10) {
            expect(prompt?.promptId).toBe(queuedPromptId);
          }
          return prompt?.status ?? "missing";
        }),
      );
      if (
        statuses[10] === "retained" &&
        statuses.filter((status) => status === "interrupted").length === 10
      ) {
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for recovery statuses: ${statuses.join(",")}`,
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    expect(statuses[10]).toBe("retained");
    expect(statuses.filter((status) => status === "interrupted")).toHaveLength(
      10,
    );

    expect(await startedCount(startedPath)).toBe(10);
    if (!queuedReceipt) throw new Error("Missing durable queued receipt");
    const queuedHeaders = sessionHeaders[queuedReceipt.sessionId];
    const retained = await waitForPromptStatus(
      secondOrigin,
      queuedHeaders,
      queuedPromptId,
      "retained",
    );
    expect(retained).toMatchObject({
      userMessageId: queuedReceipt.userMessageId,
      createdAt: queuedReceipt.createdAt,
    });
    const editLeaseId = await acquirePromptLease(
      secondOrigin,
      queuedHeaders,
      queuedPromptId,
    );
    const retryInput = {
      editLeaseId,
      operationId: "recovered-send-11",
      text: retained.text,
    };
    const [receipt, duplicate] = await Promise.all([
      resubmitRetained(secondOrigin, queuedHeaders, queuedPromptId, retryInput),
      resubmitRetained(secondOrigin, queuedHeaders, queuedPromptId, retryInput),
    ]);
    expect(duplicate).toEqual(receipt);
    expect(receipt).toMatchObject({
      promptId: queuedPromptId,
      userMessageId: queuedReceipt.userMessageId,
      sessionId: queuedReceipt.sessionId,
    });
    const sent = await waitForPromptStatus(
      secondOrigin,
      queuedHeaders,
      queuedPromptId,
      "succeeded",
    );
    expect(sent).toMatchObject({
      createdAt: queuedReceipt.createdAt,
      userMessageId: queuedReceipt.userMessageId,
    });
    expect(
      await resubmitRetained(
        secondOrigin,
        queuedHeaders,
        queuedPromptId,
        retryInput,
      ),
    ).toEqual(receipt);
    expect(await startedCount(startedPath)).toBe(11);
    const database = new NodeSqliteConnection(common.dbPath);
    try {
      expect(
        database
          .prepare<{
            count: number;
          }>(
            "SELECT COUNT(*) AS count FROM message WHERE id = ? AND session_id = ?",
          )
          .get(queuedReceipt.userMessageId, queuedReceipt.sessionId)?.count,
      ).toBe(1);
      expect(
        database
          .prepare<{
            count: number;
          }>(
            "SELECT COUNT(*) AS count FROM run_ledger WHERE session_id = ? AND context_scope_id IS NULL",
          )
          .get(queuedReceipt.sessionId)?.count,
      ).toBe(1);
      expect(
        database
          .prepare<{
            count: number;
          }>(
            "SELECT COUNT(*) AS count FROM prompt_resubmission WHERE operation_id = ?",
          )
          .get(retryInput.operationId)?.count,
      ).toBe(1);
    } finally {
      database.close();
    }

    const endpoint = new URL(second.url);
    const recoveredClient = createRemoteUiBackendClient({
      authToken,
      clientId: "recovery_client",
      directory: repo,
      host: endpoint.hostname,
      port: Number(endpoint.port),
      startupIntent: { resumeSessionId: sessionIds[0] },
    });
    try {
      const completion = await recoveredClient.waitForPrompt(activePromptId);
      expect(completion.prompt.promptId).toBe(activePromptId);
      expect(completion.prompt.status).toBe("interrupted");
      expect(completion.prompt.endedAt).toBeTypeOf("string");
      expect(completion.prompt.error).toMatchObject({
        code: "PROCESS_INTERRUPTED",
        source: "runtime",
      });
    } finally {
      await recoveredClient.dispose();
    }

    secondChild.kill("SIGTERM");
    await waitForExit(secondChild);
    const thirdChild = spawnServe(common);
    const third = await waitForReady(thirdChild);
    const thirdOrigin = new URL(third.url).origin;
    const reconnected = await fetch(`${thirdOrigin}/v1/clients`, {
      body: JSON.stringify({
        clientId: queuedHeaders["x-ohbaby-client-id"],
        startupIntent: { resumeSessionId: queuedReceipt.sessionId },
      }),
      headers: queuedHeaders,
      method: "POST",
    });
    expect(reconnected.status).toBe(200);
    expect(
      await resubmitRetained(
        thirdOrigin,
        queuedHeaders,
        queuedPromptId,
        retryInput,
      ),
    ).toEqual(receipt);
    const persisted = await waitForPromptStatus(
      thirdOrigin,
      queuedHeaders,
      queuedPromptId,
      "succeeded",
    );
    expect(persisted).toMatchObject({
      runId: sent.runId,
      userMessageId: sent.userMessageId,
      createdAt: sent.createdAt,
    });
    expect(await startedCount(startedPath)).toBe(11);
    thirdChild.kill("SIGTERM");
    await waitForExit(thirdChild);
  }, 20_000);

  it("preserves queued edit and cancel decisions across a real daemon restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-real-prompt-edit-"));
    cleanupDirectories.push(root);
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const authToken = "process-edit-token";
    const gatePath = join(root, "release");
    const startedPath = join(root, "started.log");
    const common = {
      authToken,
      blockingProvider: { gatePath, startedPath },
      dbPath: join(root, "agent.db"),
      homeDirectory: join(root, "home"),
      workdir: repo,
    };
    const firstChild = spawnServe(common);
    const first = await waitForReady(firstChild);
    const firstOrigin = new URL(first.url).origin;
    const headers = {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      "x-ohbaby-client-id": "edit_client",
      "x-ohbaby-directory": repo,
    };
    await fetch(`${firstOrigin}/v1/clients`, {
      body: JSON.stringify({ clientId: "edit_client" }),
      headers,
      method: "POST",
    });
    const sessionId = await createServerSession(firstOrigin, headers);
    const receipts: { readonly promptId: string }[] = [];
    for (const [index, text] of [
      "active",
      "before edit",
      "cancel me",
    ].entries()) {
      const response = await fetch(`${firstOrigin}/v1/prompts`, {
        body: JSON.stringify({
          clientRequestId: `edit_request_${String(index)}`,
          sessionId,
          text,
        }),
        headers,
        method: "POST",
      });
      expect(response.status).toBe(202);
      receipts.push((await response.json()) as { promptId: string });
    }
    await waitForStarted(startedPath, 1);
    const snapshotResponse = await fetch(`${firstOrigin}/v1/snapshot`, {
      headers,
    });
    const snapshotBody = (await snapshotResponse.json()) as {
      readonly snapshot: {
        readonly prompts?: readonly {
          readonly promptId: string;
          readonly updatedAt: string;
        }[];
      };
    };
    const editable = snapshotBody.snapshot.prompts?.find(
      (prompt) => prompt.promptId === receipts[1]?.promptId,
    );
    const cancellable = snapshotBody.snapshot.prompts?.find(
      (prompt) => prompt.promptId === receipts[2]?.promptId,
    );
    if (!editable || !cancellable) {
      throw new Error("Expected queued prompts before process restart");
    }
    const leaseResponse = await fetch(
      `${firstOrigin}/v1/prompts/${encodeURIComponent(editable.promptId)}/edit-lease`,
      {
        body: JSON.stringify({ ownerClientId: "edit_client" }),
        headers,
        method: "POST",
      },
    );
    expect(leaseResponse.status).toBe(200);
    const leaseBody = (await leaseResponse.json()) as {
      readonly lease: { readonly editLeaseId: string };
    };
    const edited = await fetch(
      `${firstOrigin}/v1/prompts/${encodeURIComponent(editable.promptId)}`,
      {
        body: JSON.stringify({
          editLeaseId: leaseBody.lease.editLeaseId,
          text: "after edit",
        }),
        headers,
        method: "PATCH",
      },
    );
    expect(edited.status).toBe(200);
    const cancelled = await fetch(
      `${firstOrigin}/v1/prompts/${encodeURIComponent(cancellable.promptId)}`,
      {
        body: JSON.stringify({}),
        headers,
        method: "DELETE",
      },
    );
    expect(cancelled.status).toBe(200);

    firstChild.kill("SIGKILL");
    await waitForExit(firstChild);
    await writeFile(gatePath, "release", "utf8");

    const secondChild = spawnServe(common);
    const second = await waitForReady(secondChild);
    const secondOrigin = new URL(second.url).origin;
    await fetch(`${secondOrigin}/v1/clients`, {
      body: JSON.stringify({
        clientId: "edit_client",
        startupIntent: { resumeSessionId: sessionId },
      }),
      headers,
      method: "POST",
    });
    const retained = await waitForPromptStatus(
      secondOrigin,
      headers,
      editable.promptId,
      "retained",
    );
    expect(retained.text).toBe("after edit");
    expect(
      (await snapshotPrompts(secondOrigin, headers)).find(
        (prompt) => prompt.promptId === cancellable.promptId,
      )?.status,
    ).toBe("cancelled");
    expect(await startedCount(startedPath)).toBe(1);
    const newLease = await acquirePromptLease(
      secondOrigin,
      headers,
      editable.promptId,
    );
    await resubmitRetained(secondOrigin, headers, editable.promptId, {
      editLeaseId: newLease,
      operationId: "send-edited-retained",
      text: retained.text,
    });
    await waitForStarted(startedPath, 2);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const response = await fetch(`${secondOrigin}/v1/snapshot`, { headers });
      const body = (await response.json()) as {
        readonly snapshot: {
          readonly prompts?: readonly {
            readonly promptId: string;
            readonly status: string;
            readonly text: string;
          }[];
        };
      };
      const prompts = body.snapshot.prompts ?? [];
      const active = prompts.find(
        (prompt) => prompt.promptId === receipts[0]?.promptId,
      );
      const editedPrompt = prompts.find(
        (prompt) => prompt.promptId === receipts[1]?.promptId,
      );
      const cancelledPrompt = prompts.find(
        (prompt) => prompt.promptId === receipts[2]?.promptId,
      );
      if (
        active?.status === "interrupted" &&
        editedPrompt?.status === "succeeded" &&
        cancelledPrompt?.status === "cancelled"
      ) {
        expect(editedPrompt.text).toBe("after edit");
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for edited prompt recovery`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    secondChild.kill("SIGTERM");
    await waitForExit(secondChild);
  }, 20_000);

  it("atomically rejects the 101st queued prompt with scheduler fields in a real process", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-real-prompt-limit-"));
    cleanupDirectories.push(root);
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const authToken = "process-limit-token";
    const gatePath = join(root, "release");
    const startedPath = join(root, "started.log");
    const child = spawnServe({
      authToken,
      blockingProvider: { gatePath, startedPath },
      dbPath: join(root, "agent.db"),
      homeDirectory: join(root, "home"),
      workdir: repo,
    });
    const ready = await waitForReady(child);
    const origin = new URL(ready.url).origin;
    const headers = {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      "x-ohbaby-client-id": "limit_client",
      "x-ohbaby-directory": repo,
    };
    await fetch(`${origin}/v1/clients`, {
      body: JSON.stringify({ clientId: "limit_client" }),
      headers,
      method: "POST",
    });
    const sessionId = await createServerSession(origin, headers);
    const active = await fetch(`${origin}/v1/prompts`, {
      body: JSON.stringify({
        clientRequestId: "limit_request_active",
        sessionId,
        text: "active",
      }),
      headers,
      method: "POST",
    });
    expect(active.status).toBe(202);
    await waitForStarted(startedPath, 1);
    const admissionResponses = await Promise.all(
      Array.from({ length: 101 }, async (_unused, zeroBasedIndex) => {
        const index = zeroBasedIndex + 1;
        return fetch(`${origin}/v1/prompts`, {
          body: JSON.stringify({
            clientRequestId: `limit_request_${String(index)}`,
            sessionId,
            text: `queued ${String(index)}`,
          }),
          headers,
          method: "POST",
        });
      }),
    );
    expect(
      admissionResponses.filter((response) => response.status === 202),
    ).toHaveLength(100);
    const rejected = admissionResponses.filter(
      (response) => response.status === 429,
    );
    expect(rejected).toHaveLength(1);
    await expect(rejected[0]?.json()).resolves.toMatchObject({
      error: {
        code: "QUEUE_FULL",
        limit: 100,
        source: "scheduler",
      },
      ok: false,
    });
    const database = new NodeSqliteConnection(join(root, "agent.db"));
    try {
      const row = database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM prompt_submission
            WHERE status = 'queued'`,
        )
        .get() as { readonly count: number };
      expect(row.count).toBe(100);
    } finally {
      database.close();
    }
    child.kill("SIGKILL");
    await waitForExit(child);
  }, 20_000);

  it("retains queued work on graceful stop and sends only an explicitly resubmitted item after newer work", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-real-graceful-stop-"));
    cleanupDirectories.push(root);
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const authToken = "process-graceful-token";
    const gatePath = join(root, "release");
    const startedPath = join(root, "started.log");
    const dbPath = join(root, "agent.db");
    const common = {
      authToken,
      blockingProvider: { gatePath, startedPath },
      dbPath,
      homeDirectory: join(root, "home"),
      workdir: repo,
    };
    const firstChild = spawnServe(common);
    const first = await waitForReady(firstChild);
    const origin = new URL(first.url).origin;
    const headers = {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      "x-ohbaby-client-id": "graceful_client",
      "x-ohbaby-directory": repo,
    };
    await fetch(`${origin}/v1/clients`, {
      body: JSON.stringify({ clientId: "graceful_client" }),
      headers,
      method: "POST",
    });
    const sessionId = await createServerSession(origin, headers);
    const receipts: UiPromptReceipt[] = [];
    for (const [index, text] of [
      "active",
      "retained B",
      "retained C",
    ].entries()) {
      const response = await fetch(`${origin}/v1/prompts`, {
        body: JSON.stringify({
          clientRequestId: `graceful_request_${String(index)}`,
          sessionId,
          text,
        }),
        headers,
        method: "POST",
      });
      expect(response.status).toBe(202);
      receipts.push((await response.json()) as UiPromptReceipt);
      if (index === 0) {
        await waitForStarted(startedPath, 1);
      }
    }
    await waitForStarted(startedPath, 1);

    firstChild.kill("SIGTERM");
    await waitForExit(firstChild);

    const stoppedDatabase = new NodeSqliteConnection(dbPath);
    try {
      const rows = stoppedDatabase
        .prepare(
          `SELECT prompt_id, status
             FROM prompt_submission
            WHERE session_id = ?
            ORDER BY created_at ASC`,
        )
        .all(sessionId) as unknown as readonly {
        readonly prompt_id: string;
        readonly status: string;
      }[];
      expect(rows).toEqual([
        { prompt_id: receipts[0]?.promptId, status: "interrupted" },
        { prompt_id: receipts[1]?.promptId, status: "retained" },
        { prompt_id: receipts[2]?.promptId, status: "retained" },
      ]);
    } finally {
      stoppedDatabase.close();
    }

    const secondChild = spawnServe(common);
    const second = await waitForReady(secondChild);
    const secondOrigin = new URL(second.url).origin;
    await fetch(`${secondOrigin}/v1/clients`, {
      body: JSON.stringify({
        clientId: "graceful_client",
        startupIntent: { resumeSessionId: sessionId },
      }),
      headers,
      method: "POST",
    });
    const bReceipt = receipts[1];
    const cReceipt = receipts[2];
    const retainedB = await waitForPromptStatus(
      secondOrigin,
      headers,
      bReceipt.promptId,
      "retained",
    );
    const retainedC = await waitForPromptStatus(
      secondOrigin,
      headers,
      cReceipt.promptId,
      "retained",
    );
    expect(await startedCount(startedPath)).toBe(1);
    const dResponse = await fetch(`${secondOrigin}/v1/prompts`, {
      body: JSON.stringify({
        clientRequestId: "new-D-after-restart",
        sessionId,
        text: "new D",
      }),
      headers,
      method: "POST",
    });
    expect(dResponse.status).toBe(202);
    const dReceipt = (await dResponse.json()) as UiPromptReceipt;
    await waitForStarted(startedPath, 2);
    expect(
      await waitForPromptStatus(
        secondOrigin,
        headers,
        cReceipt.promptId,
        "retained",
      ),
    ).toEqual(retainedC);
    const lease = await acquirePromptLease(
      secondOrigin,
      headers,
      bReceipt.promptId,
    );
    const resend = await resubmitRetained(
      secondOrigin,
      headers,
      bReceipt.promptId,
      { editLeaseId: lease, operationId: "graceful-send-B", text: "edited B" },
    );
    expect(resend).toMatchObject({
      promptId: bReceipt.promptId,
      userMessageId: bReceipt.userMessageId,
      sessionId,
    });
    const queuedB = await waitForPromptStatus(
      secondOrigin,
      headers,
      bReceipt.promptId,
      "queued",
    );
    const runningD = await waitForPromptStatus(
      secondOrigin,
      headers,
      dReceipt.promptId,
      "running",
    );
    expect(queuedB.admissionOrder).toBeGreaterThan(
      runningD.admissionOrder ?? 0,
    );
    expect(queuedB.createdAt).toBe(retainedB.createdAt);
    expect(queuedB.acceptedAt).not.toBe(retainedB.acceptedAt);
    expect(await startedCount(startedPath)).toBe(2);
    await writeFile(gatePath, "release", "utf8");
    await waitForPromptStatus(
      secondOrigin,
      headers,
      dReceipt.promptId,
      "succeeded",
    );
    const completedB = await waitForPromptStatus(
      secondOrigin,
      headers,
      bReceipt.promptId,
      "succeeded",
    );
    expect(completedB).toMatchObject({
      text: "edited B",
      createdAt: bReceipt.createdAt,
      userMessageId: bReceipt.userMessageId,
    });
    expect(
      await waitForPromptStatus(
        secondOrigin,
        headers,
        cReceipt.promptId,
        "retained",
      ),
    ).toEqual(retainedC);
    expect(await startedCount(startedPath)).toBe(3);
    const completedDatabase = new NodeSqliteConnection(dbPath);
    try {
      expect(
        completedDatabase
          .prepare<{
            count: number;
          }>("SELECT COUNT(*) AS count FROM message WHERE id = ?")
          .get(bReceipt.userMessageId)?.count,
      ).toBe(1);
      expect(
        completedDatabase
          .prepare<{
            count: number;
          }>("SELECT COUNT(*) AS count FROM message WHERE id = ?")
          .get(cReceipt.userMessageId)?.count,
      ).toBe(0);
    } finally {
      completedDatabase.close();
    }
    secondChild.kill("SIGTERM");
    await waitForExit(secondChild);
  }, 20_000);

  it("keeps provider 429 distinct from local queue-full in a real process", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-real-provider-error-"));
    cleanupDirectories.push(root);
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const authToken = "process-provider-token";
    const child = spawnServe({
      authToken,
      dbPath: join(root, "agent.db"),
      failingProvider: {
        message: "Authorization: Bearer secret-token response body",
        status: 429,
      },
      homeDirectory: join(root, "home"),
      workdir: repo,
    });
    const ready = await waitForReady(child);
    const origin = new URL(ready.url).origin;
    const headers = {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      "x-ohbaby-client-id": "provider_client",
      "x-ohbaby-directory": repo,
    };
    await fetch(`${origin}/v1/clients`, {
      body: JSON.stringify({ clientId: "provider_client" }),
      headers,
      method: "POST",
    });
    const sessionId = await createServerSession(origin, headers);
    const accepted = await fetch(`${origin}/v1/prompts`, {
      body: JSON.stringify({
        clientRequestId: "provider_request_1",
        sessionId,
        text: "fail with provider 429",
      }),
      headers,
      method: "POST",
    });
    expect(accepted.status).toBe(202);
    const receipt = (await accepted.json()) as { readonly promptId: string };
    const deadline = Date.now() + 10_000;
    for (;;) {
      const response = await fetch(`${origin}/v1/snapshot`, { headers });
      const body = (await response.json()) as {
        readonly snapshot: {
          readonly prompts?: readonly {
            readonly error?: {
              readonly code: string;
              readonly message: string;
              readonly source: string;
              readonly statusCode?: number;
            };
            readonly promptId: string;
            readonly status: string;
          }[];
        };
      };
      const prompt = body.snapshot.prompts?.find(
        (candidate) => candidate.promptId === receipt.promptId,
      );
      if (prompt?.status === "failed") {
        expect(prompt.error).toMatchObject({
          code: "PROVIDER_RETRY_EXHAUSTED",
          source: "provider",
          statusCode: 429,
        });
        expect(prompt.error?.message).not.toContain("secret-token");
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for provider failure");
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    child.kill("SIGTERM");
    await waitForExit(child);
  }, 20_000);

  it("keeps retained input while its workspace is unavailable and sends only after restoration", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "ohbaby-real-workspace-unavailable-"),
    );
    cleanupDirectories.push(root);
    const missingRepo = join(root, "missing-repo");
    const fallbackRepo = join(root, "fallback-repo");
    await mkdir(join(missingRepo, ".git"), { recursive: true });
    await mkdir(join(fallbackRepo, ".git"), { recursive: true });
    const authToken = "process-unavailable-token";
    const dbPath = join(root, "agent.db");
    const gatePath = join(root, "release");
    const startedPath = join(root, "started.log");
    const common = {
      authToken,
      blockingProvider: { gatePath, startedPath },
      dbPath,
      homeDirectory: join(root, "home"),
      workdir: missingRepo,
    };
    const firstChild = spawnServe(common);
    const first = await waitForReady(firstChild);
    const origin = new URL(first.url).origin;
    const headers = {
      authorization: `Bearer ${authToken}`,
      "content-type": "application/json",
      "x-ohbaby-client-id": "unavailable_client",
      "x-ohbaby-directory": missingRepo,
    };
    await fetch(`${origin}/v1/clients`, {
      body: JSON.stringify({ clientId: "unavailable_client" }),
      headers,
      method: "POST",
    });
    const sessionId = await createServerSession(origin, headers);
    let queuedPromptId = "";
    for (const [index, text] of ["active", "queued"].entries()) {
      const response = await fetch(`${origin}/v1/prompts`, {
        body: JSON.stringify({
          clientRequestId: `unavailable_request_${String(index)}`,
          sessionId,
          text,
        }),
        headers,
        method: "POST",
      });
      const receipt = (await response.json()) as { readonly promptId: string };
      if (text === "queued") {
        queuedPromptId = receipt.promptId;
      }
    }
    await waitForStarted(startedPath, 1);
    firstChild.kill("SIGKILL");
    await waitForExit(firstChild);
    await rm(missingRepo, { force: true, recursive: true });

    const secondChild = spawnServe({
      authToken,
      dbPath,
      homeDirectory: join(root, "home"),
      workdir: fallbackRepo,
    });
    await waitForReady(secondChild);

    const database = new NodeSqliteConnection(dbPath);
    try {
      const row = database
        .prepare(
          "SELECT status, error_data FROM prompt_submission WHERE prompt_id = ?",
        )
        .get(queuedPromptId) as
        | { readonly error_data: string | null; readonly status: string }
        | undefined;
      expect(row?.status).toBe("retained");
      expect(row?.error_data).toBeNull();
    } finally {
      database.close();
    }
    expect(await startedCount(startedPath)).toBe(1);
    secondChild.kill("SIGTERM");
    await waitForExit(secondChild);
    await mkdir(join(missingRepo, ".git"), { recursive: true });
    const restoredChild = spawnServe(common);
    const restored = await waitForReady(restoredChild);
    const restoredOrigin = new URL(restored.url).origin;
    const registered = await fetch(`${restoredOrigin}/v1/clients`, {
      body: JSON.stringify({
        clientId: "unavailable_client",
        startupIntent: { resumeSessionId: sessionId },
      }),
      headers,
      method: "POST",
    });
    expect(registered.status).toBe(200);
    const retained = await waitForPromptStatus(
      restoredOrigin,
      headers,
      queuedPromptId,
      "retained",
    );
    expect(await startedCount(startedPath)).toBe(1);
    const lease = await acquirePromptLease(
      restoredOrigin,
      headers,
      queuedPromptId,
    );
    await resubmitRetained(restoredOrigin, headers, queuedPromptId, {
      editLeaseId: lease,
      operationId: "restored-workspace-send",
      text: retained.text,
    });
    await writeFile(gatePath, "release", "utf8");
    const completed = await waitForPromptStatus(
      restoredOrigin,
      headers,
      queuedPromptId,
      "succeeded",
    );
    expect(completed).toMatchObject({
      userMessageId: retained.userMessageId,
      createdAt: retained.createdAt,
    });
    expect(await startedCount(startedPath)).toBe(2);
    restoredChild.kill("SIGTERM");
    await waitForExit(restoredChild);
  }, 20_000);
});

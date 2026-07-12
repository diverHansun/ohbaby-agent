import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NodeSqliteConnection } from "../../../../ohbaby-agent/src/services/database/connection.js";

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
  readonly dbPath: string;
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
          async streamChatCompletion(request) {
            if (JSON.stringify(request.messages).includes("Generate a concise title")) {
              return (async function* () {
                yield { textDelta: "Process E2E", finishReason: "stop" };
              })();
            }
            appendFileSync(blockingProvider.startedPath, "started\\n");
            return (async function* () {
              while (!existsSync(blockingProvider.gatePath)) {
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
          async streamChatCompletion(request) {
            if (JSON.stringify(request.messages).includes("Generate a concise title")) {
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
  const child = spawn(process.execPath, ["--import", "tsx", "--eval", script], {
    env: {
      ...process.env,
      OHBABY_TEST_INPUT: JSON.stringify(input),
    },
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

describe("global single serve across real processes", () => {
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

    const receipts: { readonly promptId: string }[] = [];
    for (let index = 1; index <= 11; index += 1) {
      const response = await fetch(`${origin}/v1/prompts`, {
        body: JSON.stringify({
          sessionId: `process_session_${String(index)}`,
          text: `process prompt ${String(index)}`,
        }),
        headers,
        method: "POST",
      });
      expect(response.status).toBe(202);
      receipts.push((await response.json()) as { promptId: string });
    }

    await waitForStarted(startedPath, 10);
    const queuedSnapshot = await fetch(`${origin}/v1/snapshot`, { headers });
    const queuedBody = (await queuedSnapshot.json()) as {
      readonly snapshot: {
        readonly prompts?: readonly {
          readonly promptId: string;
          readonly status: string;
        }[];
      };
    };
    expect(
      queuedBody.snapshot.prompts?.find(
        (prompt) => prompt.promptId === receipts[10]?.promptId,
      ),
    ).toMatchObject({ status: "queued" });

    await writeFile(gatePath, "release", "utf8");
    await waitForStarted(startedPath, 11);
    child.kill("SIGTERM");
    await waitForExit(child);
  }, 20_000);

  it("recovers queued work but marks active work interrupted after a real daemon crash", async () => {
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
    let queuedPromptId = "";
    for (let index = 1; index <= 11; index += 1) {
      const response = await fetch(`${firstOrigin}/v1/prompts`, {
        body: JSON.stringify({
          sessionId: `recovery_session_${String(index)}`,
          text: `recovery prompt ${String(index)}`,
        }),
        headers,
        method: "POST",
      });
      const receipt = (await response.json()) as { readonly promptId: string };
      if (index === 11) {
        queuedPromptId = receipt.promptId;
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
      const sessionId = `recovery_session_${String(index)}`;
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
          const sessionId = `recovery_session_${String(zeroBasedIndex + 1)}`;
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
        statuses[10] === "succeeded" &&
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
    expect(statuses[10]).toBe("succeeded");
    expect(statuses.filter((status) => status === "interrupted")).toHaveLength(
      10,
    );

    secondChild.kill("SIGTERM");
    await waitForExit(secondChild);
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
    const receipts: { readonly promptId: string }[] = [];
    for (const text of ["active", "before edit", "cancel me"]) {
      const response = await fetch(`${firstOrigin}/v1/prompts`, {
        body: JSON.stringify({ sessionId: "edit_session", text }),
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
    const edited = await fetch(
      `${firstOrigin}/v1/prompts/${encodeURIComponent(editable.promptId)}`,
      {
        body: JSON.stringify({
          expectedUpdatedAt: editable.updatedAt,
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
        body: JSON.stringify({ expectedUpdatedAt: cancellable.updatedAt }),
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
        startupIntent: { resumeSessionId: "edit_session" },
      }),
      headers,
      method: "POST",
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
    const active = await fetch(`${origin}/v1/prompts`, {
      body: JSON.stringify({ sessionId: "limit_session", text: "active" }),
      headers,
      method: "POST",
    });
    expect(active.status).toBe(202);
    await waitForStarted(startedPath, 1);
    for (let index = 1; index <= 100; index += 1) {
      const queued = await fetch(`${origin}/v1/prompts`, {
        body: JSON.stringify({
          sessionId: "limit_session",
          text: `queued ${String(index)}`,
        }),
        headers,
        method: "POST",
      });
      expect(queued.status).toBe(202);
    }
    const overflow = await fetch(`${origin}/v1/prompts`, {
      body: JSON.stringify({
        sessionId: "limit_session",
        text: "queued 101",
      }),
      headers,
      method: "POST",
    });
    expect(overflow.status).toBe(429);
    await expect(overflow.json()).resolves.toMatchObject({
      error: {
        code: "QUEUE_FULL",
        limit: 100,
        source: "scheduler",
      },
      ok: false,
    });
    child.kill("SIGKILL");
    await waitForExit(child);
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
    const accepted = await fetch(`${origin}/v1/prompts`, {
      body: JSON.stringify({
        sessionId: "provider_session",
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

  it("terminally marks queued work only when its workspace is truly unavailable", async () => {
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
    let queuedPromptId = "";
    for (const text of ["active", "queued"]) {
      const response = await fetch(`${origin}/v1/prompts`, {
        body: JSON.stringify({
          sessionId: "unavailable_session",
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
      expect(row?.status).toBe("failed");
      expect(
        row?.error_data ? JSON.parse(row.error_data) : undefined,
      ).toMatchObject({
        code: "WORKSPACE_UNAVAILABLE",
        source: "runtime",
      });
    } finally {
      database.close();
    }
    secondChild.kill("SIGTERM");
    await waitForExit(secondChild);
  }, 20_000);
});

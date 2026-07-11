import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UiBackendClient } from "ohbaby-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonAuthHeader } from "../../auth/token.js";
import { createDaemonHttpServer, type WorkspaceBackend } from "./server.js";

function createBackend(dispose = vi.fn()): WorkspaceBackend {
  return {
    dispose,
    getSnapshot: vi.fn(() =>
      Promise.resolve({
        activeSessionId: null,
        permissions: [],
        runs: [],
        sessions: [],
        status: { kind: "idle" as const },
      }),
    ),
    subscribeEvents: vi.fn(() => vi.fn()),
  } as unknown as UiBackendClient & { dispose(): void };
}

describe("global daemon workspace routing", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirs
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  it("keeps global routes header-free and workspace routes fail-closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-global-server-"));
    cleanupDirs.push(root);
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    const file = join(root, "not-a-directory");
    await mkdir(join(repoA, ".git"), { recursive: true });
    await mkdir(join(repoB, ".git"), { recursive: true });
    await writeFile(file, "file", "utf8");
    const backendA = createBackend();
    const disposeB = vi.fn();
    const backendB = createBackend(disposeB);
    const createWorkspaceBackend = vi.fn((scopeKey: string) => {
      if (scopeKey !== join(root, "repo-b") && !scopeKey.endsWith("/repo-b")) {
        throw new Error(`unexpected scope: ${scopeKey}`);
      }
      return backendB;
    });
    const server = createDaemonHttpServer({
      authToken: "token",
      backend: backendA,
      createWorkspaceBackend,
      port: 0,
      scopeRoot: await realpath(repoA),
    });
    await server.start();
    const authorization = daemonAuthHeader("token");

    try {
      const health = await fetch(`${server.url}/api/health`, {
        headers: { authorization },
      });
      expect(health.status).toBe(200);

      for (const request of [
        new Request(
          `${server.url}/v1/clients?directory=${encodeURIComponent(repoB)}`,
          {
            headers: { authorization, "content-type": "application/json" },
            method: "POST",
          },
        ),
        new Request(`${server.url}/v1/clients`, {
          headers: {
            authorization,
            "content-type": "application/json",
            "x-ohbaby-directory": "relative/repo",
          },
          method: "POST",
        }),
        new Request(`${server.url}/v1/clients`, {
          headers: {
            authorization,
            "content-type": "application/json",
            "x-ohbaby-directory": file,
          },
          method: "POST",
        }),
      ]) {
        const response = await fetch(request);
        expect(response.status).toBe(400);
      }

      const response = await fetch(`${server.url}/v1/clients`, {
        body: JSON.stringify({ clientId: "client_b" }),
        headers: {
          authorization,
          "content-type": "application/json",
          "x-ohbaby-directory": repoB,
        },
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(createWorkspaceBackend).toHaveBeenCalledWith(
        await realpath(repoB),
      );
    } finally {
      await server.stop();
    }

    expect(disposeB).toHaveBeenCalledTimes(1);
  });

  it("lists known and loaded workspace scopes without a workspace header", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-global-scopes-"));
    cleanupDirs.push(root);
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await mkdir(join(repoA, ".git"), { recursive: true });
    await mkdir(join(repoB, ".git"), { recursive: true });
    const canonicalA = await realpath(repoA);
    const canonicalB = await realpath(repoB);
    const server = createDaemonHttpServer({
      authToken: "token",
      backend: createBackend(),
      createWorkspaceBackend: () => createBackend(),
      listKnownWorkspaceScopes: () => [canonicalB, canonicalA, canonicalB],
      port: 0,
      scopeRoot: canonicalA,
    });
    await server.start();

    try {
      const authorization = daemonAuthHeader("token");
      const initial = await fetch(`${server.url}/v1/scopes`, {
        headers: { authorization },
      });
      expect(initial.status).toBe(200);
      await expect(initial.json()).resolves.toEqual({
        ok: true,
        scopes: [
          { directory: canonicalA, loaded: true },
          { directory: canonicalB, loaded: false },
        ],
      });

      await fetch(`${server.url}/v1/snapshot`, {
        headers: {
          authorization,
          "x-ohbaby-client-id": "client_b",
          "x-ohbaby-directory": canonicalB,
        },
      });
      const afterLoad = await fetch(`${server.url}/v1/scopes`, {
        headers: { authorization },
      });
      await expect(afterLoad.json()).resolves.toEqual({
        ok: true,
        scopes: [
          { directory: canonicalA, loaded: true },
          { directory: canonicalB, loaded: true },
        ],
      });
    } finally {
      await server.stop();
    }
  });

  it("reports active SSE connections with their workspace scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-global-connections-"));
    cleanupDirs.push(root);
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const canonicalRepo = await realpath(repo);
    const server = createDaemonHttpServer({
      authToken: "token",
      backend: createBackend(),
      createWorkspaceBackend: () => createBackend(),
      now: () => 42_000,
      port: 0,
      scopeRoot: canonicalRepo,
    });
    await server.start();
    const authorization = daemonAuthHeader("token");
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      await fetch(`${server.url}/v1/clients`, {
        body: JSON.stringify({ clientId: "client_web" }),
        headers: {
          authorization,
          "content-type": "application/json",
          "x-ohbaby-directory": canonicalRepo,
        },
        method: "POST",
      });
      const events = await fetch(`${server.url}/v1/events`, {
        headers: {
          authorization,
          "x-ohbaby-client-id": "client_web",
          "x-ohbaby-directory": canonicalRepo,
        },
      });
      reader = events.body?.getReader();
      await reader?.read();

      const connections = await fetch(`${server.url}/v1/connections`, {
        headers: { authorization },
      });
      expect(connections.status).toBe(200);
      await expect(connections.json()).resolves.toEqual({
        connections: [
          {
            clientId: "client_web",
            connectedAt: 42_000,
            scopeKey: canonicalRepo,
          },
        ],
        ok: true,
      });
    } finally {
      await reader?.cancel();
      await server.stop();
    }
  });
});

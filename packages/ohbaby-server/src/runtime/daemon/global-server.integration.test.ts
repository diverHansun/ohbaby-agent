import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UiBackendClient } from "ohbaby-sdk";
import type {
  WorkspaceRegistryEntry,
  WorkspaceRegistryStore,
} from "ohbaby-agent";
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

function createRegistry(now = (): number => Date.now()): WorkspaceRegistryStore {
  const entries = new Map<string, WorkspaceRegistryEntry>();
  return {
    list: () => [...entries.values()].sort((a, b) => a.position - b.position),
    ensureDiscovered(
      scopeKeys: readonly string[],
    ): readonly WorkspaceRegistryEntry[] {
      for (const scopeKey of new Set(scopeKeys)) {
        if (!entries.has(scopeKey)) {
          const timestamp = now();
          entries.set(scopeKey, {
            createdAt: timestamp,
            lastOpenedAt: timestamp,
            position: entries.size,
            scopeKey,
            updatedAt: timestamp,
            visibility: "visible",
          });
        }
      }
      return this.list();
    },
    hide(scopeKey: string): boolean {
      const entry = entries.get(scopeKey);
      if (!entry) return false;
      entries.set(scopeKey, {
        ...entry,
        updatedAt: now(),
        visibility: "hidden",
      });
      return true;
    },
    open(scopeKey: string): WorkspaceRegistryEntry {
      const timestamp = now();
      const current = entries.get(scopeKey);
      const entry: WorkspaceRegistryEntry = current
        ? {
            ...current,
            lastOpenedAt: timestamp,
            updatedAt: timestamp,
            visibility: "visible",
          }
        : {
            createdAt: timestamp,
            lastOpenedAt: timestamp,
            position: entries.size,
            scopeKey,
            updatedAt: timestamp,
            visibility: "visible",
          };
      entries.set(scopeKey, entry);
      return entry;
    },
  };
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
      workspaceRegistry: createRegistry(() => 42_000),
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
          {
            available: true,
            directory: canonicalA,
            lastOpenedAt: 42_000,
            loaded: true,
            position: 0,
          },
          {
            available: true,
            directory: canonicalB,
            lastOpenedAt: 42_000,
            loaded: false,
            position: 1,
          },
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
          {
            available: true,
            directory: canonicalA,
            lastOpenedAt: 42_000,
            loaded: true,
            position: 0,
          },
          {
            available: true,
            directory: canonicalB,
            lastOpenedAt: 42_000,
            loaded: true,
            position: 1,
          },
        ],
      });
    } finally {
      await server.stop();
    }
  });

  it("opens, hides, and browses projects through authenticated global routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-global-projects-"));
    cleanupDirs.push(root);
    const repo = join(root, "repo");
    const child = join(root, "child");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(child, { recursive: true });
    await writeFile(join(root, "ignored.txt"), "file", "utf8");
    const canonicalRepo = await realpath(repo);
    const canonicalRoot = await realpath(root);
    const registry = createRegistry(() => 77_000);
    const server = createDaemonHttpServer({
      authToken: "token",
      backend: createBackend(),
      createWorkspaceBackend: () => createBackend(),
      directoryPickerHome: root,
      port: 0,
      scopeRoot: canonicalRepo,
      workspaceRegistry: registry,
    });
    await server.start();
    const headers = {
      authorization: daemonAuthHeader("token"),
      "content-type": "application/json",
    };

    try {
      const roots = await fetch(`${server.url}/v1/directory-picker/roots`, {
        headers,
      });
      expect(roots.status).toBe(200);
      const rootsBody = (await roots.json()) as {
        readonly ok: boolean;
        readonly roots: readonly { readonly directory: string; readonly label: string }[];
      };
      expect(rootsBody.ok).toBe(true);
      expect(rootsBody.roots).toContainEqual({ directory: root, label: "Home" });

      const listed = await fetch(`${server.url}/v1/directory-picker/list`, {
        body: JSON.stringify({ directory: root }),
        headers,
        method: "POST",
      });
      await expect(listed.json()).resolves.toMatchObject({
        directories: [
          { directory: join(canonicalRoot, "child"), name: "child" },
          { directory: canonicalRepo, name: "repo" },
        ],
        directory: canonicalRoot,
        ok: true,
      });

      const opened = await fetch(`${server.url}/v1/scopes/open`, {
        body: JSON.stringify({ directory: repo }),
        headers,
        method: "POST",
      });
      expect(opened.status).toBe(200);
      expect(registry.list()).toContainEqual(
        expect.objectContaining({
          scopeKey: canonicalRepo,
          visibility: "visible",
        }),
      );

      const openedEmptyProject = await fetch(`${server.url}/v1/scopes/open`, {
        body: JSON.stringify({ directory: child }),
        headers,
        method: "POST",
      });
      expect(openedEmptyProject.status).toBe(200);
      const withEmptyProject = await fetch(`${server.url}/v1/scopes`, {
        headers,
      });
      const emptyProjectBody = (await withEmptyProject.json()) as {
        readonly scopes: readonly {
          readonly available: boolean;
          readonly directory: string;
        }[];
      };
      expect(emptyProjectBody.scopes).toContainEqual(
        expect.objectContaining({
          available: true,
          directory: await realpath(child),
        }),
      );

      const hidden = await fetch(`${server.url}/v1/scopes/hide`, {
        body: JSON.stringify({ directory: canonicalRepo }),
        headers,
        method: "POST",
      });
      expect(hidden.status).toBe(200);
      await fetch(`${server.url}/v1/scopes/hide`, {
        body: JSON.stringify({ directory: await realpath(child) }),
        headers,
        method: "POST",
      });
      const scopes = await fetch(`${server.url}/v1/scopes`, { headers });
      await expect(scopes.json()).resolves.toEqual({ ok: true, scopes: [] });

      const unauthorized = await fetch(
        `${server.url}/v1/directory-picker/roots`,
      );
      expect(unauthorized.status).toBe(401);
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

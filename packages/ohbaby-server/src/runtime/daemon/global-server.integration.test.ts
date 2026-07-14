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
import {
  DirectoryBrowserError,
  type DirectoryBrowser,
} from "../directory-browser.js";
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

function createRegistry(
  now = (): number => Date.now(),
): WorkspaceRegistryStore {
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
    const canonicalRepoB = await realpath(repoB);
    const backendA = createBackend();
    const disposeB = vi.fn();
    const backendB = createBackend(disposeB);
    const createWorkspaceBackend = vi.fn((scopeKey: string) => {
      if (scopeKey !== canonicalRepoB) {
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

  it("decodes marked percent-encoded workspace headers without breaking legacy ASCII callers", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-unicode-scope-"));
    cleanupDirs.push(root);
    const asciiRepo = join(root, "ascii-repo");
    const unicodeRepo = join(root, "李笑来作品集");
    await mkdir(join(asciiRepo, ".git"), { recursive: true });
    await mkdir(join(unicodeRepo, ".git"), { recursive: true });
    const canonicalAsciiRepo = await realpath(asciiRepo);
    const canonicalUnicodeRepo = await realpath(unicodeRepo);
    const createWorkspaceBackend = vi.fn(() => createBackend());
    const server = createDaemonHttpServer({
      authToken: "token",
      backend: createBackend(),
      createWorkspaceBackend,
      port: 0,
      scopeRoot: canonicalAsciiRepo,
    });
    await server.start();
    const headers = {
      authorization: daemonAuthHeader("token"),
      "content-type": "application/json",
    };

    try {
      const legacy = await fetch(`${server.url}/v1/clients`, {
        body: JSON.stringify({ clientId: "legacy_client" }),
        headers: { ...headers, "x-ohbaby-directory": canonicalAsciiRepo },
        method: "POST",
      });
      expect(legacy.status).toBe(200);

      const unicode = await fetch(`${server.url}/v1/clients`, {
        body: JSON.stringify({ clientId: "unicode_client" }),
        headers: {
          ...headers,
          "x-ohbaby-directory": encodeURIComponent(canonicalUnicodeRepo),
          "x-ohbaby-directory-encoding": "percent-utf8",
        },
        method: "POST",
      });
      expect(unicode.status).toBe(200);
      expect(createWorkspaceBackend).toHaveBeenCalledWith(
        canonicalUnicodeRepo,
      );

      const malformed = await fetch(`${server.url}/v1/clients`, {
        body: JSON.stringify({ clientId: "malformed_client" }),
        headers: {
          ...headers,
          "x-ohbaby-directory": "%E0%A4%A",
          "x-ohbaby-directory-encoding": "percent-utf8",
        },
        method: "POST",
      });
      expect(malformed.status).toBe(400);
      await expect(malformed.json()).resolves.toMatchObject({
        error: { code: "INVALID_DIRECTORY" },
        ok: false,
      });
    } finally {
      await server.stop();
    }
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

  it("opens and hides projects through authenticated global routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-global-projects-"));
    cleanupDirs.push(root);
    const repo = join(root, "repo");
    const child = join(root, "child");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(child, { recursive: true });
    const canonicalRepo = await realpath(repo);
    const registry = createRegistry(() => 77_000);
    const server = createDaemonHttpServer({
      authToken: "token",
      backend: createBackend(),
      createWorkspaceBackend: () => createBackend(),
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

      const unauthorized = await fetch(`${server.url}/v1/scopes/open`, {
        body: JSON.stringify({ directory: child }),
        method: "POST",
      });
      expect(unauthorized.status).toBe(401);
    } finally {
      await server.stop();
    }
  });

  it("provides authenticated loopback-only directory metadata routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ohbaby-global-picker-safety-"));
    cleanupDirs.push(root);
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const canonicalRepo = await realpath(repo);
    const listRoots = vi.fn<DirectoryBrowser["listRoots"]>(() =>
      Promise.resolve([{ directory: "/", name: "/" }]),
    );
    const list = vi.fn<DirectoryBrowser["list"]>(() =>
      Promise.resolve({
        children: [{ directory: "/projects", name: "projects" }],
        directory: "/",
        parent: null,
      }),
    );
    const directoryBrowser: DirectoryBrowser = { list, listRoots };
    const server = createDaemonHttpServer({
      authToken: "token",
      backend: createBackend(),
      createWorkspaceBackend: () => createBackend(),
      directoryBrowser,
      port: 0,
      scopeRoot: canonicalRepo,
    });
    await server.start();
    const headers = {
      authorization: daemonAuthHeader("token"),
      "content-type": "application/json",
    };

    try {
      const unauthorized = await fetch(
        `${server.url}/v1/directory-picker/roots`,
      );
      expect(unauthorized.status).toBe(401);
      expect(listRoots).not.toHaveBeenCalled();

      const unauthorizedListing = await fetch(
        `${server.url}/v1/directory-picker/list`,
        {
          body: JSON.stringify({ directory: "/" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      expect(unauthorizedListing.status).toBe(401);
      expect(list).not.toHaveBeenCalled();

      const roots = await fetch(`${server.url}/v1/directory-picker/roots`, {
        headers,
      });
      expect(roots.status).toBe(200);
      await expect(roots.json()).resolves.toEqual({
        ok: true,
        roots: [{ directory: "/", name: "/" }],
      });

      list.mockRejectedValueOnce(
        new DirectoryBrowserError(
          "DIRECTORY_NOT_READABLE",
          "Directory cannot be read",
        ),
      );
      const unreadable = await fetch(`${server.url}/v1/directory-picker/list`, {
        body: JSON.stringify({ directory: "/" }),
        headers,
        method: "POST",
      });
      expect(unreadable.status).toBe(400);
      await expect(unreadable.json()).resolves.toEqual({
        error: {
          code: "DIRECTORY_NOT_READABLE",
          message: "Directory cannot be read",
        },
        ok: false,
      });

      const listing = await fetch(`${server.url}/v1/directory-picker/list`, {
        body: JSON.stringify({ directory: "/" }),
        headers,
        method: "POST",
      });
      expect(listing.status).toBe(200);
      await expect(listing.json()).resolves.toEqual({
        children: [{ directory: "/projects", name: "projects" }],
        directory: "/",
        ok: true,
        parent: null,
      });
      expect(list).toHaveBeenCalledWith("/");

      const removedPicker = await fetch(`${server.url}/v1/scopes/open-picker`, {
        headers,
        method: "POST",
      });
      expect(removedPicker.status).not.toBe(200);
    } finally {
      await server.stop();
    }

    const nonLoopback = createDaemonHttpServer({
      authToken: "token",
      backend: createBackend(),
      createWorkspaceBackend: () => createBackend(),
      directoryBrowser,
      host: "0.0.0.0",
      port: 0,
      scopeRoot: canonicalRepo,
    });
    await nonLoopback.start();
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(nonLoopback.port)}/v1/directory-picker/roots`,
        { headers },
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "DIRECTORY_BROWSER_LOOPBACK_ONLY" },
        ok: false,
      });
      expect(listRoots).toHaveBeenCalledTimes(1);
      const listing = await fetch(
        `http://127.0.0.1:${String(nonLoopback.port)}/v1/directory-picker/list`,
        {
          body: JSON.stringify({ directory: "/" }),
          headers,
          method: "POST",
        },
      );
      expect(listing.status).toBe(403);
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      await nonLoopback.stop();
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

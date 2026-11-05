import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiBackendClient, UiSessionIndexEntry } from "ohbaby-sdk";
import type { UiPromptQueueExecutionPort } from "ohbaby-agent";
import { createDaemonServerApp } from "./create-app.js";
import { listenToNodeServer } from "../transport/node-listen.js";

const epoch = "files-epoch";
const binding = `runtimeEpoch=${epoch}&bindingGeneration=1`;
const headers = {
  authorization: "Bearer files-token",
  "x-ohbaby-client-id": "files-client",
  "content-type": "application/json",
};
let home: string;
let scratch: string;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "session-files-http-"));
  scratch = path.join(home, "sessions", "root", "scratch");
  vi.stubEnv("OHBABY_HOME", home);
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

async function setup(): Promise<{
  request: (route: string, init?: RequestInit) => Promise<Response>;
  removeRoot: () => void;
}> {
  const stamp = "2026-11-05T00:00:00Z";
  let sessions: UiSessionIndexEntry[] = [
    ...["root", "other"].map((id) => ({
      id,
      title: id,
      createdAt: stamp,
      updatedAt: stamp,
    })),
    {
      id: "child",
      title: "child",
      createdAt: stamp,
      updatedAt: stamp,
      parentId: "root",
      isSubagent: true,
    },
  ];
  const backend = {
    getSessionIndex: () => Promise.resolve(sessions),
    initializeSession: () => Promise.resolve(),
    getSessionView: () =>
      Promise.reject(new Error("Files must not load a chat view")),
    getSnapshot: () =>
      Promise.reject(new Error("Files must not load a snapshot")),
    getPermissionSnapshot: (input: { rootSessionId: string | null }) =>
      Promise.resolve({
        permissionEpoch: epoch,
        rootSessionId: input.rootSessionId,
        permissionRevision: 0,
        requests: [],
      }),
    subscribeEvents: () => (): void => undefined,
    subscribePermissionEvents: () => (): void => undefined,
  } as unknown as UiBackendClient & UiPromptQueueExecutionPort;
  const app = createDaemonServerApp({ backend, authToken: "files-token" });
  await app.start();
  const server = await listenToNodeServer({
    app: app.app,
    host: "127.0.0.1",
    port: 0,
  });
  cleanups.push(async () => {
    await server.stop();
    await app.dispose();
  });
  const request = (route: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${server.url}${route}`, {
      ...init,
      headers: init.headers ?? headers,
    });
  const registered = await request("/v1/clients", {
    method: "POST",
    body: JSON.stringify({
      clientId: "files-client",
      startupIntent: { resumeSessionId: "root" },
    }),
  });
  expect(registered.status).toBe(200);
  return {
    request,
    removeRoot: (): void => {
      sessions = sessions.filter((session) => session.id !== "root");
    },
  };
}
async function put(name: string, data: string | Buffer): Promise<void> {
  const file = path.join(scratch, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}
function contentRoute(name: string): string {
  return `/v1/sessions/root/files/content?${binding}&path=${encodeURIComponent(name)}`;
}

describe("session Files REST contract", () => {
  it("lists selected scratch files and serves raw private text/image bodies", async () => {
    await put("nested/text.html", "<html>中文 👋</html>");
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await put("picture", png);
    const { request } = await setup();
    const listed = await request(`/v1/sessions/root/files?${binding}`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      ok: boolean;
      files: { path: string; size: number; modifiedAt: string }[];
    };
    expect(body.ok).toBe(true);
    expect(body.files.map(({ path, size }) => ({ path, size }))).toEqual([
      { path: "nested/text.html", size: 24 },
      { path: "picture", size: 8 },
    ]);
    expect(
      body.files.every((file) => Number.isFinite(Date.parse(file.modifiedAt))),
    ).toBe(true);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(listed.headers.get("x-content-type-options")).toBe("nosniff");
    const text = await request(contentRoute("nested/text.html"));
    expect(text.status).toBe(200);
    expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(text.headers.get("cache-control")).toBe("no-store");
    expect(text.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await text.text()).toBe("<html>中文 👋</html>");
    const image = await request(contentRoute("picture"));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
  });

  it.each(["files", "files/content?path=file"])(
    "requires bearer auth and a registered client for %s",
    async (suffix) => {
      await put("file", "private");
      const { request } = await setup();
      const route = `/v1/sessions/root/${suffix}${suffix.includes("?") ? "&" : "?"}${binding}`;
      for (const [custom, status] of [
        [{ "x-ohbaby-client-id": "files-client" }, 401],
        [{ authorization: "Bearer files-token" }, 400],
        [
          {
            authorization: "Bearer files-token",
            "x-ohbaby-client-id": "unregistered",
          },
          409,
        ],
      ] as const) {
        const response = await request(route, { headers: custom });
        expect(response.status).toBe(status);
        const body = (await response.json()) as {
          ok: boolean;
          error: { message: string };
        };
        expect(body.ok).toBe(false);
        expect(typeof body.error.message).toBe("string");
      }
    },
  );

  it.each(["files", "files/content?path=file"])(
    "checks root identity and binding for %s",
    async (suffix) => {
      await put("file", "private");
      const { request, removeRoot } = await setup();
      const join = suffix.includes("?") ? "&" : "?";
      for (const [id, query, status] of [
        ["other", binding, 409],
        ["child", binding, 409],
        ["root", "runtimeEpoch=stale&bindingGeneration=1", 409],
        ["root", `runtimeEpoch=${epoch}&bindingGeneration=2`, 409],
        ["root", "", 400],
      ] as const) {
        const response = await request(
          `/v1/sessions/${id}/${suffix}${join}${query}`,
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ ok: false });
      }
      removeRoot();
      expect(
        (await request(`/v1/sessions/root/${suffix}${join}${binding}`)).status,
      ).toBe(409);
    },
  );

  it("returns explicit file errors and does not decode a relative path twice", async () => {
    await put("dir/file", "safe");
    await put("%2e%2e/literal", "literal percent path");
    await put("binary", Buffer.from([0, 1, 2]));
    await put("large", Buffer.alloc(1024 * 1024 + 1, 0x61));
    await fs.symlink(
      path.join(scratch, "dir"),
      path.join(scratch, "linked"),
      "junction",
    );
    await fs.symlink(
      path.join(scratch, "dir", "file"),
      path.join(scratch, "file-link"),
    );
    const { request } = await setup();
    for (const [name, status, code] of [
      ["../file", 400, "INVALID_PATH"],
      ["/etc/passwd", 400, "INVALID_PATH"],
      ["a\0b", 400, "INVALID_PATH"],
      ["dir", 400, "INVALID_PATH"],
      ["linked/file", 400, "INVALID_PATH"],
      ["file-link", 400, "INVALID_PATH"],
      ["missing", 404, "FILE_NOT_FOUND"],
      ["large", 413, "FILE_TOO_LARGE"],
      ["binary", 415, "UNSUPPORTED_FILE_TYPE"],
      ["", 400, "INVALID_PATH"],
    ] as const) {
      const response = await request(contentRoute(name));
      expect(response.status).toBe(status);
      const body = (await response.json()) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe(code);
      expect(typeof body.error.message).toBe("string");
    }
    expect(await (await request(contentRoute("%2e%2e/literal"))).text()).toBe(
      "literal percent path",
    );
    expect(
      (await request(`/v1/sessions/root/files/content?${binding}`)).status,
    ).toBe(400);
  });

  it("does not create storage for an empty selected session", async () => {
    const { request } = await setup();
    expect(
      await (await request(`/v1/sessions/root/files?${binding}`)).json(),
    ).toEqual({ ok: true, files: [] });
    await expect(fs.stat(path.join(home, "sessions"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["switch", "delete"])(
    "drops bytes when the selected root changes during a real read: %s",
    async (change) => {
      await put("file", "private bytes must not be delivered");
      const { request, removeRoot } = await setup();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
        const handle = await original(...args);
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(
          async (...readArgs: Parameters<typeof handle.read>) => {
            started();
            await gate;
            return read(...readArgs);
          },
        );
        return handle;
      });
      const pending = request(contentRoute("file"));
      try {
        await ready;
        if (change === "switch")
          expect(
            (await request("/v1/sessions/other/select", { method: "PATCH" }))
              .status,
          ).toBe(200);
        else removeRoot();
      } finally {
        release();
      }
      const response = await pending;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: {
          code:
            change === "switch"
              ? "SESSION_SCOPE_CHANGED"
              : "PERMISSION_SCOPE_CHANGED",
        },
      });
    },
  );

  it("reports unexpected filesystem failures as 500", async () => {
    await put("file", "safe");
    const { request } = await setup();
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error("disk denied"), { code: "EACCES" }),
    );
    const response = await request(`/v1/sessions/root/files?${binding}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "EACCES" },
    });
  });

  it("drops a file list if the client changes root during readdir", async () => {
    await put("file", "private");
    const { request } = await setup();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementationOnce(async (...args) => {
      started();
      await gate;
      return original(...args);
    });
    const pending = request(`/v1/sessions/root/files?${binding}`);
    try {
      await ready;
      expect(
        (await request("/v1/sessions/other/select", { method: "PATCH" }))
          .status,
      ).toBe(200);
    } finally {
      release();
    }
    const response = await pending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "SESSION_SCOPE_CHANGED" },
    });
  });

  it("reports unexpected content read failures as 500 without file bytes", async () => {
    await put("file", "private");
    const { request } = await setup();
    vi.spyOn(fs, "open").mockRejectedValueOnce(
      Object.assign(new Error("disk denied"), { code: "EACCES" }),
    );
    const response = await request(contentRoute("file"));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "EACCES" },
    });
  });
});

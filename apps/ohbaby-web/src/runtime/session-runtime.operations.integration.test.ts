import { afterEach, expect, it, vi } from "vitest";
import { fakeDaemon, session } from "./fake-daemon.test-support.js";
import { createOhbabyWebRuntime, type OhbabyWebRuntime } from "./index.js";

const runtimes: OhbabyWebRuntime[] = [];
function start(fetch: typeof globalThis.fetch): OhbabyWebRuntime {
  const runtime = createOhbabyWebRuntime(
    { baseUrl: "http://127.0.0.1:4096", clientId: "web", token: "token" },
    { fetch },
  );
  runtimes.push(runtime);
  return runtime;
}
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

it.each([false, true])(
  "moves a chat without replacing its idle/running connection (%s)",
  async (running) => {
    const daemon = fakeDaemon([session("chat", "/a", "/a")]);
    if (running) daemon.running.add("chat");
    const runtime = start(daemon.fetch);
    await runtime.ready;
    await runtime.openSession("chat");
    await vi.waitFor(() => {
      expect(runtime.store.getSnapshot().sessionSync.status).toBe("ready");
    });
    const client = runtime.client;
    const binding = runtime.store.getSnapshot().permissionSync.binding;
    const aborted = [...daemon.abortedStreams];
    await runtime.moveSession("chat", "/b");
    expect(runtime.catalog.getSnapshot().sessions[0]?.projectDirectory).toBe(
      "/b",
    );
    expect(runtime.client).toBe(client);
    expect(runtime.store.getSnapshot().permissionSync.binding).toEqual(binding);
    expect(daemon.abortedStreams).toEqual(aborted);
    expect(
      daemon.requests.find((request) => request.path.endsWith("/project"))
        ?.directory,
    ).toBeUndefined();
    if (!running) {
      await runtime.submitPrompt("next", { sessionId: "chat" });
      expect(runtime.getWorkspaceSnapshot().selectedDirectory).toBe("/b");
    }
  },
);

it("waits for a successful move and retains the working directory on removal", async () => {
  const daemon = fakeDaemon([session("chat", "/a", "/a")]);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = start(async (input, init) => {
    if (new URL(new Request(input, init).url).pathname.endsWith("/project"))
      await hold;
    return daemon.fetch(input, init);
  });
  await runtime.ready;
  daemon.failing.add("/v1/sessions/chat/project");
  const failed = runtime.moveSession("chat", "/b");
  expect(runtime.catalog.getSnapshot().sessions[0]?.projectDirectory).toBe(
    "/a",
  );
  release();
  await expect(failed).rejects.toThrow("unavailable");
  expect(runtime.catalog.getSnapshot().sessions[0]?.projectDirectory).toBe(
    "/a",
  );
  daemon.failing.clear();
  await runtime.moveSession("chat", null);
  expect(runtime.catalog.getSnapshot().sessions[0]).toMatchObject({
    projectDirectory: null,
    workingDirectory: "/a",
  });
});

it("hides cached rows after confirmation even when refresh fails, preserving the live chat", async () => {
  const daemon = fakeDaemon([session("chat", "/a", "/a")]);
  const runtime = start(daemon.fetch);
  await runtime.ready;
  await runtime.openSession("chat");
  const client = runtime.client;
  const aborted = [...daemon.abortedStreams];
  daemon.failing.add("/v1/scopes/hide");
  await expect(runtime.hideWorkspace("/a")).rejects.toThrow();
  expect(runtime.catalog.getSnapshot().sessions).toHaveLength(1);
  daemon.failing.delete("/v1/scopes/hide");
  daemon.failing.add("/v1/sessions");
  daemon.failing.add("/v1/scopes");
  await runtime.hideWorkspace("/a");
  expect(
    runtime.catalog
      .getSnapshot()
      .projects.some((project) => project.directory === "/a"),
  ).toBe(false);
  expect(runtime.catalog.getSnapshot().sessions).toHaveLength(0);
  expect(runtime.client).toBe(client);
  expect(daemon.abortedStreams).toEqual(aborted);
  expect(
    (await runtime.searchSessions({ query: "chat" })).results[0]?.session.id,
  ).toBe("chat");
});

it("forwards search pagination and cancellation through the directory-independent client", async () => {
  const daemon = fakeDaemon([session("old", "/a", "/a")]);
  let signal: AbortSignal | null | undefined;
  let searchUrl: URL | undefined;
  const runtime = start(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === "/v1/sessions/search") {
      signal = init?.signal;
      searchUrl = new URL(request.url);
    }
    return daemon.fetch(input, init);
  });
  await runtime.ready;
  const controller = new AbortController();
  const page = await runtime.searchSessions({
    query: "old",
    cursor: "cursor",
    limit: 5,
    signal: controller.signal,
  });
  expect(page.results[0]?.session.id).toBe("old");
  expect(signal).toBe(controller.signal);
  expect(searchUrl?.searchParams.get("cursor")).toBe("cursor");
  expect(searchUrl?.searchParams.get("limit")).toBe("5");
  expect(daemon.requests.at(-1)?.directory).toBeUndefined();
});

it("archives another chat in the current directory through an isolated client", async () => {
  const daemon = fakeDaemon([
    session("open", "/a", "/a"),
    session("other", "/a", "/a"),
  ]);
  const runtime = start(daemon.fetch);
  await runtime.ready;
  await runtime.openSession("open");
  await vi.waitFor(() => {
    expect(runtime.store.getSnapshot().sessionSync.status).toBe("ready");
  });
  const client = runtime.client;
  const currentClientId = daemon.requests.find(
    (request) => request.path === "/v1/events" && request.directory === "/a",
  )?.clientId;
  const binding = runtime.store.getSnapshot().permissionSync.binding;
  const aborted = [...daemon.abortedStreams];
  await runtime.archiveSession("other");
  expect(runtime.client).toBe(client);
  expect(runtime.store.getSnapshot().permissionSync.binding).toEqual(binding);
  expect(daemon.abortedStreams).toEqual(aborted);
  expect(
    daemon.requests.find((request) => request.path.endsWith("/other/archive"))
      ?.clientId,
  ).not.toBe(currentClientId);
});

it.each(["hide", "archive"] as const)(
  "does not append a Show more page read before a confirmed %s when refresh fails",
  async (operation) => {
    const daemon = fakeDaemon(
      Array.from({ length: 101 }, (_, index) =>
        session(`chat-${String(index)}`, "/a", "/a"),
      ),
    );
    const runtime = start(daemon.fetch);
    await runtime.ready;
    expect(runtime.catalog.getSnapshot().nextCursor).toBe("100");
    let release!: () => void;
    daemon.holdNextList = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loading = runtime.loadMoreSessions(() => false);
    await vi.waitFor(() => {
      expect(daemon.holdNextList).toBeNull();
    });
    const changing =
      operation === "hide"
        ? runtime.hideWorkspace("/a")
        : runtime.archiveSession("chat-100");
    await vi.waitFor(() => {
      if (operation === "hide")
        expect(runtime.catalog.getSnapshot().sessions).toHaveLength(0);
      else expect(daemon.sessions.get("chat-100")?.archived).toBe(true);
    });
    daemon.failing.add("/v1/sessions");
    release();
    await Promise.all([loading, changing]);
    await runtime.refreshCatalog();
    expect(
      runtime.catalog
        .getSnapshot()
        .sessions.some((row) => row.id === "chat-100"),
    ).toBe(false);
    expect(runtime.catalog.getSnapshot().nextCursor).toBe("100");
    expect(runtime.catalog.getSnapshot().loadingMore).toBe(false);
  },
);

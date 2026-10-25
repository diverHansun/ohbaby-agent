import { afterEach, expect, it, vi } from "vitest";
import { fakeDaemon, session } from "./fake-daemon.test-support.js";
import { createOhbabyWebRuntime, type OhbabyWebRuntime } from "./index.js";

const runtimes: OhbabyWebRuntime[] = [];

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: (): void => {
      values.clear();
    },
    getItem: (key): string | null => values.get(key) ?? null,
    key: (index): string | null => [...values.keys()][index] ?? null,
    get length(): number {
      return values.size;
    },
    removeItem: (key): void => {
      values.delete(key);
    },
    setItem: (key, value): void => {
      values.set(key, value);
    },
  };
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function start(fetchImpl: typeof fetch): OhbabyWebRuntime {
  const runtime = createOhbabyWebRuntime(
    { baseUrl: "http://127.0.0.1:4096", clientId: "web", token: "token" },
    { fetch: fetchImpl },
  );
  runtimes.push(runtime);
  return runtime;
}

async function selected(
  runtime: OhbabyWebRuntime,
  sessionId: string | null,
): Promise<void> {
  await vi.waitFor(() => {
    const snapshot = runtime.store.getSnapshot();
    expect(snapshot.permissionSync.binding?.rootSessionId).toBe(sessionId);
    if (sessionId) expect(snapshot.sessionSync.status).toBe("ready");
  });
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.unstubAllGlobals();
});

it("keeps the newer draft project when an earlier selection of the same project fails", async () => {
  const daemon = fakeDaemon();
  const entered = gate();
  const hold = gate();
  let failFirst = true;
  const runtime = start(async (input, init = {}) => {
    const request = new Request(input, init);
    if (
      new URL(request.url).pathname === "/v1/clients" &&
      decodeURIComponent(request.headers.get("x-ohbaby-directory") ?? "") ===
        "/b" &&
      failFirst
    ) {
      failFirst = false;
      entered.release();
      await hold.promise;
      return Response.json(
        { ok: false, error: { message: "Registration failed" } },
        { status: 500 },
      );
    }
    return daemon.fetch(input, init);
  });
  await runtime.ready;
  const first = runtime.openDraft("/b").catch((error: unknown) => error);
  await entered.promise;
  const second = runtime.openDraft("/b");
  hold.release();
  expect(await first).toBeInstanceOf(Error);
  await second;
  await selected(runtime, null);

  const receipt = await runtime.submitPrompt("send to the chosen project");
  expect(runtime.draft.getSnapshot().workspaceDirectory).toBe("/b");
  expect(runtime.getWorkspaceSnapshot().selectedDirectory).toBe("/b");
  expect(daemon.sessions.get(receipt.sessionId)?.workingDirectory).toBe("/b");
});

it("keeps a newer session selected when archiving the previous session finishes", async () => {
  const daemon = fakeDaemon([
    session("s1", "/a", "/a"),
    session("s2", "/b", "/b"),
  ]);
  const entered = gate();
  const hold = gate();
  const runtime = start(async (input, init = {}) => {
    const request = new Request(input, init);
    const response = await daemon.fetch(input, init);
    if (new URL(request.url).pathname === "/v1/sessions/s1/archive") {
      entered.release();
      await hold.promise;
    }
    return response;
  });
  await runtime.ready;
  await runtime.openSession("s1");
  await selected(runtime, "s1");
  const archive = runtime.archiveSession("s1");
  await entered.promise;
  try {
    await runtime.openSession("s2");
    await selected(runtime, "s2");
  } finally {
    hold.release();
  }
  await archive;

  expect(daemon.sessions.get("s1")?.archived).toBe(true);
  expect(
    runtime.store.getSnapshot().permissionSync.binding?.rootSessionId,
  ).toBe("s2");
  expect(runtime.getWorkspaceSnapshot().selectedDirectory).toBe("/b");
});

it.each(["accepted", "rejected", "unknown"] as const)(
  "keeps same-directory New chat independent when the old first prompt is %s",
  async (outcome) => {
    vi.stubGlobal("localStorage", memoryStorage());
    const daemon = fakeDaemon();
    const entered = gate();
    const hold = gate();
    let firstRequest = true;
    const runtime = start(async (input, init = {}) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/v1/prompts/receipt")
        return Response.json({
          ok: true,
          result: {
            runtimeEpoch: url.searchParams.get("runtimeEpoch"),
            bindingGeneration: Number(
              url.searchParams.get("bindingGeneration"),
            ),
            clientRequestId: url.searchParams.get("clientRequestId"),
          },
        });
      if (url.pathname === "/v1/prompts" && firstRequest) {
        firstRequest = false;
        entered.release();
        await hold.promise;
        if (outcome === "rejected")
          return Response.json(
            {
              ok: false,
              error: {
                code: "PROMPT_SUBMISSION_REJECTED",
                message: "Rejected",
              },
            },
            { status: 409 },
          );
        if (outcome === "unknown") throw new TypeError("Network disconnected");
      }
      return daemon.fetch(input, init);
    });
    await runtime.ready;
    await selected(runtime, null);
    const first = runtime
      .submitPrompt("late first prompt", { clientRequestId: "first" })
      .catch((error: unknown) => error);
    await entered.promise;
    try {
      await runtime.openDraft(null);
      await selected(runtime, null);
    } finally {
      hold.release();
    }
    const receipt = await first;

    if (outcome === "accepted")
      expect(receipt).toMatchObject({ sessionId: "created-1" });
    else expect(receipt).toBeInstanceOf(Error);
    expect(
      runtime.store.getSnapshot().permissionSync.binding?.rootSessionId,
    ).toBe(null);
    if (outcome === "unknown") {
      expect(runtime.store.getSnapshot().unknownPromptRequests).toMatchObject([
        { clientRequestId: "first", status: "unknown" },
      ]);
      await expect(
        runtime.submitPrompt("send from the new draft"),
      ).rejects.toThrow("unknown");
    } else {
      expect(runtime.store.getSnapshot().unknownPromptRequests).toEqual([]);
      const second = await runtime.submitPrompt("send from the new draft");
      expect(second.sessionId).toBe(
        outcome === "accepted" ? "created-2" : "created-1",
      );
    }
  },
);

// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { UiSessionHistory, UiSessionRecoveryClient } from "ohbaby-sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../dev/mock-runtime.js";
import {
  useSearchLocation,
  type SearchLocation,
} from "./use-search-location.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
beforeEach(() => {
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
});

function fixture() {
  const base = createMockRuntime("running");
  const view = base.store.getSnapshot().sessionSync.view;
  if (!view || !base.client) throw new Error("Missing running fixture");
  const sessionId = view.session.id;
  const getSessionHistory =
    vi.fn<UiSessionRecoveryClient["getSessionHistory"]>();
  const runtime = {
    ...base,
    client: { ...base.client, getSessionHistory },
  };
  const clear = vi.fn();
  const follow = vi.fn();
  let result!: ReturnType<typeof useSearchLocation>;
  function Host({ location }: { location: SearchLocation }) {
    const snapshot = useSyncExternalStore(
      (notify) => runtime.store.subscribe(notify),
      () => runtime.store.getSnapshot(),
    );
    result = useSearchLocation(
      runtime,
      location,
      snapshot,
      sessionId,
      follow,
      clear,
    );
    return null;
  }
  let ticket = 0;
  const select = async (messageId?: string) => {
    const location = { sessionId, messageId, selection: 0, ticket: ++ticket };
    await act(async () => {
      await Promise.resolve();
      root.render(<Host location={location} />);
    });
  };
  const page = (ids: string[], before?: string): UiSessionHistory => ({
    version: view.version,
    bindingGeneration: view.bindingGeneration,
    reasoningMissing: false,
    messages: ids.map((id) => ({
      id,
      role: "user",
      createdAt: view.session.createdAt,
      parts: [{ type: "text", text: id }],
    })),
    prompts: [],
    runs: [],
    hasMore: !!before,
    before,
  });
  return {
    view,
    runtime,
    select,
    getSessionHistory,
    page,
    clear,
    follow,
    get result() {
      return result;
    },
  };
}

it("repeats a loaded anchor without reading history, and follows recent chats to the end", async () => {
  const f = fixture();
  const id = f.view.session.messages[0].id;
  await f.select(id);
  expect(f.result.current?.status).toBe("ready");
  expect(f.result.current?.page).toBeUndefined();
  const first = f.result.current?.location.ticket ?? 0;
  await f.select(id);
  expect(f.result.current?.location.ticket).toBeGreaterThan(first);
  expect(f.getSessionHistory).not.toHaveBeenCalled();
  await f.select();
  expect(f.follow).toHaveBeenCalledOnce();
});

it("reads one bounded window, reuses it, prepends its own pages, and ignores unrelated queued inputs", async () => {
  const f = fixture();
  const prompt = {
    promptId: "p",
    clientRequestId: "p",
    sessionId: f.view.session.id,
    scopeKey: "root",
    userMessageId: "unrelated",
    text: "queued",
    status: "queued" as const,
    createdAt: f.view.session.createdAt,
    updatedAt: f.view.session.createdAt,
  };
  f.getSessionHistory
    .mockResolvedValueOnce({
      ...f.page(["old", "neighbor"], "before-old"),
      prompts: [prompt],
    })
    .mockResolvedValueOnce({
      ...f.page(["earlier"]),
      prompts: [
        prompt,
        { ...prompt, promptId: "p2", userMessageId: "earlier" },
      ],
    });
  await f.select("old");
  expect(f.getSessionHistory).toHaveBeenCalledTimes(1);
  expect(f.getSessionHistory).toHaveBeenCalledWith(
    expect.objectContaining({ anchorMessageId: "old", limit: 50 }),
  );
  expect(f.result.current?.page?.prompts).toEqual([]);
  await f.select("neighbor");
  expect(f.getSessionHistory).toHaveBeenCalledTimes(1);
  await act(async () => {
    expect(await f.result.loadEarlier()).toBe(true);
  });
  expect(f.getSessionHistory.mock.lastCall?.[0]).toMatchObject({
    before: "before-old",
    limit: 50,
  });
  expect(f.getSessionHistory.mock.lastCall?.[0]).not.toHaveProperty(
    "anchorMessageId",
  );
  expect(f.result.current?.page?.messages.map((m) => m.id)).toEqual([
    "earlier",
    "old",
    "neighbor",
  ]);
  expect(f.result.current?.page?.prompts.map((p) => p.promptId)).toEqual([
    "p2",
  ]);
  expect(
    f.runtime.store
      .getSnapshot()
      .view.snapshot?.sessions[0]?.messages.map((m) => m.id),
  ).not.toContain("old");
  act(() => {
    f.runtime.store.invalidateSessionHistory({
      type: "session.changed",
      version: {
        ...f.view.version,
        sessionRevision: f.view.version.sessionRevision + 1,
      },
      bindingGeneration: f.view.bindingGeneration,
      removedMessageIds: ["old"],
      historyInvalidated: true,
    });
  });
  expect(f.clear).toHaveBeenCalledOnce();
  expect(f.result.current).toBeUndefined();
  expect(f.runtime.store.getSnapshot().historyStale).toBe(false);
});

it("discards a late response after changing selection or binding", async () => {
  const f = fixture();
  let resolve!: (p: UiSessionHistory) => void;
  f.getSessionHistory.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.select("old");
  const obsolete = resolve;
  await f.select("new");
  await act(async () => {
    await Promise.resolve();
    obsolete(f.page(["old"]));
  });
  expect(f.result.current?.status).toBe("loading");
  const sync = f.runtime.store.getSnapshot().sessionSync;
  await act(async () => {
    await Promise.resolve();
    f.runtime.store.setSessionSync({
      ...sync,
      scope: {
        ...sync.scope,
        sessionId: f.view.session.id,
        bindingGeneration: 2,
      },
      view: { ...f.view, bindingGeneration: 2 },
    });
    resolve(f.page(["new"]));
  });
  expect(f.result.current).toBeUndefined();
  expect(f.clear).toHaveBeenCalledOnce();
});

it("retries a failed read and reports a removed message on an empty same-binding response", async () => {
  const f = fixture();
  f.getSessionHistory
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(f.page([]));
  await f.select("gone");
  expect(f.result.current).toMatchObject({ status: "error", error: "offline" });
  await act(async () => {
    await Promise.resolve();
    f.result.retry();
  });
  expect(f.result.current?.status).toBe("missing");
});

it("keeps the old window when dismissing or retrying an earlier-page error", async () => {
  const f = fixture();
  f.getSessionHistory
    .mockResolvedValueOnce(f.page(["old"], "before-old"))
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new Error("still offline"))
    .mockResolvedValueOnce(f.page(["earlier"]));
  await f.select("old");
  const window = f.result.current?.page;
  await act(async () => {
    expect(await f.result.loadEarlier()).toBe(false);
  });
  expect(f.result.current?.error).toBe("offline");
  act(() => {
    f.result.dismiss();
  });
  expect(f.result.current?.page).toBe(window);
  expect(f.result.current?.error).toBeUndefined();
  expect(f.clear).not.toHaveBeenCalled();
  await act(async () => {
    expect(await f.result.loadEarlier()).toBe(false);
  });
  await act(async () => {
    f.result.retry();
    await Promise.resolve();
  });
  expect(f.result.current?.page?.messages.map((m) => m.id)).toEqual([
    "earlier",
    "old",
  ]);
  expect(f.result.current?.error).toBeUndefined();
});

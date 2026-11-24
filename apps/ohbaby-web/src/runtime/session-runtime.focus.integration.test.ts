// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fakeDaemon, session } from "./fake-daemon.test-support.js";
import { CATALOG_POLL_INTERVAL_MS, createOhbabyWebRuntime } from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("refreshes the global list when the window regains focus or becomes visible", async () => {
  const daemon = fakeDaemon([session("s1", null, "/default")]);
  const runtime = createOhbabyWebRuntime(
    { baseUrl: "http://127.0.0.1:4096", clientId: "web", token: "token" },
    { fetch: daemon.fetch },
  );
  try {
    await runtime.ready;
    const lists = (): number =>
      daemon.requests.filter((request) => request.path === "/v1/sessions")
        .length;
    const before = lists();

    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => {
      expect(lists()).toBe(before + 1);
    });
    daemon.sessions.set(
      "s2",
      session("s2", "/a", "/a", "2026-10-03T00:00:00Z"),
    );
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(
        runtime.catalog.getSnapshot().sessions.map((value) => value.id),
      ).toContain("s2");
    });
  } finally {
    await runtime.dispose();
  }
});

it("re-reads the global list on a slow timer only while the page is visible", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const daemon = fakeDaemon([session("s1", null, "/default")]);
  const runtime = createOhbabyWebRuntime(
    { baseUrl: "http://127.0.0.1:4096", clientId: "web", token: "token" },
    { fetch: daemon.fetch },
  );
  let visibility: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
  try {
    await runtime.ready;
    const lists = (): number =>
      daemon.requests.filter((request) => request.path === "/v1/sessions")
        .length;
    await vi.waitFor(() => {
      expect(lists()).toBeGreaterThan(0);
    });
    const before = lists();

    vi.advanceTimersByTime(CATALOG_POLL_INTERVAL_MS);
    await vi.waitFor(() => {
      expect(lists()).toBe(before + 1);
    });
    visibility = "hidden";
    vi.advanceTimersByTime(CATALOG_POLL_INTERVAL_MS * 3);
    await Promise.resolve();
    expect(lists()).toBe(before + 1);
    await runtime.dispose();
    vi.advanceTimersByTime(CATALOG_POLL_INTERVAL_MS * 3);
    expect(lists()).toBe(before + 1);
  } finally {
    await runtime.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_HEALTH_TIMEOUT_MS, fetchDaemonHealth } from "./health.js";

describe("fetchDaemonHealth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns false when the health request times out", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = fetchDaemonHealth({
      authToken: "token",
      host: "127.0.0.1",
      packageVersion: "0.1.0",
      pid: 1,
      port: 4096,
      status: "running",
      updatedAt: Date.now(),
    });

    await vi.advanceTimersByTimeAsync(DAEMON_HEALTH_TIMEOUT_MS);
    await expect(result).resolves.toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getProxyConfigurationSnapshot,
  installSystemProxy,
  type SystemProxyInstallation,
} from "./index.js";
import { buildChildProxyEnvironment } from "./child-environment.js";
import type { SystemProxySettings } from "./system.js";
let installation: SystemProxyInstallation | undefined;
afterEach(async () => {
  await installation?.dispose();
  vi.useRealTimers();
});
describe("child configuration snapshots", () => {
  it("atomically replaces system facts on refresh, failure, recovery and disposal", async () => {
    vi.useFakeTimers();
    let settings: SystemProxySettings = {
      source: "system",
      httpProxy: "http://a:1",
      httpsProxy: "http://a:2",
    };
    let broken = false;
    const env = { NO_PROXY: "custom.test" };
    installation = await installSystemProxy({
      env,
      pollIntervalMs: 20,
      readSystem: () =>
        broken
          ? Promise.reject(new Error("credentials must stay private"))
          : Promise.resolve(settings),
    });
    const first = getProxyConfigurationSnapshot();
    expect(Object.isFrozen(first)).toBe(true);
    expect(buildChildProxyEnvironment(first).http_proxy).toBe("http://a:1/");
    env.NO_PROXY = "changed";
    settings = { source: "system", httpsProxy: "http://b:3" };
    await vi.advanceTimersByTimeAsync(20);
    const next = buildChildProxyEnvironment(getProxyConfigurationSnapshot());
    expect(next.http_proxy).toBeUndefined();
    expect(next.https_proxy).toBe("http://b:3/");
    expect(next.no_proxy).toContain("custom.test");
    expect(buildChildProxyEnvironment(first).http_proxy).toBe("http://a:1/");
    settings = { source: "system" };
    await vi.advanceTimersByTimeAsync(20);
    expect(
      buildChildProxyEnvironment(getProxyConfigurationSnapshot()).https_proxy,
    ).toBeUndefined();
    broken = true;
    await vi.advanceTimersByTimeAsync(20);
    expect(() =>
      buildChildProxyEnvironment(getProxyConfigurationSnapshot()),
    ).toThrow(/unavailable/);
    expect(JSON.stringify(getProxyConfigurationSnapshot())).not.toContain(
      "credentials",
    );
    broken = false;
    await vi.advanceTimersByTimeAsync(20);
    expect(getProxyConfigurationSnapshot().error).toBeUndefined();
    await installation.dispose();
    expect(getProxyConfigurationSnapshot().system).toBeUndefined();
  });
  it("keeps the previous completed snapshot during an in-flight read and copies system bypass", async () => {
    vi.useFakeTimers();
    const bypass = ["192.0.2.1"];
    let finish: ((value: SystemProxySettings) => void) | undefined;
    const readSystem = vi
      .fn()
      .mockResolvedValueOnce({
        source: "system",
        httpProxy: "http://a:1",
        bypass,
      })
      .mockImplementation(
        () =>
          new Promise<SystemProxySettings>((resolve) => {
            finish = resolve;
          }),
      );
    installation = await installSystemProxy({
      env: {},
      pollIntervalMs: 20,
      readSystem,
    });
    bypass.push("*.local");
    await vi.advanceTimersByTimeAsync(20);
    expect(
      buildChildProxyEnvironment(getProxyConfigurationSnapshot()).HTTP_PROXY,
    ).toBe("http://a:1/");
    finish?.({ source: "system", httpProxy: "http://b:2" });
    await vi.advanceTimersByTimeAsync(0);
    expect(
      buildChildProxyEnvironment(getProxyConfigurationSnapshot()).HTTP_PROXY,
    ).toBe("http://b:2/");
  });
});

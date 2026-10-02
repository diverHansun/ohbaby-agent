import { describe, expect, it, vi } from "vitest";
import { readSystemProxy, type SystemProxySettings } from "./system.js";

const mac = (body: string): string => `<dictionary> {\n${body}\n}`;
const read = (
  platform: NodeJS.Platform,
  output: string,
): Promise<SystemProxySettings> =>
  readSystemProxy({ platform, run: () => Promise.resolve(output) });
const windows = (values: Record<string, unknown> = {}): string =>
  JSON.stringify({
    proxy: null,
    bypass: null,
    autoConfigUrl: null,
    autoDetect: false,
    detectedUrl: null,
    detectionError: 0,
    ...values,
  });

describe("system proxy reader", () => {
  it("reads macOS protocol settings, CIDR and simple-host bypass", async () => {
    expect(
      await read(
        "darwin",
        mac(
          `HTTPEnable : 1\nHTTPProxy : ::1\nHTTPPort : 8080\nHTTPSEnable : 1\nHTTPSProxy : proxy.test\nHTTPSPort : 8081\nExcludeSimpleHostnames : 1\nExceptionsList : <array> {\n0 : *.example.test\n1 : 10.0.0.0/8\n}`,
        ),
      ),
    ).toEqual({
      source: "system",
      httpProxy: "http://[::1]:8080/",
      httpsProxy: "http://proxy.test:8081/",
      bypass: ["*.example.test", "10.0.0.0/8"],
      excludeSimpleHostnames: true,
    });
  });
  it("ignores disabled stale macOS proxy and PAC values", async () => {
    expect(
      await read(
        "darwin",
        mac(
          "HTTPEnable : 0\nHTTPProxy : stale\nProxyAutoConfigEnable : 0\nProxyAutoConfigURLString : https://secret.test/pac",
        ),
      ),
    ).toEqual({ source: "system" });
  });
  it.each(["ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable", "SOCKSEnable"])(
    "rejects enabled macOS %s",
    async (key) => {
      await expect(read("darwin", mac(`${key} : 1`))).rejects.toThrow(
        /not supported/,
      );
    },
  );
  it("allows enabled SOCKS when both HTTP protocols have static proxies", async () => {
    expect(
      await read(
        "darwin",
        mac(
          "HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7897\nHTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7897\nSOCKSEnable : 1",
        ),
      ),
    ).toMatchObject({
      httpProxy: "http://127.0.0.1:7897/",
      httpsProxy: "http://127.0.0.1:7897/",
    });
  });
  it("reads Windows protocol map and local bypass", async () => {
    expect(
      await read(
        "win32",
        windows({
          proxy: "http=[::1]:8080;https=proxy.test:8081",
          bypass: "<local>;*.test;10.0.0.0/8",
        }),
      ),
    ).toEqual({
      source: "system",
      httpProxy: "http://[::1]:8080/",
      httpsProxy: "http://proxy.test:8081/",
      bypass: ["*.test", "10.0.0.0/8"],
      excludeSimpleHostnames: true,
    });
  });
  it("uses a Windows single proxy for both protocols", async () => {
    expect(
      await read("win32", windows({ proxy: "proxy.test:8080" })),
    ).toMatchObject({
      httpProxy: "http://proxy.test:8080/",
      httpsProxy: "http://proxy.test:8080/",
    });
  });
  it("accepts checked autodetect when native discovery finds no PAC", async () => {
    expect(
      await read("win32", windows({ autoDetect: true, detectionError: 12180 })),
    ).toEqual({ source: "system" });
  });
  it.each([
    { autoConfigUrl: "https://private.test/pac" },
    { autoDetect: true, detectedUrl: "https://private.test/pac" },
  ])("rejects real Windows PAC without exposing its URL", async (config) => {
    await expect(read("win32", windows(config))).rejects.toThrow(
      "System PAC proxy is not supported",
    );
  });
  it("rejects discovery errors and incomplete results", async () => {
    for (const config of [
      { autoDetect: true, detectionError: 5 },
      { autoDetect: true },
    ]) {
      await expect(read("win32", windows(config))).rejects.toThrow(
        /discovery failed/,
      );
    }
  });
  it.each([
    "{}",
    "garbage",
    mac("HTTPEnable : 1\nHTTPProxy : secret@host\nHTTPPort : 8080"),
    mac("HTTPEnable : 1\nHTTPProxy : host\nHTTPPort : 99999"),
  ])("rejects malformed macOS settings safely", async (output) => {
    await expect(read("darwin", output)).rejects.toThrow(/System proxy/);
  });
  it.each(["null", "[]", "{}", "broken"])(
    "rejects invalid Windows JSON",
    async (output) => {
      await expect(read("win32", output)).rejects.toThrow(
        "System proxy settings are invalid",
      );
    },
  );
  it("accepts port 80 and rejects unsupported Windows protocols", async () => {
    expect(
      await read("win32", windows({ proxy: "proxy.test:80" })),
    ).toMatchObject({ httpProxy: "http://proxy.test/" });
    await expect(
      read("win32", windows({ proxy: "socks=localhost:1080" })),
    ).rejects.toThrow(/not supported/);
  });
  it("uses no-profile current-user native commands", async () => {
    const run = vi.fn((_file: string, _args: readonly string[]) =>
      Promise.resolve(windows()),
    );
    await readSystemProxy({ platform: "win32", run });
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining("WindowsPowerShell\\v1.0\\powershell.exe"),
      expect.arrayContaining(["-NoProfile", "-NonInteractive"]),
    );
    const script = run.mock.calls[0]?.[1]?.at(-1);
    expect(script).toContain("WinHttpGetIEProxyConfigForCurrentUser");
    expect(script).toContain("WinHttpDetectAutoProxyConfigUrl");
  });
  it("returns unavailable without commands on unsupported platforms", async () => {
    const run = vi.fn();
    expect(await readSystemProxy({ platform: "linux", run })).toEqual({
      source: "unavailable",
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("does not expose subprocess errors", async () => {
    await expect(
      readSystemProxy({
        platform: "darwin",
        run: () => Promise.reject(new Error("password=secret")),
      }),
    ).rejects.toThrow("System proxy settings could not be read");
  });
});

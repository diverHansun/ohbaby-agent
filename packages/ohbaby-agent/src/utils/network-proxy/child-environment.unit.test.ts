import { describe, expect, it } from "vitest";
import {
  buildChildProxyEnvironment,
  mergeChildProxyEnvironment,
} from "./child-environment.js";
import type { ProxyConfigurationSnapshot } from "./index.js";

const snapshot = (
  env: NodeJS.ProcessEnv = {},
  system: ProxyConfigurationSnapshot["system"] = {
    source: "system",
    httpProxy: "http://system:8080",
    httpsProxy: "http://system:8081",
  },
): ProxyConfigurationSnapshot => ({ env, system });
const loopback = "localhost,127.0.0.1,::1,127.0.0.0/8";

describe("child proxy environment", () => {
  it("resolves casing within a layer and applies overrides before ALL fallback", () => {
    expect(
      buildChildProxyEnvironment(
        snapshot({
          http_proxy: "http://base:1",
          HTTP_PROXY: "http://ignored:1",
          ALL_PROXY: "http://all:2",
        }),
        { HTTP_PROXY: "http://override:3" },
        "darwin",
      ),
    ).toEqual({
      HTTP_PROXY: "http://override:3/",
      http_proxy: "http://override:3/",
      HTTPS_PROXY: "http://all:2/",
      https_proxy: "http://all:2/",
      ALL_PROXY: "http://all:2/",
      all_proxy: "http://all:2/",
      NO_PROXY: loopback,
      no_proxy: loopback,
    });
  });
  it("uses the explicit protocol group without completing HTTPS from system", () => {
    const env = buildChildProxyEnvironment(snapshot(), {
      HTTP_PROXY: "http://override:3",
    });
    expect(env.HTTP_PROXY).toBe("http://override:3/");
    expect(env).not.toHaveProperty("HTTPS_PROXY");
  });
  it.each(["darwin", "linux", "win32"] as const)(
    "%s: blank overrides restore inheritance and leave ordinary empty strings intact",
    (platform) => {
      const env = mergeChildProxyEnvironment(
        { http_proxy: "http://stale:1", EMPTY: "x" },
        { HTTP_PROXY: "  ", EMPTY: "" },
        snapshot({ HTTP_PROXY: "http://base:2" }),
        platform,
      );
      expect(env.http_proxy).toBe(
        platform === "win32" ? undefined : "http://base:2/",
      );
      expect(env.HTTP_PROXY).toBe("http://base:2/");
      expect(env.EMPTY).toBe("");
    },
  );
  it("follows the system when only NO_PROXY is set and adds its native rule", () => {
    expect(
      buildChildProxyEnvironment(snapshot({ NO_PROXY: "custom.test" }))
        .NO_PROXY,
    ).toBe(`${loopback},custom.test`);
    expect(
      buildChildProxyEnvironment(snapshot({ NO_PROXY: "custom.test" }))
        .HTTPS_PROXY,
    ).toBe("http://system:8081/");
  });
  it.each(["darwin", "linux", "win32"] as const)(
    "%s: all bypass ignores failed discovery and removes every old proxy alias",
    (platform) => {
      const env = mergeChildProxyEnvironment(
        { HTTP_PROXY: "http://stale:1", https_proxy: "http://stale:2" },
        { NO_PROXY: "*" },
        { env: {}, error: "System PAC proxy is not supported" },
        platform,
      );
      expect(env).toEqual(
        platform === "win32"
          ? { NO_PROXY: "*" }
          : { NO_PROXY: "*", no_proxy: "*" },
      );
    },
  );
  it("allows complete explicit proxy overrides despite a failed system read", () => {
    expect(
      buildChildProxyEnvironment(
        { env: {}, error: "System PAC proxy is not supported" },
        { HTTPS_PROXY: "http://explicit:3" },
      ).HTTPS_PROXY,
    ).toBe("http://explicit:3/");
    expect(() =>
      buildChildProxyEnvironment({
        env: {},
        error: "System PAC proxy is not supported",
      }),
    ).toThrow(/PAC/);
  });
  it.each([
    "example.com",
    ".example.com",
    "*.local",
    "foo*bar.test",
    "host:80",
    "<local>",
    "::1/128",
  ])(
    "rejects non-equivalent system bypass %s even with ordinary NO_PROXY",
    (rule) => {
      expect(() =>
        buildChildProxyEnvironment(
          snapshot(
            { NO_PROXY: "custom.test" },
            { source: "system", httpProxy: "http://system:1", bypass: [rule] },
          ),
        ),
      ).toThrow(/HTTP_PROXY.*HTTPS_PROXY.*NO_PROXY=\*/);
    },
  );
  it("does not evaluate unused bypass when system has no proxy or bypasses everything", () => {
    expect(
      buildChildProxyEnvironment(
        snapshot(
          {},
          {
            source: "system",
            bypass: ["*.local"],
            excludeSimpleHostnames: true,
          },
        ),
      ).HTTP_PROXY,
    ).toBeUndefined();
    expect(
      buildChildProxyEnvironment(
        snapshot(
          {},
          { source: "system", httpProxy: "invalid", bypass: ["*", "*.local"] },
        ),
      ).NO_PROXY,
    ).toBe("*");
  });
  it("normalizes shortened CIDR and literal IPs while deduplicating loopback", () => {
    expect(
      buildChildProxyEnvironment(
        snapshot(
          {},
          {
            source: "system",
            httpProxy: "http://system:1",
            bypass: [
              "169.254/16",
              "10.23.45.67/8",
              "192.0.2.3",
              "[2001:db8::1]",
              "localhost",
              "127.9.8.7",
              "::1",
            ],
          },
        ),
      ).NO_PROXY,
    ).toBe(`${loopback},169.254.0.0/16,10.0.0.0/8,192.0.2.3,2001:db8::1`);
  });
  it.each(["::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1"])(
    "preserves both curl spellings of mapped IPv6 loopback bypass %s",
    (rule) => {
      const env = buildChildProxyEnvironment(
        snapshot(
          {},
          { source: "system", httpProxy: "http://system:1", bypass: [rule] },
        ),
      );
      expect(env.NO_PROXY).toBe(`${loopback},::ffff:127.0.0.1,::ffff:7f00:1`);
    },
  );
  it("preserves both curl spellings of mapped nonloopback system IP literals", () => {
    const env = buildChildProxyEnvironment(
      snapshot(
        {},
        {
          source: "system",
          httpProxy: "http://system:1",
          bypass: ["::ffff:192.0.2.1"],
        },
      ),
    );
    expect(env.NO_PROXY).toBe(`${loopback},::ffff:192.0.2.1,::ffff:c000:201`);
  });
  it("preserves native external client schemes but validates supported proxy URLs without exposing credentials", () => {
    expect(
      buildChildProxyEnvironment(
        snapshot({ ALL_PROXY: "socks5h://user:pass@proxy:1080" }),
      ).ALL_PROXY,
    ).toBe("socks5h://user:pass@proxy:1080");
    expect(() =>
      buildChildProxyEnvironment(
        snapshot({ HTTP_PROXY: "http://user:secret@proxy:80/path" }),
      ),
    ).toThrow(/no path/);
    try {
      buildChildProxyEnvironment(
        snapshot({ HTTP_PROXY: "http://user:secret@proxy:80/path" }),
      );
    } catch (error) {
      expect(String(error)).not.toMatch(/secret|user|proxy:80/);
    }
  });
  it("rejects unsupported system endpoint protocols without truncating explicit native protocols", () => {
    expect(() =>
      buildChildProxyEnvironment(
        snapshot({}, { source: "system", httpProxy: "socks5://proxy:1080" }),
      ),
    ).toThrow(/HTTP or HTTPS/);
  });
  it("reads mixed-case Windows override variables before stripping aliases", () => {
    const env = mergeChildProxyEnvironment(
      {},
      { Http_Proxy: "http://override:4", No_Proxy: "custom.test" },
      snapshot(),
      "win32",
    );
    expect(env.HTTP_PROXY).toBe("http://override:4/");
    expect(env.NO_PROXY).toContain("custom.test");
    expect(env.HTTPS_PROXY).toBeUndefined();
  });
  it("Windows removes mixed case aliases and emits one key per logical variable", () => {
    expect(
      mergeChildProxyEnvironment(
        {
          Http_Proxy: "http://old:1",
          hTTps_pROxy: "http://old:2",
          PATH: "safe",
        },
        { HTTP_PROXY: "http://new:3" },
        snapshot(),
        "win32",
      ),
    ).toEqual({
      PATH: "safe",
      HTTP_PROXY: "http://new:3/",
      NO_PROXY: loopback,
    });
  });
});

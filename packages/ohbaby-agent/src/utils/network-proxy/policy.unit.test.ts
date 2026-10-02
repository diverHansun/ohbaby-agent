import { describe, expect, it } from "vitest";
import { createProxyPolicy } from "./policy.js";

const system = {
  source: "system" as const,
  httpProxy: "http://proxy.test:8080",
  httpsProxy: "http://secure.test:8081",
};
describe("shared network routing policy", () => {
  it("follows protocol-specific system settings without environment mutation", () => {
    const env = {};
    const policy = createProxyPolicy(env, system);
    expect(policy.route(new URL("http://api.test"))).toBe(
      system.httpProxy + "/",
    );
    expect(policy.route(new URL("https://api.test"))).toBe(
      system.httpsProxy + "/",
    );
    expect(env).toEqual({});
    expect(policy.status).toContain("system");
  });
  it("uses env as a complete override, including lowercase precedence and ALL_PROXY fallback", () => {
    const policy = createProxyPolicy(
      {
        https_proxy: "http://lower:8000",
        HTTPS_PROXY: "http://upper:8000",
        ALL_PROXY: "http://all:8000",
      },
      system,
    );
    expect(policy.route(new URL("https://api.test"))).toBe(
      "http://lower:8000/",
    );
    expect(policy.route(new URL("http://api.test"))).toBe("http://all:8000/");
    expect(policy.status).toContain("environment");
    expect(
      createProxyPolicy({ HTTPS_PROXY: "http://env:8000" }, system).route(
        new URL("http://api.test"),
      ),
    ).toBeUndefined();
  });
  it("NO_PROXY alone augments OS bypass instead of disabling the OS proxy", () => {
    const policy = createProxyPolicy(
      { NO_PROXY: "inside.test:443,.inside.test:443" },
      { ...system, bypass: ["10.0.0.0/8", "*.local", "<local>", "[fd00::]/8"] },
    );
    for (const url of [
      "https://inside.test",
      "https://a.inside.test",
      "http://10.2.3.4",
      "http://printer",
      "http://printer.local",
      "http://[fd00::1]",
    ])
      expect(policy.route(new URL(url))).toBeUndefined();
    expect(policy.route(new URL("https://api.test"))).toBe(
      system.httpsProxy + "/",
    );
    expect(policy.route(new URL("https://inside.test:8443"))).toBe(
      system.httpsProxy + "/",
    );
  });
  it("always bypasses loopback including IPv4 mapped IPv6", () => {
    const policy = createProxyPolicy({}, system);
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.4.5.6",
      "[::1]",
      "[::ffff:127.0.0.1]",
    ])
      expect(policy.route(new URL(`http://${host}`))).toBeUndefined();
  });
  it("accepts abbreviated system IPv4 networks without broadening environment syntax", () => {
    const policy = createProxyPolicy({}, { ...system, bypass: ["169.254/16"] });
    expect(policy.route(new URL("https://169.254.10.2"))).toBeUndefined();
    expect(policy.route(new URL("https://169.253.10.2"))).toBeDefined();
    expect(() => createProxyPolicy({ NO_PROXY: "169.254/16" }, system)).toThrow(
      /bypass/,
    );
  });
  it("supports star bypass and prevents proxying the proxy endpoint twice", () => {
    expect(
      createProxyPolicy({ NO_PROXY: "*" }, system).route(
        new URL("https://api.test"),
      ),
    ).toBeUndefined();
    expect(
      createProxyPolicy({}, system).route(new URL(system.httpProxy)),
    ).toBeUndefined();
  });
  it("does not broaden exact bypass hosts to subdomains", () => {
    const policy = createProxyPolicy(
      { NO_PROXY: "exact.test,.suffix.test" },
      system,
    );
    expect(policy.route(new URL("https://exact.test"))).toBeUndefined();
    expect(policy.route(new URL("https://sub.exact.test"))).toBeDefined();
    expect(policy.route(new URL("https://sub.suffix.test"))).toBeUndefined();
    expect(policy.route(new URL("https://suffix.test"))).toBeDefined();
  });
  it.each(["10.0.0.0/8/ignored", "example.test:bad", "example.test:99999"])(
    "rejects malformed bypass %s",
    (rule) => {
      expect(() => createProxyPolicy({ NO_PROXY: rule }, system)).toThrow(
        /bypass/,
      );
    },
  );
  it("rejects unsupported/invalid explicit proxies without leaking credentials", () => {
    for (const proxy of [
      "socks5://user:secret@host:1080",
      "garbage",
      "https://secret@host/path",
    ]) {
      expect(() => createProxyPolicy({ HTTPS_PROXY: proxy }, system)).toThrow(
        "Proxy URL must use HTTP or HTTPS with no path, query or fragment",
      );
    }
  });
});

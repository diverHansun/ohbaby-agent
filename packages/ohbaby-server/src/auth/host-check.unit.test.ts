import { describe, expect, it } from "vitest";
import { isAllowedDaemonHost, isAllowedTerminalOrigin } from "./host-check.js";

describe("loopback request authority", () => {
  it.each([
    "localhost",
    "LOCALHOST:5173",
    "127.0.0.1:9999",
    "[::1]:80",
    "127.0.0.2:42",
  ])("allows local hostname %s independently of port", (host) => {
    expect(isAllowedDaemonHost(host, "127.0.0.2")).toBe(true);
  });
  it.each([
    undefined,
    "",
    "evil.example",
    "localhost.evil",
    "localhost@evil",
    "evil@localhost",
    "localhost/path",
    "localhost:bad",
    "127.1",
    "2130706433",
    "127.0.0.3",
    "[::1]evil",
    "localhost,evil",
  ])("rejects untrusted or malformed host %s", (host) => {
    expect(isAllowedDaemonHost(host, "127.0.0.2")).toBe(false);
  });
  it("does not restrict host on public bind", () => {
    expect(isAllowedDaemonHost("public.example", "0.0.0.0")).toBe(true);
  });
  it.each([
    undefined,
    "http://localhost:5173",
    "https://127.0.0.1:8000",
    "http://[::1]",
  ])("accepts local origin %s", (origin) => {
    expect(isAllowedTerminalOrigin(origin, "127.0.0.1")).toBe(true);
  });
  it.each([
    "",
    "null",
    "bad",
    "https://evil.example",
    "http://localhost.evil",
    "file://localhost",
    "http://user@localhost",
    "http://localhost/path",
    "http://127.1",
  ])("rejects remote or malformed origin %s", (origin) => {
    expect(isAllowedTerminalOrigin(origin, "127.0.0.1")).toBe(false);
  });
});

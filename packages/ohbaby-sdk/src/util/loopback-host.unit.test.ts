import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./loopback-host.js";

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.255.255.255", "::1", "[::1]"])(
    "accepts the loopback IP literal %s",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each([
    "localhost",
    "127.example",
    "127.0.0.1.example",
    "127.01.0.1",
    "127.0.0.01",
    "0.0.0.0",
    "::ffff:127.0.0.1",
  ])("rejects a host that is not a loopback IP literal: %s", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

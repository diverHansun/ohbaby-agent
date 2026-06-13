import { describe, expect, it } from "vitest";
import {
  createDaemonAuthToken,
  daemonAuthHeader,
  isAuthorizedDaemonRequest,
  redactDaemonAuthToken,
} from "./auth.js";

describe("daemon auth", () => {
  it("creates a non-empty local bearer token", () => {
    expect(createDaemonAuthToken()).toMatch(/^ohbaby_[a-f0-9-]{36}$/);
  });

  it("formats bearer auth headers", () => {
    expect(daemonAuthHeader("token_1")).toBe("Bearer token_1");
  });

  it("accepts only the configured daemon token", () => {
    expect(isAuthorizedDaemonRequest("Bearer token_1", "token_1")).toBe(true);
    expect(isAuthorizedDaemonRequest("Bearer token_2", "token_1")).toBe(false);
    expect(isAuthorizedDaemonRequest(undefined, "token_1")).toBe(false);
  });

  it("allows unauthenticated requests when no daemon token is configured", () => {
    expect(isAuthorizedDaemonRequest(undefined, undefined)).toBe(true);
  });

  it("redacts tokens before logging", () => {
    expect(redactDaemonAuthToken("ohbaby_1234567890")).toBe("ohbaby_...");
    expect(redactDaemonAuthToken("plain-token")).toBe("...");
  });
});

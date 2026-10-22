import { describe, expect, it } from "vitest";
import { sanitizeCommandMcpServerSummary } from "./normalize.js";

describe("MCP command diagnostics", () => {
  it("keeps valid errors and tool counts while accepting old summaries", () => {
    expect(
      sanitizeCommandMcpServerSummary({
        name: "bad",
        status: "failed",
        error: "connection refused",
      }),
    ).toEqual({ name: "bad", status: "failed", error: "connection refused" });
    expect(
      sanitizeCommandMcpServerSummary({
        name: "ok",
        status: "connected",
        toolCount: 0,
      }),
    ).toEqual({ name: "ok", status: "connected", toolCount: 0 });
    expect(
      sanitizeCommandMcpServerSummary({ name: "old", status: "disabled" }),
    ).toEqual({ name: "old", status: "disabled" });
    expect(
      sanitizeCommandMcpServerSummary({
        name: "wrong",
        status: "connected",
        toolCount: -1,
        error: 1,
      }),
    ).toEqual({ name: "wrong", status: "connected" });
  });
});

import { describe, expect, it } from "vitest";
import { projectToolResultDetails } from "./tool-result-details.js";

describe("built-in tool details whitelist", () => {
  it("ignores legacy results, foreign sources and metadata kind claims", () => {
    expect(
      projectToolResultDetails(
        "write",
        { diff: "fake", kind: "mutation" },
        "completed",
      ),
    ).toBeUndefined();
    expect(
      projectToolResultDetails(
        "write",
        { uiToolSource: "mcp", diff: "fake" },
        "completed",
      ),
    ).toBeUndefined();
    expect(
      projectToolResultDetails(
        "custom",
        { uiToolSource: "builtin", kind: "bash", exitCode: 0 },
        "success",
      ),
    ).toBeUndefined();
  });
  it("preserves known zero and partial search facts without leaking raw metadata", () => {
    expect(
      projectToolResultDetails(
        "grep",
        {
          uiToolSource: "builtin",
          count: 4,
          matchCount: 0,
          scanComplete: false,
          displayLimited: true,
          secret: "hidden",
        },
        "success",
      ),
    ).toEqual({
      kind: "search",
      unit: "matches",
      count: 0,
      scanComplete: false,
      displayLimited: true,
    });
  });
  it("rejects invalid ranges and types", () => {
    expect(
      projectToolResultDetails(
        "read",
        {
          uiToolSource: "builtin",
          startLine: -2,
          shownLineCount: NaN,
          hasMore: "false",
        },
        "completed",
      ),
    ).toEqual({
      kind: "read",
      startLine: undefined,
      shownLineCount: undefined,
      hasMore: undefined,
    });
  });
  it("keeps started shell jobs distinct from terminal completion", () => {
    expect(
      projectToolResultDetails(
        "bash",
        {
          uiToolSource: "builtin",
          status: "running",
          jobId: "j",
          exitCode: null,
          truncated: true,
        },
        "success",
      ),
    ).toEqual({
      kind: "bash",
      status: "running",
      jobId: "j",
      exitCode: undefined,
      outputTruncated: true,
    });
  });
  it("does not show a failed mutation's preview as a committed change", () => {
    expect(
      projectToolResultDetails(
        "write",
        { uiToolSource: "builtin", diff: "+fake", diffOmitted: false },
        "error",
      ),
    ).toBeUndefined();
  });
  it("preserves dry runs and honest omission facts", () => {
    expect(
      projectToolResultDetails(
        "write",
        {
          uiToolSource: "builtin",
          diffOmitted: true,
          diffOmissionReason: "binary",
          created: false,
          dryRun: true,
        },
        "success",
      ),
    ).toEqual({
      kind: "mutation",
      diff: undefined,
      diffOmissionReason: "binary",
      created: false,
      dryRun: true,
    });
  });
});

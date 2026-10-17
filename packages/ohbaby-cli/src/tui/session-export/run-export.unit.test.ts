import { describe, expect, it, vi } from "vitest";
import {
  describeExportError,
  EXPORT_USAGE,
  parseExportFormat,
  runSessionExport,
} from "./run-export.js";

describe("session export", () => {
  it.each([
    [[], "html"],
    [["html"], "html"],
    [["jsonl"], "jsonl"],
    [["foo"], undefined],
    [["html", "extra"], undefined],
  ] as const)("parses %j", (argv, expected) => {
    expect(parseExportFormat(argv)).toBe(expected);
  });

  it.each([
    new Error("Unsupported daemon rpc method: exportSession"),
    Object.assign(new Error("Not Found"), { status: 404 }),
    new Error("Session storage is not available"),
  ])("recognizes unsupported backend: %s", (error) => {
    expect(describeExportError(error)).toBe(
      "Export is not supported by this backend.",
    );
  });

  it.each([
    ["SESSION_NOT_FOUND", "Session not found."],
    ["SUBAGENT_SESSION", "Subagent sessions cannot be exported."],
    ["EMPTY_SESSION", "Nothing to export in this session yet."],
    ["INVALID_FORMAT", EXPORT_USAGE],
  ])(
    "maps %s without confusing coded 404 with missing routes",
    (code, expected) => {
      expect(
        describeExportError(
          Object.assign(new Error("backend detail"), { code, status: 404 }),
        ),
      ).toBe(expected);
    },
  );

  it("preserves real failures", () => {
    expect(
      describeExportError(
        Object.assign(new Error("Disk full"), { code: "ENOSPC" }),
      ),
    ).toBe("Disk full");
    expect(
      describeExportError(
        Object.assign(new Error("unrelated missing resource"), {
          code: "OTHER",
          status: 404,
        }),
      ),
    ).toBe("unrelated missing resource");
  });

  it("only saves the backend response locally after a successful export", async () => {
    const client = {
      exportSession: vi.fn().mockResolvedValue({
        filename: "fixture.jsonl",
        content: "完整",
        mimeType: "application/x-ndjson",
        messageCount: 2,
      }),
    };
    const save = vi.fn().mockResolvedValue("/local/Downloads/fixture.jsonl");
    await expect(
      runSessionExport({
        client,
        sessionId: "session_fixture",
        format: "jsonl",
        directory: "/local/Downloads",
        save,
      }),
    ).resolves.toEqual({
      path: "/local/Downloads/fixture.jsonl",
      messageCount: 2,
    });
    expect(client.exportSession).toHaveBeenCalledWith({
      sessionId: "session_fixture",
      format: "jsonl",
    });
    expect(save).toHaveBeenCalledWith({
      directory: "/local/Downloads",
      filename: "fixture.jsonl",
      content: "完整",
    });
    client.exportSession.mockRejectedValue(new Error("not available"));
    save.mockClear();
    await expect(
      runSessionExport({
        client,
        sessionId: "session_fixture",
        format: "html",
        save,
      }),
    ).rejects.toThrow("not available");
    expect(save).not.toHaveBeenCalled();
  });
});

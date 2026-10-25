import { describe, expect, it } from "vitest";
import { exportSession } from "./index.js";
import type {
  ExportDependencies,
  ExportInput,
  ExportDocument,
  ExportHeader,
  ExportMessage,
} from "./types.js";
const now = new Date(2026, 9, 17, 15, 30, 12);
function deps(id = "session_1760000000000_k3x9ab1"): ExportDependencies {
  return {
    appVersion: "1.2.3",
    now: () => now,
    sessionManager: {
      get: () =>
        Promise.resolve({
          id,
          title: "中文 👋",
          projectId: "p",
          workingDirectory: "/repo",
          agentName: "build",
          status: "active",
          createdAt: 1,
          updatedAt: 2,
          stats: { messageCount: 1 },
          isSubagent: false,
          childrenIds: [],
        }),
    },
    messageManager: {
      listBySession: () =>
        Promise.resolve([
          {
            info: {
              id: "m",
              sessionId: id,
              role: "user",
              agent: "build",
              time: { created: 1 },
              system: "__HIDDEN_PROMPT__",
            },
            parts: [
              {
                type: "text",
                text: "你好 </script> $& $$ 👋",
                id: "p",
                messageId: "m",
                sessionId: id,
                orderIndex: 0,
              },
            ],
          },
        ]),
    },
  };
}
describe("exportSession", () => {
  it("uses one content contract for JSONL and HTML without exposing internal fields", async () => {
    const jsonl = await exportSession(deps(), {
      sessionId: "session",
      format: "jsonl",
    });
    const html = await exportSession(deps(), {
      sessionId: "session",
      format: "html",
    });
    const lines = jsonl.content
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as ExportHeader | ExportMessage) as [
      ExportHeader,
      ...ExportMessage[],
    ];
    const encoded = /<script[^>]*id="session-data"[^>]*>([^<]*)<\/script>/.exec(
      html.content,
    )?.[1];
    if (encoded === undefined) throw new Error("Missing HTML payload");
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as ExportDocument;
    expect(decoded).toEqual({ header: lines[0], messages: lines.slice(1) });
    expect(lines[0]).toMatchObject({
      type: "session",
      format: "ohbaby.session-export",
      version: 1,
      app: { name: "ohbaby", version: "1.2.3" },
      stats: { messageCount: 1 },
    });
    expect(lines[1].parts[0]).toMatchObject({
      type: "text",
      text: "你好 </script> $& $$ 👋",
    });
    expect(jsonl.content.endsWith("\n")).toBe(true);
    expect(jsonl.content).not.toContain("__HIDDEN_PROMPT__");
    expect(JSON.stringify(decoded)).not.toContain("__HIDDEN_PROMPT__");
    expect(jsonl.content).not.toContain(":null");
    expect(jsonl).toMatchObject({
      filename: "ohbaby-20261017-153012-k3x9ab1.jsonl",
      mimeType: "application/x-ndjson; charset=utf-8",
      messageCount: 1,
    });
    expect(html).toMatchObject({
      filename: "ohbaby-20261017-153012-k3x9ab1.html",
      mimeType: "text/html; charset=utf-8",
    });
  });
  it.each([
    ["prefix_a/b\\c?", "abc"],
    ["no_!!!", "session"],
    ["abcdefghijk", "defghijk"],
  ])("sanitizes the filename for %s", async (id, suffix) => {
    const result = await exportSession(deps(id), {
      sessionId: id,
      format: "jsonl",
    });
    expect(result.filename).toBe(`ohbaby-20261017-153012-${suffix}.jsonl`);
  });
  it.each([{}, { sessionId: "s", format: "xml" }])(
    "rejects malformed format (%s)",
    async (input) => {
      await expect(
        exportSession(deps(), input as unknown as ExportInput),
      ).rejects.toMatchObject({ code: "INVALID_FORMAT" });
    },
  );
  it.each([undefined, null, [], "html"])(
    "rejects non-object input (%s)",
    async (input) => {
      await expect(
        exportSession(deps(), input as unknown as ExportInput),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    },
  );
  it.each(["", " ", null, 1])(
    "rejects invalid session IDs (%s)",
    async (sessionId) => {
      await expect(
        exportSession(deps(), { format: "jsonl", sessionId } as ExportInput),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    },
  );
});

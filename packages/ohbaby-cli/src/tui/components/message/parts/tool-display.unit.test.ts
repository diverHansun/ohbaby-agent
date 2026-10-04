import { describe, expect, it } from "vitest";
import type { UiToolCall, UiToolResult } from "ohbaby-sdk";
import { createTheme } from "../../../theme/index.js";
import { visibleWidth } from "../../../render/wrap.js";
import { renderToolDisplay } from "./tool-display.js";

const theme = createTheme("dark", 3);
function display(
  name: string,
  input: Record<string, unknown>,
  result: Partial<UiToolResult>,
  expanded = false,
  width = 60,
) {
  const call: UiToolCall = { id: "call", name, input, status: "completed" };
  return renderToolDisplay(
    call,
    { callId: "call", output: "", ...result },
    width,
    expanded,
    theme,
  );
}
const text = (rows: ReturnType<typeof display>) =>
  rows.map((row) => row.text).join("\n");
describe("saved tool facts presentation", () => {
  it("keeps Bash tail and expands all stored rows with a separate error and exit code", () => {
    const result = {
      output: Array.from({ length: 12 }, (_, i) => `line ${String(i)}`).join(
        "\n",
      ),
      error: "failure reason",
      details: { kind: "bash" as const, exitCode: 1 },
    };
    const compact = text(display("bash", { command: "test" }, result));
    expect(compact).toContain("7 lines omitted");
    expect(compact).not.toContain("line 0");
    expect(compact).toContain("line 11");
    expect(compact).toContain("failure reason");
    expect(compact).toContain("exit 1");
    const full = text(display("bash", { command: "test" }, result, true));
    expect(full).toContain("line 0");
    expect(full).not.toContain("omitted");
  });
  it("uses read/search summary and expands only saved output", () => {
    const result = {
      output: "saved body",
      details: { kind: "read" as const, startLine: 4, shownLineCount: 8 },
    };
    expect(text(display("read", { file_path: "src/app.ts" }, result))).toBe(
      "Read src/app.ts · 4–11",
    );
    expect(
      text(display("read", { file_path: "src/app.ts" }, result, true)),
    ).toContain("saved body");
    expect(
      text(
        display(
          "grep",
          { pattern: "needle", path: "src" },
          {
            output: "hits",
            details: { kind: "search", count: 3, unit: "matches" },
          },
        ),
      ),
    ).toContain("needle src · 3 matches");
  });
  it("shows new file source only when created fact and success confirm it", () => {
    const input = {
      file_path: "new.ts",
      content: Array.from({ length: 15 }, (_, i) => `source ${String(i)}`).join(
        "\n",
      ),
    };
    expect(
      text(
        display("write", input, {
          output: "saved",
          details: {
            kind: "mutation",
            created: true,
            diff: "--- new.ts\n+++ new.ts\n@@ -0,0 +1,1 @@\n+source 0",
          },
        }),
      ),
    ).toContain("5 lines omitted");
    expect(
      text(display("write", input, { output: "legacy saved" })),
    ).not.toContain("source 0");
    expect(
      text(
        display("write", input, {
          output: "preview",
          details: { kind: "mutation", created: true, dryRun: true },
        }),
      ),
    ).toContain("Dry run");
    expect(
      text(
        display("write", input, {
          output: "preview",
          details: { kind: "mutation", created: true, dryRun: true },
        }),
      ),
    ).not.toContain("source 0");
  });
  it("renders true diff numbers and preserves hunk ranges only in expanded output", () => {
    const result = {
      output: "saved",
      details: {
        kind: "mutation" as const,
        diff: "--- a\n+++ a\n@@ -8,3 +8,3 @@\n before\n-old\n+new\n after",
      },
    };
    const compact = text(display("edit", { file_path: "a" }, result));
    expect(compact).toContain("-   9 old");
    expect(compact).toContain("+   9 new");
    expect(compact).not.toContain("@@");
    expect(text(display("edit", { file_path: "a" }, result, true))).toContain(
      "@@ -8,3 +8,3 @@",
    );
  });
  it.each([1, 2, 8, 20, 60])(
    "bounds wide/tab/ANSI rows at width %i without executing terminal commands",
    (width) => {
      const rows = display(
        "bash",
        { command: "界界\tbad\u001b[2J" },
        {
          output:
            "\u001b[31m界界\toutput\u001b[0m\nnext\u001b]52;c;secret\u0007\nend\u001b[H",
        },
        true,
        width,
      );
      expect(text(rows)).not.toContain("52;");
      expect(text(rows)).not.toContain("[2J");
      for (const row of rows)
        expect(visibleWidth(row.text)).toBeLessThanOrEqual(width);
    },
  );
  it("does not promise an empty result or background completion", () => {
    expect(text(display("bash", {}, { outputAvailable: false }))).toContain(
      "Output unavailable",
    );
    expect(
      text(
        display(
          "bash",
          {},
          { details: { kind: "bash", status: "running", jobId: "job" } },
        ),
      ),
    ).toContain("Started in background");
  });
});

it("labels incomplete saved scans and zero-line read pages without claiming complete totals", () => {
  const result = {
    details: {
      kind: "search" as const,
      unit: "files" as const,
      count: 2,
      scanComplete: false,
      displayLimited: true,
    },
    output: "saved files",
  };
  for (const expanded of [false, true]) {
    const rendered = text(
      display("glob", { pattern: "**/*.ts" }, result, expanded),
    );
    expect(rendered).toContain("2 files found");
    expect(rendered).toContain("Partial scan");
    expect(rendered.match(/Output truncated/gu)).toHaveLength(1);
  }
  expect(
    text(
      display(
        "read",
        { path: "empty" },
        { details: { kind: "read", startLine: 1, shownLineCount: 0 } },
      ),
    ),
  ).toContain("0 lines");
});

it("keeps finite unknown scalar arguments and excludes internal metadata and prompts", () => {
  const rendered = text(
    display(
      "custom",
      {
        target: "object",
        amount: 3,
        prompt: "PRIVATE",
        metadata: { private: true },
      },
      {},
    ),
  );
  expect(rendered).toContain("target=object amount=3");
  expect(rendered).not.toContain("PRIVATE");
});

it("preserves a narrow Read object's filename and saved range", () => {
  const rows = display(
    "read",
    { file_path: "/very/long/project/src/components/important-file.ts" },
    {
      details: {
        kind: "read",
        startLine: 123,
        shownLineCount: 20,
        hasMore: true,
      },
    },
    false,
    40,
  );
  expect(rows[0].text).toContain("important-file.ts");
  expect(rows[0].text).toContain("123–142");
  expect(visibleWidth(rows[0].text)).toBeLessThanOrEqual(40);
  expect(text(rows)).toContain("Output truncated");
});

it("marks compact hunk gaps and aligns four-digit line numbers", () => {
  const rows = display(
    "edit",
    { path: "a" },
    {
      details: {
        kind: "mutation",
        diff: "@@ -9,1 +9,1 @@\n-a\n+b\n@@ -1000,1 +1000,1 @@\n-c\n+d",
      },
    },
  );
  expect(rows.filter((row) => row.text.trim() === "…")).toHaveLength(2);
  expect(text(rows)).toContain("-    9 a");
  expect(text(rows)).toContain("- 1000 c");
});

it.each(["timed_out", "cancelled"] as const)(
  "shows Bash %s without an error",
  (status) => {
    expect(
      text(
        display(
          "bash",
          { command: "sleep 10" },
          { details: { kind: "bash", status } },
        ),
      ),
    ).toContain(status === "timed_out" ? "Timed out" : "Cancelled");
  },
);

it("uses singular for exactly one omitted display row", () => {
  expect(
    text(display("bash", { command: "test" }, { output: "1\n2\n3\n4\n5\n6" })),
  ).toContain("1 line omitted");
});

it("keeps saved web search bodies in the expanded projection", () => {
  expect(
    text(
      display("web_search", { query: "query" }, { output: "SAVED-WEB-BODY" }),
    ),
  ).not.toContain("SAVED-WEB-BODY");
  expect(
    text(
      display(
        "web_search",
        { query: "query" },
        { output: "SAVED-WEB-BODY" },
        true,
      ),
    ),
  ).toContain("SAVED-WEB-BODY");
});

it.each([
  ["read", { path: "alpha\nbeta\tgamma" }],
  ["grep", { pattern: "alpha\nbeta\tgamma", path: "src" }],
  ["web_search", { query: "alpha\nbeta\tgamma" }],
  ["custom", { text: "alpha\nbeta\tgamma" }],
  ["custom", { text: "a\n".repeat(30) }],
] as const)(
  "keeps multiline %s arguments within one compact title row",
  (name, input) => {
    const compact = display(name, input, {}, false, 60);
    expect(compact).toHaveLength(1);
    expect(compact[0].text).not.toMatch(/[\n\r\t]/u);
    expect(visibleWidth(compact[0].text)).toBeLessThanOrEqual(60);
    const expanded = display(name, input, {}, true, 60);
    expect(expanded.length).toBeGreaterThan(1);
    if (
      name !== "custom" ||
      !("text" in input && input.text === "a\n".repeat(30))
    ) {
      expect(text(compact)).toContain("alpha beta gamma");
      expect(text(expanded)).toContain("alpha\n");
    }
  },
);

import { createReadStream, writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { UiMessage, UiToolResultDetails } from "ohbaby-sdk";
import { renderTerminalUi } from "../../../../packages/ohbaby-cli/src/tui/index.js";
import { createTuiReviewBackend } from "./tui-improve1-backend.js";

const controlFd = Number(process.env.TUI_REVIEW_CONTROL_FD);
const reportFd = Number(process.env.TUI_REVIEW_REPORT_FD);
if (!Number.isInteger(controlFd) || !Number.isInteger(reportFd)) {
  throw new Error("Run via scripts/run-tui-improve3-pty.py");
}
const report = (value: unknown): void => {
  writeSync(reportFd, `${JSON.stringify(value)}\n`);
};
const workspace = await mkdtemp(
  path.join(os.tmpdir(), "tui-improve3-process-"),
);
const backend = createTuiReviewBackend(4);
function tool(
  index: number,
  name: string,
  input: Record<string, unknown>,
  output: string,
  details?: UiToolResultDetails,
  error?: string,
): UiMessage {
  return {
    id: `tool-${index}`,
    role: "assistant",
    status: "completed",
    createdAt: `2026-10-04T00:00:${String(index).padStart(2, "0")}Z`,
    parts: [
      {
        type: "tool-call",
        call: {
          id: `call-${index}`,
          name,
          input,
          status: error ? "failed" : "completed",
        },
      },
      {
        type: "tool-result",
        result: {
          callId: `call-${index}`,
          output,
          outputAvailable: true,
          details,
          error,
        },
      },
    ],
  };
}
const tools = Array.from({ length: 20 }, (_, i) => {
  switch (i % 5) {
    case 0:
      return tool(
        i + 1,
        "bash",
        { command: "pnpm test --filter 中文" },
        Array.from(
          { length: 300 },
          (_, j) => `SHELL-${i}-${String(j + 1).padStart(3, "0")} 中文 👨‍👩‍👧‍👦`,
        ).join("\n"),
        { kind: "bash", exitCode: i === 0 ? 1 : 0 },
        i === 0 ? "EXIT-FAILURE-REASON" : undefined,
      );
    case 1:
      return tool(
        i + 1,
        "read",
        { file_path: "src/中文.ts" },
        "READ-BODY-ONLY-EXPANDED\nexport const value = 1;",
        { kind: "read", startLine: 1, shownLineCount: 2, hasMore: false },
      );
    case 2:
      return tool(
        i + 1,
        "grep",
        { pattern: "session", path: "src/" },
        "src/session.ts:1:session",
        {
          kind: "search",
          unit: "matches",
          count: 1,
          scanComplete: true,
          displayLimited: false,
        },
      );
    case 3:
      return tool(
        i + 1,
        "edit",
        { file_path: "src/config.ts" },
        "Edited src/config.ts",
        {
          kind: "mutation",
          diff: "--- src/config.ts\n+++ src/config.ts\n@@ -8,3 +8,3 @@\n const config = {\n-  retries: 2,\n+  retries: 3,\n };\n",
        },
      );
    default:
      return tool(
        i + 1,
        "write",
        {
          file_path: "src/new.ts",
          content: Array.from(
            { length: 30 },
            (_, j) => `NEW-LINE-${j + 1}`,
          ).join("\n"),
        },
        "Wrote src/new.ts",
        { kind: "mutation", created: true },
      );
  }
});
const messages = [
  ...backend.view.session.messages,
  ...tools,
  {
    id: "markdown",
    role: "assistant" as const,
    status: "completed" as const,
    createdAt: "2026-10-04T00:01:00Z",
    parts: [
      {
        type: "text" as const,
        text: "## MARKDOWN-END\n\n| 名称 | Value |\n| --- | --- |\n| 中文 | `alpha_beta` |\n\n```ts\n  const emoji = '👩‍💻';\n```\n\n[docs](https://example.com/docs)",
      },
    ],
  },
];
backend.update({
  session: { ...backend.view.session, messages },
  todo: { status: "ready", value: null },
});
const app = renderTerminalUi({
  client: backend.client,
  subscribeEvents: backend.subscribeEvents,
  pendingPromptWorkspace: workspace,
});
const control = createInterface({
  input: createReadStream("", { fd: controlFd, autoClose: false }),
});
control.on("line", (line) => {
  const command = JSON.parse(line) as { action: string };
  if (command.action === "approval")
    backend.approve({
      id: "review-approval",
      description: "APPROVAL-FOCUS-PRESERVED",
    });
  if (command.action === "refresh") backend.update();
  if (command.action === "late")
    backend.update({
      session: {
        ...backend.view.session,
        messages: [
          ...backend.view.session.messages,
          tool(
            30,
            "bash",
            { command: "echo later" },
            "LATE-FIRST\n2\n3\n4\n5\n6\nLATE-LAST",
            { kind: "bash", exitCode: 0 },
          ),
        ],
      },
    });
  if (command.action === "correction")
    backend.update({
      session: {
        ...backend.view.session,
        messages: backend.view.session.messages.map((message) =>
          message.id !== "tool-1"
            ? message
            : {
                ...message,
                parts: message.parts.map((part) =>
                  part.type !== "tool-result"
                    ? part
                    : {
                        ...part,
                        result: {
                          ...part.result,
                          output: part.result.output + "\nCORRECTED-END",
                        },
                      },
                ),
              },
        ),
      },
    });
  if (command.action === "inspect")
    report({ responses: backend.responses, submitted: backend.submitted });
  if (command.action === "quit") app.unmount();
});
const ready = setTimeout(() => report({ ready: true }), 700);
const timeout = setTimeout(() => app.unmount(), 60000);
try {
  await app.waitUntilExit();
} finally {
  clearTimeout(ready);
  clearTimeout(timeout);
  control.close();
  await rm(workspace, { recursive: true, force: true });
  report({
    exited: true,
    raw: process.stdin.isRaw,
    submitted: backend.submitted,
  });
}

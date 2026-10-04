import { createReadStream, writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { UiMessage } from "ohbaby-sdk";
import { renderTerminalUi } from "../../../../packages/ohbaby-cli/src/tui/index.js";
import { createTuiReviewBackend } from "./tui-improve1-backend.js";

const controlFd = Number(process.env.TUI_REVIEW_CONTROL_FD);
const reportFd = Number(process.env.TUI_REVIEW_REPORT_FD);
if (!Number.isInteger(controlFd) || !Number.isInteger(reportFd)) {
  throw new Error("Run via scripts/run-tui-improve4-stream-pty.py");
}
const report = (value: unknown): void => {
  writeSync(reportFd, `${JSON.stringify(value)}\n`);
};
const workspace = await mkdtemp(path.join(os.tmpdir(), "tui-improve4-stream-"));
const backend = createTuiReviewBackend(2);
let history = backend.view.session.messages;
let run = {
  id: "review-run",
  sessionId: "review-session",
  startedAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
  status: { kind: "running" as const, runId: "review-run" },
};
let stream: UiMessage = {
  id: "stream",
  role: "assistant",
  status: "streaming",
  createdAt: "2026-10-04T00:00:00Z",
  parts: [],
};
backend.update({ runs: [run], todo: { status: "ready", value: null } });
process.stdout.write("SHELL-SENTINEL\n");
const app = renderTerminalUi({
  client: backend.client,
  subscribeEvents: backend.subscribeEvents,
  pendingPromptWorkspace: workspace,
});
const control = createInterface({
  input: createReadStream("", { fd: controlFd, autoClose: false }),
});
control.on("line", (line) => {
  const command = JSON.parse(line) as { action: string; count?: number };
  if (command.action === "stream") {
    stream = {
      ...stream,
      parts: [
        {
          type: "text",
          text:
            "```ts\n" +
            Array.from(
              { length: command.count ?? 1 },
              (_, index) => `STREAM-${String(index).padStart(3, "0")} 中文 👩‍💻`,
            ).join("\n"),
        },
      ],
    };
    backend.update({
      session: { ...backend.view.session, messages: [...history, stream] },
    });
  }
  if (command.action === "start-prose") {
    history = backend.view.session.messages;
    stream = {
      ...stream,
      id: "prose",
      status: "streaming",
      parts: [],
      createdAt: "2026-10-04T00:00:01.500Z",
    };
    run = {
      ...run,
      id: "review-prose-run",
      startedAt: stream.createdAt,
      updatedAt: stream.createdAt,
      status: { kind: "running", runId: "review-prose-run" },
    };
    backend.emit({ type: "run.updated", run });
  }
  if (command.action === "prose" || command.action === "start-prose") {
    stream = {
      ...stream,
      parts: [
        {
          type: "text",
          text:
            "PROSE-FIRST " +
            Array.from(
              { length: 100 },
              (_, index) =>
                `段落${String(index).padStart(3, "0")}自动换行的正文需要完整保留。`,
            ).join("") +
            " PROSE-LAST " +
            "more tokens ".repeat(command.count ?? 0) +
            `PROSE-${String(command.count ?? 0)}`,
        },
      ],
    };
    backend.update({
      session: { ...backend.view.session, messages: [...history, stream] },
      runs: [run],
    });
  }
  for (const kind of ["table", "list"] as const) {
    if (command.action === `start-${kind}`) {
      history = backend.view.session.messages;
      stream = {
        ...stream,
        id: kind,
        status: "streaming",
        parts: [],
        createdAt: `2026-10-04T00:00:${kind === "table" ? "02" : "04"}Z`,
      };
      run = {
        ...run,
        id: `review-${kind}-run`,
        startedAt: stream.createdAt,
        updatedAt: stream.createdAt,
        status: { kind: "running", runId: `review-${kind}-run` },
      };
      // A new run emits its lifecycle event before message streaming in the
      // real backend; session.changed alone does not establish runtime state.
      backend.emit({ type: "run.updated", run });
    }
    if (command.action === kind || command.action === `start-${kind}`) {
      const source =
        kind === "table"
          ? "| Key | Value |\n| --- | --- |\n" +
            Array.from(
              { length: 20 },
              (_, index) => `| TABLE${String(index).padStart(2, "0")} | a |`,
            ).join("\n")
          : Array.from(
              { length: 20 },
              (_, index) => `- LIST${String(index).padStart(2, "0")}`,
            ).join("\n");
      const extra =
        command.count === undefined
          ? ""
          : kind === "table"
            ? "\n| TABLE20 | " + "x".repeat(command.count)
            : "\n\n  continuation " + "x".repeat(command.count);
      stream = { ...stream, parts: [{ type: "text", text: source + extra }] };
      backend.update({
        session: { ...backend.view.session, messages: [...history, stream] },
        runs: [run],
      });
    }
  }
  if (command.action === "complete") {
    const text = stream.parts[0];
    stream = {
      ...stream,
      status: "completed",
      parts:
        text?.type === "text"
          ? [
              {
                ...text,
                text: text.text.startsWith("```ts\n")
                  ? text.text + "\n```"
                  : text.text,
              },
            ]
          : [],
    };
    backend.update({
      session: { ...backend.view.session, messages: [...history, stream] },
      runs: [
        { ...run, status: { kind: "idle" }, endedAt: "2026-10-04T00:00:01Z" },
      ],
    });
  }
  if (command.action === "approval")
    backend.approve({ id: "stream-approval", description: "STREAM-APPROVAL" });
  if (command.action === "tasks")
    backend.update({
      todo: {
        status: "ready",
        value: {
          sessionId: "review-session",
          visible: true,
          todos: Array.from({ length: 20 }, (_, index) => ({
            content: `TASK-${String(index).padStart(2, "0")}`,
            status: "pending",
          })),
        },
      },
    });
  if (command.action === "refresh") backend.update();
  if (command.action === "inspect")
    report({ responses: backend.responses, submitted: backend.submitted });
  if (command.action === "quit") app.unmount();
});
const ready = setTimeout(() => report({ ready: true }), 600);
const timeout = setTimeout(() => app.unmount(), 90000);
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
  process.stdout.write("SHELL-RESTORED\n");
}

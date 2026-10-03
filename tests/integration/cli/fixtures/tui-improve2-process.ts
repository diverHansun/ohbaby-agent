import { createReadStream, writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { renderTerminalUi } from "../../../../packages/ohbaby-cli/src/tui/index.js";
import { createTuiReviewBackend } from "./tui-improve1-backend.js";

// stdin belongs exclusively to Ink. A separate pipe drives synthetic backend events.
const controlFd = Number(process.env.TUI_REVIEW_CONTROL_FD);
const reportFd = Number(process.env.TUI_REVIEW_REPORT_FD);
if (!Number.isInteger(controlFd) || !Number.isInteger(reportFd)) {
  throw new Error("Run via scripts/run-tui-improve2-pty.py");
}
const report = (value: unknown): void => {
  writeSync(reportFd, `${JSON.stringify(value)}\n`);
};
const workspace = await mkdtemp(
  path.join(os.tmpdir(), "tui-improve2-process-"),
);
const backend = createTuiReviewBackend();
const run = {
  id: "review-run",
  sessionId: "review-session",
  startedAt: "2026-10-04T00:00:00Z",
  updatedAt: "2026-10-04T00:00:00Z",
  status: { kind: "running" as const, runId: "review-run" },
};
backend.update({
  runs: [run],
  todo: {
    status: "ready",
    value: {
      sessionId: "review-session",
      visible: true,
      todos: Array.from({ length: 20 }, (_, i) => ({
        content:
          i === 19
            ? "END-TASK-20 中文内容"
            : `Review task ${String(i + 1).padStart(2, "0")} 中文内容`,
        status: i < 2 ? "completed" : i === 2 ? "in_progress" : "pending",
      })),
    },
  },
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
      id: "long",
      description: Array.from({ length: 45 }, (_, i) =>
        i === 44 ? "END-APPROVAL-45 中文" : `Approval detail ${i + 1} 中文`,
      ).join("\n"),
    });
  if (command.action === "no-deny")
    backend.approve({
      id: "no-deny",
      choices: [{ id: "allow", label: "Allow once", intent: "allow" }],
    });
  if (command.action === "stop")
    backend.update({
      runs: [
        { ...run, status: { kind: "idle" }, endedAt: "2026-10-04T00:00:01Z" },
      ],
    });
  if (command.action === "inspect")
    report({
      responses: backend.responses,
      submitted: backend.submitted,
      requests: backend.requests.map((request) => request.id),
    });
  if (command.action === "quit") app.unmount();
});
const ready = setTimeout(() => report({ ready: true }), 500);
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
    responses: backend.responses,
    submitted: backend.submitted,
    raw: process.stdin.isRaw,
  });
  process.exitCode = 0;
}

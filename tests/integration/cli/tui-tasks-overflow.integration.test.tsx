import {
  render,
  TerminalOutput,
  TerminalInput,
  tick,
} from "./fixtures/tui-improve1-terminal.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OhbabyTerminalApp } from "../../../packages/ohbaby-cli/src/tui/app.js";
import { createTuiReviewBackend } from "./fixtures/tui-improve1-backend.js";
import { SHIMMER_INTERVAL_MS } from "../../../packages/ohbaby-cli/src/tui/components/shimmer-text.js";

describe("TUI expanded Tasks viewport", () => {
  it("separates Tasks paging, draft cursor navigation and empty-draft history loading", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tui-tasks-"));
    const backend = createTuiReviewBackend();
    const originalHistory = backend.client.getSessionHistory;
    let historyLoads = 0;
    backend.client.getSessionHistory = (
      input: Parameters<typeof originalHistory>[0],
    ): ReturnType<typeof originalHistory> => {
      historyLoads++;
      return originalHistory(input);
    };
    backend.update({
      history: { hasMore: true, before: "older" },
      todo: {
        status: "ready",
        value: {
          sessionId: "review-session",
          visible: true,
          todos: Array.from({ length: 20 }, (_, index) => ({
            content: `Task-ID-${String(index + 1).padStart(2, "0")} ${index === 5 ? "long wrapped task body ".repeat(30) + "END-SIX" : "task body"}`,
            status: index === 0 ? "in_progress" : "pending",
          })),
        },
      },
    });
    const stdout = new TerminalOutput();
    stdout.columns = 60;
    stdout.rows = 20;
    const stdin = new TerminalInput();
    const app = render(
      <OhbabyTerminalApp
        client={backend.client}
        subscribeEvents={backend.subscribeEvents}
        pendingPromptWorkspace={workspace}
      />,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
        incrementalRendering: false,
      },
    );
    try {
      await tick();
      await tick();
      const draft = "draft one\ndraft two\ndraft three\ndraft four\ndraft five";
      stdin.send(draft);
      await tick();
      const baseline = stdout.chunks.length;
      stdin.send("\u0014");
      await tick();
      await tick();
      expect(stdout.text()).toContain("Alt+PgUp/PgDn");
      for (let page = 0; page < 12; page++) {
        stdin.send("\x1b[6;3~");
        await tick();
      }
      const pages = stdout.chunks.slice(baseline).join("");
      for (let i = 1; i <= 20; i++)
        expect(pages).toContain(`Task-ID-${String(i).padStart(2, "0")}`);
      expect(pages).toContain("END-SIX");
      expect(pages).toContain("draft five");
      expect(historyLoads).toBe(0);
      expect(pages).not.toContain("\x1b[3J");
      stdin.send("\x1b[5;3~");
      await tick();
      const quiet = stdout.chunks.length;
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(stdout.chunks.slice(quiet).join("")).toBe("");
      stdin.send("\x1b[5~");
      await tick();
      expect(historyLoads).toBe(0);
      expect(stdout.chunks.slice(quiet).join("")).not.toContain("\x1b[3J");
      // PgUp must move the draft cursor up one row, not page Tasks or history.
      stdin.send("!");
      await tick();
      expect(stdout.text()).toContain("draft four!");
      stdin.send("\x7f");
      await tick();
      stdin.send("\x1b[6~");
      await tick();
      const interval = vi.spyOn(globalThis, "setInterval");
      const animationStart = stdout.chunks.length;
      try {
        backend.update({
          runs: [
            {
              id: "review-running",
              sessionId: "review-session",
              startedAt: "2026-10-03T00:00:00.000Z",
              updatedAt: "2026-10-03T00:00:00.000Z",
              status: { kind: "running", runId: "review-running" },
              modelActivity: {
                requestId: "review-request",
                runId: "review-running",
                messageId: "pending",
                purpose: "agent-step",
                step: 0,
                attempt: 0,
                startedAt: 1000,
                outcome: "running",
              },
            },
          ],
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(
          interval.mock.calls.some((call) => call[1] === SHIMMER_INTERVAL_MS),
        ).toBe(true);
        expect(stdout.chunks.slice(animationStart).join("")).not.toContain(
          "\x1b[3J",
        );
        expect(stdout.chunks.slice(animationStart).join("")).not.toContain(
          "History 40:",
        );
      } finally {
        interval.mockRestore();
      }
      stdin.send("\u0014");
      await tick();
      expect(stdout.text()).toContain("Tasks 0/20 completed · Ctrl+T expand");
      expect(stdout.text()).toContain("draft five");
      stdin.send("\r");
      await tick();
      expect(backend.submitted).toEqual([draft]);
      stdin.send("\x1b[5~");
      await tick();
      expect(historyLoads).toBe(1);
    } finally {
      app.unmount();
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it("keeps task paging inactive behind an approval and resumes afterwards", async () => {
    const workspace = await mkdtemp(
      path.join(os.tmpdir(), "tui-tasks-dialog-"),
    );
    const backend = createTuiReviewBackend();
    backend.update({
      todo: {
        status: "ready",
        value: {
          sessionId: "review-session",
          visible: true,
          todos: Array.from({ length: 100 }, (_, index) => ({
            content: `Task ${String(index + 1)}`,
            status: "pending",
          })),
        },
      },
    });
    const stdout = new TerminalOutput();
    stdout.columns = 80;
    stdout.rows = 40;
    const stdin = new TerminalInput();
    const app = render(
      <OhbabyTerminalApp
        client={backend.client}
        subscribeEvents={backend.subscribeEvents}
        pendingPromptWorkspace={workspace}
      />,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
        incrementalRendering: false,
      },
    );
    const firstVisibleTaskRow = (): number => {
      const pages = Array.from(stdout.text().matchAll(/(\d+)–\d+\/100 rows/gu));
      expect(pages.length).toBeGreaterThan(0);
      return Number(pages.at(-1)?.[1]);
    };
    try {
      await tick();
      await tick();
      stdin.send("\u0014");
      await tick();
      await tick();
      stdin.send("\x1b[6;3~");
      await tick();
      const before = firstVisibleTaskRow();
      expect(before).toBeGreaterThan(1);
      backend.approve();
      await tick();
      await tick();
      expect(stdout.text()).toContain("Fake review approval");
      expect(firstVisibleTaskRow()).toBe(before);
      stdin.send("\x1b[6;3~");
      await tick();
      expect(firstVisibleTaskRow()).toBe(before);
      stdin.send("\x1b[5;3~");
      await tick();
      expect(firstVisibleTaskRow()).toBe(before);
      stdin.send("\r");
      await tick();
      await tick();
      expect(backend.requests).toHaveLength(0);
      expect(firstVisibleTaskRow()).toBe(before);
      stdin.send("\x1b[6;3~");
      await tick();
      expect(firstVisibleTaskRow()).toBeGreaterThan(before);
    } finally {
      app.unmount();
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("pages wrapped short lists without requiring the count-based Ctrl+T toggle", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tui-tasks-short-"));
    const backend = createTuiReviewBackend();
    backend.update({
      todo: {
        status: "ready",
        value: {
          sessionId: "review-session",
          visible: true,
          todos: Array.from({ length: 3 }, (_, index) => ({
            content: `LONG-${String(index)} ${"very long task text ".repeat(30)} END-${String(index)}`,
            status: "pending",
          })),
        },
      },
    });
    const stdout = new TerminalOutput();
    stdout.columns = 60;
    stdout.rows = 20;
    const stdin = new TerminalInput();
    const app = render(
      <OhbabyTerminalApp
        client={backend.client}
        subscribeEvents={backend.subscribeEvents}
        pendingPromptWorkspace={workspace}
      />,
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
        incrementalRendering: false,
      },
    );
    try {
      await tick();
      await tick();
      stdin.send("\u0014");
      await tick();
      expect(stdout.text()).toContain("Alt+PgUp/PgDn");
      for (let page = 0; page < 10; page++) {
        stdin.send("\x1b[6;3~");
        await tick();
      }
      for (let index = 0; index < 3; index++) {
        expect(stdout.text()).toContain(`LONG-${String(index)}`);
        expect(stdout.text()).toContain(`END-${String(index)}`);
      }
      expect(stdout.text()).not.toContain("ctrl+t to expand");
    } finally {
      app.unmount();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

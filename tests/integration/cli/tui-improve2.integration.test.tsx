import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { OhbabyTerminalApp } from "../../../packages/ohbaby-cli/src/tui/app.js";
import { createTuiReviewBackend } from "./fixtures/tui-improve1-backend.js";
import {
  render,
  TerminalInput,
  TerminalOutput,
  tick,
} from "./fixtures/tui-improve1-terminal.js";

describe("improve-2 complete TUI interaction", () => {
  it.each([
    [120, 40],
    [80, 24],
    [60, 20],
    [80, 12],
  ])(
    "keeps long approvals reachable and returns to the draft at %ix%i",
    async (columns, rows) => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "tui-improve2-"));
      const backend = createTuiReviewBackend();
      const stdout = new TerminalOutput();
      stdout.columns = columns;
      stdout.rows = rows;
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
        const draft = Array.from(
          { length: 200 },
          (_, i) => `草稿 ${i} 👨‍👩‍👧‍👦 é`,
        ).join("\n");
        stdin.send(draft);
        await tick();
        let outputStart = stdout.chunks.length;
        // Esc must never accept a request whose source omitted a deny choice.
        backend.approve({
          id: "no-deny",
          description: "Explicit selection required",
          choices: [{ id: "allow", label: "Allow once", intent: "allow" }],
        });
        await tick();
        stdin.send("\x1b");
        await tick();
        expect(backend.responses).toEqual([]);
        expect(backend.requests[0]?.id).toBe("no-deny");
        expect(stdout.chunks.slice(outputStart).join("")).toContain("Esc");
        stdin.send("\r");
        await tick();
        expect(backend.responses).toEqual([
          { requestId: "no-deny", choiceId: "allow" },
        ]);
        backend.update({
          runs: [
            {
              id: "active-review",
              sessionId: "review-session",
              startedAt: "2026-10-04T00:00:00Z",
              updatedAt: "2026-10-04T00:00:00Z",
              status: { kind: "running", runId: "active-review" },
            },
          ],
        });
        backend.emit({
          type: "notice.emitted",
          notice: {
            id: "approval-notice",
            createdAt: "2026-10-04",
            level: "warning",
            title: "Concurrent notice",
            message: "A notice while approval is active",
            source: "review",
          },
        });
        backend.approve({
          id: "long-request",
          description: Array.from(
            { length: 45 },
            (_, i) => `Approval detail ${i + 1} 中文`,
          ).join("\n"),
        });
        await tick();
        await tick();
        const approvalFrame = stripVTControlCharacters(
          stdout.chunks
            .filter((chunk) => chunk.includes("Enter select"))
            .at(-1) ?? "",
        );
        expect(approvalFrame).toContain("Approval detail 1");
        expect(approvalFrame).toContain("review-model");
        expect(approvalFrame).toContain("/review/中文-project");
        expect(approvalFrame.trimEnd().split("\n").length).toBeLessThan(rows);
        outputStart = stdout.chunks.length;
        // One paging key is delivered to the approval; the prompt/history remains inactive.
        for (let page = 0; page < 50; page++) {
          stdin.send("\x1b[6~");
          await tick();
        }
        expect(stdout.chunks.slice(outputStart).join("")).toContain(
          "Approval detail 45",
        );
        stdin.send("\x1b");
        await tick();
        expect(backend.responses).toEqual([
          { requestId: "no-deny", choiceId: "allow" },
          { requestId: "long-request", choiceId: "deny" },
        ]);
        expect(backend.requests).toHaveLength(0);
        expect(stdout.text()).toContain("草稿 199");
        stdin.send("\r");
        await tick();
        expect(backend.submitted).toEqual([draft]);
        expect(stdout.text()).not.toContain(
          "INTERNAL_OBSERVATION_DO_NOT_DISPLAY",
        );
        expect(stdout.chunks.join("")).not.toContain("\x1b[3J");
      } finally {
        app.unmount();
        expect(stdin.raw).toBe(false);
        expect(stdout.chunks.join("")).toContain("\x1b[?25h");
        await rm(workspace, { recursive: true, force: true });
      }
    },
    20000,
  );
});

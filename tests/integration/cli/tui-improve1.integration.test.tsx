import {
  render,
  TerminalOutput,
  TerminalInput,
  tick,
  Box,
  useBoxMetrics,
} from "./fixtures/tui-improve1-terminal.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useEffect, useRef, type ReactNode } from "react";
import type { DOMElement } from "ink";
import { OhbabyTerminalApp } from "../../../packages/ohbaby-cli/src/tui/app.js";
import { createTuiReviewBackend } from "./fixtures/tui-improve1-backend.js";

function MeasureFrame({
  children,
  onHeight,
}: {
  children: ReactNode;
  onHeight: (height: number) => void;
}) {
  const element = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(element);
  useEffect(() => {
    if (metrics.hasMeasured) onHeight(metrics.height);
  }, [metrics.height, metrics.hasMeasured, onHeight]);
  return (
    <Box ref={element} flexDirection="column">
      {children}
    </Box>
  );
}

describe("improve-1 full Ink App", () => {
  it.each([
    [120, 40],
    [80, 24],
    [60, 20],
  ])(
    "combines history, footer, tasks, multiline draft and approval at %ix%i",
    async (columns, rows) => {
      const workspace = await mkdtemp(path.join(os.tmpdir(), "tui-review-"));
      const backend = createTuiReviewBackend();
      const stdout = new TerminalOutput();
      stdout.columns = columns;
      stdout.rows = rows;
      let frameHeight = 0;
      const measure = (height: number): void => {
        frameHeight = height;
      };
      const stdin = new TerminalInput();
      const app = render(
        <MeasureFrame onHeight={measure}>
          <OhbabyTerminalApp
            client={backend.client}
            subscribeEvents={backend.subscribeEvents}
            pendingPromptWorkspace={workspace}
          />
        </MeasureFrame>,
        {
          stdin: stdin as unknown as NodeJS.ReadStream,
          stdout: stdout as unknown as NodeJS.WriteStream,
          exitOnCtrlC: false,
          patchConsole: false,
          incrementalRendering: true,
        },
      );
      try {
        await tick();
        backend.emit({
          type: "permission.updated",
          permission: { mode: "auto", level: "default", sessionRules: [] },
        });
        backend.emit({
          type: "notice.emitted",
          notice: {
            id: "review-notice",
            createdAt: "2026-10-03",
            level: "warning",
            title: "Review notice",
            message: "Synthetic notice remains visible",
            source: "review",
          },
        });
        await tick();
        // This fixture is idle: Tasks now require explicit readback.
        stdin.send("\u0014");
        await tick();
        const text = stdout.text();
        expect(text).toContain("History 40");
        expect(text).toContain("/review/中文-project");
        expect(text).toContain("review-model · high");
        expect(text).toContain("0.2% 2k/1m");
        expect(text).toContain("auto/default");
        expect(text).toContain("Review task 1");
        expect(text).toMatch(/Synthetic notice remains\s+visible/u);
        expect(text).not.toContain("INTERNAL_OBSERVATION_DO_NOT_DISPLAY");
        expect(text).not.toContain("PRIVATE_REASONING_DO_NOT_DISPLAY");
        expect(text).not.toContain("Thought");
        expect(text).not.toContain("Earlier history may be stale");
        stdin.send(
          Array.from({ length: 30 }, (_, index) => `draft 中文 ${index}`).join(
            "\n",
          ),
        );
        await tick();
        expect(frameHeight).toBeLessThan(rows);
        backend.approve();
        await tick();
        expect(stdout.text()).toContain("Fake review approval");
        expect(frameHeight).toBeLessThan(rows);
        // The real dialog responds to this synthetic backend only.
        stdin.send("\r");
        await tick();
        expect(backend.requests).toHaveLength(0);
        expect(stdout.text()).toContain("draft 中文 29");
        expect(frameHeight).toBeLessThan(rows);
        const baseline = stdout.chunks.length;
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect(backend.refreshes).toBeGreaterThan(1);
        // Equal backend polls must not force a render of the tall transcript.
        expect(stdout.chunks.slice(baseline).join("")).toBe("");
      } finally {
        app.unmount();
        expect(stdin.raw).toBe(false);
        expect(stdout.chunks.join("")).toContain("\x1b[?25h");
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});

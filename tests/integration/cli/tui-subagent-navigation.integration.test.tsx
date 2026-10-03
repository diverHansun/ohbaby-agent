import {
  render,
  TerminalOutput,
  TerminalInput,
  tick,
  Box,
  useBoxMetrics,
} from "./fixtures/tui-improve1-terminal.js";
import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import type { DOMElement } from "ink";
import type { CoreAPI, UiSubagentExecution } from "ohbaby-sdk";
import { stripVTControlCharacters } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OhbabyTerminalApp,
  SESSION_VIEW_CLEAR_SEQUENCE,
} from "../../../packages/ohbaby-cli/src/tui/app.js";
import { createTuiReviewBackend } from "./fixtures/tui-improve1-backend.js";

describe("TUI subagent browser navigation", () => {
  it("replays one current history on return, retains draft, and settles to zero polling output", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "tui-navigation-"));
    const backend = createTuiReviewBackend();
    const stdout = new TerminalOutput();
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
        incrementalRendering: true,
      },
    );
    try {
      await tick();
      await tick();
      stdin.send("draft 中文 preserved");
      await tick();
      for (const exitKey of ["\u0007", "\u001b"]) {
        stdin.send("\u0007");
        await tick();
        expect(stdout.text()).toContain("Subagents · Read only");
        const baseline = stdout.chunks.length;
        stdin.send(exitKey);
        await tick();
        await tick();
        const returned = stdout.chunks.slice(baseline).join("");
        expect(returned.split(SESSION_VIEW_CLEAR_SEQUENCE)).toHaveLength(2);
        const projection = returned.slice(
          returned.lastIndexOf(SESSION_VIEW_CLEAR_SEQUENCE),
        );
        expect(projection.split("History 40:")).toHaveLength(2);
        expect(projection).toContain("draft 中文 preserved");
        const quiet = stdout.chunks.length;
        await new Promise((resolve) => setTimeout(resolve, 1100));
        expect(stdout.chunks.slice(quiet).join("")).toBe("");
      }
      expect(backend.refreshes).toBeGreaterThan(1);
    } finally {
      app.unmount();
      expect(stdin.raw).toBe(false);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

it("keeps actual App execution detail pages and status reachable at 60x20", async () => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "tui-browser-window-"),
  );
  const backend = createTuiReviewBackend();
  const execution: UiSubagentExecution = {
    executionId: "child",
    subagentId: "audit-agent",
    rootSessionId: "review-session",
    rootRunId: "run",
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    resultStored: true,
    delivery: "processed",
    processedRequestId: "request",
    artifactPath: "/workspace/results/full-result.json",
  };
  const client: CoreAPI = {
    ...backend.client,
    listSubagentExecutions: async () => ({
      executions: [execution],
      activeCount: 0,
      completedCount: 1,
      waiting: false,
      approvalBlocked: false,
      hasMore: false,
    }),
    getSubagentExecutionView: async () => ({
      execution,
      readOnly: true,
      reasoningMissing: false,
      history: { hasMore: false },
      messages: [
        {
          id: "details",
          role: "assistant",
          createdAt: "2026-01-01",
          parts: [
            {
              type: "text",
              text: Array.from(
                { length: 35 },
                (_, index) => `detail-${String(index).padStart(2, "0")}`,
              ).join("\n"),
            },
          ],
        },
      ],
    }),
  };
  const stdout = new TerminalOutput();
  stdout.columns = 60;
  stdout.rows = 20;
  const stdin = new TerminalInput();
  let height = 0;
  const measure = (value: number): void => {
    height = value;
  };
  const app = render(
    <MeasureBrowser onHeight={measure}>
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={backend.subscribeEvents}
        pendingPromptWorkspace={workspace}
      />
    </MeasureBrowser>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      // Complete frames let this geometry/navigation test inspect the current
      // visible page. The companion navigation test covers incremental writes.
      incrementalRendering: false,
    },
  );
  const frame = (): string =>
    stripVTControlCharacters(
      stdout.chunks.findLast((chunk) =>
        chunk.includes("Subagents · Read only"),
      ) ?? "",
    );
  try {
    await tick();
    await tick();
    stdin.send("\u0007");
    await tick();
    stdin.send("\r");
    await tick();
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      expect(height).toBeLessThan(20);
      expect(frame()).toContain("Subagents · Read only");
      expect(frame()).toContain("audit-agent · completed");
      for (const match of frame().matchAll(/detail-\d+/gu)) seen.add(match[0]);
      stdin.send("\u001b[6~");
      await tick();
    }
    expect(seen.size).toBe(35);
    for (let page = 0; page < 10; page++) {
      stdin.send("\u001b[5~");
      await tick();
    }
    expect(frame()).toContain("Processed request: request");
    expect(frame()).toContain("detail-00");
    expect(height).toBeLessThan(20);
  } finally {
    app.unmount();
    await rm(workspace, { recursive: true, force: true });
  }
});

function MeasureBrowser({
  children,
  onHeight,
}: {
  readonly children: ReactNode;
  readonly onHeight: (height: number) => void;
}): ReactElement {
  const ref = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(ref);
  useEffect(() => {
    if (metrics.hasMeasured) onHeight(metrics.height);
  }, [metrics.hasMeasured, metrics.height, onHeight]);
  return (
    <Box ref={ref} flexDirection="column">
      {children}
    </Box>
  );
}

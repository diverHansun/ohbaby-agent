import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { Terminal } from "@xterm/headless";
import { Markdown } from "@earendil-works/pi-tui";
import { Box, render, Text } from "ink";
import type {
  CoreAPI,
  UiMessage,
  UiPermissionRequest,
  UiSessionTodoList,
} from "ohbaby-sdk";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodoPanel } from "../components/todo-panel.js";
import { TranscriptViewport } from "../components/transcript/transcript-viewport.js";
import { createFrameCoalescingStdout } from "../terminal-output.js";
import { ThemeProvider } from "../theme/index.js";
import { AppShell } from "./app-shell.js";
import {
  advanceTranscriptCommit,
  type TranscriptItem,
} from "../store/transcript.js";
import { DialogManager } from "../dialogs/manager.js";
import { Prompt } from "../components/prompt/index.js";

const SHIFT_HOME = "\u001b[1;2H";
const SHIFT_END = "\u001b[1;2F";
const SHIFT_PAGE_UP = "\u001b[5;2~";

class TerminalOutput extends EventEmitter {
  readonly isTTY = true;
  readonly chunks: string[] = [];
  columns = 64;
  rows = 20;

  write(
    chunk: string,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): boolean {
    this.chunks.push(chunk);
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  }
}

/** Ink consumes this stream via read(), exactly as it does a process PTY. */
class TerminalInput extends Readable {
  readonly isTTY = true;
  isRaw = false;

  override _read(): void {
    // Test input arrives through push(), never from a background producer.
  }

  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

interface SceneOptions {
  readonly text: string;
  readonly expanded?: boolean;
  readonly complete?: boolean;
  readonly history?: readonly TranscriptItem[];
  readonly dock?: ReactNode;
  readonly priorityDock?: boolean;
  readonly toolsExpanded?: boolean;
  readonly liveMessage?: UiMessage | null;
}

function scene({
  text,
  expanded = false,
  complete = false,
  history = [],
  dock,
  priorityDock = Boolean(dock),
  toolsExpanded = false,
  liveMessage,
}: SceneOptions): ReactElement {
  const message: UiMessage = {
    id: "live_message",
    role: "assistant",
    status: complete ? "completed" : "streaming",
    createdAt: "2026-10-04T04:00:00.000Z",
    parts: [{ type: "text", text }],
  };
  const todoList: UiSessionTodoList = {
    sessionId: "test_session",
    visible: true,
    todos: Array.from({ length: 20 }, (_, index) => ({
      content: `task ${String(index + 1)} 中文说明避免占满输出区域`,
      status: index === 0 ? "in_progress" : "pending",
    })),
  };
  return (
    <ThemeProvider>
      <AppShell
        fullscreen
        priorityDock={priorityDock}
        identity="test_session"
        output={
          <TranscriptViewport
            toolsExpanded={toolsExpanded}
            committedItems={
              complete
                ? [
                    ...history,
                    {
                      id: message.id,
                      messageId: message.id,
                      message,
                      spacing: true,
                    },
                  ]
                : history
            }
            liveMessage={
              liveMessage === undefined
                ? complete
                  ? null
                  : message
                : liveMessage
            }
            commandNotices={[]}
            notices={[]}
            runtime={{ kind: "idle" }}
          />
        }
      >
        {dock ?? (
          <>
            <TodoPanel expanded={expanded} todoList={todoList} />
            <Box flexDirection="column">
              <Text>PROMPT-ONCE 中文草稿</Text>
              <Text>FOOTER-ONCE</Text>
            </Box>
          </>
        )}
      </AppShell>
    </ThemeProvider>
  );
}

async function write(term: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => {
    term.write(data, resolve);
  });
}

function screen(term: Terminal): string[] {
  const buffer = term.buffer.active;
  return Array.from(
    { length: term.rows },
    (_, row) =>
      buffer
        .getLine(buffer.baseY + row)
        ?.translateToString(true, 0, term.cols) ?? "",
  );
}

async function harness(
  initial: SceneOptions,
  dimensions = { columns: 64, rows: 20 },
): Promise<{
  readonly term: Terminal;
  readonly output: TerminalOutput;
  readonly input: TerminalInput;
  readonly normalBefore: readonly string[];
  readonly update: (options: SceneOptions) => Promise<void>;
  readonly press: (key: string) => Promise<void>;
  readonly resize: (columns: number, rows: number) => Promise<void>;
  readonly close: () => Promise<void>;
}> {
  const output = new TerminalOutput();
  output.columns = dimensions.columns;
  output.rows = dimensions.rows;
  const input = new TerminalInput();
  const term = new Terminal({
    cols: output.columns,
    rows: output.rows,
    convertEol: true,
    allowProposedApi: true,
  });
  await write(term, "SHELL-BEFORE-TUI\r\n$ ");
  const normalBefore = screen(term);
  const app = render(scene(initial), {
    alternateScreen: true,
    interactive: true,
    incrementalRendering: true,
    patchConsole: false,
    exitOnCtrlC: false,
    // SAFETY: these local streams expose the TTY APIs used by Ink.
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: createFrameCoalescingStdout(
      output as unknown as NodeJS.WriteStream,
    ),
  });
  let written = 0;
  const drain = async (): Promise<void> => {
    // Allow useBoxMetrics layout effects and Ink's frame throttle to settle.
    for (let turn = 0; turn < 2; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 45));
      await app.waitUntilRenderFlush();
    }
    await write(term, output.chunks.slice(written).join(""));
    written = output.chunks.length;
  };
  await drain();
  return {
    term,
    output,
    input,
    normalBefore,
    update: async (options): Promise<void> => {
      app.rerender(scene(options));
      await drain();
    },
    press: async (key): Promise<void> => {
      input.push(key);
      await drain();
    },
    resize: async (columns, rows): Promise<void> => {
      output.columns = columns;
      output.rows = rows;
      term.resize(columns, rows);
      output.emit("resize");
      await drain();
    },
    close: async (): Promise<void> => {
      app.unmount();
      await app.waitUntilExit();
      await write(term, output.chunks.slice(written).join(""));
      input.destroy();
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("fullscreen transcript and dock terminal semantics", () => {
  it("keeps every streamed paragraph readable while preserving a manually selected viewport", async () => {
    vi.stubEnv("OHBABY_TUI_NO_ANIM", "1");
    let text = "HISTORY-START 中文开头";
    const h = await harness({ text });
    try {
      expect(h.term.buffer.active.type).toBe("alternate");
      expect(screen(h.term).join("\n")).toContain("HISTORY-START");
      // One unfinished Markdown paragraph, with no newline that could seal it.
      text += "这是一段仍在生成但已经显示的中文文字。".repeat(100) + "LIVE-END";
      await h.update({ text });
      expect(screen(h.term).join("\n")).toContain("LIVE-END");
      expect(screen(h.term).join("\n")).not.toContain("HISTORY-START");
      await h.press(SHIFT_HOME);
      const pinned = screen(h.term);
      expect(pinned.join("\n")).toContain("HISTORY-START");
      expect(pinned.join("\n")).toContain("History");
      for (let token = 0; token < 5; token += 1) {
        text += `继续生成第${String(token)}部分中文。`.repeat(8);
        await h.update({ text });
        expect(screen(h.term)).toEqual(pinned);
      }
      await h.press(SHIFT_END);
      expect(screen(h.term).join("\n")).not.toContain("HISTORY-START");
      text += "FOLLOW-END";
      await h.update({ text });
      expect(screen(h.term).join("\n")).toContain("FOLLOW-END");
      await h.press("\u001b[<64;3;2M");
      const mouseReading = screen(h.term);
      expect(mouseReading.join("\n")).toContain("History");
      text += "鼠标上滚时新内容继续增长".repeat(15);
      await h.update({ text });
      expect(screen(h.term)).toEqual(mouseReading);
      await h.press(SHIFT_PAGE_UP);
      const reading = screen(h.term);
      text += "生成结束".repeat(30);
      await h.update({ text, complete: true });
      expect(screen(h.term)).toEqual(reading);
    } finally {
      await h.close();
      expect(screen(h.term)).toEqual(h.normalBefore);
      h.term.dispose();
    }
  });

  it("reserves output beside twenty tasks, reflows on resize, and restores shell and mouse on exit", async () => {
    vi.stubEnv("OHBABY_TUI_NO_ANIM", "1");
    const text =
      "FIRST-MARKER " + "中文输出持续增长。".repeat(90) + "LATEST-MARKER";
    const h = await harness({ text, expanded: true });
    try {
      const assertDockAndLatest = (): void => {
        const visible = screen(h.term).join("\n");
        expect(visible).toContain("LATEST-MARKER");
        expect(visible.match(/PROMPT-ONCE/gu)).toHaveLength(1);
        expect(visible.match(/FOOTER-ONCE/gu)).toHaveLength(1);
        expect(visible).toContain("Tasks");
        expect(visible).not.toContain("task 20");
      };
      assertDockAndLatest();
      await h.resize(42, 14);
      assertDockAndLatest();
      await h.press(SHIFT_HOME);
      expect(screen(h.term).join("\n")).toContain("FIRST-MARKER");
      await h.resize(84, 26);
      expect(screen(h.term).join("\n")).toContain("FIRST-MARKER");
      await h.press(SHIFT_END);
      assertDockAndLatest();
      await h.update({ text, expanded: false });
      assertDockAndLatest();
      expect(h.input.isRaw).toBe(true);
    } finally {
      await h.close();
    }
    try {
      expect(h.term.buffer.active.type).toBe("normal");
      expect(screen(h.term).join("\n")).toContain("SHELL-BEFORE-TUI");
      expect(h.term.modes.mouseTrackingMode).toBe("none");
      expect(h.input.isRaw).toBe(false);
      await write(h.term, "AFTER-TUI");
      expect(screen(h.term).join("\n")).toContain("AFTER-TUI");
    } finally {
      h.term.dispose();
    }
  });
});

function historyItems(
  count: number,
  prefix = "ROW",
): readonly TranscriptItem[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `${prefix}-${String(index).padStart(3, "0")}`;
    return {
      id,
      messageId: id,
      spacing: true,
      message: {
        id,
        role: "assistant",
        status: "completed",
        createdAt: "2026-10-04T04:00:00.000Z",
        parts: [
          {
            type: "text",
            text: `${id} ${"历史消息内容需要跨多行显示。".repeat(6)}`,
          },
        ],
      },
    };
  });
}

describe("fullscreen review probes", () => {
  it("reuses unchanged long message formatting when scrolling and refreshes it for text and width changes", async () => {
    const format = vi.spyOn(Markdown.prototype, "render");
    let text = Array.from(
      { length: 120 },
      (_, index) => `LINE-${String(index).padStart(3, "0")} **中文正文**`,
    ).join("\n");
    const h = await harness({ text });
    try {
      const latest = screen(h.term);
      format.mockClear();
      for (let turn = 0; turn < 5; turn++) await h.press("\u001b[<64;3;2M");
      expect(screen(h.term)).not.toEqual(latest);
      expect(format).not.toHaveBeenCalled();
      const reading = screen(h.term);
      text += "\nNEW-CONTENT";
      await h.update({ text });
      expect(format).toHaveBeenCalled();
      expect(screen(h.term)).toEqual(reading);
      await h.press(SHIFT_END);
      expect(screen(h.term).join("\n")).toContain("NEW-CONTENT");
      format.mockClear();
      await h.resize(42, 20);
      expect(format).toHaveBeenCalled();
      expect(screen(h.term).join("\n")).toContain("NEW-CONTENT");
    } finally {
      await h.close();
      h.term.dispose();
      format.mockRestore();
    }
  });

  it("preserves the read message when older history is prepended", async () => {
    const history = historyItems(30);
    const h = await harness({ text: "LATEST", history });
    try {
      await h.press(SHIFT_HOME);
      expect(screen(h.term).join("\n")).toContain("ROW-000");
      const previous = screen(h.term);
      await h.update({
        text: "LATEST",
        history: [...historyItems(3, "PRE"), ...history],
      });
      expect(screen(h.term)).toEqual(previous);
    } finally {
      await h.close();
      h.term.dispose();
    }
  });

  it("preserves the read message when a nonzero viewport offset reflows", async () => {
    const history = historyItems(30);
    const h = await harness({ text: "LATEST", history });
    try {
      await h.press(SHIFT_HOME);
      for (let page = 0; page < 4; page += 1) await h.press("\u001b[6;2~");
      const before = /ROW-\d+/u.exec(screen(h.term).join("\n"))?.[0];
      expect(before).toBeDefined();
      await h.resize(42, 20);
      expect(screen(h.term).join("\n")).toContain(before);
    } finally {
      await h.close();
      h.term.dispose();
    }
  });

  it.each([
    { columns: 80, rows: 12 },
    { columns: 40, rows: 16 },
  ])(
    "keeps real approval controls actionable at $columns by $rows",
    async (dimensions) => {
      const respondPermission = vi.fn().mockResolvedValue(undefined);
      // SAFETY: the dock only calls this API method in this approval scenario.
      const client = { respondPermission } as unknown as CoreAPI;
      const request: UiPermissionRequest = {
        id: "approve-request",
        sessionId: "root",
        rootSessionId: "root",
        runId: "run",
        callId: "call",
        messageId: "message",
        createdAt: 1,
        title: "Write file",
        description: Array.from(
          { length: 12 },
          (_, i) => `OPERATION-${String(i).padStart(2, "0")}`,
        ).join("\n"),
        choices: [
          { id: "allow_once", intent: "allow", label: "Allow once" },
          { id: "allow_always", intent: "allow", label: "Always allow" },
          { id: "reject", intent: "deny", label: "Reject" },
        ],
      };
      const dock = (
        <>
          <DialogManager
            client={client}
            interactions={[]}
            permissions={[request]}
            permissionSync={{
              status: "ready",
              binding: {
                rootSessionId: "root",
                permissionEpoch: "epoch",
                bindingGeneration: 1,
              },
              requests: [request],
              permissionRevision: 1,
              attempts: 0,
            }}
            onRetryPermissions={vi.fn()}
          />
          <Prompt
            client={client}
            footerOnly
            disabled
            activeSessionId="root"
            catalog={null}
          />
        </>
      );
      const h = await harness({ text: "LLM-OUTPUT", dock }, dimensions);
      try {
        expect(screen(h.term).join("\n")).toContain("Allow once");
        expect(screen(h.term).join("\n")).toContain("OPERATION-00");
        await h.press("\u001b[6;2~");
        // Shift+PgDn belongs to the transcript; unmodified PgDn reads the approval.
        expect(screen(h.term).join("\n")).toContain("OPERATION-00");
        await h.press("\r");
        expect(respondPermission).toHaveBeenCalledWith(
          request.id,
          { choiceId: "allow_once" },
          expect.anything(),
        );
      } finally {
        await h.close();
        h.term.dispose();
      }
    },
  );

  it("retains distant history across scrolling and live updates with 500 messages", async () => {
    const history = historyItems(500);
    const h = await harness({ text: "LIVE", history });
    try {
      let text = "LIVE";
      for (let token = 0; token < 10; token += 1) {
        text += `第${String(token)}段中文`;
        await h.update({ text, history });
      }
      expect(screen(h.term).join("\n")).toContain("第9段中文");
      await h.press(SHIFT_HOME);
      expect(screen(h.term).join("\n")).toContain("ROW-000");
      for (let page = 0; page < 10; page += 1) await h.press("\u001b[6;2~");
      const reading = screen(h.term);
      expect(reading.join("\n")).toMatch(/ROW-0\d\d/u);
      await h.update({ text: text + "更多输出", history });
      expect(screen(h.term)).toEqual(reading);
      await h.press(SHIFT_END);
      expect(screen(h.term).join("\n")).toContain("更多输出");
      expect(screen(h.term).join("\n")).toContain("ROW-499");
    } finally {
      await h.close();
      h.term.dispose();
    }
  }, 30000);

  it("remeasures hidden content replacements and tools expanded outside the viewport", async () => {
    const first = historyItems(1)[0];
    const history = [first, ...historyItems(60, "LATER")];
    const h = await harness({ text: "LATEST", history });
    try {
      const output = Array.from(
        { length: 18 },
        (_, i) => `TOOL-ROW-${String(i).padStart(2, "0")}`,
      ).join("\n");
      const replacement: TranscriptItem = {
        ...first,
        message: {
          ...first.message,
          parts: [
            { type: "text", text: "REPLACED-START" },
            {
              type: "tool-call",
              call: {
                id: "call",
                name: "bash",
                input: { command: "echo test" },
                status: "completed",
              },
            },
            { type: "tool-result", result: { callId: "call", output } },
            { type: "text", text: "REPLACED-END" },
          ],
        },
      };
      const updated = [replacement, ...history.slice(1)];
      await h.update({ text: "LATEST", history: updated, toolsExpanded: true });
      expect(screen(h.term).join("\n")).toContain("LATEST");
      await h.press(SHIFT_HOME);
      expect(screen(h.term).join("\n")).toContain("REPLACED-START");
      let seen = screen(h.term).join("\n");
      for (let page = 0; page < 3; page += 1) {
        await h.press("\u001b[6;2~");
        seen += "\n" + screen(h.term).join("\n");
      }
      for (let row = 0; row < 18; row += 1)
        expect(seen).toContain(`TOOL-ROW-${String(row).padStart(2, "0")}`);
      expect(seen).toContain("REPLACED-END");
      await h.press(SHIFT_END);
      await h.update({
        text: "LATEST",
        history: updated,
        toolsExpanded: false,
      });
      await h.resize(42, 20);
      await h.press(SHIFT_HOME);
      const collapsed = screen(h.term).join("\n");
      expect(collapsed).toContain("REPLACED-START");
      expect(collapsed).toContain("REPLACED-END");
      expect(collapsed).not.toContain("TOOL-ROW-00");
      expect(collapsed).toContain("13 lines omitted");
      expect(collapsed).toContain("LATER-000");
    } finally {
      await h.close();
      h.term.dispose();
    }
  });

  it("keeps the reading anchor when live text becomes a committed fragment before a tool", async () => {
    const message: UiMessage = {
      id: "stream-fragment",
      role: "assistant",
      status: "streaming",
      createdAt: "2026-10-04T04:00:00.000Z",
      parts: [
        {
          type: "text",
          text: Array.from(
            { length: 70 },
            (_, i) => `TEXT-ROW-${String(i).padStart(2, "0")}`,
          ).join("\n"),
        },
      ],
    };
    const running = { kind: "running", runId: "run" } as const;
    const initial = advanceTranscriptCommit(undefined, [message], running);
    const h = await harness({
      text: "",
      history: initial.committedItems,
      liveMessage: initial.liveMessage,
    });
    try {
      await h.press(SHIFT_HOME);
      await h.press("\u001b[6;2~");
      const before = screen(h.term);
      const withTool: UiMessage = {
        ...message,
        parts: [
          ...message.parts,
          {
            type: "tool-call",
            call: {
              id: "next-tool",
              name: "bash",
              input: { command: "ls" },
              status: "running",
            },
          },
        ],
      };
      const next = advanceTranscriptCommit(initial, [withTool], running);
      expect(next.committedItems[0].id).toBe("stream-fragment#0-1");
      await h.update({
        text: "",
        history: next.committedItems,
        liveMessage: next.liveMessage,
      });
      expect(screen(h.term)).toEqual(before);
    } finally {
      await h.close();
      h.term.dispose();
    }
  });

  it("keeps Ctrl+B/F out of the draft and leaves a real prompt usable beside narrow tasks", async () => {
    const submit = vi.fn().mockResolvedValue({ sessionId: "root" });
    // SAFETY: only prompt submission is exercised by this dock fixture.
    const client = { submitPromptAccepted: submit } as unknown as CoreAPI;
    const dock = (
      <>
        <TodoPanel
          expanded
          todoList={{
            sessionId: "root",
            visible: true,
            todos: Array.from({ length: 20 }, (_, i) => ({
              content: `Task ${String(i)} 多行任务说明需要保留输入框`,
              status: "pending",
            })),
          }}
        />
        <Prompt
          client={client}
          disabled={false}
          activeSessionId="root"
          catalog={null}
        />
      </>
    );
    const history = historyItems(50);
    const h = await harness(
      { text: "LATEST", history, dock, priorityDock: false },
      { columns: 40, rows: 12 },
    );
    try {
      expect(screen(h.term).join("\n")).toContain("LATEST");
      expect(screen(h.term).join("\n")).toContain("Tasks");
      await h.press("abc");
      await h.press("\u0002");
      expect(screen(h.term).join("\n")).toContain("History");
      await h.press("\u0006");
      await h.press("d");
      await h.press("\r");
      expect(submit).toHaveBeenCalledWith("abcd", expect.anything());
      expect(screen(h.term).join("\n")).toContain("LATEST");
    } finally {
      await h.close();
      h.term.dispose();
    }
  });
});

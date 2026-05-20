import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInProcessUiBackendClient } from "ohbaby-agent";
import { OhbabyTerminalApp } from "ohbaby-tui";
import type { TuiBackendClient } from "../../../packages/ohbaby-tui/src/store/snapshot.js";
import {
  createFakeLLMClient,
  createSequentialFakeLLMClient,
  flush,
  promptLine,
  waitForFrame,
  writeToolCallEvent,
} from "./helpers.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const directory of cleanupDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

async function tempWorkspace(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), `.tmp-${prefix}-`));
  cleanupDirectories.push(directory);
  return directory;
}

describe("TUI main chain with real in-process backend", () => {
  it("submits a prompt, clears input immediately, and renders streaming text once", async () => {
    const client = createInProcessUiBackendClient({
      llmClient: createFakeLLMClient([
        { textDelta: "Hello" },
        { textDelta: " world", finishReason: "stop" },
      ]),
    });
    const app = render(<OhbabyTerminalApp client={client} />);

    await waitForFrame(
      app,
      (frame) => promptLine(frame).trimEnd() === "ohbaby >",
    );
    app.stdin.write("hello");
    await waitForFrame(app, (frame) => promptLine(frame).includes("hello"));
    app.stdin.write("\r");

    await waitForFrame(
      app,
      (frame) => promptLine(frame).trimEnd() === "ohbaby >",
    );
    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("Hello world"),
    );

    expect(frame).toContain("ohbaby");
    expect(frame).not.toContain("Hellolo");
    expect(frame).toContain("status: idle | session: session_1");
    app.unmount();
  });

  it("renders tool permission flow and accepts another prompt after allow_once", async () => {
    const workdir = await tempWorkspace("ohbaby-tui-permission");
    const requests = [];
    const realClient = createInProcessUiBackendClient({
      llmClient: createSequentialFakeLLMClient(
        [
          [
            writeToolCallEvent({
              callId: "call_write",
              content: "allowed",
              filePath: "allowed.txt",
            }),
          ],
          [{ textDelta: "Permission complete.", finishReason: "stop" }],
          [{ textDelta: "Second prompt works.", finishReason: "stop" }],
        ],
        requests,
      ),
      workdir,
    });
    const client: TuiBackendClient = {
      ...realClient,
      submitPrompt: vi.fn(realClient.submitPrompt.bind(realClient)),
    };
    const app = render(<OhbabyTerminalApp client={client} />);

    await waitForFrame(
      app,
      (frame) => promptLine(frame).trimEnd() === "ohbaby >",
    );
    app.stdin.write("write file");
    app.stdin.write("\r");
    await waitForFrame(app, (frame) => frame.includes("Permission:"));

    app.stdin.write("busy submit");
    await flush();
    expect(client.submitPrompt).toHaveBeenCalledTimes(1);

    app.stdin.write("\t");
    app.stdin.write("\t");
    app.stdin.write("\r");

    const completedFrame = await waitForFrame(app, (frame) =>
      frame.includes("Permission complete."),
    );
    expect(completedFrame).toContain("tool write (completed)");
    expect(completedFrame).toContain("tool result call_write:");
    expect(completedFrame).toContain("status: idle | session: session_1");

    app.stdin.write("again");
    app.stdin.write("\r");
    const secondFrame = await waitForFrame(app, (frame) =>
      frame.includes("Second prompt works."),
    );

    expect(secondFrame).toContain("status: idle | session: session_1");
    expect(client.submitPrompt).toHaveBeenCalledTimes(2);
    app.unmount();
  });

  it("aborts a pending permission run with Ctrl+C and can submit again", async () => {
    const workdir = await tempWorkspace("ohbaby-tui-abort");
    await mkdir(join(workdir, "src"));
    const realClient = createInProcessUiBackendClient({
      llmClient: createSequentialFakeLLMClient([
        [
          writeToolCallEvent({
            callId: "call_abort",
            content: "nope",
            filePath: "src/aborted.txt",
          }),
        ],
        [{ textDelta: "After abort works.", finishReason: "stop" }],
      ]),
      workdir,
    });
    const app = render(<OhbabyTerminalApp client={realClient} />);

    await waitForFrame(
      app,
      (frame) => promptLine(frame).trimEnd() === "ohbaby >",
    );
    app.stdin.write("abort this");
    app.stdin.write("\r");
    await waitForFrame(app, (frame) => frame.includes("Permission:"));

    app.stdin.write("\u0003");
    const abortedFrame = await waitForFrame(
      app,
      (frame) =>
        frame.includes("run aborted") && !frame.includes("Permission:"),
    );
    expect(abortedFrame).toContain("status: error: run aborted");

    app.stdin.write("continue");
    app.stdin.write("\r");
    const recoveredFrame = await waitForFrame(app, (frame) =>
      frame.includes("After abort works."),
    );

    expect(recoveredFrame).toContain("status: idle | session: session_1");
    expect(recoveredFrame).not.toContain("Permission:");
    app.unmount();
  });

  it("switches policy mode through slash commands and Shift+Tab", async () => {
    const client = createInProcessUiBackendClient({
      llmClient: createFakeLLMClient([]),
    });
    const app = render(<OhbabyTerminalApp client={client} />);

    await waitForFrame(app, (frame) =>
      frame.includes("mode: agent/ask-before-edit"),
    );
    app.stdin.write("/mode ask");
    app.stdin.write("\r");
    await waitForFrame(app, (frame) =>
      frame.includes("mode: ask/ask-before-edit"),
    );

    app.stdin.write("\u001B[Z");
    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("mode: plan/ask-before-edit"),
    );

    expect(frame).toContain("status: idle");
    app.unmount();
  });
});

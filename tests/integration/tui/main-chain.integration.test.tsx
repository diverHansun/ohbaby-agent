import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInProcessUiBackendClient } from "ohbaby-agent";
import { OhbabyTerminalApp } from "ohbaby-cli";
import type { TerminalClient } from "../../../packages/ohbaby-cli/src/tui/store/snapshot.js";
import {
  createFakeLLMClient,
  createSequentialFakeLLMClient,
  flush,
  promptIsReady,
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
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await waitForFrame(app, promptIsReady);
    app.stdin.write("hello");
    await waitForFrame(app, (frame) => promptLine(frame).includes("hello"));
    app.stdin.write("\r");

    await waitForFrame(app, promptIsReady);
    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("Hello world"),
    );

    expect(frame).not.toContain("ohbaby");
    expect(frame).not.toContain("Hellolo");
    expect(frame).toContain("auto · default · session_1");
    app.unmount();
  });

  it("renders tool permission flow and accepts another prompt after allow_once", async () => {
    const workdir = await tempWorkspace("ohbaby-cli-permission");
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
    const client: TerminalClient = {
      ...realClient,
      submitPrompt: vi.fn(realClient.submitPrompt.bind(realClient)),
    };
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await waitForFrame(app, promptIsReady);
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
    expect(completedFrame).toContain("Write allowed.txt");
    expect(completedFrame).not.toContain("tool write");
    expect(completedFrame).not.toContain("tool result");
    expect(completedFrame).not.toContain("result hidden");
    expect(completedFrame).toContain("auto · default · session_1");

    app.stdin.write("again");
    app.stdin.write("\r");
    const secondFrame = await waitForFrame(app, (frame) =>
      frame.includes("Second prompt works."),
    );

    expect(secondFrame).toContain("auto · default · session_1");
    expect(client.submitPrompt).toHaveBeenCalledTimes(2);
    app.unmount();
  });

  it("aborts a pending permission run with Ctrl+C and can submit again", async () => {
    const workdir = await tempWorkspace("ohbaby-cli-abort");
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
    const app = render(
      <OhbabyTerminalApp
        client={realClient}
        subscribeEvents={realClient.subscribeEvents}
      />,
    );

    await waitForFrame(app, promptIsReady);
    app.stdin.write("abort this");
    app.stdin.write("\r");
    await waitForFrame(app, (frame) => frame.includes("Permission:"));

    app.stdin.write("\u0003");
    const abortedFrame = await waitForFrame(
      app,
      (frame) =>
        frame.includes("run aborted") && !frame.includes("Permission:"),
    );
    expect(abortedFrame).toContain("error: run aborted");
    expect(abortedFrame).not.toContain("status: error");

    app.stdin.write("continue");
    app.stdin.write("\r");
    const recoveredFrame = await waitForFrame(app, (frame) =>
      frame.includes("After abort works."),
    );

    expect(recoveredFrame).toContain("auto · default · session_1");
    expect(recoveredFrame).not.toContain("Permission:");
    app.unmount();
  });

  it("switches permission mode with Shift+Tab and level with slash commands", async () => {
    const client = createInProcessUiBackendClient({
      llmClient: createFakeLLMClient([]),
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await waitForFrame(app, (frame) => frame.includes("auto · default"));
    app.stdin.write("\u001B[Z");
    await waitForFrame(app, (frame) => frame.includes("plan · default"));
    app.stdin.write("\u001B[Z");
    await waitForFrame(app, (frame) => frame.includes("auto · default"));
    app.stdin.write("/permission");
    app.stdin.write("\r");
    await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("Permission level:"),
    );
    app.stdin.write("\u001B[B");
    app.stdin.write("\r");
    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("auto · full-access"),
    );

    expect(frame).toContain("auto · full-access");
    expect(frame).not.toContain("status: idle");
    app.unmount();
  });

  it("executes slash commands from the TUI in plan mode", async () => {
    const client = createInProcessUiBackendClient({
      llmClient: createFakeLLMClient([]),
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await waitForFrame(app, promptIsReady);
    app.stdin.write("\u001B[Z");
    await waitForFrame(app, (frame) => frame.includes("plan · default"));

    app.stdin.write("/status");
    app.stdin.write("\r");
    const frame = await waitForFrame(
      app,
      (nextFrame) =>
        nextFrame.includes("│ Runtime  idle") &&
        !nextFrame.includes("Unknown command"),
    );

    expect(frame).toContain("plan · default");
    expect(frame).not.toContain("status: idle");
    app.unmount();
  });

  it("uses default permission approval for write tool calls in plan mode", async () => {
    const workdir = await tempWorkspace("ohbaby-cli-plan-permission");
    const requests = [];
    const client = createInProcessUiBackendClient({
      llmClient: createSequentialFakeLLMClient(
        [
          [
            writeToolCallEvent({
              callId: "call_write_denied",
              content: "denied",
              filePath: "denied.txt",
            }),
          ],
          [{ textDelta: "Plan write completed.", finishReason: "stop" }],
        ],
        requests,
      ),
      workdir,
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await waitForFrame(app, (frame) => frame.includes("auto · default"));
    app.stdin.write("\u001B[Z");
    await waitForFrame(app, (frame) => frame.includes("plan · default"));

    app.stdin.write("try to write");
    app.stdin.write("\r");
    await waitForFrame(app, (frame) => frame.includes("Permission:"));

    app.stdin.write("\t");
    app.stdin.write("\t");
    app.stdin.write("\r");

    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("Plan write completed."),
    );

    expect(frame).toContain("Write denied.txt");
    expect(frame).not.toContain("plan mode");
    expect(requests).toHaveLength(2);
    await expect(readFile(join(workdir, "denied.txt"), "utf8")).resolves.toBe(
      "denied",
    );
    app.unmount();
  });

  it("runs write tool calls without permission after full-access is selected", async () => {
    const workdir = await tempWorkspace("ohbaby-cli-full-access");
    const client = createInProcessUiBackendClient({
      llmClient: createSequentialFakeLLMClient([
        [
          writeToolCallEvent({
            callId: "call_write_auto",
            content: "auto edit ok",
            filePath: "auto.txt",
          }),
        ],
        [{ textDelta: "Auto edit wrote the file.", finishReason: "stop" }],
      ]),
      workdir,
    });
    const app = render(
      <OhbabyTerminalApp
        client={client}
        subscribeEvents={client.subscribeEvents}
      />,
    );

    await waitForFrame(app, promptIsReady);
    app.stdin.write("/permission");
    app.stdin.write("\r");
    await waitForFrame(app, (frame) => frame.includes("Permission level:"));
    app.stdin.write("\u001B[B");
    app.stdin.write("\r");
    await waitForFrame(app, (frame) => frame.includes("auto · full-access"));

    app.stdin.write("write automatically");
    app.stdin.write("\r");
    const frame = await waitForFrame(app, (nextFrame) =>
      nextFrame.includes("Auto edit wrote the file."),
    );

    expect(frame).toContain("Write auto.txt");
    expect(frame).not.toContain("Permission:");
    await expect(readFile(join(workdir, "auto.txt"), "utf8")).resolves.toBe(
      "auto edit ok",
    );
    app.unmount();
  });
});

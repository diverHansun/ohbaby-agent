import { render } from "ink-testing-library";
import { stripVTControlCharacters } from "node:util";
import type { CoreAPI, UiEventHandler } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayoutProvider } from "../../layout/context.js";
import { computeLayoutMetrics } from "../../layout/metrics.js";
import {
  BackgroundTaskBrowser,
  CONFIRM_TIMEOUT_MS,
} from "./background-task-browser.js";
import type { BackgroundTaskProbe } from "./use-background-tasks.js";
import { fakeTaskClient, taskRow, typicalRows } from "./test-fixtures.js";

const subscribe =
  (_handler: UiEventHandler): (() => void) =>
  () =>
    undefined;
const DOWN = "\u001b[B";
const ESC = "\u001b";
const ENTER = "\r";

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(
  client: Partial<CoreAPI>,
  options: {
    readonly probe?: Partial<BackgroundTaskProbe>;
    readonly columns?: number;
    readonly rows?: number;
    readonly approvalPending?: boolean;
  } = {},
): ReturnType<typeof render> & { readonly onClose: ReturnType<typeof vi.fn> } {
  const onClose = vi.fn();
  const probe: BackgroundTaskProbe = {
    hasTasks: true,
    known: true,
    main: 5,
    subagents: 0,
    running: 2,
    ...options.probe,
  };
  const element = (): ReactElement => (
    <LayoutProvider
      value={computeLayoutMetrics({
        columns: options.columns ?? 80,
        rows: options.rows ?? 30,
      })}
    >
      <BackgroundTaskBrowser
        client={client as CoreAPI}
        subscribeEvents={subscribe}
        rootSessionId="root"
        probe={probe}
        approvalPending={options.approvalPending ?? false}
        onClose={onClose}
      />
    </LayoutProvider>
  );
  const app = render(element());
  mounted.push(() => {
    app.unmount();
  });
  return Object.assign(app, { onClose });
}

const frame = (app: ReturnType<typeof render>): string =>
  stripVTControlCharacters(app.lastFrame() ?? "");

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function press(
  app: ReturnType<typeof render>,
  key: string,
): Promise<void> {
  // Ink tells a lone Escape from a sequence only after a short pause.
  await new Promise((resolve) => setTimeout(resolve, 10));
  app.stdin.write(key);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settle();
}

describe("Background tasks panel", () => {
  it("lists background tasks by group and leaves foreground commands out", async () => {
    const app = mount(fakeTaskClient(typicalRows()));
    await settle();
    const text = frame(app);
    expect(text).toContain("Background tasks");
    expect(text).toContain("Running 2");
    expect(text).toContain("Done 3");
    expect(text).toContain("› Dev server");
    expect(text).toContain("Failed");
    expect(text).not.toContain("git status");
    // No filter without subagent tasks; Esc closes.
    expect(text).not.toContain("f filter");
    expect(text).toContain("↑/↓ select · Enter open · c cancel · Esc close");
    await press(app, ESC);
    expect(app.onClose).toHaveBeenCalledOnce();
  });

  it("asks before cancelling, sends one request, and any other key backs out", async () => {
    const client = fakeTaskClient(typicalRows());
    // Hold the stop open so a second confirmation would show as a second call.
    let finish!: () => void;
    const answer = client.stopShellJob.getMockImplementation();
    client.stopShellJob.mockImplementation(
      (input) =>
        new Promise((resolve, reject) => {
          finish = () => {
            answer?.(input).then(resolve, reject);
          };
        }),
    );
    const app = mount(client);
    await settle();
    await press(app, "c");
    expect(frame(app)).toContain("Cancel Dev server? y confirm · any key back");
    // Another key only leaves the confirmation; the selection does not move.
    await press(app, DOWN);
    expect(frame(app)).not.toContain("y confirm");
    expect(frame(app)).toContain("› Dev server");
    expect(client.stopShellJob).not.toHaveBeenCalled();
    await press(app, "c");
    await press(app, "y");
    await press(app, "c");
    await press(app, "y");
    expect(client.stopShellJob).toHaveBeenCalledOnce();
    expect(client.stopShellJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "dev" }),
    );
    expect(frame(app)).toContain("Cancelling…");
    // While it is cancelling, the key line no longer offers `c`.
    expect(frame(app)).not.toContain("c cancel");
    finish();
    await settle();
    expect(frame(app)).toContain("Done 4");
  });

  it("lists an unconfirmed foreground command and stops tracking it after y", async () => {
    const client = fakeTaskClient([
      taskRow("left", {
        command: "npm run dev",
        mode: "foreground",
        status: "completed",
        cleanup: "unconfirmed",
        managedByCurrentBackend: false,
        canStop: false,
      }),
      taskRow("here", {
        command: "Get-ChildItem",
        mode: "foreground",
        status: "completed",
        cleanup: "unconfirmed",
        canStop: false,
      }),
    ]);
    const app = mount(client);
    await settle();
    expect(frame(app)).toContain("npm run dev");
    expect(frame(app)).toContain("Get-ChildItem");
    // Only the one an exited ohbaby left can be released.
    expect(frame(app)).toContain("u stop tracking");
    await press(app, "u");
    expect(frame(app)).toContain("Stop tracking npm run dev? y confirm");
    await press(app, "y");
    await settle();
    expect(client.abandonShellJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "left", confirm: true }),
    );
    expect(frame(app)).not.toContain("npm run dev");
    // The one this ohbaby still manages offers no release.
    expect(frame(app)).not.toContain("u stop tracking");
    await press(app, "u");
    expect(frame(app)).not.toContain("y confirm");
  });

  it("drops an unanswered confirmation after five seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = fakeTaskClient(typicalRows());
    const app = mount(client);
    await settle();
    await press(app, "c");
    expect(frame(app)).toContain("y confirm");
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 10);
    expect(frame(app)).not.toContain("y confirm");
    await press(app, "y");
    expect(client.stopShellJob).not.toHaveBeenCalled();
  });

  it("opens a detail that follows output, freezes on scroll and resumes at the bottom", async () => {
    const app = mount(fakeTaskClient(typicalRows()), { rows: 20 });
    await settle();
    await press(app, ENTER);
    await settle();
    let text = frame(app);
    expect(text).toContain("Dev server");
    expect(text).toMatch(/Running · \d/u);
    expect(text).toContain("dev line 39");
    expect(text).not.toContain("End follow");
    await press(app, "\u001b[A");
    text = frame(app);
    expect(text).not.toContain("dev line 39");
    expect(text).toContain("End follow");
    await press(app, DOWN);
    expect(frame(app)).toContain("dev line 39");
    expect(frame(app)).not.toContain("End follow");
    await press(app, ESC);
    expect(frame(app)).toContain("› Dev server");
    expect(app.onClose).not.toHaveBeenCalled();
  });

  it("cycles the owner filter when subagents have tasks and shows their names", async () => {
    const rows = [
      ...typicalRows(),
      taskRow("lint", {
        description: "Lint",
        ownerKind: "subagent",
        ownerName: "code-reviewer",
        subagentId: "code-reviewer",
      }),
    ];
    const app = mount(fakeTaskClient(rows), { probe: { subagents: 1 } });
    await settle();
    expect(frame(app)).toContain("Background tasks · Main agent");
    expect(frame(app)).toContain("f filter");
    await press(app, "f");
    await settle();
    expect(frame(app)).toContain("Background tasks · Subagents");
    expect(frame(app)).toContain("code-reviewer");
    expect(frame(app)).not.toContain("Dev server");
  });

  it("starts on All when only subagents ran tasks", async () => {
    const rows = [
      taskRow("lint", {
        description: "Lint",
        ownerKind: "subagent",
        ownerName: "code-reviewer",
      }),
    ];
    const app = mount(fakeTaskClient(rows), {
      probe: { main: 0, subagents: 1 },
    });
    await settle();
    expect(frame(app)).toContain("Background tasks · All");
    expect(frame(app)).toContain("Lint");
  });

  it("says the terminal is too small below 40 columns of content", async () => {
    const app = mount(fakeTaskClient(typicalRows()), { columns: 40 });
    await settle();
    expect(frame(app).trim()).toBe("Terminal too small");
    await press(app, "c");
    await press(app, ESC);
    expect(app.onClose).toHaveBeenCalledOnce();
  });

  it("keeps a load error with its retry hint across other keys", async () => {
    const client = fakeTaskClient(typicalRows());
    client.listShellJobs.mockRejectedValueOnce(new Error("Daemon offline"));
    const app = mount(client);
    await settle();
    expect(frame(app)).toContain("Daemon offline · r retry");
    await press(app, DOWN);
    expect(frame(app)).toContain("r retry");
    await press(app, "r");
    await settle();
    expect(frame(app)).not.toContain("Daemon offline");
    expect(frame(app)).toContain("Running 2");
  });

  it("does not treat modified letter keys as cancel or confirmation", async () => {
    const client = fakeTaskClient(typicalRows());
    const app = mount(client);
    await settle();
    await press(app, "\u0003"); // Ctrl+C
    expect(frame(app)).not.toContain("y confirm");
    await press(app, "c");
    expect(frame(app)).toContain("y confirm");
    await press(app, "\u0019"); // Ctrl+Y only backs out of the confirmation.
    expect(frame(app)).not.toContain("y confirm");
    expect(client.stopShellJob).not.toHaveBeenCalled();
    await press(app, "c");
    await press(app, "Y");
    expect(client.stopShellJob).toHaveBeenCalledOnce();
  });

  it.each(["AbortError", "TimeoutError"])(
    "restores cancel and permits retry after an unanswered stop (%s)",
    async (errorName) => {
      const timeout = new AbortController();
      const timer = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValueOnce(timeout.signal);
      const client = fakeTaskClient(typicalRows());
      client.stopShellJob.mockImplementationOnce(
        (input) =>
          new Promise((_resolve, reject) => {
            input.signal?.addEventListener(
              "abort",
              () => {
                reject(new DOMException("Aborted", errorName));
              },
              { once: true },
            );
          }),
      );
      const app = mount(client);
      await settle();
      await press(app, "c");
      await press(app, "y");
      expect(frame(app)).toContain("Cancelling…");
      timeout.abort();
      await settle();
      expect(frame(app)).toContain(
        "System didn't respond to Cancel. Try again.",
      );
      expect(frame(app)).toContain("c cancel");
      expect(timer).toHaveBeenCalledWith(10_000);
      await press(app, "c");
      await press(app, "y");
      expect(client.stopShellJob).toHaveBeenCalledTimes(2);
      expect(frame(app)).not.toContain("System didn't respond");
      expect(frame(app)).toContain("Done 4");
    },
  );

  it("does not report a timeout after output confirms the stop took effect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
    const client = fakeTaskClient(typicalRows());
    const stop = client.stopShellJob.getMockImplementation();
    if (!stop) throw new Error("Missing stop implementation");
    client.stopShellJob.mockImplementationOnce(async (input) => {
      await stop(input);
      return new Promise((_resolve, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    });
    const app = mount(client);
    await settle();
    await press(app, ENTER);
    await press(app, "c");
    await press(app, "y");
    await vi.advanceTimersByTimeAsync(2100);
    await settle();
    expect(frame(app)).toContain("Cancelled by you");
    timeout.abort();
    await settle();
    expect(frame(app)).not.toContain("System didn't respond");
    expect(frame(app)).not.toContain("c cancel");
  });

  it("reads terminal output until the final tail is ready, then stops polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const client = fakeTaskClient([taskRow("done", { status: "completed" })]);
    const partial = await client.getShellJobOutput({
      rootSessionId: "root",
      jobId: "done",
    });
    client.getShellJobOutput.mockClear();
    client.getShellJobOutput.mockResolvedValueOnce({
      ...partial,
      output: "PARTIAL OUTPUT",
    });
    client.getShellJobOutput.mockResolvedValue({
      ...partial,
      job: { ...partial.job, resultReadyAt: 1 },
      output: "FINAL OUTPUT",
    });
    const app = mount(client);
    await settle();
    await press(app, ENTER);
    expect(frame(app)).toContain("PARTIAL OUTPUT");
    await vi.advanceTimersByTimeAsync(2100);
    await settle();
    expect(frame(app)).toContain("FINAL OUTPUT");
    await vi.advanceTimersByTimeAsync(4100);
    expect(client.getShellJobOutput).toHaveBeenCalledTimes(2);
  });

  it("shows a missing task instead of stale details and refreshes the list", async () => {
    const client = fakeTaskClient(typicalRows());
    client.getShellJobOutput.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "SHELL_JOB_NOT_FOUND" }),
    );
    const app = mount(client);
    await settle();
    const initialReads = client.listShellJobs.mock.calls.length;
    await press(app, ENTER);
    expect(frame(app)).toContain("This task is no longer available.");
    expect(frame(app)).not.toContain("Running ·");
    expect(frame(app)).not.toContain("c cancel");
    expect(client.listShellJobs.mock.calls.length).toBeGreaterThan(
      initialReads,
    );
    await press(app, "c");
    await press(app, "y");
    expect(client.stopShellJob).not.toHaveBeenCalled();
  });

  it("notes a pending approval", async () => {
    const app = mount(fakeTaskClient(typicalRows()), { approvalPending: true });
    await settle();
    expect(frame(app)).toContain(
      "Approval pending · Close this panel to review",
    );
  });
});

// @vitest-environment jsdom
import type {
  UiBackendClient,
  UiCompactSessionUsage,
  UiEvent,
  UiPermissionRequest,
  UiPromptEditLease,
  UiPromptSubmission,
  UiRunStatus,
  UiSnapshot,
  UiWebCommandCatalog,
} from "ohbaby-sdk";
import { createSessionSync, type UiSessionView } from "ohbaby-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OhbabyWebRuntime } from "../runtime/index.js";
import type { OhbabyWebStore } from "../store/store.js";
import { createMockSettingsApi } from "../dev/mock-settings.js";
import { SettingsLayer } from "../runtime/settings-layer.js";
import { createDraftStore } from "../store/draft.js";
import { createGlobalCatalogStore } from "../store/global-catalog.js";
import { createOhbabyWebStore } from "../store/store.js";
import { OhbabyWebApp } from "./App.js";

const timestamp = "2026-06-12T00:00:00.000Z";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

interface MountedApp {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

interface FakeRuntime {
  readonly client: UiBackendClient;
  readonly abortSession: ReturnType<
    typeof vi.fn<OhbabyWebRuntime["abortSession"]>
  >;
  readonly archiveSession: ReturnType<
    typeof vi.fn<(sessionId: string) => Promise<void>>
  >;
  readonly exportSession: ReturnType<
    typeof vi.fn<OhbabyWebRuntime["exportSession"]>
  >;
  readonly compactSession: ReturnType<
    typeof vi.fn<UiBackendClient["compactSession"]>
  >;
  readonly createSession: ReturnType<
    typeof vi.fn<OhbabyWebRuntime["createSession"]>
  >;
  readonly executeSlashCommand: ReturnType<
    typeof vi.fn<OhbabyWebRuntime["executeSlashCommand"]>
  >;
  readonly editQueuedPrompt: ReturnType<
    typeof vi.fn<UiBackendClient["editQueuedPrompt"]>
  >;
  readonly connectModel: ReturnType<
    typeof vi.fn<UiBackendClient["connectModel"]>
  >;
  readonly listCommands: ReturnType<
    typeof vi.fn<OhbabyWebRuntime["listWebCommands"]>
  >;
  readonly hideWorkspace: ReturnType<
    typeof vi.fn<OhbabyWebRuntime["hideWorkspace"]>
  >;
  readonly getDirectoryPickerRoots: ReturnType<
    typeof vi.fn<OhbabyWebRuntime["getDirectoryPickerRoots"]>
  >;
  readonly listDirectoryPicker: ReturnType<
    typeof vi.fn<OhbabyWebRuntime["listDirectoryPicker"]>
  >;
  readonly openFolder: ReturnType<typeof vi.fn<OhbabyWebRuntime["openFolder"]>>;
  readonly openDraft: ReturnType<typeof vi.fn<OhbabyWebRuntime["openDraft"]>>;
  readonly runtime: OhbabyWebRuntime;
  readonly selectSession: ReturnType<
    typeof vi.fn<OhbabyWebRuntime["selectSession"]>
  >;
  readonly setPermission: ReturnType<
    typeof vi.fn<UiBackendClient["setPermission"]>
  >;
  readonly setSearchApiKey: ReturnType<
    typeof vi.fn<UiBackendClient["setSearchApiKey"]>
  >;
  readonly submitPromptAccepted: ReturnType<
    typeof vi.fn<UiBackendClient["submitPromptAccepted"]>
  >;
  readonly store: OhbabyWebStore;
}

const mountedApps: MountedApp[] = [];

it("keeps in-flight submissions out of recovery reminders without enabling resends", async () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  fake.store.setUnknownPromptRequests([
    {
      directory: "/repo-a",
      runtimeEpoch: "epoch",
      clientRequestId: "in-flight",
      sessionId: "session_1",
      status: "unknown",
      submitting: true,
    },
  ]);
  const app = mountApp(fake.runtime);
  await setTextareaValue(app.container, "another prompt");
  expect(app.container.textContent).not.toContain(
    "Submission result is unknown",
  );
  expect(app.container.textContent).not.toContain("Check submission");
  expect(app.container.textContent).not.toContain("Forget pending submission");
  expect(
    app.container.querySelector(".ohb-send-button")?.hasAttribute("disabled"),
  ).toBe(true);
});

it("shows only unresolved reminders while another submission is in flight", () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  const request = {
    directory: "/repo-a",
    runtimeEpoch: "epoch",
    sessionId: "session_1",
    status: "unknown" as const,
  };
  fake.store.setUnknownPromptRequests([
    { ...request, clientRequestId: "in-flight", submitting: true },
    { ...request, sessionId: "other-session", clientRequestId: "unresolved" },
  ]);
  const forget = vi.spyOn(fake.runtime, "forgetUnknownPrompt");
  const app = mountApp(fake.runtime);
  const buttons = [...app.container.querySelectorAll("button")].filter(
    (button) => button.textContent === "Forget pending submission",
  );
  expect(buttons).toHaveLength(1);
  act(() => {
    buttons[0]?.click();
  });
  expect(forget).toHaveBeenCalledWith("unresolved");
});

it("keeps a confirmed backend restart visible even before the POST settles", () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  fake.store.setUnknownPromptRequests([
    {
      directory: "/repo-a",
      runtimeEpoch: "old-epoch",
      clientRequestId: "restarted",
      sessionId: "session_1",
      status: "epoch-changed",
      submitting: true,
    },
  ]);
  const app = mountApp(fake.runtime);
  expect(app.container.textContent).toContain("The backend restarted");
  const forget = [...app.container.querySelectorAll("button")].find(
    (button) => button.textContent === "Forget pending submission",
  );
  expect(forget?.disabled).toBe(true);
});

it("offers explicit forgetting without resubmitting or cancelling an unknown prompt", () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  const forget = vi.spyOn(fake.runtime, "forgetUnknownPrompt");
  const submit = vi.spyOn(fake.client, "submitPromptAccepted");
  fake.runtime.store.setUnknownPromptRequests([
    {
      directory: "/repo-a",
      runtimeEpoch: "epoch",
      clientRequestId: "pending-one",
      sessionId: "session_1",
      status: "unknown",
    },
  ]);
  const app = mountApp(fake.runtime);
  const button = [...app.container.querySelectorAll("button")].find(
    (item) => item.textContent === "Forget pending submission",
  );
  expect(button).toBeDefined();
  act(() => button?.click());
  expect(forget).toHaveBeenCalledWith("pending-one");
  expect(submit).not.toHaveBeenCalled();
  expect(fake.abortSession).not.toHaveBeenCalled();
});

it.each(["session", "empty project"] as const)(
  "renders the %s composer without a decorative prompt marker",
  (location) => {
    const base = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({
      snapshot:
        location === "session"
          ? base
          : { ...base, activeSessionId: null, sessions: [] },
    });
    const app = mountApp(fake.runtime);
    expect(
      app.container.querySelector(".ohb-composer-input textarea"),
    ).not.toBeNull();
    expect(
      app.container.querySelector(".ohb-composer-input .ohb-prompt"),
    ).toBeNull();
  },
);

afterEach(() => {
  for (const app of mountedApps.splice(0)) {
    act(() => {
      app.root.unmount();
    });
    app.container.remove();
  }
  vi.restoreAllMocks();
  globalThis.sessionStorage.clear();
});

describe("OhbabyWebApp slash command interactions", () => {
  it("sticks to growing stream content without taking back an upward scroll", async () => {
    const initial = snapshotWithStatus({ kind: "running", runId: "run_1" });
    const fake = createFakeRuntime({ snapshot: initial });
    const app = mountApp(fake.runtime);
    const stream = app.container.querySelector<HTMLElement>(".ohb-stream");
    if (!stream) {
      throw new Error("stream not found");
    }

    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1_000,
      scrollTop: 0,
    });
    await waitFor(() => stream.scrollTop === 1_000);

    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1_000,
      scrollTop: 400,
    });
    await act(async () => {
      stream.dispatchEvent(new Event("wheel"));
      stream.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });

    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1_200,
      scrollTop: 400,
    });
    act(() => {
      fake.store.replaceSnapshot(
        snapshotWithMessageText(initial, "hello expanded"),
        2,
      );
    });
    await flushTimers();
    expect(stream.scrollTop).toBe(400);

    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1_200,
      scrollTop: 800,
    });
    await act(async () => {
      stream.dispatchEvent(new Event("wheel"));
      stream.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });

    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1_400,
      scrollTop: 800,
    });
    act(() => {
      fake.store.replaceSnapshot(
        snapshotWithMessageText(initial, "hello expanded again"),
        3,
      );
    });
    await flushTimers();
    expect(stream.scrollTop).toBe(1_400);
  });

  it("lets an upward wheel leave the bottom before streamed output lands", async () => {
    const initial = snapshotWithStatus({ kind: "running", runId: "run_1" });
    const fake = createFakeRuntime({ snapshot: initial });
    const app = mountApp(fake.runtime);
    const stream = app.container.querySelector<HTMLElement>(".ohb-stream");
    if (!stream) {
      throw new Error("stream not found");
    }
    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1_000,
      scrollTop: 0,
    });
    await waitFor(() => stream.scrollTop === 1_000);

    // The wheel fires before the browser's smooth scroll moves scrollTop.
    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1_200,
      scrollTop: 600,
    });
    act(() => {
      stream.dispatchEvent(new WheelEvent("wheel", { deltaY: -20 }));
      fake.store.replaceSnapshot(
        snapshotWithMessageText(initial, "streamed token"),
        2,
      );
    });
    await flushTimers();
    expect(stream.scrollTop).toBe(600);

    // A small upward step still inside the near-bottom band must not re-stick.
    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1_200,
      scrollTop: 780,
    });
    await act(async () => {
      stream.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });
    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1_200,
      scrollTop: 770,
    });
    await act(async () => {
      stream.dispatchEvent(new WheelEvent("wheel", { deltaY: -10 }));
      stream.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });
    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1_400,
      scrollTop: 770,
    });
    act(() => {
      fake.store.replaceSnapshot(
        snapshotWithMessageText(initial, "more streamed tokens"),
        3,
      );
    });
    await flushTimers();
    expect(stream.scrollTop).toBe(770);
  });

  it.each(["wheel", "touch", "ArrowUp", "PageUp", "Home"])(
    "keeps following while %s scrolls a tool output, then stops at its upper edge",
    async (input) => {
      const base = snapshotWithStatus({ kind: "running", runId: "run_1" });
      const initial: UiSnapshot = {
        ...base,
        sessions: base.sessions.map((session) => ({
          ...session,
          messages: [
            ...session.messages.map((message) => ({
              ...message,
              id: "user_message",
            })),
            {
              id: "message_tool",
              createdAt: timestamp,
              role: "assistant",
              parts: [
                {
                  type: "tool-call",
                  call: {
                    id: "call_read",
                    name: "read",
                    input: { path: "long.txt" },
                    status: "completed",
                  },
                },
                {
                  type: "tool-result",
                  result: {
                    callId: "call_read",
                    output: "Long tool output\n".repeat(80),
                  },
                },
              ],
            },
            {
              id: "message_1",
              createdAt: timestamp,
              role: "assistant",
              parts: [{ type: "text", text: "hello" }],
            },
          ],
        })),
      };
      const fake = createFakeRuntime({ snapshot: initial });
      const app = mountApp(fake.runtime);
      act(() =>
        app.container
          .querySelector<HTMLButtonElement>(".ohb-tool-panel button")
          ?.click(),
      );
      const stream = app.container.querySelector<HTMLElement>(".ohb-stream");
      const output = app.container.querySelector<HTMLElement>(
        ".ohb-tool-output pre",
      );
      if (!stream || !output)
        throw new Error("expected stream and expanded output");
      // JSDOM has no layout or imported CSS; supply the tool output's real
      // scrolling geometry while keeping the application event handlers.
      output.style.overflowY = "auto";
      setScrollMetrics(output, {
        clientHeight: 200,
        scrollHeight: 1_000,
        scrollTop: 100,
      });
      setScrollMetrics(stream, {
        clientHeight: 400,
        scrollHeight: 1_000,
        scrollTop: 0,
      });
      await waitFor(() => stream.scrollTop === 1_000);
      const scrollUp = (): void => {
        if (input === "wheel") {
          output.dispatchEvent(
            new WheelEvent("wheel", { bubbles: true, deltaY: -20 }),
          );
        } else if (input === "touch") {
          for (const [type, y] of [
            ["touchstart", 100],
            ["touchmove", 120],
          ] as const) {
            const event = new Event(type, { bubbles: true });
            Object.defineProperty(event, "touches", {
              value: { item: () => ({ clientY: y }) },
            });
            output.dispatchEvent(event);
          }
        } else {
          output.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: input }),
          );
        }
      };
      setScrollMetrics(stream, {
        clientHeight: 400,
        scrollHeight: 1_200,
        scrollTop: 600,
      });
      act(() => {
        scrollUp();
        fake.store.replaceSnapshot(
          snapshotWithMessageText(initial, "more content"),
          2,
        );
      });
      await flushTimers();
      expect(stream.scrollTop).toBe(1_200);

      output.scrollTop = 0;
      setScrollMetrics(stream, {
        clientHeight: 400,
        scrollHeight: 1_400,
        scrollTop: 800,
      });
      act(() => {
        scrollUp();
        fake.store.replaceSnapshot(
          snapshotWithMessageText(initial, "more content again"),
          3,
        );
      });
      await flushTimers();
      expect(stream.scrollTop).toBe(800);
    },
  );

  it("keeps the scroll anchor after scrolling up while a pending prompt is still visible", async () => {
    const admission =
      deferred<Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>>();
    const initial = {
      ...snapshotWithStatus({ kind: "running", runId: "old-run" }),
      status: { kind: "idle" as const },
      runs: [],
    };
    const fake = createFakeRuntime({ snapshot: initial });
    fake.submitPromptAccepted.mockReturnValue(admission.promise);
    const app = mountApp(fake.runtime);
    await setTextareaValue(app.container, "pending");
    await pressTextareaKey(app.container, "Enter");
    const stream = app.container.querySelector<HTMLElement>(".ohb-stream");
    if (!stream) throw new Error("missing stream");
    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1000,
      scrollTop: 0,
    });
    await flushTimers();
    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1000,
      scrollTop: 400,
    });
    act(() => {
      stream.dispatchEvent(new Event("wheel"));
      stream.dispatchEvent(new Event("scroll"));
    });
    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1200,
      scrollTop: 400,
    });
    act(() => {
      fake.store.replaceSnapshot(
        snapshotWithMessageText(initial, "new live content"),
        2,
      );
    });
    await flushTimers();
    expect(stream.scrollTop).toBe(400);
  });
  it("does not restore a late rejected submission into a different session draft", async () => {
    const admission =
      deferred<Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>>();
    const initial = {
      ...snapshotWithStatus({ kind: "idle" }),
      activeSessionId: null,
    };
    const fake = createFakeRuntime({ snapshot: initial });
    fake.submitPromptAccepted.mockReturnValue(admission.promise);
    const app = mountApp(fake.runtime);
    await setTextareaValue(app.container, "original new-session prompt");
    await pressTextareaKey(app.container, "Enter");
    act(() => {
      fake.store.replaceSnapshot(
        { ...initial, activeSessionId: "session_1" },
        2,
      );
    });
    await act(async () => {
      admission.reject(new Error("response lost"));
      await admission.promise.catch(() => undefined);
    });
    expect(textareaValue(app.container)).toBe("");
    act(() => {
      fake.store.replaceSnapshot(initial, 3);
    });
    expect(textareaValue(app.container)).toBe("original new-session prompt");
  });
  it("resets stick-to-bottom when the active session changes", async () => {
    const initial = snapshotWithStatus({ kind: "running", runId: "run_1" });
    const fake = createFakeRuntime({ snapshot: initial });
    const app = mountApp(fake.runtime);
    const stream = app.container.querySelector<HTMLElement>(".ohb-stream");
    if (!stream) {
      throw new Error("stream not found");
    }

    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1_000,
      scrollTop: 400,
    });
    await act(async () => {
      stream.dispatchEvent(new Event("scroll"));
      await Promise.resolve();
    });

    const nextSession = {
      createdAt: timestamp,
      id: "session_2",
      messages: [
        {
          createdAt: timestamp,
          id: "message_2",
          parts: [{ text: "session two", type: "text" as const }],
          role: "user" as const,
        },
      ],
      title: "Session 2",
      updatedAt: timestamp,
    };
    setScrollMetrics(stream, {
      clientHeight: 400,
      scrollHeight: 1_600,
      scrollTop: 400,
    });
    act(() => {
      fake.store.replaceSnapshot(
        {
          ...initial,
          activeSessionId: "session_2",
          sessions: [...initial.sessions, nextSession],
        },
        2,
      );
    });
    await flushTimers();
    expect(stream.scrollTop).toBe(1_600);
  });

  it("uses a fixed placeholder instead of an animated typewriter", () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);
    const textarea = app.container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("textarea not found");
    }
    expect(textarea.placeholder).toMatch(
      /^(Describe a task|Follow up), or type \/ for commands$/u,
    );
    expect(app.container.querySelector(".ohb-composer-typewriter")).toBeNull();
  });

  it("renders icon-only send and stop actions", async () => {
    const idleFake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const idleApp = mountApp(idleFake.runtime);
    await setTextareaValue(idleApp.container, "send this");
    const sendButton = idleApp.container.querySelector(".ohb-send-button");
    expect(sendButton?.querySelector("span")).toBeNull();
    expect(sendButton?.textContent).not.toContain("Send");

    globalThis.sessionStorage.clear();
    const runningFake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
    });
    const runningApp = mountApp(runningFake.runtime);
    const stopButton = runningApp.container.querySelector(".ohb-stop-button");
    if (!(stopButton instanceof HTMLButtonElement)) {
      throw new Error("stop button not found");
    }
    expect(stopButton.querySelector("span")).toBeNull();
    expect(stopButton.textContent).not.toContain("Stop");
    await act(async () => {
      stopButton.click();
      await Promise.resolve();
    });
    expect(runningFake.abortSession).toHaveBeenCalledWith("session_1", "run_1");
  });

  it("fits the composer textarea to one through seven visual lines", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);
    const textarea = app.container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("textarea not found");
    }
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 72,
    });
    await setTextareaValue(app.container, "line one\nline two\nline three");
    expect(textarea.style.height).toBe("72px");
    expect(textarea.style.overflowY).toBe("hidden");

    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      value: 300,
    });
    await setTextareaValue(
      app.container,
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten",
    );
    expect(textarea.style.height).toBe("168px");
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("keeps static placeholders for running and unavailable composer states", () => {
    const running = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
    });
    const runningApp = mountApp(running.runtime);
    const runningTextarea = runningApp.container.querySelector("textarea");
    expect(runningTextarea?.getAttribute("placeholder")).toBe(
      "Steer now or queue a follow-up...",
    );

    const unavailable = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
    });
    unavailable.store.setConnectionState("disconnected");
    const unavailableApp = mountApp(unavailable.runtime);
    const unavailableTextarea =
      unavailableApp.container.querySelector("textarea");
    expect(unavailableTextarea?.getAttribute("placeholder")).toBe(
      "Draft while reconnecting…",
    );
  });

  it("does not send or prevent default while an IME is composing", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);
    await setTextareaValue(app.container, "hello");

    const composingEnter = await pressComposingTextareaKey(
      app.container,
      "Enter",
    );
    expect(fake.submitPromptAccepted).not.toHaveBeenCalled();
    expect(composingEnter.defaultPrevented).toBe(false);

    const legacyComposingEnter = await pressComposingTextareaKey(
      app.container,
      "Enter",
      229,
    );
    expect(fake.submitPromptAccepted).not.toHaveBeenCalled();
    expect(legacyComposingEnter.defaultPrevented).toBe(false);
  });

  it("does not execute a slash command while an IME is composing", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["status"]));
    const app = mountApp(fake.runtime);
    await setTextareaValue(app.container, "/");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-slash-palette")),
    );

    const composingEnter = await pressComposingTextareaKey(
      app.container,
      "Enter",
    );
    expect(fake.submitPromptAccepted).not.toHaveBeenCalled();
    expect(composingEnter.defaultPrevented).toBe(false);
  });

  it("renders all active-session todos and collapses to the current task", async () => {
    const todos = Array.from({ length: 10 }, (_, index) => ({
      content: `task ${String(index + 1)}`,
      status:
        index === 0
          ? ("completed" as const)
          : index === 1
            ? ("in_progress" as const)
            : ("pending" as const),
    }));
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "running", runId: "run_1" }),
        todos: [
          {
            sessionId: "session_other",
            todos: [{ content: "not active", status: "pending" }],
            visible: true,
          },
          { sessionId: "session_1", todos, visible: true },
        ],
      },
    });
    const app = mountApp(fake.runtime);
    const items = Array.from(
      app.container.querySelectorAll<HTMLElement>(".ohb-todo-item"),
    );

    expect(items).toHaveLength(10);
    expect(items.map((item) => item.textContent)).toEqual(
      todos.map(
        (todo) =>
          `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "●" : "○"}${todo.content}`,
      ),
    );
    expect(app.container.textContent).not.toContain("not active");
    const dock = app.container.querySelector(".ohb-todo-dock");
    const scrollRegion = app.container.querySelector(".ohb-todo-items");
    const composerInput = app.container.querySelector(".ohb-composer-input");
    expect(scrollRegion?.getAttribute("aria-label")).toBe("Todo items");
    expect(scrollRegion?.getAttribute("tabindex")).toBe("0");
    expect(app.container.textContent).toContain("1/10 completed");
    expect(
      Boolean(
        dock &&
        composerInput &&
        dock.compareDocumentPosition(composerInput) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);

    await clickButton(app.container, "Collapse todo list");
    expect(
      app.container
        .querySelector(".ohb-todo-toggle")
        ?.getAttribute("aria-expanded"),
    ).toBe("false");
    expect(app.container.querySelectorAll(".ohb-todo-item")).toHaveLength(1);
    expect(app.container.querySelector(".ohb-todo-item")?.textContent).toBe(
      "●task 2",
    );

    await clickButton(app.container, "Expand todo list");
    expect(app.container.querySelectorAll(".ohb-todo-item")).toHaveLength(10);
  });

  it("hides the todo dock from todo.updated without clearing its projection", () => {
    const todos = [{ content: "Finish UI", status: "in_progress" as const }];
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "running", runId: "run_1" }),
        todos: [{ sessionId: "session_1", todos, visible: true }],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.querySelector(".ohb-todo-dock")).not.toBeNull();
    act(() => {
      fake.store.applyEvent(
        {
          sessionId: "session_1",
          todos,
          type: "todo.updated",
          visible: false,
        },
        2,
      );
    });
    expect(app.container.querySelector(".ohb-todo-dock")).toBeNull();
    expect(fake.store.getSnapshot().view.snapshot?.todos).toEqual([
      { sessionId: "session_1", todos, visible: false },
    ]);
  });

  it("defensively filters legacy todo tool parts from the transcript", () => {
    const base = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({
      snapshot: {
        ...base,
        sessions: [
          {
            ...base.sessions[0],
            messages: [
              {
                createdAt: timestamp,
                id: "message_todo_only",
                parts: [
                  {
                    call: {
                      id: "call_todo_only",
                      input: { todos: [] },
                      name: "todo_write",
                      status: "completed",
                    },
                    type: "tool-call",
                  },
                  {
                    result: { callId: "call_todo_only", output: "No todos." },
                    type: "tool-result",
                  },
                ],
                role: "assistant",
              },
              {
                createdAt: timestamp,
                id: "message_mixed",
                parts: [
                  { text: "Visible answer", type: "text" },
                  {
                    call: {
                      id: "call_todo_mixed",
                      input: {},
                      name: "todo_read",
                      status: "completed",
                    },
                    type: "tool-call",
                  },
                  {
                    result: { callId: "call_todo_mixed", output: "No todos." },
                    type: "tool-result",
                  },
                ],
                role: "assistant",
              },
              {
                createdAt: timestamp,
                id: "message_split_result",
                parts: [
                  {
                    result: {
                      callId: "call_todo_only",
                      output: "Hidden split result",
                    },
                    type: "tool-result",
                  },
                ],
                role: "tool",
              },
            ],
          },
        ],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.textContent).toContain("Visible answer");
    expect(app.container.textContent).not.toContain("todo_read");
    expect(app.container.textContent).not.toContain("todo_write");
    expect(app.container.textContent).not.toContain("No todos.");
    expect(app.container.textContent).not.toContain("Hidden split result");
    expect(app.container.querySelectorAll(".ohb-tool-panel")).toHaveLength(0);
    expect(app.container.querySelectorAll(".ohb-message")).toHaveLength(1);
  });

  it("renders user prompts as right-aligned bubbles without role labels", () => {
    const base = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({
      snapshot: {
        ...base,
        sessions: [
          {
            ...base.sessions[0],
            messages: [
              {
                createdAt: timestamp,
                id: "message_user",
                parts: [{ text: "Please inspect this", type: "text" }],
                role: "user",
              },
              {
                createdAt: timestamp,
                id: "message_assistant",
                parts: [{ text: "I will inspect it.", type: "text" }],
                role: "assistant",
              },
              {
                createdAt: timestamp,
                id: "message_system",
                parts: [{ text: "System note", type: "text" }],
                role: "system",
              },
            ],
          },
        ],
      },
    });
    const app = mountApp(fake.runtime);

    expect(
      app.container.querySelector(".ohb-message-user-bubble")?.textContent,
    ).toContain("Please inspect this");
    expect(
      app.container.querySelector(".ohb-message-assistant-bare")?.textContent,
    ).toContain("I will inspect it.");
    expect(
      app.container
        .querySelector(".ohb-message-user")
        ?.getAttribute("aria-label"),
    ).toBe("User message");
    expect(
      app.container
        .querySelector(".ohb-message-assistant")
        ?.getAttribute("aria-label"),
    ).toBe("Assistant message");
    expect(
      app.container
        .querySelector(".ohb-message-system")
        ?.getAttribute("aria-label"),
    ).toBe("System message");
    expect(app.container.querySelector(".ohb-message-label")).toBeNull();
    expect(app.container.textContent).not.toContain("OHBABY");
    expect(app.container.textContent).not.toContain("YOU");
  });

  it("keeps an expanded tool panel attached to its call when parts reorder", async () => {
    const base = snapshotWithStatus({ kind: "idle" });
    const toolA = {
      call: {
        id: "call_a",
        input: { path: "a.txt" },
        name: "tool_a",
        status: "completed" as const,
      },
      type: "tool-call" as const,
    };
    const toolB = {
      call: {
        id: "call_b",
        input: { path: "b.txt" },
        name: "tool_b",
        status: "completed" as const,
      },
      type: "tool-call" as const,
    };
    const withParts = (
      parts: readonly (typeof toolA | typeof toolB)[],
    ): UiSnapshot => ({
      ...base,
      sessions: [
        {
          ...base.sessions[0],
          messages: [
            {
              createdAt: timestamp,
              id: "message_tools",
              parts,
              role: "assistant" as const,
            },
          ],
        },
      ],
    });
    const fake = createFakeRuntime({ snapshot: withParts([toolA, toolB]) });
    const app = mountApp(fake.runtime);
    const panelByTitle = (title: string): HTMLElement => {
      const panel = Array.from(
        app.container.querySelectorAll<HTMLElement>(".ohb-tool-panel"),
      ).find((candidate) =>
        candidate.querySelector("button")?.textContent.includes(title),
      );
      if (!panel) throw new Error(`tool panel not found: ${title}`);
      return panel;
    };

    await act(async () => {
      panelByTitle("tool_a").querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(
      panelByTitle("tool_a").querySelector("pre")?.textContent ?? "",
    ).toContain("a.txt");

    act(() => {
      fake.store.replaceSnapshot(withParts([toolB, toolA]), 2);
    });

    expect(
      panelByTitle("tool_a").querySelector("pre")?.textContent ?? "",
    ).toContain("a.txt");
    expect(panelByTitle("tool_b").querySelector("pre")).toBeNull();
  });

  it("keeps a failed tool call quiet until the user expands it", async () => {
    const base = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({
      snapshot: {
        ...base,
        sessions: [
          {
            ...base.sessions[0],
            messages: [
              {
                createdAt: timestamp,
                id: "message_failed_tool",
                parts: [
                  {
                    call: {
                      id: "call_bash",
                      input: { command: "false" },
                      name: "bash",
                      status: "failed",
                    },
                    type: "tool-call",
                  },
                  {
                    result: {
                      callId: "call_bash",
                      error: "exit code 1",
                      output: "stderr text",
                    },
                    type: "tool-result",
                  },
                ],
                role: "assistant",
              },
            ],
          },
        ],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.querySelectorAll(".ohb-tool-panel")).toHaveLength(1);
    expect(app.container.textContent).not.toContain("failed");
    expect(app.container.textContent).not.toContain("stderr text");
    expect(app.container.textContent).not.toContain("call_bash");

    await act(async () => {
      app.container
        .querySelector<HTMLButtonElement>(".ohb-tool-panel button")
        ?.click();
      await Promise.resolve();
    });

    expect(
      app.container.querySelector(".ohb-tool-input")?.textContent,
    ).toContain('"command": "false"');
    expect(
      app.container.querySelector(".ohb-tool-output")?.textContent,
    ).toContain("stderr text");
    expect(
      app.container.querySelector(".ohb-tool-output")?.textContent,
    ).toContain("exit code 1");
  });

  it("renders an adaptive queued list and expands after five items", async () => {
    const prompts = Array.from({ length: 6 }, (_, index) => ({
      clientRequestId: `request_${String(index)}`,
      createdAt: new Date(Date.parse(timestamp) + index).toISOString(),
      promptId: `prompt_${String(index)}`,
      scopeKey: "/repo-a",
      sessionId: "session_1",
      status: "queued" as const,
      text: `queued ${String(index)}`,
      updatedAt: timestamp,
      userMessageId: `message_${String(index)}`,
    }));
    const fake = createFakeRuntime({
      snapshot: { ...snapshotWithStatus({ kind: "idle" }), prompts },
    });
    const app = mountApp(fake.runtime);

    expect(
      app.container.querySelectorAll(".ohb-prompt-queue-item"),
    ).toHaveLength(5);
    await clickButton(app.container, "Show all queued prompts");
    expect(
      app.container.querySelectorAll(".ohb-prompt-queue-item"),
    ).toHaveLength(6);
  });

  it("restores a session draft without waiting for snapshot events", () => {
    globalThis.sessionStorage.setItem(
      "ohbaby:composer:session_1",
      JSON.stringify({
        clientRequestId: "request_pending",
        pendingText: "restored draft",
        text: "restored draft",
      }),
    );
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    const textarea = app.container.querySelector("textarea");
    expect(
      textarea instanceof HTMLTextAreaElement ? textarea.value : null,
    ).toBe("restored draft");
  });

  it("shows the Lychee mark and the in-flow composer when no session is selected", () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.querySelector(".ohb-main-body-empty")).not.toBeNull();
    expect(
      app.container.querySelector(".ohb-draft-hero .ohb-lychee-mark"),
    ).not.toBeNull();
    expect(
      app.container.querySelector(".ohb-draft-hero .ohb-wordmark"),
    ).toBeNull();
    expect(app.container.querySelector(".ohb-composer-hero")).not.toBeNull();
  });

  it("selects the receipt session after submitting from an empty project", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [],
      },
    });
    fake.submitPromptAccepted.mockImplementation((_text, options) =>
      Promise.resolve({
        clientRequestId: options?.clientRequestId ?? "request_generated",
        createdAt: timestamp,
        promptId: "prompt_new",
        sessionId: "session_new",
        status: "queued",
        userMessageId: "message_new",
      }),
    );
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "first prompt");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() => fake.selectSession.mock.calls.length === 1);

    expect(fake.selectSession).toHaveBeenCalledWith("session_new");
  });

  it.each(["accepted", "rejected"] as const)(
    "keeps another draft usable when the previous first prompt is %s late",
    async (outcome) => {
      const pendingReceipt =
        deferred<
          Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>
        >();
      const initial: UiSnapshot = {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [],
      };
      const fake = createFakeRuntime({ snapshot: initial });
      let requestId = "";
      fake.submitPromptAccepted.mockImplementationOnce((_text, options) => {
        requestId = options?.clientRequestId ?? "";
        return pendingReceipt.promise;
      });
      const app = mountApp(fake.runtime);

      await setTextareaValue(app.container, "slow first prompt");
      await pressTextareaKey(app.container, "Enter");
      // Exercise selection isolation independently of a replacement client.
      await act(async () => {
        await fake.runtime.openDraft(null);
        fake.store.replaceSnapshot(initial, 2);
      });
      await setTextareaValue(app.container, "new draft still being written");
      await act(async () => {
        if (outcome === "accepted") {
          pendingReceipt.resolve({
            clientRequestId: requestId,
            createdAt: timestamp,
            promptId: "prompt_late",
            sessionId: "session_late",
            status: "queued",
            userMessageId: "message_late",
          });
        } else {
          pendingReceipt.reject(new Error("old draft admission failed"));
        }
        await pendingReceipt.promise.catch(() => undefined);
      });

      expect(fake.submitPromptAccepted).toHaveBeenCalledTimes(1);
      expect(fake.selectSession).not.toHaveBeenCalled();
      expect(app.container.textContent).not.toContain("slow first prompt");
      expect(app.container.textContent).not.toContain(
        "old draft admission failed",
      );
      expect(app.container.querySelector(".ohb-draft-hero")).not.toBeNull();
      expect(
        app.container.querySelector(".ohb-workspace-picker"),
      ).not.toBeNull();
      expect(textareaValue(app.container)).toBe(
        "new draft still being written",
      );
      expect(
        app.container.querySelector<HTMLButtonElement>(".ohb-send-button")
          ?.disabled,
      ).toBe(false);

      await pressTextareaKey(app.container, "Enter");
      expect(fake.submitPromptAccepted).toHaveBeenCalledTimes(2);
      expect(fake.submitPromptAccepted.mock.calls[1]?.[0]).toBe(
        "new draft still being written",
      );
      expect(textareaValue(app.container)).toBe("");
      expect(app.container.textContent).toContain(
        "new draft still being written",
      );
    },
  );

  it("unblocks the new draft after replacing the client while a first prompt is pending", async () => {
    const initial: UiSnapshot = {
      ...snapshotWithStatus({ kind: "idle" }),
      activeSessionId: null,
      sessions: [],
    };
    const first = createFakeRuntime({ snapshot: initial });
    const second = createFakeRuntime({ snapshot: initial });
    const pendingReceipt =
      deferred<Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>>();
    first.submitPromptAccepted.mockReturnValue(pendingReceipt.promise);
    const nextReceipt =
      deferred<Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>>();
    second.submitPromptAccepted.mockReturnValue(nextReceipt.promise);
    let connectedClient = first.client;
    Object.defineProperty(first.runtime, "client", {
      get: () => connectedClient,
    });
    vi.spyOn(first.runtime, "submitPrompt").mockImplementation(
      (text, options) => connectedClient.submitPromptAccepted(text, options),
    );
    const app = mountApp(first.runtime);

    await setTextareaValue(app.container, "old client first prompt");
    await pressTextareaKey(app.container, "Enter");
    await setTextareaValue(app.container, "draft survives the client change");
    await act(async () => {
      connectedClient = second.client;
      first.store.replaceSnapshot(initial, 2);
      await Promise.resolve();
    });

    expect(app.container.textContent).not.toContain("old client first prompt");
    expect(app.container.querySelector(".ohb-draft-hero")).not.toBeNull();
    expect(app.container.querySelector(".ohb-workspace-picker")).not.toBeNull();
    expect(textareaValue(app.container)).toBe(
      "draft survives the client change",
    );
    expect(
      app.container.querySelector<HTMLButtonElement>(".ohb-send-button")
        ?.disabled,
    ).toBe(false);

    await pressTextareaKey(app.container, "Enter");
    expect(second.submitPromptAccepted.mock.calls[0]?.[0]).toBe(
      "draft survives the client change",
    );
    expect(app.container.textContent).toContain(
      "draft survives the client change",
    );
    await act(async () => {
      pendingReceipt.reject(new Error("old client failed"));
      await pendingReceipt.promise.catch(() => undefined);
    });
    expect(app.container.textContent).not.toContain("old client failed");
    expect(app.container.textContent).toContain(
      "draft survives the client change",
    );
    expect(textareaValue(app.container)).toBe("");
    expect(
      app.container
        .querySelector(".ohb-send-button")
        ?.getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("keeps the first prompt projected when its receipt automatically binds the session", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [],
      },
    });
    fake.submitPromptAccepted.mockImplementation((_text, options) => {
      // acceptBinding updates the selected session before submitPrompt resolves,
      // without advancing the runtime's user-selection generation.
      fake.store.replaceSnapshot(snapshotWithStatus({ kind: "idle" }), 2);
      return Promise.resolve({
        clientRequestId: options?.clientRequestId ?? "request_generated",
        createdAt: timestamp,
        promptId: "prompt_bound",
        sessionId: "session_1",
        status: "queued",
        userMessageId: "message_bound",
      });
    });
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "automatically bound first prompt");
    await pressTextareaKey(app.container, "Enter");

    expect(fake.selectSession).not.toHaveBeenCalled();
    expect(app.container.textContent).toContain(
      "automatically bound first prompt",
    );
    expect(
      app.container
        .querySelector(".ohb-message-pending")
        ?.getAttribute("data-user-message-id"),
    ).toBe("message_bound");
    expect(app.container.querySelector(".ohb-draft-hero")).toBeNull();
  });

  it.each(["accepted", "rejected"] as const)(
    "keeps a session prompt pending across an automatic move until it is %s",
    async (outcome) => {
      const initial = snapshotWithStatus({ kind: "idle" });
      const fake = createFakeRuntime({ snapshot: initial });
      const pendingReceipt =
        deferred<
          Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>
        >();
      fake.submitPromptAccepted.mockReturnValue(pendingReceipt.promise);
      let connectedClient = fake.client;
      Object.defineProperty(fake.runtime, "client", {
        get: () => connectedClient,
      });
      const app = mountApp(fake.runtime);

      await setTextareaValue(app.container, "prompt follows the session move");
      await pressTextareaKey(app.container, "Enter");
      const requestId =
        fake.submitPromptAccepted.mock.calls[0]?.[1]?.clientRequestId ?? "";
      // SESSION_MOVED replaces the client and resynchronizes the same session
      // inside submitPrompt, without starting a new user selection.
      await act(async () => {
        connectedClient = { ...fake.client };
        fake.store.reset();
        await Promise.resolve();
      });
      await act(async () => {
        fake.store.replaceSnapshot(initial, 2);
        fake.store.setPermissionSync({
          ...fake.store.getSnapshot().permissionSync,
          status: "ready",
        });
        fake.store.setConnectionState("live");
        await Promise.resolve();
      });

      expect(app.container.textContent).toContain(
        "prompt follows the session move",
      );
      expect(
        app.container
          .querySelector(".ohb-send-button")
          ?.getAttribute("aria-busy"),
      ).toBe("true");
      await setTextareaValue(app.container, "next draft stays here");
      expect(
        app.container.querySelector<HTMLButtonElement>(".ohb-send-button")
          ?.disabled,
      ).toBe(true);
      await pressTextareaKey(app.container, "Enter");
      expect(fake.submitPromptAccepted).toHaveBeenCalledTimes(1);

      await act(async () => {
        if (outcome === "accepted") {
          pendingReceipt.resolve({
            clientRequestId: requestId,
            createdAt: timestamp,
            promptId: "prompt_moved",
            sessionId: "session_1",
            status: "queued",
            userMessageId: "message_moved",
          });
        } else {
          pendingReceipt.reject(new Error("target admission failed"));
        }
        await pendingReceipt.promise.catch(() => undefined);
      });

      expect(textareaValue(app.container)).toBe("next draft stays here");
      expect(
        app.container
          .querySelector(".ohb-send-button")
          ?.getAttribute("aria-busy"),
      ).toBe("false");
      if (outcome === "rejected") {
        expect(app.container.textContent).toContain("target admission failed");
        expect(app.container.querySelector(".ohb-message-pending")).toBeNull();
      } else {
        expect(
          app.container
            .querySelector(".ohb-message-pending")
            ?.getAttribute("data-user-message-id"),
        ).toBe("message_moved");
        act(() => {
          fake.store.replaceSnapshot(
            {
              ...initial,
              prompts: [
                promptSubmission({
                  clientRequestId: requestId,
                  promptId: "prompt_moved",
                  status: "succeeded",
                  text: "prompt follows the session move",
                  userMessageId: "message_moved",
                }),
              ],
              sessions: initial.sessions.map((session) => ({
                ...session,
                messages: [
                  {
                    createdAt: timestamp,
                    id: "message_moved",
                    parts: [
                      { type: "text", text: "prompt follows the session move" },
                    ],
                    role: "user",
                  },
                ],
              })),
            },
            3,
          );
        });
        expect(app.container.querySelector(".ohb-message-pending")).toBeNull();
        expect(
          app.container.textContent.match(/prompt follows the session move/gu),
        ).toHaveLength(1);
      }
    },
  );

  it("commits the first prompt and startup feedback before admission resolves", async () => {
    const pendingReceipt =
      deferred<Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>>();
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [],
      },
    });
    fake.submitPromptAccepted.mockReturnValue(pendingReceipt.promise);
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "visible on the next frame");
    await pressTextareaKey(app.container, "Enter");

    expect(app.container.querySelector(".ohb-main-body")?.className).toContain(
      "ohb-main-body-chat",
    );
    expect(app.container.querySelector("textarea")?.textContent).toBe("");
    expect(textareaValue(app.container)).toBe("");
    expect(app.container.textContent).toContain("visible on the next frame");
    expect(
      app.container.querySelector(".ohb-message-pending-label"),
    ).toBeNull();
    expect(app.container.querySelectorAll(".ohb-thinking")).toHaveLength(0);
    expect(
      app.container
        .querySelector('.ohb-send-button[title="Send message"]')
        ?.getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("keeps an active-run follow-up in the queue instead of the conversation", async () => {
    const pendingReceipt =
      deferred<Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>>();
    const initialSnapshot = snapshotWithStatus({
      kind: "running",
      runId: "run_1",
    });
    const fake = createFakeRuntime({ snapshot: initialSnapshot });
    fake.submitPromptAccepted.mockReturnValue(pendingReceipt.promise);
    const app = mountApp(fake.runtime);

    expect(app.container.querySelectorAll(".ohb-stop-button")).toHaveLength(1);
    expect(app.container.querySelectorAll(".ohb-send-button")).toHaveLength(0);

    await setTextareaValue(app.container, "visible immediately");
    expect(app.container.querySelectorAll(".ohb-stop-button")).toHaveLength(0);
    expect(app.container.querySelectorAll(".ohb-send-button")).toHaveLength(1);
    await pressTextareaKey(app.container, "Enter");

    expect(app.container.querySelector(".ohb-message-pending")).toBeNull();
    expect(textareaValue(app.container)).toBe("");
    expect(app.container.querySelectorAll(".ohb-stop-button")).toHaveLength(1);
    expect(app.container.querySelectorAll(".ohb-send-button")).toHaveLength(0);

    await act(async () => {
      pendingReceipt.resolve({
        clientRequestId:
          fake.submitPromptAccepted.mock.calls[0]?.[1]?.clientRequestId ?? "",
        createdAt: timestamp,
        promptId: "prompt_pending",
        sessionId: "session_1",
        status: "queued",
        userMessageId: "message_pending",
      });
      await pendingReceipt.promise;
    });
    expect(app.container.querySelector(".ohb-message-pending")).toBeNull();

    await act(async () => {
      fake.store.replaceSnapshot(
        {
          ...initialSnapshot,
          prompts: [
            {
              clientRequestId:
                fake.submitPromptAccepted.mock.calls[0]?.[1]?.clientRequestId ??
                "",
              createdAt: timestamp,
              promptId: "prompt_pending",
              scopeKey: "/repo-a",
              sessionId: "session_1",
              status: "queued",
              text: "visible immediately",
              updatedAt: timestamp,
              userMessageId: "message_pending",
            },
          ],
        },
        2,
      );
      await Promise.resolve();
    });
    expect(app.container.querySelector(".ohb-message-pending")).toBeNull();
    expect(app.container.textContent).toContain("visible immediately");
    expect(
      app.container.querySelectorAll(".ohb-prompt-queue-item"),
    ).toHaveLength(1);
  });

  it("leaves transport errors to the header and words them for people", () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    act(() => {
      fake.store.setError("Failed to fetch");
      fake.store.setConnectionState("reconnecting");
    });
    expect(app.container.querySelector(".ohb-banner-error")).toBeNull();
    expect(
      app.container.querySelector(".ohb-connection-state")?.textContent,
    ).toBe("Reconnecting…");

    act(() => {
      fake.store.setConnectionState("live");
    });
    const banner = app.container.querySelector(".ohb-banner-error");
    expect(banner?.textContent).toBe(
      "Can't reach ohbaby. Check that it's still running.",
    );
    // A state error clears itself, so it offers no Dismiss that cannot work.
    expect(banner?.querySelector(".ohb-banner-close")).toBeNull();
  });

  it.each(["reconnecting", "resyncing"] as const)(
    "keeps the last-known stop action disabled while %s",
    (connectionState) => {
      const initial = snapshotWithStatus({ kind: "running", runId: "run_1" });
      const fake = createFakeRuntime({ snapshot: initial });
      const app = mountApp(fake.runtime);

      act(() => {
        fake.store.setConnectionState(connectionState);
      });
      expect(
        app.container.querySelector(".ohb-connection-state")?.textContent,
      ).toBe(connectionState === "reconnecting" ? "Reconnecting…" : "Syncing…");
      expect(app.container.querySelectorAll(".ohb-stop-button")).toHaveLength(
        1,
      );
      expect(
        app.container
          .querySelector(".ohb-stop-button")
          ?.hasAttribute("disabled"),
      ).toBe(true);
      expect(app.container.querySelectorAll(".ohb-send-button")).toHaveLength(
        0,
      );

      act(() => {
        fake.store.replaceSnapshot(snapshotWithStatus({ kind: "idle" }), 2);
        fake.store.setConnectionState("live");
      });
      expect(app.container.querySelectorAll(".ohb-stop-button")).toHaveLength(
        0,
      );
      expect(app.container.querySelectorAll(".ohb-send-button")).toHaveLength(
        1,
      );
    },
  );

  it("keeps a drafted Send disabled until reconnection restores a running snapshot", async () => {
    const initial = snapshotWithStatus({ kind: "running", runId: "run_1" });
    const fake = createFakeRuntime({ snapshot: initial });
    const app = mountApp(fake.runtime);
    await setTextareaValue(app.container, "queued after reconnect");

    act(() => {
      fake.store.setConnectionState("reconnecting");
    });
    expect(
      app.container.querySelector("textarea")?.hasAttribute("disabled"),
    ).toBe(false);
    expect(
      app.container.querySelector(".ohb-send-button")?.hasAttribute("disabled"),
    ).toBe(true);
    expect(app.container.querySelectorAll(".ohb-stop-button")).toHaveLength(0);
    expect(textareaValue(app.container)).toBe("queued after reconnect");

    act(() => {
      fake.store.replaceSnapshot(initial, 2);
      fake.store.setConnectionState("live");
    });
    expect(
      app.container.querySelector(".ohb-send-button")?.hasAttribute("disabled"),
    ).toBe(false);
    await pressTextareaKey(app.container, "Enter");
    expect(fake.submitPromptAccepted.mock.calls[0]?.[0]).toBe(
      "queued after reconnect",
    );
    expect(app.container.querySelectorAll(".ohb-stop-button")).toHaveLength(1);
  });

  it("shows Stop while a run waits for permission", () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({
        kind: "waiting-for-permission",
        requestId: "permission_1",
      }),
    });
    const app = mountApp(fake.runtime);
    expect(app.container.querySelectorAll(".ohb-stop-button")).toHaveLength(1);
    expect(app.container.querySelectorAll(".ohb-send-button")).toHaveLength(0);
  });

  it("keeps double Escape interruption available while a draft replaces Stop", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
    });
    const app = mountApp(fake.runtime);
    await setTextareaValue(app.container, "follow-up draft");

    expect(app.container.querySelectorAll(".ohb-stop-button")).toHaveLength(0);
    expect(app.container.querySelectorAll(".ohb-send-button")).toHaveLength(1);
    await pressTextareaKey(app.container, "Escape");
    expect(fake.abortSession).not.toHaveBeenCalled();
    await pressTextareaKey(app.container, "Escape");

    expect(fake.abortSession).toHaveBeenCalledTimes(1);
    expect(fake.abortSession).toHaveBeenCalledWith("session_1", "run_1");
    expect(textareaValue(app.container)).toBe("follow-up draft");
  });

  it("keeps one named Send action when idle and enables it only for a draft", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);
    expect(app.container.querySelectorAll(".ohb-stop-button")).toHaveLength(0);
    expect(app.container.querySelectorAll(".ohb-send-button")).toHaveLength(1);
    expect(
      app.container
        .querySelector(".ohb-send-button")
        ?.getAttribute("aria-label"),
    ).toBe("Send message");
    expect(
      app.container.querySelector(".ohb-send-button")?.hasAttribute("disabled"),
    ).toBe(true);

    await setTextareaValue(app.container, "ready to send");
    expect(
      app.container.querySelector(".ohb-send-button")?.hasAttribute("disabled"),
    ).toBe(false);
  });

  it("keeps a follow-up queued while the first prompt is starting before a run appears", async () => {
    const initial = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({ snapshot: initial });
    fake.submitPromptAccepted.mockImplementation((text, options) =>
      Promise.resolve({
        clientRequestId: options?.clientRequestId ?? "request_missing",
        createdAt: timestamp,
        promptId:
          text === "first starting prompt"
            ? "prompt_starting"
            : "prompt_follow_up",
        sessionId: "session_1",
        status: "queued",
        userMessageId:
          text === "first starting prompt"
            ? "message_starting"
            : "message_follow_up",
      }),
    );
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "first starting prompt");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() => fake.submitPromptAccepted.mock.calls.length === 1);
    const firstRequestId =
      fake.submitPromptAccepted.mock.calls[0]?.[1]?.clientRequestId ?? "";
    act(() => {
      fake.store.replaceSnapshot(
        {
          ...initial,
          prompts: [
            promptSubmission({
              clientRequestId: firstRequestId,
              promptId: "prompt_starting",
              status: "starting",
              text: "first starting prompt",
              userMessageId: "message_starting",
            }),
          ],
        },
        2,
      );
    });
    await flushTimers();

    await setTextareaValue(app.container, "follow-up during starting");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() => fake.submitPromptAccepted.mock.calls.length === 2);
    const secondRequestId =
      fake.submitPromptAccepted.mock.calls[1]?.[1]?.clientRequestId ?? "";
    act(() => {
      fake.store.replaceSnapshot(
        {
          ...initial,
          prompts: [
            promptSubmission({
              clientRequestId: firstRequestId,
              promptId: "prompt_starting",
              status: "starting",
              text: "first starting prompt",
              userMessageId: "message_starting",
            }),
            promptSubmission({
              clientRequestId: secondRequestId,
              promptId: "prompt_follow_up",
              status: "queued",
              text: "follow-up during starting",
              userMessageId: "message_follow_up",
            }),
          ],
        },
        3,
      );
    });
    await flushTimers();

    expect(app.container.querySelectorAll(".ohb-message-pending")).toHaveLength(
      1,
    );
    expect(
      app.container.querySelectorAll(".ohb-prompt-queue-item"),
    ).toHaveLength(1);
    expect(
      app.container.textContent.match(/follow-up during starting/gu),
    ).toHaveLength(1);
  });

  it("does not project a pending existing-session prompt into the new-session scope", async () => {
    const admission =
      deferred<Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>>();
    const initial = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({ snapshot: initial });
    fake.submitPromptAccepted.mockReturnValue(admission.promise);
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "belongs to session one");
    await pressTextareaKey(app.container, "Enter");
    act(() => {
      fake.store.replaceSnapshot(
        {
          ...initial,
          activeSessionId: null,
        },
        2,
      );
    });

    expect(app.container.textContent).not.toContain("belongs to session one");
    expect(app.container.querySelector(".ohb-thinking")).toBeNull();
    expect(
      app.container
        .querySelector(".ohb-send-button")
        ?.getAttribute("aria-busy"),
    ).toBe("false");
    await setTextareaValue(app.container, "new-session submission");
    await pressTextareaKey(app.container, "Enter");
    expect(fake.submitPromptAccepted).toHaveBeenCalledTimes(2);
  });

  it("does not project a pending new-session prompt into a historical session", async () => {
    const admission =
      deferred<Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>>();
    const initial = {
      ...snapshotWithStatus({ kind: "idle" }),
      activeSessionId: null,
    };
    const fake = createFakeRuntime({ snapshot: initial });
    fake.submitPromptAccepted.mockReturnValue(admission.promise);
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "belongs to a new session");
    await pressTextareaKey(app.container, "Enter");
    act(() => {
      fake.store.replaceSnapshot(
        {
          ...initial,
          activeSessionId: "session_1",
        },
        2,
      );
    });

    expect(app.container.textContent).not.toContain("belongs to a new session");
    expect(app.container.querySelector(".ohb-thinking")).toBeNull();
    expect(
      app.container
        .querySelector(".ohb-send-button")
        ?.getAttribute("aria-busy"),
    ).toBe("false");
    await setTextareaValue(app.container, "historical-session submission");
    await pressTextareaKey(app.container, "Enter");
    expect(fake.submitPromptAccepted).toHaveBeenCalledTimes(2);
  });

  it("stops admission at the receipt while session selection is still pending", async () => {
    const selection = deferred<undefined>();
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [],
      },
    });
    let selectionGeneration = 0;
    vi.spyOn(fake.runtime, "getSelectionGeneration").mockImplementation(
      () => selectionGeneration,
    );
    fake.selectSession.mockImplementation(() => {
      selectionGeneration += 1;
      return selection.promise;
    });
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "accepted before navigation");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() => fake.selectSession.mock.calls.length === 1);

    expect(
      app.container
        .querySelector(".ohb-send-button")
        ?.getAttribute("aria-busy"),
    ).toBe("false");
    expect(
      app.container
        .querySelector(".ohb-message-pending")
        ?.getAttribute("data-user-message-id"),
    ).toBe("message_1");
    expect(app.container.textContent).toContain("accepted before navigation");
    expect(
      app.container.querySelector(".ohb-message-pending-label"),
    ).toBeNull();
    expect(app.container.querySelectorAll(".ohb-thinking")).toHaveLength(0);
  });

  it("restores a rejected prompt only when the user has not typed a new draft", async () => {
    const admission =
      deferred<Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>>();
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.submitPromptAccepted.mockReturnValue(admission.promise);
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "restore me");
    await pressTextareaKey(app.container, "Enter");
    await setTextareaValue(app.container, "new draft");
    await act(async () => {
      admission.reject(new Error("admission failed"));
      await admission.promise.catch(() => undefined);
    });

    expect(textareaValue(app.container)).toBe("new draft");
    expect(app.container.querySelector(".ohb-message-pending")).toBeNull();
    expect(app.container.textContent).toContain("admission failed");
  });

  it("restores the submitted text when admission fails before new input", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.submitPromptAccepted.mockRejectedValue(new Error("offline"));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "restore after reject");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() => app.container.textContent.includes("offline"));

    expect(textareaValue(app.container)).toBe("restore after reject");
    expect(app.container.querySelector(".ohb-thinking")).toBeNull();
  });

  it("rebuilds a starting prompt without fabricating model thinking", () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        prompts: [promptSubmission({ status: "starting" })],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.textContent).toContain("server projected prompt");
    expect(app.container.querySelectorAll(".ohb-message-pending")).toHaveLength(
      1,
    );
    expect(app.container.querySelectorAll(".ohb-thinking")).toHaveLength(0);
    expect(app.container.textContent).not.toContain("starting agent");
    expect(
      app.container.querySelector(".ohb-message-pending-label"),
    ).toBeNull();
  });

  it("lets the formal message take over without fabricating model thinking", () => {
    const snapshot = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshot,
        prompts: [promptSubmission({ status: "starting" })],
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          messages: [
            {
              createdAt: timestamp,
              id: "message_projected",
              parts: [{ text: "server projected prompt", type: "text" }],
              role: "user",
            },
          ],
        })),
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.querySelector(".ohb-message-pending")).toBeNull();
    expect(app.container.querySelectorAll(".ohb-message-user")).toHaveLength(1);
    expect(app.container.querySelectorAll(".ohb-thinking")).toHaveLength(0);
  });

  it("moves a busy starting projection back to the queue", async () => {
    const starting = {
      ...snapshotWithStatus({ kind: "idle" }),
      prompts: [promptSubmission({ status: "starting" })],
    };
    const fake = createFakeRuntime({ snapshot: starting });
    const app = mountApp(fake.runtime);
    expect(app.container.querySelector(".ohb-message-pending")).not.toBeNull();

    act(() => {
      fake.store.replaceSnapshot(
        {
          ...starting,
          prompts: [promptSubmission({ status: "queued" })],
        },
        2,
      );
    });
    await flushTimers();

    expect(app.container.querySelector(".ohb-message-pending")).toBeNull();
    expect(app.container.querySelector(".ohb-thinking")).toBeNull();
    expect(
      app.container.querySelectorAll(".ohb-prompt-queue-item"),
    ).toHaveLength(1);
  });

  it("shows an accepted terminal failure inline after reload", () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        prompts: [
          promptSubmission({
            error: {
              code: "runtime_failed",
              message: "runtime could not start",
              retryable: true,
              source: "runtime",
            },
            status: "failed",
          }),
        ],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.textContent).toContain("server projected prompt");
    expect(app.container.textContent).toContain("runtime could not start");
    expect(app.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(app.container.querySelector(".ohb-thinking")).toBeNull();
  });

  it("shows an interrupted prompt inline after reload", () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        prompts: [
          promptSubmission({
            error: {
              code: "interrupted",
              message: "run was interrupted",
              retryable: true,
              source: "runtime",
            },
            status: "interrupted",
          }),
        ],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.textContent).toContain("server projected prompt");
    expect(app.container.textContent).toContain("run was interrupted");
    expect(app.container.querySelector(".ohb-thinking")).toBeNull();
  });

  it("does not retain a cancelled prompt projection after reload", () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        prompts: [promptSubmission({ status: "cancelled" })],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.textContent).not.toContain("server projected prompt");
    expect(app.container.querySelector(".ohb-message-pending")).toBeNull();
    expect(app.container.querySelector(".ohb-thinking")).toBeNull();
  });

  it("shows a persisted prompt failure beside its formal user message after reload", () => {
    const initial = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({
      snapshot: {
        ...initial,
        prompts: [
          promptSubmission({
            error: {
              code: "PROVIDER_FAILED",
              message: "Provider rejected the request",
              retryable: false,
              source: "provider",
            },
            status: "failed",
          }),
        ],
        sessions: initial.sessions.map((session) => ({
          ...session,
          messages: [
            {
              createdAt: timestamp,
              id: "message_projected",
              parts: [{ text: "server projected prompt", type: "text" }],
              role: "user",
            },
          ],
        })),
      },
    });
    const app = mountApp(fake.runtime);

    expect(
      app.container.querySelector('[role="alert"]')?.textContent,
    ).toContain("Provider rejected the request");
    expect(
      app.container.textContent.match(/server projected prompt/gu),
    ).toHaveLength(1);
  });

  it("does not show an earlier prompt failure while a newer prompt runs", () => {
    const initial = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({
      snapshot: {
        ...initial,
        prompts: [
          promptSubmission({
            error: {
              code: "PROVIDER_FAILED",
              message: "Old provider failure",
              retryable: false,
              source: "provider",
            },
            status: "failed",
          }),
          promptSubmission({
            createdAt: "2026-06-12T00:00:01.000Z",
            promptId: "prompt_next",
            status: "running",
            userMessageId: "message_next",
          }),
        ],
        sessions: initial.sessions.map((session) => ({
          ...session,
          messages: [
            {
              createdAt: timestamp,
              id: "message_projected",
              parts: [{ text: "server projected prompt", type: "text" }],
              role: "user",
            },
          ],
        })),
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("hides a prior prompt failure when a new run starts before its prompt event", () => {
    const initial = snapshotWithStatus({ kind: "running", runId: "run_next" });
    const fake = createFakeRuntime({
      snapshot: {
        ...initial,
        prompts: [
          promptSubmission({
            error: {
              code: "PROVIDER_FAILED",
              message: "Old provider failure",
              retryable: false,
              source: "provider",
            },
            status: "failed",
            userMessageId: "message_1",
          }),
        ],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not retain a succeeded prompt when no formal row is present", () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        prompts: [promptSubmission({ status: "succeeded" })],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.textContent).not.toContain("server projected prompt");
    expect(app.container.querySelector(".ohb-message-pending")).toBeNull();
    expect(app.container.querySelector(".ohb-thinking")).toBeNull();
  });

  it("orders an earlier terminal projection before later formal messages", () => {
    const initial = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({
      snapshot: {
        ...initial,
        prompts: [
          promptSubmission({
            createdAt: "2026-06-12T00:00:01.000Z",
            error: {
              code: "runtime_failed",
              message: "earlier failure",
              retryable: true,
              source: "runtime",
            },
            status: "failed",
            text: "earlier failed prompt",
          }),
        ],
        sessions: initial.sessions.map((session) => ({
          ...session,
          messages: [
            {
              createdAt: "2026-06-12T00:00:02.000Z",
              id: "message_later",
              parts: [{ text: "later formal message", type: "text" }],
              role: "user",
            },
          ],
        })),
      },
    });
    const app = mountApp(fake.runtime);
    const timelineText =
      app.container.querySelector(".ohb-stream-inner")?.textContent ?? "";

    expect(timelineText.indexOf("earlier failed prompt")).toBeLessThan(
      timelineText.indexOf("later formal message"),
    );
  });

  it("keeps an idle first prompt visible when queued arrives before its receipt", async () => {
    const receipt =
      deferred<Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>>();
    const initial = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({ snapshot: initial });
    fake.submitPromptAccepted.mockReturnValue(receipt.promise);
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "queued before receipt");
    await pressTextareaKey(app.container, "Enter");
    const clientRequestId =
      fake.submitPromptAccepted.mock.calls[0]?.[1]?.clientRequestId ?? "";
    act(() => {
      fake.store.replaceSnapshot(
        {
          ...initial,
          prompts: [
            promptSubmission({
              clientRequestId,
              status: "queued",
              text: "queued before receipt",
            }),
          ],
        },
        2,
      );
    });

    expect(app.container.textContent).toContain("queued before receipt");
    expect(app.container.querySelectorAll(".ohb-message-pending")).toHaveLength(
      1,
    );
    expect(app.container.querySelectorAll(".ohb-thinking")).toHaveLength(0);
    expect(
      app.container
        .querySelector(".ohb-send-button")
        ?.getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("deduplicates a formal message that arrives with starting before the receipt", async () => {
    const receipt =
      deferred<Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>>();
    const initial = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({ snapshot: initial });
    fake.submitPromptAccepted.mockReturnValue(receipt.promise);
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "formal before receipt");
    await pressTextareaKey(app.container, "Enter");
    const clientRequestId =
      fake.submitPromptAccepted.mock.calls[0]?.[1]?.clientRequestId ?? "";
    act(() => {
      fake.store.replaceSnapshot(
        {
          ...initial,
          prompts: [
            promptSubmission({
              clientRequestId,
              status: "starting",
              text: "formal before receipt",
            }),
          ],
          sessions: initial.sessions.map((session) => ({
            ...session,
            messages: [
              {
                createdAt: timestamp,
                id: "message_projected",
                parts: [{ text: "formal before receipt", type: "text" }],
                role: "user",
              },
            ],
          })),
        },
        2,
      );
    });

    expect(app.container.querySelector(".ohb-message-pending")).toBeNull();
    expect(app.container.querySelectorAll(".ohb-message-user")).toHaveLength(1);
    expect(app.container.querySelectorAll(".ohb-thinking")).toHaveLength(0);
    expect(
      app.container
        .querySelector(".ohb-send-button")
        ?.getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("shows one provisional row without model thinking when running precedes formal", async () => {
    const initial = snapshotWithStatus({ kind: "idle" });
    const running: UiSnapshot = {
      ...initial,
      prompts: [promptSubmission({ status: "running" })],
      runs: [
        {
          id: "run_projected",
          sessionId: "session_1",
          startedAt: timestamp,
          status: { kind: "running", runId: "run_projected" },
          updatedAt: timestamp,
        },
      ],
      status: { kind: "running", runId: "run_projected" },
    };
    const fake = createFakeRuntime({ snapshot: running });
    const app = mountApp(fake.runtime);

    expect(app.container.querySelectorAll(".ohb-message-pending")).toHaveLength(
      1,
    );
    expect(app.container.querySelectorAll(".ohb-thinking")).toHaveLength(0);
    expect(app.container.textContent).not.toContain(
      "double click esc to interrupt",
    );
    expect(app.container.querySelector(".ohb-composer-hint")).toBeNull();

    act(() => {
      fake.store.replaceSnapshot(
        {
          ...running,
          sessions: running.sessions.map((session) => ({
            ...session,
            messages: [
              {
                createdAt: timestamp,
                id: "message_projected",
                parts: [{ text: "server projected prompt", type: "text" }],
                role: "user",
              },
            ],
          })),
        },
        2,
      );
    });
    await flushTimers();

    expect(app.container.querySelector(".ohb-message-pending")).toBeNull();
    expect(app.container.querySelectorAll(".ohb-message-user")).toHaveLength(1);
    expect(app.container.querySelectorAll(".ohb-thinking")).toHaveLength(0);
  });

  it("keeps keyed consecutive submissions in conversation and queue placements", async () => {
    const initial = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({ snapshot: initial });
    fake.submitPromptAccepted.mockImplementation((text, options) =>
      Promise.resolve({
        clientRequestId: options?.clientRequestId ?? "request_missing",
        createdAt: timestamp,
        promptId: text === "first" ? "prompt_first" : "prompt_second",
        sessionId: "session_1",
        status: "queued",
        userMessageId: text === "first" ? "message_first" : "message_second",
      }),
    );
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "first");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() => fake.submitPromptAccepted.mock.calls.length === 1);
    await setTextareaValue(app.container, "second");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() => fake.submitPromptAccepted.mock.calls.length === 2);
    const firstRequestId =
      fake.submitPromptAccepted.mock.calls[0]?.[1]?.clientRequestId ?? "";
    const secondRequestId =
      fake.submitPromptAccepted.mock.calls[1]?.[1]?.clientRequestId ?? "";
    act(() => {
      fake.store.replaceSnapshot(
        {
          ...initial,
          prompts: [
            promptSubmission({
              clientRequestId: firstRequestId,
              promptId: "prompt_first",
              status: "starting",
              text: "first",
              userMessageId: "message_first",
            }),
            promptSubmission({
              clientRequestId: secondRequestId,
              promptId: "prompt_second",
              status: "queued",
              text: "second",
              userMessageId: "message_second",
            }),
          ],
        },
        2,
      );
    });
    await flushTimers();

    expect(app.container.querySelectorAll(".ohb-message-pending")).toHaveLength(
      1,
    );
    expect(app.container.textContent).toContain("first");
    expect(
      app.container.querySelectorAll(".ohb-prompt-queue-item"),
    ).toHaveLength(1);
    expect(app.container.textContent).toContain("second");
  });

  it("keeps an accepted prompt when selecting its session fails", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [],
      },
    });
    fake.selectSession.mockRejectedValue(new Error("navigation failed"));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "accepted despite navigation");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      app.container.textContent.includes("navigation failed"),
    );

    expect(app.container.textContent).toContain("accepted despite navigation");
    expect(
      app.container
        .querySelector(".ohb-message-pending")
        ?.getAttribute("data-user-message-id"),
    ).toBe("message_1");
    expect(textareaValue(app.container)).toBe("");
  });

  it("calculates thinking elapsed time from the actual model request and server sample", () => {
    vi.spyOn(Date, "now").mockReturnValue(999999999999);
    const initial = snapshotWithStatus({ kind: "running", runId: "run_1" });
    const fake = createFakeRuntime({
      snapshot: {
        ...initial,
        serverNow: 13000,
        runs: [
          {
            ...initial.runs[0],
            modelActivity: {
              requestId: "r",
              runId: "run_1",
              messageId: "m",
              step: 1,
              attempt: 1,
              purpose: "agent-step",
              startedAt: 1000,
              outcome: "running",
            },
          },
        ],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.querySelector(".ohb-thinking")?.textContent).toContain(
      "· 12s",
    );
  });

  it("shows automatic steer failure while preserving accepted prompt admission", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.submitPromptAccepted.mockImplementation((_text, options) =>
      Promise.resolve({
        clientRequestId: options?.clientRequestId ?? "",
        promptId: "accepted-prompt",
        userMessageId: "accepted-message",
        sessionId: "session_1",
        status: "queued",
        createdAt: timestamp,
        steer: {
          status: "error",
          error: {
            code: "STEER_FAILED",
            source: "scheduler",
            message: "Input store unavailable",
            retryable: true,
          },
        },
      }),
    );
    const app = mountApp(fake.runtime);
    await setTextareaValue(app.container, "accepted requirement");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      app.container.textContent.includes("Accepted in queue"),
    );
    expect(app.container.textContent).toContain("Input store unavailable");
    expect(textareaValue(app.container)).toBe("");
    expect(fake.submitPromptAccepted).toHaveBeenCalledTimes(1);
  });

  it("preserves the draft when the receipt request id does not match", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.submitPromptAccepted.mockResolvedValue({
      clientRequestId: "different_request",
      createdAt: timestamp,
      promptId: "prompt_other",
      sessionId: "session_1",
      status: "queued",
      userMessageId: "message_other",
    });
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "keep this draft");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      app.container.textContent.includes(
        "Prompt receipt did not match this submission",
      ),
    );

    const textarea = app.container.querySelector("textarea");
    expect(
      textarea instanceof HTMLTextAreaElement ? textarea.value : null,
    ).toBe("keep this draft");
  });

  it("restores a pending request id after leaving queued-edit mode", async () => {
    const queuedPrompt = {
      clientRequestId: "request_queued",
      createdAt: timestamp,
      promptId: "prompt_queued",
      scopeKey: "/repo-a",
      sessionId: "session_1",
      status: "queued" as const,
      text: "queued text",
      updatedAt: timestamp,
      userMessageId: "message_queued",
    };
    globalThis.sessionStorage.setItem(
      "ohbaby:composer:session_1",
      JSON.stringify({
        clientRequestId: "request_pending",
        pendingText: "pending draft",
        text: "pending draft",
      }),
    );
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "running", runId: "run_1" }),
        prompts: [queuedPrompt],
      },
    });
    vi.spyOn(fake.client, "acquirePromptEditLease").mockResolvedValue({
      editLeaseId: "lease_1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerClientId: "client_web",
      prompt: queuedPrompt,
    });
    vi.spyOn(fake.client, "releasePromptEditLease").mockResolvedValue(
      queuedPrompt,
    );
    fake.submitPromptAccepted.mockImplementation((_text, options) =>
      Promise.resolve({
        clientRequestId: options?.clientRequestId ?? "request_generated",
        createdAt: timestamp,
        promptId: "prompt_retry",
        sessionId: "session_1",
        status: "queued",
        userMessageId: "message_retry",
      }),
    );
    const app = mountApp(fake.runtime);
    const editButton = app.container.querySelector(
      '[aria-label="Edit prompt: queued text"]',
    );
    if (!(editButton instanceof HTMLButtonElement)) {
      throw new Error("queued edit button not found");
    }

    await act(async () => {
      editButton.click();
      await Promise.resolve();
    });
    await waitFor(() =>
      app.container.textContent.includes("Editing queued prompt"),
    );
    expect(app.container.querySelectorAll(".ohb-stop-button")).toHaveLength(0);
    expect(
      app.container
        .querySelector(".ohb-send-button")
        ?.getAttribute("aria-label"),
    ).toBe("Save queued prompt");
    expect(app.container.querySelector(".ohb-queued-edit-hint")).not.toBeNull();
    await pressTextareaKey(app.container, "Escape");
    expect(fake.abortSession).not.toHaveBeenCalled();
    expect(
      app.container
        .querySelector(".ohb-send-button")
        ?.getAttribute("aria-label"),
    ).toBe("Send message");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() => fake.submitPromptAccepted.mock.calls.length === 1);

    expect(fake.submitPromptAccepted).toHaveBeenCalledWith(
      "pending draft",
      expect.objectContaining({
        clientRequestId: "request_pending",
      }),
    );
  });

  it("saves an edited queued prompt from the paper-plane button without creating a new prompt", async () => {
    const queuedPrompt = {
      clientRequestId: "request_queued",
      createdAt: timestamp,
      promptId: "prompt_queued",
      scopeKey: "/repo-a",
      sessionId: "session_1",
      status: "queued" as const,
      text: "queued text",
      updatedAt: timestamp,
      userMessageId: "message_queued",
    };
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "running", runId: "run_1" }),
        prompts: [queuedPrompt],
      },
    });
    vi.spyOn(fake.client, "acquirePromptEditLease").mockResolvedValue({
      editLeaseId: "lease_1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerClientId: "client_web",
      prompt: queuedPrompt,
    });
    fake.editQueuedPrompt.mockResolvedValue({
      ...queuedPrompt,
      text: "edited queued text",
    });
    const app = mountApp(fake.runtime);
    const editButton = app.container.querySelector(
      '[aria-label="Edit prompt: queued text"]',
    );
    if (!(editButton instanceof HTMLButtonElement)) {
      throw new Error("queued edit button not found");
    }

    await act(async () => {
      editButton.click();
      await Promise.resolve();
    });
    await waitFor(() =>
      app.container.textContent.includes("Editing queued prompt"),
    );
    await setTextareaValue(app.container, "edited queued text");

    const saveButton = app.container.querySelector(
      'button[aria-label="Save queued prompt"]',
    );
    if (!(saveButton instanceof HTMLButtonElement)) {
      throw new Error("queued save button not found");
    }
    expect(saveButton.textContent).not.toContain("Save");
    await act(async () => {
      saveButton.click();
      await Promise.resolve();
    });

    await waitFor(
      () => !app.container.textContent.includes("Editing queued prompt"),
    );
    expect(fake.editQueuedPrompt).toHaveBeenCalledWith({
      editLeaseId: "lease_1",
      promptId: "prompt_queued",
      text: "edited queued text",
    });
    expect(fake.submitPromptAccepted).not.toHaveBeenCalled();
  });

  it("keeps queued edit content and hint when paper-plane save fails", async () => {
    const queuedPrompt = {
      clientRequestId: "request_queued_failure",
      createdAt: timestamp,
      promptId: "prompt_queued_failure",
      scopeKey: "/repo-a",
      sessionId: "session_1",
      status: "queued" as const,
      text: "queued text",
      updatedAt: timestamp,
      userMessageId: "message_queued_failure",
    };
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "running", runId: "run_1" }),
        prompts: [queuedPrompt],
      },
    });
    vi.spyOn(fake.client, "acquirePromptEditLease").mockResolvedValue({
      editLeaseId: "lease_failure",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerClientId: "client_web",
      prompt: queuedPrompt,
    });
    fake.editQueuedPrompt.mockRejectedValue(new Error("save failed"));
    const app = mountApp(fake.runtime);
    const editButton = app.container.querySelector(
      '[aria-label="Edit prompt: queued text"]',
    );
    if (!(editButton instanceof HTMLButtonElement)) {
      throw new Error("queued edit button not found");
    }

    await act(async () => {
      editButton.click();
      await Promise.resolve();
    });
    await waitFor(() =>
      app.container.textContent.includes("Editing queued prompt"),
    );
    await setTextareaValue(app.container, "edited queued text");
    const saveButton = app.container.querySelector(
      'button[aria-label="Save queued prompt"]',
    );
    if (!(saveButton instanceof HTMLButtonElement)) {
      throw new Error("queued save button not found");
    }

    await act(async () => {
      saveButton.click();
      await Promise.resolve();
    });
    await waitFor(() => app.container.textContent.includes("save failed"));
    expect(textareaValue(app.container)).toBe("edited queued text");
    expect(app.container.querySelector(".ohb-queued-edit-hint")).not.toBeNull();
    expect(fake.submitPromptAccepted).not.toHaveBeenCalled();
  });

  it("preserves expired editing separately from the original draft and blocks implicit submission", async () => {
    globalThis.sessionStorage.setItem(
      "ohbaby:composer:session_1",
      JSON.stringify({ text: "older draft" }),
    );
    globalThis.sessionStorage.setItem(
      "ohbaby:composer-lease:session_1",
      JSON.stringify({
        editLeaseId: "expired_lease",
        editText: "preserve edited buffer",
        expiresAt: "2026-07-12T00:00:00.000Z",
        lastActivityAt: 1,
        originalDraft: "older draft",
        promptId: "prompt_queued",
      }),
    );
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    vi.spyOn(fake.client, "renewPromptEditLease").mockRejectedValue(
      new Error("lease expired"),
    );
    const app = mountApp(fake.runtime);
    await waitFor(() =>
      app.container.textContent.includes("Edit lease expired"),
    );
    expect(textareaValue(app.container)).toBe("preserve edited buffer");
    expect(
      globalThis.sessionStorage.getItem("ohbaby:composer:session_1"),
    ).toContain("older draft");
    expect(
      globalThis.sessionStorage.getItem("ohbaby:composer-lease:session_1"),
    ).toContain("preserve edited buffer");
    await pressTextareaKey(app.container, "Enter");
    expect(fake.submitPromptAccepted).not.toHaveBeenCalled();
    await pressTextareaKey(app.container, "Escape");
    expect(textareaValue(app.container)).toBe("older draft");
  });

  it("does not acquire a second lease while another queued edit is active", async () => {
    const prompts = ["one", "two"].map((text, index) => ({
      clientRequestId: `request_${text}`,
      createdAt: timestamp,
      promptId: `prompt_${text}`,
      scopeKey: "/repo-a",
      sessionId: "session_1",
      status: "queued" as const,
      text,
      updatedAt: timestamp,
      userMessageId: `message_${String(index)}`,
    }));
    const fake = createFakeRuntime({
      snapshot: { ...snapshotWithStatus({ kind: "idle" }), prompts },
    });
    const firstPrompt = prompts[0];
    const pendingLease = deferred<UiPromptEditLease>();
    const acquire = vi
      .spyOn(fake.client, "acquirePromptEditLease")
      .mockReturnValue(pendingLease.promise);
    const lease = {
      editLeaseId: "lease_one",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerClientId: "client_web",
      prompt: firstPrompt,
    } satisfies UiPromptEditLease;
    const app = mountApp(fake.runtime);
    const editOne = app.container.querySelector(
      '[aria-label="Edit prompt: one"]',
    );
    const editTwo = app.container.querySelector(
      '[aria-label="Edit prompt: two"]',
    );
    if (
      !(editOne instanceof HTMLButtonElement) ||
      !(editTwo instanceof HTMLButtonElement)
    ) {
      throw new Error("queued edit buttons not found");
    }

    await act(async () => {
      editOne.click();
      editTwo.click();
      await Promise.resolve();
    });
    expect(acquire).toHaveBeenCalledTimes(1);
    await act(async () => {
      pendingLease.resolve(lease);
      await pendingLease.promise;
    });
    await waitFor(() => app.container.textContent.includes("editing"));
    await act(async () => {
      editTwo.click();
      await Promise.resolve();
    });

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(app.container.textContent).toContain(
      "Finish or cancel the current queued edit first.",
    );
  });

  it("does not open or execute the slash palette while disconnected", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
    });
    fake.store.setConnectionState("disconnected");
    fake.listCommands.mockResolvedValue(catalog(["status"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");

    expect(fake.listCommands).not.toHaveBeenCalled();
    expect(app.container.querySelector(".ohb-slash-palette")).toBeNull();
  });

  it("refreshes an already-open slash palette after the command catalog changes", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const nextCatalog = deferred<UiWebCommandCatalog>();
    fake.listCommands
      .mockResolvedValueOnce(catalog(["status"]))
      .mockReturnValueOnce(nextCatalog.promise);
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => fake.listCommands.mock.calls.length === 1);
    expect(slashPaletteText(app.container)).toContain("/status");

    await act(async () => {
      fake.store.applyEvent(
        {
          reason: "test",
          timestamp: Date.parse(timestamp),
          type: "command.catalog.updated",
          version: "commands-v2",
        },
        2,
      );
      await Promise.resolve();
    });

    await waitFor(() => fake.listCommands.mock.calls.length === 2);
    expect(slashPaletteText(app.container)).not.toContain("/status");
    nextCatalog.resolve(catalog(["skills"]));
    await waitFor(() => slashPaletteText(app.container).includes("/skills"));
    expect(slashPaletteText(app.container)).not.toContain("/status");
    expect(slashPaletteText(app.container)).toContain("/skills");
  });

  it("moves slash selection with PageDown and PageUp", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["skills", "status"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => selectedSlashText(app.container).includes("/skills"));

    await pressTextareaKey(app.container, "PageDown");
    expect(selectedSlashText(app.container)).toContain("/status");

    await pressTextareaKey(app.container, "PageUp");
    expect(selectedSlashText(app.container)).toContain("/skills");
  });

  it("keeps the completed command highlighted after Tab narrows the list", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["skills", "status"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => selectedSlashText(app.container).includes("/skills"));
    await pressTextareaKey(app.container, "ArrowDown");
    await pressTextareaKey(app.container, "Tab");

    expect(app.container.querySelector("textarea")?.value).toBe("/status");
    expect(selectedSlashText(app.container)).toContain("/status");
  });

  it("keeps skill commands out of the top-level slash palette", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["skills", "skill.hansun-db"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/skills"));

    expect(slashPaletteText(app.container)).toContain("/skills");
    expect(slashPaletteText(app.container)).not.toContain("/hansun-db");
  });

  it("inserts the selected skill from the skills modal with PageDown and Tab", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await showSkillsModal(fake, [
      "skill-1",
      "skill-2",
      "skill-3",
      "skill-4",
      "skill-5",
      "hansun-db",
    ]);
    await pressWindowKey("PageDown");
    await pressWindowKey("Tab");

    const textarea = app.container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("textarea not found");
    }
    expect(textarea.value).toBe("/hansun-db ");
    expect(app.container.querySelector(".ohb-command-modal")).toBeNull();
    expect(document.activeElement).toBe(textarea);
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("uses the hovered skill as the real selection before Tab insertion", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await showSkillsModal(fake, ["review", "hansun-db"]);
    const rows = Array.from(
      app.container.querySelectorAll<HTMLButtonElement>(".ohb-list-skill"),
    );
    expect(rows[0]?.getAttribute("aria-selected")).toBe("true");
    expect(rows[1]?.getAttribute("aria-selected")).toBe("false");

    await act(async () => {
      rows[1]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await Promise.resolve();
    });
    expect(rows[0]?.getAttribute("aria-selected")).toBe("false");
    expect(rows[1]?.getAttribute("aria-selected")).toBe("true");

    await pressWindowKey("Tab");
    expect(textareaValue(app.container)).toBe("/hansun-db ");
    expect(app.container.querySelector(".ohb-command-modal")).toBeNull();
    expect(document.activeElement).toBe(
      app.container.querySelector("textarea"),
    );
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("scrolls only the newly selected skill row into view", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await showSkillsModal(fake, [
      "skill-1",
      "skill-2",
      "skill-3",
      "skill-4",
      "skill-5",
      "hansun-db",
    ]);
    const rows = Array.from(
      app.container.querySelectorAll<HTMLButtonElement>(".ohb-list-skill"),
    );
    const scrollMocks = rows.map(() => vi.fn());
    rows.forEach((row, index) => {
      row.scrollIntoView = scrollMocks[index] ?? vi.fn();
    });

    await pressWindowKey("PageDown");

    expect(scrollMocks[5]).toHaveBeenCalledWith({ block: "nearest" });
    for (const mock of scrollMocks.slice(0, 5)) {
      expect(mock).not.toHaveBeenCalled();
    }

    scrollMocks.forEach((mock) => mock.mockClear());
    await act(async () => {
      fake.store.applyEvent(
        {
          reason: "unrelated rerender",
          timestamp: Date.parse(timestamp),
          type: "command.catalog.updated",
          version: "commands-v2",
        },
        4,
      );
      await Promise.resolve();
    });
    for (const mock of scrollMocks) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("resets a same-length replacement skills notice before scrolling", async () => {
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    const scrolledRows: string[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(function (this: HTMLElement) {
        scrolledRows.push(this.textContent);
      }),
    });
    try {
      const fake = createFakeRuntime({
        snapshot: snapshotWithStatus({ kind: "idle" }),
      });
      mountApp(fake.runtime);

      await showSkillsModal(fake, ["first", "second"]);
      await pressWindowKey("ArrowDown");
      scrolledRows.length = 0;

      await showSkillsModal(fake, ["next-first", "next-second"], {
        sequence: 4,
        suffix: "next",
      });

      expect(scrolledRows).toHaveLength(1);
      expect(scrolledRows[0]).toContain("/next-first");
    } finally {
      if (originalScrollIntoView) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalScrollIntoView,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("clamps every skills navigation key and inserts with Enter", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await showSkillsModal(fake, [
      "skill-1",
      "skill-2",
      "skill-3",
      "skill-4",
      "skill-5",
      "skill-6",
    ]);
    const selectedText = (): string =>
      app.container.querySelector('[aria-selected="true"]')?.textContent ?? "";

    await pressWindowKey("ArrowUp");
    expect(selectedText()).toContain("/skill-1");
    await pressWindowKey("ArrowDown");
    expect(selectedText()).toContain("/skill-2");
    await pressWindowKey("PageDown");
    expect(selectedText()).toContain("/skill-6");
    await pressWindowKey("PageDown");
    expect(selectedText()).toContain("/skill-6");
    await pressWindowKey("PageUp");
    expect(selectedText()).toContain("/skill-1");
    await pressWindowKey("PageUp");
    expect(selectedText()).toContain("/skill-1");
    await pressWindowKey("ArrowDown");
    await pressWindowKey("Enter");

    expect(textareaValue(app.container)).toBe("/skill-2 ");
    expect(app.container.querySelector(".ohb-command-modal")).toBeNull();
    expect(document.activeElement).toBe(
      app.container.querySelector("textarea"),
    );
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("closes the skills modal with Escape without changing the draft", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);
    await setTextareaValue(app.container, "keep this draft");

    await showSkillsModal(fake, ["review", "hansun-db"]);
    await pressWindowKey("Escape");

    expect(app.container.querySelector(".ohb-command-modal")).toBeNull();
    expect(textareaValue(app.container)).toBe("keep this draft");
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("renders complete scope and source metadata for skill rows", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await showSkillsModal(fake, [
      {
        description: "Review code",
        name: "review",
        scope: "project",
        source: "project-native",
      },
      {
        description: "Brainstorm ideas",
        name: "brainstorming",
        scope: "user",
      },
    ]);
    const rows = Array.from(
      app.container.querySelectorAll<HTMLButtonElement>(".ohb-list-skill"),
    );

    expect(rows[0]?.querySelector("small")?.textContent).toBe(
      "project · project-native",
    );
    expect(rows[1]?.querySelector("small")?.textContent).toBe("user");
  });

  it("inserts a clicked skill from the skills modal", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await showSkillsModal(fake, ["review", "hansun-db"]);
    const row = Array.from(
      app.container.querySelectorAll(".ohb-list-row"),
    ).find((candidate) => candidate.textContent.includes("/hansun-db"));
    if (!(row instanceof HTMLElement)) {
      throw new Error("skill row not found");
    }
    await act(async () => {
      row.click();
      await Promise.resolve();
    });

    const textarea = app.container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("textarea not found");
    }
    expect(textarea.value).toBe("/hansun-db ");
    expect(app.container.querySelector(".ohb-command-modal")).toBeNull();
    expect(document.activeElement).toBe(textarea);
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("replaces the /status context row with the seven-bucket detail", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await showStatusModal(fake);

    const contextRow = app.container.querySelector(".ohb-status-context-row");
    expect(contextRow).not.toBeNull();
    expect(
      Array.from(
        contextRow?.querySelectorAll(".ohb-context-composition-row") ?? [],
      ).map((row) => row.textContent),
    ).toEqual([
      "System prompt~10K",
      "Built-in tools~5K",
      "MCP tools~2K",
      "Skills~1K",
      "Conversation~15K",
      "Summarized conversation~4K",
      "Subagent exchanges~0",
    ]);
    expect(contextRow?.textContent).not.toContain("Cache");
    const cacheRow = Array.from(
      app.container.querySelectorAll(".ohb-status-result > div"),
    ).find((row) => row.querySelector("span")?.textContent === "cache");
    expect(
      Array.from(cacheRow?.querySelectorAll("span") ?? []).map(
        (part) => part.textContent,
      ),
    ).toEqual(["cache", "hit 61%"]);
  });

  it("renders an args hint only for slash rows that take args", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["status", "goal"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/status"));

    const rows = Array.from(
      app.container.querySelectorAll<HTMLButtonElement>(".ohb-slash-row"),
    );
    const statusRow = rows.find((row) => row.textContent.includes("/status"));
    const goalRow = rows.find((row) => row.textContent.includes("/goal"));
    expect(statusRow?.querySelector(".ohb-slash-args")).toBeNull();
    expect(
      statusRow?.querySelector(".ohb-slash-description")?.textContent,
    ).toBe("Show backend status");
    expect(goalRow?.querySelector(".ohb-slash-args")?.textContent).toBe(
      "[<objective> | status]",
    );
  });

  it("confirms full-access before changing permission policy", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    const permissionButton = app.container.querySelector<HTMLButtonElement>(
      ".ohb-permission-toggle",
    );
    expect(permissionButton?.getAttribute("aria-label")).toContain("default");
    expect(permissionButton?.getAttribute("aria-label")).toContain(
      "without approval prompts",
    );
    expect(permissionButton?.querySelector("svg")).not.toBeNull();
    expect(app.container.querySelector(".ohb-mode-button")).toBeNull();
    await clickButton(
      app.container,
      "Default: ask before protected actions. Click for full-access.",
    );

    expect(fake.setPermission).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Enable full access?");
    expect(dialog?.textContent).toContain("Not now");
    const confirm = Array.from(dialog?.querySelectorAll("button") ?? []).find(
      (button) => button.textContent === "Use full access",
    );
    expect(document.activeElement).toBe(confirm);

    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });

    expect(fake.setPermission).toHaveBeenCalledTimes(1);
    expect(fake.setPermission).toHaveBeenCalledWith({ level: "full-access" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows an empty context ring in the main header", () => {
    const snapshot = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshot,
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          messages: [
            {
              createdAt: timestamp,
              id: "message_context_pending",
              parts: [{ text: "hello", type: "text" }],
              role: "user",
            },
          ],
        })),
      },
    });
    const app = mountApp(fake.runtime);
    const header = app.container.querySelector(".ohb-main-header");

    expect(
      header?.querySelector('button[aria-label="Context usage unavailable"]'),
    ).not.toBeNull();
  });

  it("renders measured context usage in the conversation header", () => {
    const snapshot = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshot,
        contextWindowUsages: [
          {
            contextWindowRatio: 0.25,
            contextWindowTokens: 200_000,
            currentTokens: 50_000,
            estimatedAt: timestamp,
            modelId: "fake-model",
            sessionId: "session_1",
          },
        ],
        sessions: snapshot.sessions.map((session) => ({
          ...session,
          messages: [
            {
              createdAt: timestamp,
              id: "message_context_measured",
              parts: [{ text: "hello", type: "text" }],
              role: "user",
            },
          ],
        })),
      },
    });
    const app = mountApp(fake.runtime);

    expect(
      app.container.querySelector(
        '.ohb-main-header button[aria-label^="25% context used"]',
      ),
    ).not.toBeNull();
  });

  it("leaves default permission unchanged when full-access confirmation is dismissed", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await clickButton(
      app.container,
      "Default: ask before protected actions. Click for full-access.",
    );
    await clickButton(document, "Not now");

    expect(fake.setPermission).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(
      app.container.querySelector(".ohb-shell")?.hasAttribute("inert"),
    ).toBe(false);
    expect(document.activeElement).toBe(
      app.container.querySelector(".ohb-permission-toggle"),
    );
  });

  it("traps confirmation focus and dismisses with Escape or the backdrop", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);
    const permissionButton = app.container.querySelector(
      ".ohb-permission-toggle",
    );

    await clickButton(
      app.container,
      "Default: ask before protected actions. Click for full-access.",
    );
    const confirm = document.querySelector<HTMLButtonElement>(
      'button[title="Use full access"]',
    );
    const cancel = document.querySelector<HTMLButtonElement>(
      'button[title="Not now"]',
    );
    expect(
      app.container.querySelector(".ohb-shell")?.hasAttribute("inert"),
    ).toBe(true);

    await act(async () => {
      confirm?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }),
      );
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(cancel);
    await act(async () => {
      cancel?.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          key: "Tab",
          shiftKey: true,
        }),
      );
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(confirm);

    await act(async () => {
      confirm?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
      );
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(permissionButton);

    await clickButton(
      app.container,
      "Default: ask before protected actions. Click for full-access.",
    );
    await act(async () => {
      document.querySelector<HTMLDivElement>(".ohb-full-access-layer")?.click();
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(fake.setPermission).not.toHaveBeenCalled();
  });

  it("returns from full-access to default without confirmation", async () => {
    const snapshot = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshot,
        permission: {
          level: "full-access",
          mode: "auto",
          sessionRules: [],
        },
      },
    });
    const app = mountApp(fake.runtime);

    await clickButton(
      app.container,
      "Full-access: run without approval prompts. Click for default.",
    );

    expect(fake.setPermission).toHaveBeenCalledWith({ level: "default" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("shows independent approvals without a chat snapshot and lets the user choose another request", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.store.reset();
    const first = { ...permissionRequest(), sourceLabel: "Researcher" };
    const second = {
      ...first,
      id: "permission_2",
      sourceLabel: "Editor",
      title: "Edit file?",
    };
    fake.store.setPermissionSync({
      status: "ready",
      binding: {
        permissionEpoch: "epoch",
        rootSessionId: "session_1",
        bindingGeneration: 1,
      },
      requests: [first, second],
      permissionRevision: 2,
      attempts: 1,
    });
    const respond = vi.spyOn(fake.client, "respondPermission");
    const app = mountApp(fake.runtime);
    expect(app.container.textContent).toContain("Researcher");
    expect(permissionAction(app.container, "Allow once").disabled).toBe(false);
    const next = app.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Next approval"]',
    );
    await act(async () => {
      next?.click();
      await Promise.resolve();
    });
    expect(app.container.textContent).toContain("Editor");
    await act(async () => {
      permissionAction(app.container, "Allow once").click();
      await Promise.resolve();
    });
    expect(respond).toHaveBeenCalledWith("permission_2", {
      choiceId: "allow_once",
    });
    expect(app.container.textContent).not.toContain("Cancel run");
    act(() => {
      fake.store.setPermissionSync({
        ...fake.store.getSnapshot().permissionSync,
        status: "syncing",
      });
    });
    expect(permissionAction(app.container, "Allow once").disabled).toBe(true);
  });

  it("styles permission choices by their consequence", () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "running", runId: "run_1" }),
        permissions: [permissionRequest()],
      },
    });
    const app = mountApp(fake.runtime);

    expect(permissionAction(app.container, "Allow once").className).toBe(
      "ohb-perm-btn ohb-perm-allow-primary",
    );
    expect(permissionAction(app.container, "Always allow").className).toBe(
      "ohb-perm-btn ohb-perm-allow-secondary",
    );
    expect(permissionAction(app.container, "Reject").className).toBe(
      "ohb-perm-btn ohb-perm-deny",
    );
    expect(app.container.textContent).not.toContain("Cancel run");
  });

  it("shows and navigates the independent session index before core history is available", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [],
      },
    });
    act(() => {
      fake.store.setSessionIndex(
        ["one", "two"].map((id) => ({
          id,
          title: `Saved ${id}`,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      );
      fake.store.setSessionSync({
        status: "syncing",
        scope: { sessionId: "one", runtimeEpoch: "epoch" },
        attempts: 1,
      });
    });
    const app = mountApp(fake.runtime);
    expect(
      app.container.querySelector('button[aria-label="Select Saved one"]'),
    ).not.toBeNull();
    expect(
      app.container.querySelector('button[aria-label="Select Saved two"]'),
    ).not.toBeNull();
    await clickButton(app.container, "Select Saved two");
    expect(fake.selectSession).toHaveBeenCalledWith("two");
  });
  it("shows verified Stop while history is pending and a draft is being edited", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    act(() => {
      fake.store.setSessionSync({
        status: "syncing",
        scope: { sessionId: "session_1", runtimeEpoch: "epoch" },
        attempts: 1,
      });
      fake.store.setSessionControl({
        sessionId: "session_1",
        rootSessionId: "session_1",
        runtimeEpoch: "epoch",
        runId: "verified",
        driver: "user",
      });
    });
    const app = mountApp(fake.runtime);
    await setTextareaValue(app.container, "keep this draft");
    expect(app.container.querySelector(".ohb-stop-button")).not.toBeNull();
  });
  it("creates and selects sessions from the sidebar", async () => {
    const first = snapshotWithStatus({ kind: "idle" }).sessions[0];
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: "session_1",
        sessions: [
          first,
          {
            createdAt: timestamp,
            id: "session_2",
            messages: [],
            title: "Session 2",
            updatedAt: "2026-06-13T00:00:00.000Z",
          },
        ],
      },
    });
    const app = mountApp(fake.runtime);

    expect(
      app.container.querySelector(".ohb-sidebar-new .lucide-square-pen"),
    ).not.toBeNull();
    expect(
      app.container.querySelector(".ohb-shell-sidebar")?.hasAttribute("inert"),
    ).toBe(false);
    await clickButton(app.container, "Collapse sidebar");
    expect(
      app.container.querySelector(".ohb-shell-sidebar")?.hasAttribute("inert"),
    ).toBe(true);
    await clickButton(app.container, "Open sidebar");
    expect(
      app.container.querySelector('button[aria-label="Select Session 2"]')
        ?.textContent,
    ).not.toContain("0 messages");

    await clickButton(app.container, "New chat");
    await clickButton(app.container, "Select Session 2");

    expect(fake.openDraft).toHaveBeenCalledTimes(1);
    expect(fake.selectSession).toHaveBeenCalledWith("session_2");
  });

  it("starts a new chat in a project from its sidebar group", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "New chat in repo-b");

    expect(fake.openDraft).toHaveBeenCalledWith("/repo-b");
  });

  it("hides a workspace through its group menu", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Workspace actions for repo-b");
    await clickButton(document.body, "Hide workspace");

    expect(fake.hideWorkspace).toHaveBeenCalledWith("/repo-b");
  });

  it("opens the web directory picker from the sidebar", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Open folder…");

    await waitFor(
      () =>
        app.container
          .querySelector('[role="dialog"]')
          ?.textContent.includes("C:\\") === true,
    );
    expect(fake.getDirectoryPickerRoots).toHaveBeenCalledTimes(1);
    expect(fake.openFolder).not.toHaveBeenCalled();
    const root = [...app.container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("C:\\"),
    );
    if (!root) {
      throw new Error("directory root not found");
    }
    await act(async () => {
      root.click();
      await Promise.resolve();
    });
    await waitFor(() =>
      Boolean(
        [...app.container.querySelectorAll("button")].find(
          (button) => button.textContent === "Choose this folder",
        ),
      ),
    );
    const choose = [...app.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Choose this folder",
    );
    if (!choose) {
      throw new Error("choose directory button not found");
    }
    await act(async () => {
      choose.click();
      await Promise.resolve();
    });

    expect(fake.openFolder).toHaveBeenCalledWith("C:\\");
  });

  it("keeps the directory picker open when opening a directory fails", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.openFolder.mockRejectedValueOnce(new Error("Scope unavailable"));
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Open folder…");
    await waitFor(
      () =>
        app.container
          .querySelector('[role="dialog"]')
          ?.textContent.includes("C:\\") === true,
    );
    const root = [...app.container.querySelectorAll("button")].find((button) =>
      button.textContent.includes("C:\\"),
    );
    if (!root) {
      throw new Error("directory root not found");
    }
    await act(async () => {
      root.click();
      await Promise.resolve();
    });
    await waitFor(() =>
      Boolean(
        [...app.container.querySelectorAll("button")].find(
          (button) => button.textContent === "Choose this folder",
        ),
      ),
    );
    const choose = [...app.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Choose this folder",
    );
    if (!choose) {
      throw new Error("choose directory button not found");
    }
    await act(async () => {
      choose.click();
      await Promise.resolve();
    });

    await waitFor(() =>
      Boolean(
        app.container
          .querySelector('[role="alert"]')
          ?.textContent.includes("Scope unavailable"),
      ),
    );
    expect(app.container.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("renders transient reasoning for a streaming assistant message", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "running", runId: "run_1" }),
        sessions: [
          {
            createdAt: timestamp,
            id: "session_1",
            messages: [
              {
                createdAt: timestamp,
                id: "message_assistant",
                parts: [],
                role: "assistant",
                status: "streaming",
              },
            ],
            title: "Session",
            updatedAt: timestamp,
          },
        ],
      },
    });
    const app = mountApp(fake.runtime);

    await act(async () => {
      fake.store.applyEvent(
        {
          content: "thinking out loud",
          delta: "thinking out loud",
          messageId: "message_assistant",
          sessionId: "session_1",
          type: "message.reasoning.delta",
        },
        2,
      );
      await Promise.resolve();
    });

    expect(
      app.container.querySelector(".ohb-reasoning")?.textContent,
    ).toContain("thinking out loud");
  });

  it.each([
    {
      error: Object.assign(new Error("Daemon request failed with HTTP 404"), {
        status: 404,
      }),
      expected: "Export is not supported by this backend.",
    },
    {
      error: Object.assign(new Error("Session not found"), {
        status: 404,
        code: "SESSION_NOT_FOUND",
      }),
      expected: "Session not found",
    },
  ])(
    "shows the export failure without selecting the target: $expected",
    async ({ error, expected }) => {
      const first = snapshotWithStatus({ kind: "idle" }).sessions[0];
      const fake = createFakeRuntime({
        snapshot: {
          ...snapshotWithStatus({ kind: "idle" }),
          activeSessionId: "session_1",
          sessions: [
            first,
            {
              createdAt: timestamp,
              id: "session_2",
              messages: [],
              title: "Session 2",
              updatedAt: timestamp,
            },
          ],
        },
      });
      fake.exportSession.mockRejectedValue(error);
      const app = mountApp(fake.runtime);
      await clickButton(app.container, "Actions for Session 2");
      await clickButton(document.body, "Export…");
      await clickButton(document.body, "HTML");
      await waitFor(() =>
        Boolean(
          app.container
            .querySelector(".ohb-notice-stack .ohb-banner")
            ?.textContent.includes(expected),
        ),
      );
      expect(fake.exportSession).toHaveBeenCalledWith(
        "session_2",
        "html",
        "/repo-a",
      );
      expect(fake.selectSession).not.toHaveBeenCalled();
      expect(document.querySelector('[role="menu"]')).toBeNull();
    },
  );

  it("archives sidebar sessions without confirmation or selecting the row", async () => {
    const first = snapshotWithStatus({ kind: "idle" }).sessions[0];
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: "session_1",
        sessions: [
          first,
          {
            createdAt: timestamp,
            id: "session_2",
            messages: [],
            title: "Session 2",
            updatedAt: "2026-06-13T00:00:00.000Z",
          },
        ],
      },
    });
    const confirm = vi.spyOn(window, "confirm");
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Actions for Session 2");
    await clickButton(document.body, "Archive");

    expect(confirm).not.toHaveBeenCalled();
    expect(fake.archiveSession).toHaveBeenCalledWith("session_2", "/repo-a");
    expect(fake.selectSession).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("selects the first listed sidebar session when no session is active", async () => {
    const first = snapshotWithStatus({ kind: "idle" }).sessions[0];
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [first],
      },
    });
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Select Session");

    expect(fake.selectSession).toHaveBeenCalledWith("session_1");
  });

  it("loads the selected sidebar session transcript from an empty active state", async () => {
    const first = snapshotWithStatus({ kind: "idle" }).sessions[0];
    const selectedSnapshot: UiSnapshot = {
      ...snapshotWithStatus({ kind: "idle" }),
      activeSessionId: "session_1",
      sessions: [
        {
          ...first,
          messages: [
            {
              createdAt: timestamp,
              id: "message_user",
              parts: [{ text: "resume this session", type: "text" }],
              role: "user",
            },
            {
              createdAt: timestamp,
              id: "message_assistant",
              parts: [{ text: "loaded transcript", type: "text" }],
              role: "assistant",
            },
          ],
        },
      ],
    };
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [first],
      },
    });
    fake.selectSession.mockImplementationOnce(() => {
      fake.store.replaceSnapshot(selectedSnapshot, 2);
      return Promise.resolve();
    });
    const app = mountApp(fake.runtime);

    expect(app.container.textContent).not.toContain("loaded transcript");

    await clickButton(app.container, "Select Session");

    await waitFor(() =>
      app.container.textContent.includes("loaded transcript"),
    );
    expect(app.container.textContent).toContain("resume this session");
    expect(fake.selectSession).toHaveBeenCalledWith("session_1");
  });

  it("opens the structured compact overlay from the slash palette", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["compact"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/compact"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );
    let complete!: () => void;
    fake.compactSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = (): void => {
            resolve({
              sessionId: "session_1",
              status: "compacted",
              usageAfter: compactUsage(8_000),
              usageBefore: compactUsage(16_000),
            });
          };
        }),
    );
    await clickButton(app.container, "Compact session");

    expect(fake.compactSession).toHaveBeenCalledWith({
      sessionId: "session_1",
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
    // The overlay steps aside; progress lives in the conversation.
    expect(app.container.querySelector(".ohb-structured-overlay")).toBeNull();
    expect(
      app.container.querySelector('[aria-label="Compacting"]'),
    ).not.toBeNull();
    complete();
    await waitFor(
      () => !app.container.querySelector('[aria-label="Compacting"]'),
    );
  });

  it("opens the structured goal overlay from the slash palette", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        goals: [
          {
            goal: {
              objective: "finish goal UI",
              turnsUsed: 7,
              wallClockMs: 192000,
              status: "active",
              turnBudget: 20,
            },
            sessionId: "session_1",
          },
        ],
      },
    });
    fake.listCommands.mockResolvedValue(catalog(["goal"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/goal"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );

    expect(
      app.container.querySelector(".ohb-structured-dialog")?.textContent,
    ).toContain("finish goal UI");
    expect(
      app.container.querySelector(".ohb-goal-state")?.textContent,
    ).toContain("Turns7/20");
    expect(
      app.container.querySelector(".ohb-goal-state")?.textContent,
    ).toContain("Active time3m 12s");
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("renders the goal strip above the composer input instead of the header chip", () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        goals: [
          {
            goal: {
              objective: "finish goal UI",
              turnsUsed: 7,
              wallClockMs: 192000,
              status: "paused",
              turnBudget: 20,
            },
            sessionId: "session_1",
          },
        ],
      },
    });
    const app = mountApp(fake.runtime);

    expect(
      app.container.querySelector(".ohb-main-header .ohb-goal-chip"),
    ).toBeNull();
    const strip = app.container.querySelector(".ohb-composer .ohb-goal-strip");
    expect(strip).not.toBeNull();
    expect(
      strip?.nextElementSibling?.classList.contains("ohb-composer-input"),
    ).toBe(true);
    expect(strip?.querySelector("svg.ohb-goal-strip-icon")).not.toBeNull();
    expect(strip?.textContent).toContain("Paused goal");
    expect(strip?.textContent).toContain("finish goal UI");
    expect(strip?.textContent).toContain("7/20");
    expect(strip?.textContent).toContain("3m 12s");
    expect(
      strip?.querySelector(".ohb-goal-strip-summary")?.getAttribute("title"),
    ).toContain("finish goal UI");
    expect(strip?.querySelectorAll("button button")).toHaveLength(0);

    act(() => {
      fake.runtime.store.replaceSnapshot(
        {
          ...snapshotWithStatus({ kind: "running", runId: "run_1" }),
          goals: [
            {
              goal: {
                objective: "finish goal UI",
                turnsUsed: 7,
                wallClockMs: 192000,
                status: "active",
                turnBudget: 20,
              },
              sessionId: "session_1",
            },
          ],
        },
        2,
      );
    });
    expect(
      app.container.querySelector(".ohb-main-header .ohb-goal-chip"),
    ).toBeNull();
    expect(
      app.container.querySelector(
        ".ohb-main-header .ohb-context-usage-control",
      ),
    ).not.toBeNull();
    expect(
      app.container.querySelector(".ohb-composer .ohb-goal-strip")?.textContent,
    ).toContain("Active goal");
  });

  it.each(["paused", "blocked"] as const)(
    "offers optional resume limits for a %s goal and keeps backend errors visible",
    async (goalStatus) => {
      const fake = createFakeRuntime({
        snapshot: {
          ...snapshotWithStatus({ kind: "idle" }),
          goals: [
            {
              sessionId: "session_1",
              goal: {
                objective: "finish goal UI",
                turnsUsed: 7,
                wallClockMs: 192000,
                status: goalStatus,
                pauseReason: "budget reached",
              },
            },
          ],
        },
      });
      fake.executeSlashCommand.mockResolvedValue({
        status: "failed",
        commandRunId: "resume_failed",
        clientInvocationId: "resume",
        outputCount: 0,
        eventCount: 1,
        error: {
          code: "budget_reached",
          message: "Cannot resume: turns used 20/20.",
        },
      });
      const app = mountApp(fake.runtime);
      await clickButton(app.container, "Edit goal");
      expect(
        app.container.querySelector(".ohb-goal-state")?.textContent,
      ).toContain("Turns7");
      expect(
        app.container.querySelector(".ohb-goal-state")?.textContent,
      ).toContain("Active time3m 12s");
      const resume = app.container.querySelector<HTMLButtonElement>(
        '[data-goal-action="resume"]',
      );
      expect(resume?.disabled).toBe(false);
      expect(app.container.querySelector("summary")?.textContent).toContain(
        "Optional limits",
      );
      expect(
        app.container.querySelector('input[aria-label="Turn limit"]'),
      ).not.toBeNull();
      expect(
        app.container.querySelector(
          'input[aria-label="Active duration limit"]',
        ),
      ).not.toBeNull();
      const dialog = app.container.querySelector(".ohb-structured-dialog");
      if (!dialog) throw new Error("Goal dialog missing");
      await clickButton(dialog, "Resume goal");
      await waitFor(() =>
        Boolean(app.container.querySelector(".ohb-structured-error")),
      );
      expect(
        app.container.querySelector(".ohb-structured-dialog")?.textContent,
      ).toContain("Cannot resume: turns used 20/20.");
      expect(app.container.querySelector(".ohb-structured-success")).toBeNull();
    },
  );

  it("opens goal commands as an overlay instead of direct execution", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["goal"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/goal pause");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );

    expect(
      app.container.querySelector('button[data-goal-action="pause"]'),
    ).toBeNull();
    expect(
      app.container.querySelector(".ohb-structured-dialog")?.textContent,
    ).toContain("No goal to pause.");
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("makes resume primary for a blocked goal, saves objective separately and locks actions while busy", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        goals: [
          {
            sessionId: "session_1",
            goal: {
              objective: "finish goal UI",
              turnsUsed: 7,
              wallClockMs: 192000,
              status: "blocked",
              pauseReason: "same blocker three times",
            },
          },
        ],
      },
    });
    const pending = deferred<import("ohbaby-sdk").UiCommandCompletion>();
    fake.executeSlashCommand.mockReturnValue(pending.promise);
    const app = mountApp(fake.runtime);
    await clickButton(app.container, "Resume goal");
    const dialog = app.container.querySelector(".ohb-structured-dialog");
    const button = (action: string): HTMLButtonElement | null | undefined =>
      dialog?.querySelector<HTMLButtonElement>(
        `[data-goal-action="${action}"]`,
      );
    expect(dialog?.querySelector(".ohb-structured-result")?.textContent).toBe(
      "Turns7Active time3m 12s",
    );
    expect(dialog?.textContent).toContain("same blocker three times");
    expect(button("pause")).toBeNull();
    expect(button("resume")?.className).toContain("ohb-button-primary");
    expect(button("save")?.textContent).toBe("Save objective");
    expect(button("save")?.disabled).toBe(true);

    const objective = dialog?.querySelector("textarea");
    if (!objective) throw new Error("objective field not found");
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method -- React controlled inputs need the native textarea setter in jsdom tests.
      const setValue = descriptor?.set;
      if (setValue)
        Reflect.apply(setValue, objective, ["finish goal UI polish"]);
      objective.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    expect(button("save")?.disabled).toBe(false);
    await clickButton(app.container, "Save objective");
    expect(fake.executeSlashCommand).toHaveBeenCalledWith({
      allowOverlay: true,
      sessionId: "session_1",
      text: "/goal replace\nfinish goal UI polish",
    });
    expect(button("resume")?.disabled).toBe(true);
    expect(button("delete")?.disabled).toBe(true);
    await act(async () => {
      pending.resolve({
        status: "completed",
        commandRunId: "r",
        clientInvocationId: "i",
        outputCount: 0,
        eventCount: 1,
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-success")),
    );
    expect(button("resume")?.disabled).toBe(false);
  });

  it.each(["completed failure", "lost response"])(
    "shows a business failure in the originating goal overlay without claiming success: %s",
    async (outcome) => {
      const fake = createFakeRuntime({
        snapshot: snapshotWithStatus({ kind: "idle" }),
      });
      fake.listCommands.mockResolvedValue(catalog(["goal"]));
      fake.executeSlashCommand.mockResolvedValue({
        status: "failed",
        commandRunId: "r",
        clientInvocationId: "i",
        outputCount: 0,
        eventCount: 1,
        error: {
          code: "UNAVAILABLE",
          message: "budget subcommand unavailable",
        },
      });
      if (outcome === "lost response")
        fake.executeSlashCommand.mockRejectedValue(
          new Error(
            "budget subcommand unavailable. Command result is unconfirmed: response lost",
          ),
        );
      const app = mountApp(fake.runtime);
      await setTextareaValue(app.container, "/goal budget 100");
      await pressTextareaKey(app.container, "Enter");
      await waitFor(() =>
        Boolean(app.container.querySelector(".ohb-structured-overlay")),
      );
      await clickButton(app.container, "Create goal");
      await waitFor(() =>
        Boolean(app.container.querySelector(".ohb-structured-error")),
      );
      expect(
        app.container.querySelector(".ohb-structured-error")?.textContent,
      ).toContain("budget subcommand unavailable");
      if (outcome === "lost response")
        expect(
          app.container.querySelector(".ohb-structured-error")?.textContent,
        ).toContain("unconfirmed");
      expect(app.container.querySelector(".ohb-structured-success")).toBeNull();
      expect(app.container.querySelector(".ohb-command-notice")).toBeNull();
    },
  );

  it("executes goal panel actions through the overlay allowance", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        goals: [
          {
            goal: {
              objective: "finish goal UI",
              turnsUsed: 7,
              wallClockMs: 192000,
              status: "active",
            },
            sessionId: "session_1",
          },
        ],
      },
    });
    fake.listCommands.mockResolvedValue(catalog(["goal"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/goal"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );
    const dialog = app.container.querySelector(".ohb-structured-dialog");
    if (!dialog) throw new Error("Goal dialog missing");
    await clickButton(dialog, "Pause goal");

    expect(fake.executeSlashCommand).toHaveBeenCalledWith({
      allowOverlay: true,
      sessionId: "session_1",
      text: "/goal pause",
    });
  });

  it("opens the goal panel when the edit icon in the goal strip is clicked without submitting", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        goals: [
          {
            goal: {
              objective: "finish goal UI",
              turnsUsed: 7,
              wallClockMs: 192000,
              status: "active",
            },
            sessionId: "session_1",
          },
        ],
      },
    });
    const app = mountApp(fake.runtime);

    const editButton = app.container.querySelector(
      '[data-goal-strip-action="edit"]',
    );
    if (!(editButton instanceof HTMLButtonElement)) {
      throw new Error("goal edit button not found");
    }
    await act(async () => {
      editButton.click();
      await Promise.resolve();
    });

    expect(
      app.container.querySelector(".ohb-structured-dialog")?.textContent,
    ).toContain("finish goal UI");
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("pauses an active goal directly from the goal strip, resumes a paused goal directly, and falls back to the resume panel with visible error when direct resume fails", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        goals: [
          {
            goal: {
              objective: "ship goal strip",
              turnsUsed: 4,
              wallClockMs: 45_000,
              status: "active",
            },
            sessionId: "session_1",
          },
        ],
      },
    });
    fake.executeSlashCommand.mockResolvedValueOnce({
      status: "completed",
      commandRunId: "pause_1",
      clientInvocationId: "inv_pause",
      outputCount: 0,
      eventCount: 1,
    });
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Pause goal");
    expect(fake.executeSlashCommand).toHaveBeenCalledWith({
      allowOverlay: true,
      sessionId: "session_1",
      text: "/goal pause",
    });
    expect(app.container.querySelector(".ohb-structured-overlay")).toBeNull();

    act(() => {
      fake.runtime.store.replaceSnapshot(
        {
          ...snapshotWithStatus({ kind: "idle" }),
          goals: [
            {
              goal: {
                objective: "ship goal strip",
                turnsUsed: 20,
                wallClockMs: 45_000,
                status: "paused",
                turnBudget: 20,
              },
              sessionId: "session_1",
            },
          ],
        },
        2,
      );
    });

    fake.executeSlashCommand.mockResolvedValueOnce({
      status: "failed",
      commandRunId: "resume_1",
      clientInvocationId: "inv_resume",
      outputCount: 0,
      eventCount: 1,
      error: {
        code: "budget_reached",
        message: "Cannot resume: turns used 20/20.",
      },
    });

    await clickButton(app.container, "Resume goal");
    expect(fake.executeSlashCommand).toHaveBeenLastCalledWith({
      allowOverlay: true,
      sessionId: "session_1",
      text: "/goal resume",
    });
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );
    expect(
      app.container.querySelector(".ohb-structured-error")?.textContent,
    ).toContain("Cannot resume: turns used 20/20.");
    expect(
      app.container.querySelector('[data-goal-action="resume"]'),
    ).not.toBeNull();
  });

  it("disables goal strip actions while disconnected or submitting and ignores stale async completions after switching sessions", async () => {
    const pendingPause = deferred<import("ohbaby-sdk").UiCommandCompletion>();
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        sessions: [
          {
            id: "session_1",
            title: "Session 1",
            workingDirectory: "/repo",
            messages: [],
            createdAt: "2026-03-20T00:00:00.000Z",
            updatedAt: "2026-03-20T00:00:00.000Z",
          },
          {
            id: "session_2",
            title: "Session 2",
            workingDirectory: "/repo",
            messages: [],
            createdAt: "2026-03-20T00:01:00.000Z",
            updatedAt: "2026-03-20T00:01:00.000Z",
          },
        ],
        goals: [
          {
            goal: {
              objective: "session 1 goal",
              turnsUsed: 2,
              wallClockMs: 12_000,
              status: "paused",
            },
            sessionId: "session_1",
          },
          {
            goal: {
              objective: "session 2 goal",
              turnsUsed: 1,
              wallClockMs: 5_000,
              status: "active",
            },
            sessionId: "session_2",
          },
        ],
      },
    });
    fake.executeSlashCommand.mockReturnValueOnce(pendingPause.promise);
    const app = mountApp(fake.runtime);

    const resumeBtn = app.container.querySelector<HTMLButtonElement>(
      '[data-goal-strip-action="resume"]',
    );
    const editBtn = app.container.querySelector<HTMLButtonElement>(
      '[data-goal-strip-action="edit"]',
    );
    expect(resumeBtn?.disabled).toBe(false);
    expect(editBtn?.disabled).toBe(false);

    await clickButton(app.container, "Resume goal");
    expect(
      app.container.querySelector<HTMLButtonElement>(
        '[data-goal-strip-action="resume"]',
      )?.disabled,
    ).toBe(true);
    expect(
      app.container.querySelector<HTMLButtonElement>(
        '[data-goal-strip-action="edit"]',
      )?.disabled,
    ).toBe(true);

    const currentSnapshot = fake.runtime.store.getSnapshot().view.snapshot;
    if (!currentSnapshot) {
      throw new Error("missing snapshot");
    }
    act(() => {
      fake.runtime.store.replaceSnapshot(
        {
          ...currentSnapshot,
          activeSessionId: "session_2",
        },
        2,
      );
    });
    expect(
      app.container.querySelector(".ohb-goal-strip")?.textContent,
    ).toContain("session 2 goal");
    expect(
      app.container.querySelector<HTMLButtonElement>(
        '[data-goal-strip-action="pause"]',
      )?.disabled,
    ).toBe(false);

    await act(async () => {
      pendingPause.resolve({
        status: "failed",
        commandRunId: "stale_resume",
        clientInvocationId: "inv_stale",
        outputCount: 0,
        eventCount: 1,
        error: {
          code: "budget_reached",
          message: "Stale session error should not appear",
        },
      });
      await Promise.resolve();
    });
    expect(app.container.querySelector(".ohb-structured-overlay")).toBeNull();
    expect(app.container.textContent).not.toContain(
      "Stale session error should not appear",
    );

    act(() => {
      fake.runtime.store.setConnectionState("reconnecting");
    });
    expect(
      app.container.querySelector<HTMLButtonElement>(
        '[data-goal-strip-action="pause"]',
      )?.disabled,
    ).toBe(true);
    expect(
      app.container.querySelector<HTMLButtonElement>(
        '[data-goal-strip-action="edit"]',
      )?.disabled,
    ).toBe(true);
  });

  it("does not render the goal strip without a goal for the active session", () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    expect(app.container.querySelector(".ohb-goal-strip")).toBeNull();
    expect(app.container.querySelector(".ohb-goal-chip")).toBeNull();
  });

  it("keeps the slash palette and its catalog through unrelated store refreshes", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["status", "compact"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/status"));
    const calls = fake.listCommands.mock.calls.length;

    act(() => {
      fake.store.setCurrentModel({
        provider: "zhipu",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        interfaceProvider: "openai-compatible",
        model: "glm-4.7",
      });
    });
    await flushTimers();

    expect(slashPaletteText(app.container)).toContain("/status");
    expect(fake.listCommands.mock.calls.length).toBe(calls);
  });

  it("shows compact failures in the error banner", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["compact"]));
    fake.compactSession.mockResolvedValueOnce({
      error: "summary failed",
      sessionId: "session_1",
      status: "failed",
      usageAfter: compactUsage(16_000),
      usageBefore: compactUsage(16_000),
    });
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/compact"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );
    await clickButton(app.container, "Compact session");

    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-banner-error")),
    );
    expect(
      app.container.querySelector(".ohb-banner-error")?.textContent,
    ).toContain("Compaction failed: summary failed");
  });
});

function mountApp(runtime: OhbabyWebRuntime): MountedApp {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<OhbabyWebApp runtime={runtime} />);
  });
  const app = { container, root };
  mountedApps.push(app);
  return app;
}

function createFakeRuntime(input: {
  readonly snapshot: UiSnapshot;
}): FakeRuntime {
  const store = createOhbabyWebStore();
  const replaceFixture = store.replaceSnapshot.bind(store);
  store.replaceSnapshot = (snapshot, seq): void => {
    store.setSessionIndex(
      snapshot.sessions.map(({ messages: _messages, ...session }) => session),
    );
    store.setSessionSync({
      status: snapshot.activeSessionId ? "ready" : "idle",
      scope: snapshot.activeSessionId
        ? { sessionId: snapshot.activeSessionId, runtimeEpoch: "epoch" }
        : null,
      attempts: 1,
    });
    store.setSessionControl(
      snapshot.activeSessionId
        ? {
            sessionId: snapshot.activeSessionId,
            rootSessionId: snapshot.activeSessionId,
            runtimeEpoch: "epoch",
            runId:
              snapshot.status.kind === "running"
                ? snapshot.status.runId
                : (snapshot.permissions.find(
                    (request) => request.sessionId === snapshot.activeSessionId,
                  )?.runId ?? null),
            driver: "user",
          }
        : null,
    );
    const permissions = store.getSnapshot().permissionSync;
    store.setPermissionSync({
      ...permissions,
      binding: {
        permissionEpoch: "epoch",
        rootSessionId: snapshot.activeSessionId,
        bindingGeneration: (permissions.binding?.bindingGeneration ?? 0) + 1,
      },
      requests: snapshot.permissions,
    });
    replaceFixture(snapshot, seq);
  };
  store.replaceSnapshot(input.snapshot, 1);
  store.setPermissionSync({
    status: "ready",
    binding: {
      permissionEpoch: "epoch",
      rootSessionId: input.snapshot.activeSessionId,
      bindingGeneration: 1,
    },
    requests: input.snapshot.permissions,
    permissionRevision: 0,
    attempts: 1,
  });
  store.setConnectionState("live");
  const abortSession = vi.fn<OhbabyWebRuntime["abortSession"]>(() =>
    Promise.resolve(),
  );
  const executeSlashCommand = vi.fn<OhbabyWebRuntime["executeSlashCommand"]>(
    () =>
      Promise.resolve({
        status: "completed" as const,
        commandRunId: "command_1",
        clientInvocationId: "invoke_1",
        outputCount: 0,
        eventCount: 0,
      }),
  );
  const editQueuedPrompt = vi.fn<UiBackendClient["editQueuedPrompt"]>(() =>
    Promise.reject(new Error("unused")),
  );
  const createSession = vi.fn<OhbabyWebRuntime["createSession"]>(() =>
    Promise.resolve(),
  );
  const selectSession = vi.fn<OhbabyWebRuntime["selectSession"]>(() =>
    Promise.resolve(),
  );
  const archiveSession = vi.fn<(sessionId: string) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const exportSession = vi.fn<OhbabyWebRuntime["exportSession"]>(() =>
    Promise.reject(new Error("unused")),
  );
  const connectModel = vi.fn<UiBackendClient["connectModel"]>(() =>
    Promise.resolve({
      apiKeyEnv: "ZHIPU_API_KEY",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      contextWindowSource: "default",
      contextWindowTokens: 128_000,
      envPath: ".env",
      interfaceProvider: "openai-compatible",
      model: "glm-4.7",
      modelJsonPath: "model.json",
      provider: "zhipu",
      saved: true,
    }),
  );
  const listCommands = vi.fn<OhbabyWebRuntime["listWebCommands"]>(() =>
    Promise.resolve(catalog(["status"])),
  );
  const setPermission = vi.fn<UiBackendClient["setPermission"]>(() =>
    Promise.resolve({
      level: "default",
      mode: "auto",
      sessionRules: [],
    }),
  );
  const compactSession = vi.fn<UiBackendClient["compactSession"]>(() =>
    Promise.resolve({
      sessionId: "session_1",
      status: "compacted",
      usageAfter: compactUsage(8_000),
      usageBefore: compactUsage(16_000),
    }),
  );
  const setSearchApiKey = vi.fn<UiBackendClient["setSearchApiKey"]>(() =>
    Promise.resolve({
      apiKeyEnv: "TAVILY_API_KEY",
      envPath: ".env",
      provider: "tavily",
      searchJsonPath: "search.json",
    }),
  );
  // Opening a draft or a session is a new user choice, as in the runtime.
  let selection = 0;
  const openDraft = vi.fn<OhbabyWebRuntime["openDraft"]>(() => {
    selection += 1;
    return Promise.resolve();
  });
  const hideWorkspace = vi.fn<OhbabyWebRuntime["hideWorkspace"]>(() =>
    Promise.resolve(),
  );
  const openFolder = vi.fn<OhbabyWebRuntime["openFolder"]>((directory) =>
    Promise.resolve(directory),
  );
  const getDirectoryPickerRoots = vi.fn<
    OhbabyWebRuntime["getDirectoryPickerRoots"]
  >(() =>
    Promise.resolve({
      ok: true,
      roots: [{ directory: "C:\\", name: "C:\\" }],
    }),
  );
  const listDirectoryPicker = vi.fn<OhbabyWebRuntime["listDirectoryPicker"]>(
    (directory) =>
      Promise.resolve({
        children: [],
        directory,
        ok: true,
        parent: null,
      }),
  );
  const workspaceSnapshot = {
    scopes: [
      {
        available: true,
        directory: "/repo-a",
        lastOpenedAt: 2,
        loaded: true,
        position: 0,
      },
      {
        available: true,
        directory: "/repo-b",
        lastOpenedAt: 1,
        loaded: false,
        position: 1,
      },
    ],
    selectedDirectory: "/repo-a",
  } as const;
  // Like a daemon without global routes: the instance index is the whole list.
  const globalCatalog = createGlobalCatalogStore();
  globalCatalog.setWorkspaces(workspaceSnapshot.scopes, "/default");
  const mirrorIndex = (): void => {
    globalCatalog.replaceSessions(
      store.getSnapshot().sessionIndex.map((entry) => ({
        id: entry.id,
        title: entry.title,
        status: "active" as const,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        messageCount: 0,
        workspaceDirectory: "/repo-a",
        workingDirectory: "/repo-a",
      })),
      undefined,
    );
  };
  mirrorIndex();
  store.subscribe(mirrorIndex);
  const submitPromptAccepted = vi.fn<UiBackendClient["submitPromptAccepted"]>(
    (_text, options) =>
      Promise.resolve({
        clientRequestId: options?.clientRequestId ?? "request_1",
        createdAt: "2026-07-12T00:00:00.000Z",
        promptId: "prompt_1",
        sessionId: "session_1",
        status: "queued",
        userMessageId: "message_1",
      }),
  );
  const client: UiBackendClient = {
    abortRun: vi.fn(() => Promise.resolve()),
    acquirePromptEditLease: vi.fn(() => Promise.reject(new Error("unused"))),
    updateSessionReasoning: vi.fn(() =>
      Promise.reject(new Error("Unused reasoning test stub")),
    ),
    exportSession: vi.fn(() => Promise.reject(new Error("Not implemented"))),
    archiveSession: vi.fn(() => Promise.resolve()),
    compactSession,
    steerQueuedPrompt: vi.fn(() => Promise.reject(new Error("unused"))),
    resendSteerInput: vi.fn(() => Promise.reject(new Error("unused"))),
    cancelQueuedPrompt: vi.fn(() => Promise.reject(new Error("unused"))),
    connectModel,
    executeCommand: vi.fn(() =>
      Promise.resolve({
        status: "completed" as const,
        commandRunId: "command_1",
        clientInvocationId: "invoke_1",
        outputCount: 0,
        eventCount: 0,
      }),
    ),
    editQueuedPrompt,
    resubmitRetainedPrompt: vi.fn(() =>
      Promise.reject(new Error("Unused retained resubmission stub")),
    ),
    getContextWindowUsage: vi.fn(() =>
      Promise.resolve({
        contextWindowRatio: 0.125,
        contextWindowTokens: 128_000,
        currentTokens: 16_000,
        estimatedAt: timestamp,
        modelId: "glm-4.7",
        sessionId: "session_1",
      }),
    ),
    getCurrentModel: vi.fn(() => Promise.resolve(null)),
    getSnapshot: () => Promise.resolve(input.snapshot),
    listCommands: () => listCommands(),
    probeModelContextWindow: vi.fn(() =>
      Promise.resolve({
        contextWindowSource: "default" as const,
        contextWindowTokens: 128_000,
      }),
    ),
    respondPermission: vi.fn(() => Promise.resolve()),
    respondInteraction: vi.fn(() => Promise.resolve()),
    releasePromptEditLease: vi.fn(() => Promise.reject(new Error("unused"))),
    renewPromptEditLease: vi.fn(() => Promise.reject(new Error("unused"))),
    setPermission,
    setSearchApiKey,
    submitPromptAccepted: submitPromptAccepted,
    submitPromptAndWait: vi.fn<UiBackendClient["submitPromptAndWait"]>(() =>
      Promise.resolve({
        prompt: {
          clientRequestId: "request_1",
          createdAt: timestamp,
          endedAt: timestamp,
          promptId: "prompt_1",
          scopeKey: "/repo-a",
          sessionId: "session_1",
          status: "succeeded",
          text: "done",
          updatedAt: timestamp,
          userMessageId: "message_1",
        },
      }),
    ),
    getSelectedSessionId: () => Promise.resolve(input.snapshot.activeSessionId),
    createSession: () => Promise.reject(new Error("unused")),
    selectSession: () => Promise.resolve(),
    getSessionIndex: () => Promise.resolve([]),
    getPermissionSnapshot: () =>
      Promise.resolve({
        permissionEpoch: "epoch",
        rootSessionId: null,
        permissionRevision: 0,
        requests: [],
      }),
    subscribePermissionEvents: () => () => undefined,
    subscribeEvents: () => () => undefined,
    waitForPrompt: vi.fn<UiBackendClient["waitForPrompt"]>(() =>
      Promise.resolve({
        prompt: {
          clientRequestId: "request_1",
          createdAt: timestamp,
          endedAt: timestamp,
          promptId: "prompt_1",
          scopeKey: "/repo-a",
          sessionId: "session_1",
          status: "succeeded",
          text: "done",
          updatedAt: timestamp,
          userMessageId: "message_1",
        },
      }),
    ),
  };
  return {
    abortSession,
    archiveSession,
    client,
    compactSession,
    connectModel,
    createSession,
    editQueuedPrompt,
    executeSlashCommand,
    exportSession,
    getDirectoryPickerRoots,
    hideWorkspace,
    listCommands,
    listDirectoryPicker,
    openDraft,
    openFolder,
    runtime: {
      retryPermissions: vi.fn(),
      retrySession: vi.fn(),
      loadEarlierHistory: vi.fn(() => Promise.resolve()),
      retryUnknownPrompts: vi.fn(() => Promise.resolve()),
      forgetUnknownPrompt: vi.fn(),
      abortSession,
      archiveSession,
      moveSession: () => Promise.resolve(),
      searchSessions: () => Promise.resolve({ results: [] }),
      exportSession,
      client,
      createSession,
      dispose: vi.fn(() => Promise.resolve()),
      executeSlashCommand,
      getDirectoryPickerRoots,
      hideWorkspace,
      listDirectoryPicker,
      listWebCommands: listCommands,
      openDraft,
      openFolder,
      // Sidebar opens go through selectSession so tests observe one entry point.
      openSession: (sessionId): Promise<void> => {
        selection += 1;
        return selectSession(sessionId);
      },
      getSelectionGeneration: () => selection,
      getWorkspaceSnapshot: () => workspaceSnapshot,
      ready: Promise.resolve(),
      refreshCatalog: () => Promise.resolve(),
      loadMoreSessions: () => Promise.resolve(),
      catalog: globalCatalog,
      draft: createDraftStore(),
      settings: new SettingsLayer(
        createMockSettingsApi("settings", () => Promise.resolve()),
        () => "/repo-a",
      ),
      submitPrompt: (text, options) =>
        client.submitPromptAccepted(text, options),
      selectSession,
      store,
      subscribeWorkspaces: () => () => undefined,
    },
    selectSession,
    setPermission,
    setSearchApiKey,
    store,
    submitPromptAccepted,
  };
}

function snapshotWithStatus(status: UiRunStatus): UiSnapshot {
  const run =
    status.kind === "running"
      ? [
          {
            id: status.runId,
            sessionId: "session_1",
            startedAt: timestamp,
            status,
            updatedAt: timestamp,
          },
        ]
      : [];
  return {
    activeSessionId: "session_1",
    permission: {
      level: "default",
      mode: "auto",
      sessionRules: [],
    },
    permissions: [],
    runs: run,
    sessions: [
      {
        createdAt: timestamp,
        id: "session_1",
        messages:
          status.kind === "running"
            ? [
                {
                  createdAt: timestamp,
                  id: "message_1",
                  parts: [{ text: "hello", type: "text" }],
                  role: "user",
                },
              ]
            : [],
        title: "Session",
        updatedAt: timestamp,
      },
    ],
    status,
  };
}

function promptSubmission(
  patch: Partial<UiPromptSubmission> = {},
): UiPromptSubmission {
  return {
    clientRequestId: "request_projected",
    createdAt: timestamp,
    promptId: "prompt_projected",
    scopeKey: "/repo-a",
    sessionId: "session_1",
    status: "queued",
    text: "server projected prompt",
    updatedAt: timestamp,
    userMessageId: "message_projected",
    ...patch,
  };
}

function snapshotWithMessageText(
  snapshot: UiSnapshot,
  text: string,
): UiSnapshot {
  return {
    ...snapshot,
    sessions: snapshot.sessions.map((session) =>
      session.id === "session_1"
        ? {
            ...session,
            messages: session.messages.map((message) =>
              message.id === "message_1"
                ? {
                    ...message,
                    parts: [{ text, type: "text" as const }],
                  }
                : message,
            ),
          }
        : session,
    ),
  };
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: {
    readonly clientHeight: number;
    readonly scrollHeight: number;
    readonly scrollTop: number;
  },
): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    scrollTop: { configurable: true, value: metrics.scrollTop, writable: true },
  });
}

function permissionRequest(): UiPermissionRequest {
  return {
    choices: [
      { id: "allow_once", intent: "allow", label: "Allow once" },
      { id: "allow_always", intent: "allow", label: "Always allow" },
      { id: "reject", intent: "deny", label: "Reject" },
      { id: "cancel", intent: "abort", label: "Cancel run" },
    ],
    description: "Run shell command",
    id: "permission_1",
    sessionId: "child",
    rootSessionId: "session_1",
    callId: "call",
    messageId: "message",
    createdAt: 1,
    runId: "run_1",
    title: "Permission required",
  };
}

function permissionAction(
  container: ParentNode,
  label: string,
): HTMLButtonElement {
  const button = Array.from(
    container.querySelectorAll(".ohb-permission-actions button"),
  ).find((candidate) => candidate.textContent === label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`permission action not found: ${label}`);
  }
  return button;
}

function catalog(ids: readonly CatalogId[]): UiWebCommandCatalog {
  return {
    commands: ids.map((id) => ({
      ...(id === "goal"
        ? { acceptsArguments: true, argsHint: "[<objective> | status]" }
        : {}),
      action: catalogAction(id),
      argumentMode: catalogArgumentMode(id),
      category: catalogCategory(id),
      description:
        id === "skill.hansun-db"
          ? "Use Hansun knowledge base"
          : id === "skills"
            ? "List available skills"
            : id === "compact"
              ? "Compact session"
              : "Show backend status",
      executionKind:
        id === "skill.hansun-db"
          ? "skill"
          : id === "status" || id === "skills"
            ? "passthrough"
            : "overlay",
      id,
      path: id === "skill.hansun-db" ? ["hansun-db"] : [id],
      source: id === "skill.hansun-db" ? "skill" : "builtin",
      surfaces: ["tui"],
    })),
    version: ids.join("-"),
  };
}

type CatalogId = "compact" | "goal" | "skill.hansun-db" | "skills" | "status";

function catalogAction(
  id: CatalogId,
): UiWebCommandCatalog["commands"][number]["action"] {
  switch (id) {
    case "compact":
      return "compactSession";
    case "goal":
      return "openGoalPanel";
    case "skill.hansun-db":
    case "skills":
    case "status":
      return "executeCommand";
  }
}

function catalogArgumentMode(
  id: CatalogId,
): UiWebCommandCatalog["commands"][number]["argumentMode"] {
  return id === "skill.hansun-db"
    ? "raw"
    : id === "skills" || id === "status"
      ? "argv"
      : id === "goal"
        ? "argv"
        : "structured";
}

function catalogCategory(id: CatalogId): string {
  switch (id) {
    case "compact":
    case "goal":
      return "session";
    case "skill.hansun-db":
    case "skills":
      return "skill";
    case "status":
      return "system";
  }
}

interface SkillModalFixture {
  readonly description: string;
  readonly name: string;
  readonly scope: "project" | "user";
  readonly source?: string;
}

async function showSkillsModal(
  fake: FakeRuntime,
  fixtures: readonly (string | SkillModalFixture)[],
  options: {
    readonly sequence?: number;
    readonly suffix?: string;
  } = {},
): Promise<void> {
  const suffix = options.suffix ? `_${options.suffix}` : "";
  const sequence = options.sequence ?? 2;
  const clientInvocationId = `invoke_skills${suffix}`;
  const commandRunId = `command_skills${suffix}`;
  await act(async () => {
    fake.store.beginCommand({
      clientInvocationId,
      commandId: "skills",
      path: ["skills"],
      raw: "/skills",
      rawArgs: "",
      argv: [],
      surface: "tui",
      sessionId: "session_1",
    });
    fake.store.applyEvent(
      {
        command: {
          clientInvocationId,
          commandId: "skills",
          commandRunId,
          path: ["skills"],
          surface: "tui",
        },
        timestamp: Date.parse(timestamp),
        type: "command.started",
      },
      sequence,
    );
    fake.store.applyEvent(
      {
        clientInvocationId,
        commandRunId,
        output: {
          data: {
            skills: fixtures.map((fixture) =>
              typeof fixture === "string"
                ? {
                    description: `Use ${fixture}`,
                    name: fixture,
                    scope: "user",
                    source: "test",
                  }
                : fixture,
            ),
          },
          kind: "data",
          subject: "skills",
        },
        timestamp: Date.parse(timestamp),
        type: "command.result.delivered",
      },
      sequence + 1,
    );
    await Promise.resolve();
  });
  await waitFor(() =>
    Boolean(fake.store.getSnapshot().view.commandNotices.length),
  );
}

async function showStatusModal(fake: FakeRuntime): Promise<void> {
  await act(async () => {
    fake.store.beginCommand({
      clientInvocationId: "invoke_status",
      commandId: "status",
      path: ["status"],
      raw: "/status",
      rawArgs: "",
      argv: [],
      surface: "tui",
      sessionId: "session_1",
    });
    fake.store.applyEvent(
      {
        command: {
          clientInvocationId: "invoke_status",
          commandId: "status",
          commandRunId: "command_status",
          path: ["status"],
          surface: "tui",
        },
        timestamp: Date.parse(timestamp),
        type: "command.started",
      },
      2,
    );
    fake.store.applyEvent(
      {
        clientInvocationId: "invoke_status",
        commandRunId: "command_status",
        output: {
          data: {
            contextWindow: {
              composition: {
                "system-prompt": 10_000,
                "builtin-tools": 5_000,
                mcp: 2_000,
                skills: 1_000,
                conversation: 15_000,
                "summarized-conversation": 4_000,
                "subagent-exchanges": 0,
              },
              contextWindowRatio: 0.37,
              contextWindowTokens: 100_000,
              currentTokens: 37_000,
              estimatedAt: timestamp,
              modelId: "model-a",
              sessionId: "session_1",
            },
            permission: { level: "default", mode: "auto" },
            promptCacheUsage: {
              accountedInputTokens: 10_000,
              cacheReadShare: 0.614,
              cacheReadTokens: 6_140,
              sessionId: "session_1",
            },
            workingDirectory: "/repo",
            sessionId: "session_1",
            status: "idle",
          },
          kind: "data",
          subject: "status",
        },
        timestamp: Date.parse(timestamp),
        type: "command.result.delivered",
      },
      3,
    );
    await Promise.resolve();
  });
  await waitFor(() =>
    Boolean(fake.store.getSnapshot().view.commandNotices.length),
  );
}

function compactUsage(currentTokens: number): UiCompactSessionUsage {
  return {
    contextLimit: 128_000,
    currentTokens,
    modelId: "glm-4.7",
    remainingTokens: 128_000 - currentTokens,
    usageRatio: currentTokens / 128_000,
  };
}

async function setTextareaValue(
  container: ParentNode,
  value: string,
): Promise<void> {
  const textarea = container.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("textarea not found");
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  );
  await act(async () => {
    if (descriptor?.set) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- React controlled inputs need the native textarea setter in jsdom tests.
      const setValue = descriptor.set;
      Reflect.apply(setValue, textarea, [value]);
    } else {
      textarea.value = value;
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

function textareaValue(container: ParentNode): string {
  const textarea = container.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("textarea not found");
  }
  return textarea.value;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("condition was not met before timeout");
}

async function flushTimers(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

function slashPaletteText(container: ParentNode): string {
  return container.querySelector(".ohb-slash-palette")?.textContent ?? "";
}

function selectedSlashText(container: ParentNode): string {
  return container.querySelector(".ohb-slash-selected")?.textContent ?? "";
}

async function pressTextareaKey(
  container: ParentNode,
  key: string,
): Promise<void> {
  const textarea = container.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("textarea not found");
  }
  await act(async () => {
    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key }),
    );
    await Promise.resolve();
  });
}

async function pressComposingTextareaKey(
  container: ParentNode,
  key: string,
  keyCode = 0,
): Promise<globalThis.KeyboardEvent> {
  const textarea = container.querySelector("textarea");
  if (!(textarea instanceof HTMLTextAreaElement)) {
    throw new Error("textarea not found");
  }
  const event = new KeyboardEvent("keydown", { bubbles: true, key });
  Object.defineProperty(event, "isComposing", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(event, "keyCode", {
    configurable: true,
    value: keyCode,
  });
  await act(async () => {
    textarea.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

async function pressWindowKey(key: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    await Promise.resolve();
  });
}

async function clickButton(
  container: ParentNode,
  title: string,
): Promise<void> {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) =>
      candidate.getAttribute("title") === title ||
      candidate.getAttribute("aria-label") === title ||
      candidate.textContent === title,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${title}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

/* eslint-disable @typescript-eslint/unbound-method -- These client methods are Vitest mocks. */
it("does not reload model metadata for streaming tokens or session preference changes", async () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  const handlers = new Set<(event: UiEvent) => void>();
  vi.spyOn(fake.client, "subscribeEvents").mockImplementation((handler) => {
    handlers.add(handler);
    return (): void => {
      handlers.delete(handler);
    };
  });
  mountApp(fake.runtime);
  await act(async () => {
    await Promise.resolve();
  });
  const initial = vi.mocked(fake.client.getCurrentModel).mock.calls.length;
  expect(initial).toBeGreaterThan(0);
  act(() => {
    for (let revision = 1; revision <= 100; revision++) {
      for (const handler of handlers)
        handler({
          type: "session.changed",
          version: {
            runtimeEpoch: "epoch",
            sessionId: "session_1",
            viewGeneration: "view",
            sessionRevision: revision,
          },
          textAppends: [
            { messageId: "m", partId: "p", offset: revision - 1, text: "x" },
          ],
        });
    }
    for (const handler of handlers)
      handler({
        type: "session.changed",
        version: {
          runtimeEpoch: "epoch",
          sessionId: "session_1",
          viewGeneration: "view",
          sessionRevision: 101,
        },
        session: {
          id: "session_1",
          title: "renamed",
          createdAt: timestamp,
          updatedAt: timestamp,
          reasoning: { enabled: true, effort: "high" },
        },
      });
  });
  expect(fake.client.getCurrentModel).toHaveBeenCalledTimes(initial);
  act(() => {
    for (const handler of handlers) handler({ type: "model.invalidated" });
  });
  expect(fake.client.getCurrentModel).toHaveBeenCalledTimes(initial + 1);
});
it("shows raw reasoning labels inside the input and persists session preference", async () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  vi.mocked(fake.client.getCurrentModel).mockResolvedValue({
    provider: "p",
    model: "m",
    baseUrl: "https://p",
    interfaceProvider: "openai-compatible",
    reasoning: {
      status: "identified",
      mode: "effort",
      supportsDisabled: false,
      efforts: ["high", "max"],
      default: { enabled: true, effort: "high" },
    },
  });
  vi.mocked(fake.client.updateSessionReasoning).mockResolvedValue({
    id: "session_1",
    title: "t",
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    reasoning: { effort: "max" },
  });
  const app = mountApp(fake.runtime);
  await waitFor(() =>
    Boolean(app.container.querySelector('[aria-label="Reasoning effort"]')),
  );
  const select = app.container.querySelector<HTMLSelectElement>(
    '[aria-label="Reasoning effort"]',
  );
  if (!select) throw new Error("Reasoning selector missing");
  expect(Array.from(select.options).map((option) => option.text)).toEqual([
    "high",
    "max",
  ]);
  expect(select.value).toBe("high");
  await act(async () => {
    await Promise.resolve();
    select.value = "max";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(fake.client.updateSessionReasoning).toHaveBeenCalledWith({
    sessionId: "session_1",
    reasoning: { enabled: true, effort: "max" },
  });
  expect(select.closest(".ohb-composer-input")).not.toBeNull();
  expect(select.closest(".ohb-composer-tools")).toBeNull();
});
it("unknown capability keeps send available and labels the control unknown without fake tiers", async () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  vi.mocked(fake.client.getCurrentModel).mockResolvedValue({
    provider: "p",
    model: "m",
    baseUrl: "https://p",
    interfaceProvider: "openai-compatible",
    reasoning: { status: "unknown", efforts: [] },
  });
  const app = mountApp(fake.runtime);
  await waitFor(() => app.container.textContent.includes("unknown"));
  expect(
    app.container
      .querySelector(".ohb-reasoning-unknown")
      ?.closest(".ohb-composer-input"),
  ).not.toBeNull();
  expect(app.container.textContent).not.toContain("推理默认");
  expect(
    app.container.querySelector('[aria-label="Reasoning effort"]'),
  ).toBeNull();
  await setTextareaValue(app.container, "hello");
  expect(
    app.container.querySelector<HTMLTextAreaElement>("textarea")?.disabled,
  ).toBe(false);
});
it("shows only a spinning brain while reasoning capability is detecting", async () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  vi.mocked(fake.client.getCurrentModel).mockResolvedValue({
    provider: "p",
    model: "m",
    baseUrl: "https://p",
    interfaceProvider: "openai-compatible",
    reasoning: { status: "detecting", efforts: [] },
  });
  const app = mountApp(fake.runtime);
  await waitFor(() =>
    Boolean(app.container.querySelector(".ohb-reasoning-detecting")),
  );
  const status = app.container.querySelector(".ohb-reasoning-detecting");
  expect(status?.closest(".ohb-composer-input")).not.toBeNull();
  expect(status?.querySelector(".ohb-reasoning-spinner")).not.toBeNull();
  expect(status?.textContent).toBe("");
  expect(app.container.textContent).not.toContain("检测中");
  expect(app.container.textContent).not.toContain("推理默认");
});
it("keeps the reasoning selector for an identified model that cannot disable reasoning", async () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  vi.mocked(fake.client.getCurrentModel).mockResolvedValue({
    provider: "p",
    model: "m",
    baseUrl: "https://p",
    interfaceProvider: "openai-compatible",
    reasoning: {
      status: "identified",
      mode: "binary",
      supportsDisabled: false,
      efforts: [],
      default: { enabled: true },
    },
  });
  const app = mountApp(fake.runtime);
  await waitFor(() =>
    Boolean(app.container.querySelector('[aria-label="Reasoning effort"]')),
  );
  const select = app.container.querySelector<HTMLSelectElement>(
    '[aria-label="Reasoning effort"]',
  );
  expect(
    Array.from(select?.options ?? []).map((option) => option.text),
  ).toEqual(["On"]);
});
it("clears old workspace reasoning while the new client metadata is pending", async () => {
  const first = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  vi.mocked(first.client.getCurrentModel).mockResolvedValue({
    provider: "old",
    model: "old",
    baseUrl: "https://old.test",
    interfaceProvider: "openai-compatible",
    reasoning: {
      status: "identified",
      mode: "effort",
      supportsDisabled: false,
      efforts: ["high"],
      default: { enabled: true, effort: "high" },
    },
  });
  const second = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  const next =
    deferred<Awaited<ReturnType<UiBackendClient["getCurrentModel"]>>>();
  vi.mocked(second.client.getCurrentModel).mockReturnValue(next.promise);
  const app = mountApp(first.runtime);
  await waitFor(() =>
    Boolean(app.container.querySelector('[aria-label="Reasoning effort"]')),
  );
  const oldSelect = app.container.querySelector<HTMLSelectElement>(
    '[aria-label="Reasoning effort"]',
  );
  if (!oldSelect) throw new Error("Old selector missing");
  await act(async () => {
    oldSelect.value = "high";
    oldSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    app.root.render(<OhbabyWebApp runtime={second.runtime} />);
    await Promise.resolve();
  });
  expect(
    app.container.querySelector('[aria-label="Reasoning effort"]'),
  ).toBeNull();
  await setTextareaValue(app.container, "new workspace");
  await pressTextareaKey(app.container, "Enter");
  expect(second.submitPromptAccepted.mock.calls[0]?.[0]).toBe("new workspace");
  expect(
    second.submitPromptAccepted.mock.calls[0]?.[1]?.reasoning,
  ).toBeUndefined();
});

it.each(["pending", "acknowledged"])(
  "keeps local reasoning through stale session events with PATCH %s",
  async (phase) => {
    const snapshot = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({ snapshot });
    vi.mocked(fake.client.getCurrentModel).mockResolvedValue({
      provider: "p",
      model: "m",
      baseUrl: "https://p",
      interfaceProvider: "openai-compatible",
      reasoning: {
        status: "identified",
        mode: "effort",
        supportsDisabled: false,
        efforts: ["medium", "high"],
        default: { effort: "medium" },
      },
    });
    const save =
      deferred<
        Awaited<ReturnType<UiBackendClient["updateSessionReasoning"]>>
      >();
    vi.mocked(fake.client.updateSessionReasoning).mockReturnValue(save.promise);
    const app = mountApp(fake.runtime);
    await waitFor(() =>
      Boolean(app.container.querySelector('[aria-label="Reasoning effort"]')),
    );
    const select = app.container.querySelector<HTMLSelectElement>(
      '[aria-label="Reasoning effort"]',
    );
    if (!select) throw new Error("Selector missing");
    await act(async () => {
      select.value = "high";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });
    if (phase === "acknowledged") {
      await act(async () => {
        save.resolve({
          ...snapshot.sessions[0],
          reasoning: { enabled: true, effort: "high" },
        });
        await Promise.resolve();
      });
    }
    await act(async () => {
      fake.store.replaceSnapshot(
        {
          ...snapshot,
          sessions: snapshot.sessions.map((session) => ({
            ...session,
            reasoning: { effort: "medium" },
          })),
        },
        2,
      );
      await Promise.resolve();
    });
    expect(select.value).toBe("high");
    await setTextareaValue(app.container, "use high");
    await pressTextareaKey(app.container, "Enter");
    expect(fake.submitPromptAccepted).toHaveBeenCalledWith(
      "use high",
      expect.objectContaining({ reasoning: { enabled: true, effort: "high" } }),
    );
    await act(async () => {
      save.resolve({
        ...snapshot.sessions[0],
        reasoning: { enabled: true, effort: "high" },
      });
      await Promise.resolve();
    });
    expect(select.value).toBe("high");
    await act(async () => {
      fake.store.replaceSnapshot(
        {
          ...snapshot,
          sessions: snapshot.sessions.map((session) => ({
            ...session,
            reasoning: { enabled: true, effort: "high" },
          })),
        },
        3,
      );
      await Promise.resolve();
    });
    expect(select.value).toBe("high");
  },
);

it.each([false, true])(
  "keeps React external-store updates healthy through 400 microtask source appends (pending admission=%s)",
  async (pendingAdmission) => {
    const initial = snapshotWithStatus({
      kind: "running",
      runId: "run-stream",
    });
    const fake = createFakeRuntime({ snapshot: initial });
    const baseline: UiSessionView = {
      version: {
        runtimeEpoch: "epoch",
        sessionId: "session_1",
        viewGeneration: "stream-view",
        sessionRevision: 0,
      },
      session: {
        ...initial.sessions[0],
        messages: [
          {
            id: "streamed",
            role: "assistant",
            status: "streaming",
            createdAt: timestamp,
            parts: [{ id: "part", type: "text", text: "" }],
          },
        ],
      },
      runs: [],
      prompts: [],
      history: { hasMore: false },
      reasoningMissing: false,
      todo: { status: "ready", value: null },
      goal: { status: "ready", value: null },
      context: { status: "ready", value: null },
    };
    const sync = createSessionSync({
      query: () => Promise.resolve(baseline),
      onChange: (state) => {
        fake.store.setSessionSync(state);
      },
    });
    if (pendingAdmission)
      fake.submitPromptAccepted.mockImplementation(
        () => new Promise(() => undefined),
      );
    const app = mountApp(fake.runtime);
    await act(async () => {
      sync.begin({ sessionId: "session_1", runtimeEpoch: "epoch" }, 1);
      await Promise.resolve();
    });
    if (pendingAdmission) {
      await setTextareaValue(app.container, "concurrent admission retained");
      await pressTextareaKey(app.container, "Enter");
      expect(fake.submitPromptAccepted).toHaveBeenCalledTimes(1);
    }
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const environment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    environment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      // A real SSE chunk awaits each frame; act() would batch away this scheduling boundary.
      for (let offset = 0; offset < 400; offset++) {
        sync.receive({
          type: "session.changed",
          version: { ...baseline.version, sessionRevision: offset + 1 },
          textAppends: [
            { messageId: "streamed", partId: "part", offset, text: "x" },
          ],
        });
        await Promise.resolve();
        await Promise.resolve();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      environment.IS_REACT_ACT_ENVIRONMENT = true;
      sync.dispose();
    }
    await act(async () => {
      await Promise.resolve();
    });
    expect(app.container.textContent).toContain("x".repeat(400));
    if (pendingAdmission)
      expect(app.container.textContent).toContain(
        "concurrent admission retained",
      );
    expect(errors.mock.calls.flat().map(String).join("\n")).not.toMatch(
      /ui\.observation\.failure|Maximum update depth/,
    );
  },
);

describe("execution progress facts", () => {
  it("does not show model thinking merely because a run exists", () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
    });
    expect(
      mountApp(fake.runtime).container.querySelector(".ohb-thinking"),
    ).toBeNull();
  });
  it("keeps Stop pending after RPC acceptance and clears on the exact terminal prompt", async () => {
    const initial = snapshotWithStatus({ kind: "running", runId: "run_1" });
    const fake = createFakeRuntime({ snapshot: initial });
    const app = mountApp(fake.runtime);
    const stop = requiredStopButton(app.container);
    await act(async () => {
      stop.click();
      await Promise.resolve();
    });
    expect(stop.disabled).toBe(true);
    expect(stop.getAttribute("aria-label")).toBe("Stopping run");
    await act(async () => {
      stop.click();
      await Promise.resolve();
    });
    expect(fake.abortSession).toHaveBeenCalledTimes(1);
    act(() => {
      fake.store.replaceSnapshot(
        {
          ...initial,
          status: { kind: "idle" },
          runs: [],
          prompts: [
            {
              promptId: "p",
              clientRequestId: "c",
              scopeKey: "s",
              sessionId: "session_1",
              runId: "run_1",
              userMessageId: "message_1",
              text: "hello",
              status: "succeeded",
              createdAt: timestamp,
              updatedAt: timestamp,
              endedAt: "2026-06-12T00:00:05.000Z",
            },
          ],
        },
        2,
      );
    });
    expect(
      app.container.querySelector('[aria-label="Stopping run"]'),
    ).toBeNull();
    expect(app.container.querySelectorAll(".ohb-prompt-duration")).toHaveLength(
      1,
    );
    expect(
      app.container.querySelector(".ohb-prompt-duration")?.textContent,
    ).toContain("5s");
  });
});

it("finishes Stop before RPC settles and ignores its later transport failure", async () => {
  const initial = snapshotWithStatus({ kind: "running", runId: "run_1" });
  const fake = createFakeRuntime({ snapshot: initial });
  const rpc = deferred<undefined>();
  fake.abortSession.mockImplementation(() => rpc.promise);
  const app = mountApp(fake.runtime);
  act(() => {
    requiredStopButton(app.container).click();
  });
  act(() => {
    fake.store.replaceSnapshot(
      {
        ...initial,
        status: { kind: "idle" },
        runs: [{ ...initial.runs[0], status: { kind: "idle" } }],
      },
      2,
    );
  });
  expect(app.container.querySelector('[aria-label="Stopping run"]')).toBeNull();
  await act(async () => {
    rpc.reject(new Error("late transport failure"));
    await Promise.resolve();
  });
  expect(app.container.textContent).not.toContain("late transport failure");
});

it("keeps B pending when A fails late in the same session", async () => {
  const initial = snapshotWithStatus({ kind: "running", runId: "run_1" });
  const fake = createFakeRuntime({ snapshot: initial });
  const a = deferred<undefined>();
  const b = deferred<undefined>();
  fake.abortSession
    .mockImplementationOnce(() => a.promise)
    .mockImplementationOnce(() => b.promise);
  const app = mountApp(fake.runtime);
  await act(async () => {
    requiredStopButton(app.container).click();
    await Promise.resolve();
  });
  act(() => {
    fake.store.replaceSnapshot(
      snapshotWithStatus({ kind: "running", runId: "run_2" }),
      2,
    );
  });
  await act(async () => {
    requiredStopButton(app.container).click();
    await Promise.resolve();
  });
  await act(async () => {
    a.reject(new Error("A failed late"));
    await Promise.resolve();
  });
  expect(
    app.container.querySelector<HTMLButtonElement>(".ohb-stop-button")
      ?.disabled,
  ).toBe(true);
  expect(app.container.textContent).not.toContain("A failed late");
  act(() => {
    b.resolve(undefined);
  });
});

it("keeps Stop uncertain across disconnect without repeating RPC and permits draft editing", async () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
  });
  const rpc = deferred<undefined>();
  fake.abortSession.mockImplementation(() => rpc.promise);
  const app = mountApp(fake.runtime);
  await act(async () => {
    requiredStopButton(app.container).click();
    await Promise.resolve();
  });
  act(() => {
    fake.store.setConnectionState("disconnected");
  });
  await act(async () => {
    rpc.reject(new Error("offline"));
    await Promise.resolve();
  });
  expect(
    app.container.querySelector(".ohb-stop-button")?.getAttribute("aria-label"),
  ).toContain("status unconfirmed");
  await setTextareaValue(app.container, "next draft");
  expect(textareaValue(app.container)).toBe("next draft");
  act(() => {
    fake.store.setConnectionState("live");
  });
  expect(fake.abortSession).toHaveBeenCalledTimes(1);
  expect(
    app.container.querySelector<HTMLButtonElement>(".ohb-stop-button")
      ?.disabled,
  ).toBe(true);
  act(() => {
    fake.store.replaceSnapshot(
      snapshotWithStatus({ kind: "running", runId: "run_1" }),
      2,
    );
  });
  expect(app.container.querySelector('[aria-label="Stopping run"]')).toBeNull();
  expect(app.container.textContent).toContain("offline");
});

it("hides model waiting permanently after first text and resets for the next attempt", () => {
  const initial = snapshotWithStatus({ kind: "running", runId: "run_1" });
  const request = {
    requestId: "r1",
    runId: "run_1",
    messageId: "m",
    step: 1,
    attempt: 1,
    purpose: "agent-step" as const,
    startedAt: 1000,
    outcome: "running" as const,
  };
  const fake = createFakeRuntime({
    snapshot: {
      ...initial,
      serverNow: 4000,
      runs: [{ ...initial.runs[0], modelActivity: request }],
    },
  });
  const app = mountApp(fake.runtime);
  expect(app.container.querySelector(".ohb-thinking")?.textContent).toContain(
    "3s",
  );
  act(() => {
    fake.store.replaceSnapshot(
      {
        ...initial,
        serverNow: 8000,
        runs: [
          {
            ...initial.runs[0],
            modelActivity: { ...request, firstTextAt: 4500 },
          },
        ],
      },
      2,
    );
  });
  expect(app.container.querySelector(".ohb-thinking")).toBeNull();
  act(() => {
    fake.store.replaceSnapshot(
      {
        ...initial,
        serverNow: 10000,
        runs: [
          {
            ...initial.runs[0],
            modelActivity: { ...request, firstTextAt: 4500 },
          },
        ],
      },
      3,
    );
  });
  expect(app.container.querySelector(".ohb-thinking")).toBeNull();
  act(() => {
    fake.store.replaceSnapshot(
      {
        ...initial,
        serverNow: 11000,
        runs: [
          {
            ...initial.runs[0],
            modelActivity: { ...request, requestId: "r2", startedAt: 11000 },
          },
        ],
      },
      4,
    );
  });
  expect(app.container.querySelector(".ohb-thinking")?.textContent).toContain(
    "0s",
  );
});

it("does not resurrect A's unresolved Stop after B reaches a reliable terminal", async () => {
  const initial = snapshotWithStatus({ kind: "running", runId: "run_1" });
  const fake = createFakeRuntime({ snapshot: initial });
  const app = mountApp(fake.runtime);
  await act(async () => {
    requiredStopButton(app.container).click();
    await Promise.resolve();
  });
  act(() => {
    fake.store.replaceSnapshot(
      snapshotWithStatus({ kind: "running", runId: "run_2" }),
      2,
    );
  });
  await act(async () => {
    requiredStopButton(app.container).click();
    await Promise.resolve();
  });
  act(() => {
    fake.store.replaceSnapshot(
      {
        ...initial,
        status: { kind: "idle" },
        runs: [{ ...initial.runs[0], id: "run_2", status: { kind: "idle" } }],
      },
      3,
    );
  });
  expect(app.container.querySelector('[aria-label="Stopping run"]')).toBeNull();
});

function requiredStopButton(container: HTMLDivElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(".ohb-stop-button");
  if (!button) throw new Error("Stop button missing");
  return button;
}

it("changes only the Stop accessible hint after ten seconds and never resends", async () => {
  vi.useFakeTimers();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
    });
    const app = mountApp(fake.runtime);
    await act(async () => {
      requiredStopButton(app.container).click();
      await Promise.resolve();
    });
    act(() => {
      now = 10001;
      vi.advanceTimersByTime(10001);
    });
    expect(requiredStopButton(app.container).getAttribute("aria-label")).toBe(
      "Still stopping run",
    );
    expect(requiredStopButton(app.container).disabled).toBe(true);
    expect(fake.abortSession).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["succeeded", "failed", "cancelled", "interrupted"] as const)(
  "renders one %s total from its prompt ledger across snapshots",
  (status) => {
    const initial = snapshotWithStatus({ kind: "idle" });
    const prompt: UiPromptSubmission = {
      promptId: "p",
      clientRequestId: "c",
      scopeKey: "s",
      sessionId: "session_1",
      runId: "r",
      userMessageId: "u",
      text: "question",
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
      endedAt: "2026-06-12T00:01:01Z",
    };
    const snapshot: UiSnapshot = {
      ...initial,
      prompts: [prompt],
      sessions: [
        {
          ...initial.sessions[0],
          messages: [
            {
              id: "u",
              role: "user",
              createdAt: timestamp,
              parts: [{ type: "text", text: "question" }],
            },
            ...(status === "succeeded"
              ? [
                  {
                    id: "a",
                    role: "assistant" as const,
                    runId: "r",
                    createdAt: timestamp,
                    parts: [{ type: "text" as const, text: "final answer" }],
                  },
                ]
              : []),
          ],
        },
      ],
    };
    const fake = createFakeRuntime({ snapshot });
    const app = mountApp(fake.runtime);
    expect(app.container.querySelectorAll(".ohb-prompt-duration")).toHaveLength(
      1,
    );
    expect(
      app.container.querySelector(".ohb-prompt-duration")?.textContent,
    ).toContain("Total 1m 1s");
    if (status === "succeeded")
      expect(
        app.container
          .querySelector(".ohb-prompt-duration")
          ?.nextElementSibling?.textContent.trim(),
      ).toBe("final answer");
    act(() => {
      fake.store.replaceSnapshot(snapshot, 2);
    });
    expect(app.container.querySelectorAll(".ohb-prompt-duration")).toHaveLength(
      1,
    );
  },
);

function snapshotForDraftScope(id: string): UiSnapshot {
  const initial = snapshotWithStatus({ kind: "idle" });
  return {
    ...initial,
    activeSessionId: id,
    sessions: initial.sessions.map((session) => ({ ...session, id })),
  };
}

describe("feature boundary late-result isolation", () => {
  it("persists a successful slash clear instead of restoring the command after reload", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);
    await setTextareaValue(app.container, "/status");
    await waitFor(() => slashPaletteText(app.container).includes("/status"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() => fake.executeSlashCommand.mock.calls.length === 1);
    expect(textareaValue(app.container)).toBe("");
    expect(
      JSON.parse(
        sessionStorage.getItem("ohbaby:composer:session_1") ?? '{"text":""}',
      ),
    ).toMatchObject({ text: "" });
  });
  it("does not let a pending slash clear or disable a different session draft", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const pending = deferred<import("ohbaby-sdk").UiCommandCompletion>();
    fake.executeSlashCommand.mockReturnValue(pending.promise);
    const app = mountApp(fake.runtime);
    await setTextareaValue(app.container, "/status");
    await waitFor(() => slashPaletteText(app.container).includes("/status"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() => fake.executeSlashCommand.mock.calls.length === 1);
    act(() => {
      fake.store.replaceSnapshot(snapshotForDraftScope("session_2"), 4);
    });
    await setTextareaValue(app.container, "B draft");
    const disabled = app.container.querySelector("textarea")?.disabled;
    await act(async () => {
      pending.resolve({
        status: "completed" as const,
        commandRunId: "command_1",
        clientInvocationId: "invoke_1",
        outputCount: 0,
        eventCount: 0,
      });
      await pending.promise;
    });
    expect(disabled).toBe(false);
    expect(textareaValue(app.container)).toBe("B draft");
  });
  it("does not replay a consumed skills insertion into another session or on return", async () => {
    const initial = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({ snapshot: initial });
    const app = mountApp(fake.runtime);
    await showSkillsModal(fake, ["review"]);
    await pressWindowKey("Tab");
    expect(textareaValue(app.container)).toBe("/review ");
    await setTextareaValue(app.container, "A changed after insertion");
    act(() => {
      fake.store.replaceSnapshot(snapshotForDraftScope("session_2"), 4);
    });
    expect(textareaValue(app.container)).toBe("");
    await setTextareaValue(app.container, "B draft");
    act(() => {
      fake.store.replaceSnapshot(initial, 5);
    });
    expect(textareaValue(app.container)).toBe("A changed after insertion");
  });
  it("closes the old compact form when switching scope and ignores its late result", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["compact"]));
    const pending =
      deferred<Awaited<ReturnType<UiBackendClient["compactSession"]>>>();
    fake.compactSession.mockReturnValue(pending.promise);
    const app = mountApp(fake.runtime);
    await setTextareaValue(app.container, "/compact");
    await waitFor(() => slashPaletteText(app.container).includes("/compact"));
    await pressTextareaKey(app.container, "Enter");
    await clickButton(app.container, "Compact session");
    act(() => {
      fake.store.replaceSnapshot(snapshotForDraftScope("session_2"), 4);
    });
    await act(async () => {
      pending.reject(new Error("A compact failed late"));
      await pending.promise.catch(() => undefined);
    });
    expect(app.container.querySelector(".ohb-structured-overlay")).toBeNull();
    expect(app.container.textContent).not.toContain("A compact failed late");
  });
  it("does not let old lease recovery failure clear the new scope's queued editor", async () => {
    for (const id of ["session_1", "session_2"]) {
      sessionStorage.setItem(
        `ohbaby:composer-lease:${id}`,
        JSON.stringify({
          editLeaseId: `lease_${id}`,
          editText: `editing ${id}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
          lastActivityAt: 1,
          originalDraft: `draft ${id}`,
          promptId: `prompt_${id}`,
        }),
      );
    }
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const old = deferred<UiPromptEditLease>();
    vi.spyOn(fake.client, "renewPromptEditLease").mockImplementation((input) =>
      input.editLeaseId === "lease_session_1"
        ? old.promise
        : Promise.resolve({
            ...input,
            prompt: promptSubmission({ sessionId: "session_2" }),
            ownerClientId: "web",
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
    );
    const app = mountApp(fake.runtime);
    act(() => {
      fake.store.replaceSnapshot(snapshotForDraftScope("session_2"), 4);
    });
    await act(async () => {
      old.reject(new Error("old expired"));
      await old.promise.catch(() => undefined);
    });
    expect(textareaValue(app.container)).toBe("editing session_2");
    expect(app.container.querySelector(".ohb-queued-edit-hint")).not.toBeNull();
    expect(app.container.textContent).not.toContain(
      "Queued edit lease expired",
    );
  });
});

it("preserves an intentionally cleared new draft after a late admission rejection", async () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  const pending =
    deferred<Awaited<ReturnType<UiBackendClient["submitPromptAccepted"]>>>();
  fake.submitPromptAccepted.mockReturnValue(pending.promise);
  const app = mountApp(fake.runtime);
  await setTextareaValue(app.container, "old submission");
  await pressTextareaKey(app.container, "Enter");
  await setTextareaValue(app.container, "a newer edit");
  await setTextareaValue(app.container, "");
  await act(async () => {
    pending.reject(new Error("old failure"));
    await pending.promise.catch(() => undefined);
  });
  expect(textareaValue(app.container)).toBe("");
});

function storeEditLease(
  sessionId: string,
  editLeaseId: string,
  text: string,
): void {
  sessionStorage.setItem(
    `ohbaby:composer-lease:${sessionId}`,
    JSON.stringify({
      editLeaseId,
      editText: text,
      expiresAt: "2099-01-01T00:00:00.000Z",
      lastActivityAt: 1,
      originalDraft: "original draft",
      promptId: "prompt_queued",
    }),
  );
}

describe("queued edit identity isolation", () => {
  it("ignores an old A recovery failure after leaving and returning to A", async () => {
    storeEditLease("session_1", "lease_A", "original edit");
    const initial = snapshotWithStatus({ kind: "idle" });
    const fake = createFakeRuntime({ snapshot: initial });
    const old = deferred<UiPromptEditLease>();
    vi.spyOn(fake.client, "renewPromptEditLease")
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue({
        editLeaseId: "lease_new_A",
        ownerClientId: "web",
        prompt: promptSubmission(),
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    mountApp(fake.runtime);
    act(() => {
      fake.store.replaceSnapshot(snapshotForDraftScope("session_2"), 4);
    });
    storeEditLease("session_1", "lease_new_A", "new A edit");
    act(() => {
      fake.store.replaceSnapshot(initial, 5);
    });
    await act(async () => {
      old.reject(new Error("old A failure"));
      await old.promise.catch(() => undefined);
    });
    expect(sessionStorage.getItem("ohbaby:composer-lease:session_1")).toContain(
      "lease_new_A",
    );
    expect(sessionStorage.getItem("ohbaby:composer-lease:session_1")).toContain(
      "new A edit",
    );
  });
  it.each(["edit", "release"])(
    "recovery success preserves a later %s of the same lease",
    async (action) => {
      storeEditLease("session_1", "lease_A", "original edit");
      const fake = createFakeRuntime({
        snapshot: snapshotWithStatus({ kind: "idle" }),
      });
      const pending = deferred<UiPromptEditLease>();
      vi.spyOn(fake.client, "renewPromptEditLease").mockReturnValue(
        pending.promise,
      );
      const app = mountApp(fake.runtime);
      if (action === "edit") await setTextareaValue(app.container, "new edit");
      else await pressTextareaKey(app.container, "Escape");
      await act(async () => {
        pending.resolve({
          editLeaseId: "lease_A",
          ownerClientId: "web",
          prompt: promptSubmission(),
          expiresAt: "2099-02-01T00:00:00.000Z",
        });
        await pending.promise;
      });
      const stored = sessionStorage.getItem("ohbaby:composer-lease:session_1");
      if (action === "edit") expect(stored).toContain("new edit");
      else expect(stored).toBeNull();
    },
  );
  it("does not close Q2 when cancellation of the old Q1 editor completes", async () => {
    const q1 = promptSubmission({
      promptId: "q1",
      text: "queued one",
      status: "queued",
    });
    const q2 = promptSubmission({
      promptId: "q2",
      text: "queued two",
      status: "queued",
    });
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "running", runId: "run_1" }),
        prompts: [q1, q2],
      },
    });
    vi.spyOn(fake.client, "acquirePromptEditLease").mockImplementation(
      ({ promptId }) =>
        Promise.resolve({
          editLeaseId: `lease_${promptId}`,
          ownerClientId: "web",
          prompt: promptId === "q1" ? q1 : q2,
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
    );
    const pending = deferred<UiPromptSubmission>();
    vi.spyOn(fake.client, "cancelQueuedPrompt").mockReturnValue(
      pending.promise,
    );
    const app = mountApp(fake.runtime);
    const click = async (label: string): Promise<void> => {
      const button = app.container.querySelector(`[aria-label="${label}"]`);
      if (!(button instanceof HTMLButtonElement))
        throw new Error(`missing ${label}`);
      await act(async () => {
        button.click();
        await Promise.resolve();
      });
    };
    await click("Edit prompt: queued one");
    await click("Delete prompt: queued one");
    await pressTextareaKey(app.container, "Escape");
    await click("Edit prompt: queued two");
    await act(async () => {
      pending.resolve({ ...q1, status: "cancelled" });
      await pending.promise;
    });
    expect(textareaValue(app.container)).toBe("queued two");
    expect(app.container.querySelector(".ohb-queued-edit-hint")).not.toBeNull();
    expect(sessionStorage.getItem("ohbaby:composer-lease:session_1")).toContain(
      "lease_q2",
    );
  });
});

it("temporarily hides the mounted composer and todo during root approval, retains Stop, then restores the draft and focus", async () => {
  const fake = createFakeRuntime({
    snapshot: {
      ...snapshotWithStatus({ kind: "running", runId: "run_1" }),
      todos: [
        {
          sessionId: "session_1",
          visible: true,
          todos: [{ content: "Keep task", status: "in_progress" }],
        },
      ],
    },
  });
  const app = mountApp(fake.runtime);
  await setTextareaValue(app.container, "Keep my draft");
  await clickButton(app.container, "Collapse todo list");
  const input = app.container.querySelector<HTMLTextAreaElement>("textarea");
  act(() => {
    input?.focus();
  });
  const todo = app.container.querySelector(".ohb-todo-dock");
  const sync = fake.store.getSnapshot().permissionSync;
  act(() => {
    fake.store.setPermissionSync({
      ...sync,
      requests: [permissionRequest()],
      permissionRevision: 1,
    });
  });
  const wrapper =
    app.container.querySelector<HTMLElement>(".ohb-root-composer");
  expect(wrapper?.style.display).toBe("none");
  expect(wrapper?.hasAttribute("inert")).toBe(true);
  expect(app.container.querySelector("textarea")).toBe(input);
  expect(input?.value).toBe("Keep my draft");
  expect(app.container.querySelector(".ohb-todo-dock")).toBe(todo);
  expect(
    app.container
      .querySelector(".ohb-todo-toggle")
      ?.getAttribute("aria-expanded"),
  ).toBe("false");
  expect(document.activeElement).toBe(
    app.container.querySelector(".ohb-approval-panel h2"),
  );
  const stop = app.container.querySelector<HTMLButtonElement>(
    '.ohb-approval-panel [aria-label="Stop run"]',
  );
  expect(stop).not.toBeNull();
  await act(async () => {
    stop?.click();
    await Promise.resolve();
  });
  expect(fake.abortSession).toHaveBeenCalledWith("session_1", "run_1");
  act(() => {
    fake.store.setPermissionSync({
      ...sync,
      requests: [],
      permissionRevision: 2,
    });
  });
  expect(wrapper?.style.display).toBe("contents");
  expect(wrapper?.hasAttribute("inert")).toBe(false);
  expect(input?.value).toBe("Keep my draft");
  expect(document.activeElement).toBe(input);
});

it("keeps the composer visible for an approval sync error without an actual request", () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  const app = mountApp(fake.runtime);
  act(() => {
    fake.store.setPermissionSync({
      ...fake.store.getSnapshot().permissionSync,
      status: "error",
      error: "Retry approval sync",
      requests: [],
    });
  });
  expect(app.container.querySelector(".ohb-approval-panel")).toBeNull();
  expect(
    app.container.querySelector<HTMLElement>(".ohb-root-composer")?.style
      .display,
  ).toBe("contents");
  expect(app.container.textContent).toContain("Retry approvals");
});

it("does not restore input focus after the user moved to another control before approval", () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
  });
  const app = mountApp(fake.runtime);
  const input = app.container.querySelector<HTMLTextAreaElement>("textarea");
  const other = app.container.querySelector<HTMLButtonElement>(
    ".ohb-permission-toggle",
  );
  act(() => {
    input?.focus();
    other?.focus();
  });
  const sync = fake.store.getSnapshot().permissionSync;
  act(() => {
    fake.store.setPermissionSync({ ...sync, requests: [permissionRequest()] });
  });
  act(() => {
    fake.store.setPermissionSync({ ...sync, requests: [] });
  });
  expect(document.activeElement).not.toBe(input);
});

it("reserves the measured approval height and updates it when the card resizes", () => {
  let resized: ResizeObserverCallback = () => undefined;
  let height = 220;
  const geometry = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return new DOMRect(
        0,
        0,
        700,
        this.classList.contains("ohb-approval-panel") ? height : 0,
      );
    });
  const original = globalThis.ResizeObserver;
  class Observer {
    constructor(callback: ResizeObserverCallback) {
      resized = callback;
    }
    observe(): void {
      /* Triggered explicitly by the test. */
    }
    unobserve(): void {
      /* No resources in this observer fixture. */
    }
    disconnect(): void {
      /* No resources in this observer fixture. */
    }
  }
  globalThis.ResizeObserver = Observer;
  try {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
    });
    const app = mountApp(fake.runtime);
    const sync = fake.store.getSnapshot().permissionSync;
    act(() => {
      fake.store.setPermissionSync({
        ...sync,
        requests: [permissionRequest()],
      });
    });
    const content = app.container.querySelector<HTMLElement>(".ohb-main-body");
    expect(content?.style.getPropertyValue("--approval-space")).toBe("244px");
    act(() => {
      height = 340;
      resized([], new Observer(() => undefined));
    });
    expect(content?.style.getPropertyValue("--approval-space")).toBe("364px");
    act(() => {
      fake.store.setPermissionSync({ ...sync, requests: [] });
    });
    expect(content?.style.getPropertyValue("--approval-space")).toBe("");
  } finally {
    geometry.mockRestore();
    globalThis.ResizeObserver = original;
  }
});

it("keeps the child shell read-only and returns focus to pending approval when it closes", async () => {
  const base = snapshotWithStatus({ kind: "running", runId: "run_1" });
  const rootSession = base.sessions[0];
  const fake = createFakeRuntime({
    snapshot: {
      ...base,
      sessions: [
        {
          ...rootSession,
          messages: [
            {
              id: "delegation",
              role: "assistant",
              createdAt: timestamp,
              parts: [
                {
                  type: "tool-call",
                  call: {
                    id: "delegate",
                    name: "subagent_run",
                    input: { prompt: "Investigate" },
                    status: "completed",
                  },
                },
                {
                  type: "tool-result",
                  result: { callId: "delegate", output: "done" },
                  metadata: {
                    subagent: {
                      execution: {
                        executionId: "exec",
                        subagentId: "worker",
                        status: "completed",
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
      permissions: [permissionRequest()],
    },
  });
  fake.client.watchSubagentConversation = vi.fn(() =>
    Promise.reject(new Error("fixture unavailable")),
  );
  const app = mountApp(fake.runtime);
  const trigger = app.container.querySelector<HTMLButtonElement>(
    ".ohb-delegation-row",
  );
  await act(async () => {
    trigger?.click();
    await Promise.resolve();
  });
  expect(app.container.querySelector(".ohb-approval-panel")).toBeNull();
  expect(app.container.querySelector(".ohb-subagent-view")).not.toBeNull();
  expect(
    app.container.querySelector<HTMLElement>(".ohb-root-composer")?.style
      .display,
  ).toBe("contents");
  expect(app.container.textContent).toContain("Read-only subagent");
  await act(async () => {
    app.container
      .querySelector<HTMLButtonElement>(
        '.ohb-subagent-view [aria-label="Close"]',
      )
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  expect(document.activeElement).toBe(
    app.container.querySelector(".ohb-approval-panel h2"),
  );
  expect(document.activeElement).not.toBe(trigger);
});

it("keeps slash parse failures beside input and clears only that error on editing", async () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  fake.executeSlashCommand.mockRejectedValue(
    new Error('Unknown command "/does-not-exist"'),
  );
  fake.store.setError("unrelated transport error");
  const app = mountApp(fake.runtime);
  await setTextareaValue(app.container, "/does-not-exist");
  await pressTextareaKey(app.container, "Enter");
  await waitFor(() =>
    app.container.textContent.includes('Unknown command "/does-not-exist"'),
  );
  const inputArea = app.container.querySelector(".ohb-composer-content");
  expect(inputArea?.textContent).toContain('Unknown command "/does-not-exist"');
  expect(app.container.textContent).toContain("unrelated transport error");
  await setTextareaValue(app.container, "/corrected");
  expect(app.container.textContent).not.toContain(
    'Unknown command "/does-not-exist"',
  );
  expect(app.container.textContent).toContain("unrelated transport error");
});

it.each([
  ["user-stop", "typed", false],
  ["service-shutdown", "typed", false],
  ["user-stop", "run", false],
  ["user-stop", "legacy", false],
  ["process-interrupted", "typed", true],
  ["cancelled", "typed", true],
  ["user-stop", "abort", false],
  ["service-shutdown", "abort", false],
  ["runtime interrupted", "abort", true],
  ["process-interrupted", "abort", true],
] as const)(
  "projects persisted interruption %s (%s) correctly after reload and session return",
  (reason, source, isError) => {
    const initial = snapshotWithStatus({ kind: "idle" });
    const stopped: UiSnapshot = {
      ...initial,
      prompts: [
        promptSubmission({
          status: "interrupted",
          runId: "stopped-run",
          error: {
            code: "RUN_INTERRUPTED",
            source: "runtime",
            retryable: true,
            message:
              source === "legacy" || source === "abort"
                ? reason
                : "runtime interrupted",
            ...(source === "typed" ? { terminalReason: reason } : {}),
            ...(source === "abort" ? { terminalReason: "cancelled" } : {}),
          },
        }),
      ],
      runs: [
        {
          id: "stopped-run",
          sessionId: "session_1",
          startedAt: timestamp,
          updatedAt: timestamp,
          endedAt: timestamp,
          status: { kind: "idle" },
          ...(source === "run" ? { terminalReason: reason } : {}),
          ...(source === "abort" ? { terminalReason: "cancelled" } : {}),
        },
      ],
      sessions: initial.sessions.map((session) => ({
        ...session,
        messages: [
          {
            id: "message_projected",
            createdAt: timestamp,
            role: "user" as const,
            parts: [{ type: "text" as const, text: "server projected prompt" }],
          },
        ],
      })),
    };
    const fake = createFakeRuntime({ snapshot: stopped });
    const app = mountApp(fake.runtime);
    const assertPresentation = (): void => {
      expect(Boolean(app.container.querySelector('[role="alert"]'))).toBe(
        isError,
      );
      expect(app.container.textContent).toContain("server projected prompt");
    };
    assertPresentation();
    act(() => {
      fake.store.replaceSnapshot(
        {
          ...initial,
          activeSessionId: "other",
          prompts: [],
          runs: [],
          sessions: [
            ...initial.sessions,
            { ...initial.sessions[0], id: "other", messages: [] },
          ],
        },
        2,
      );
    });
    act(() => {
      fake.store.replaceSnapshot(stopped, 3);
    });
    assertPresentation();
  },
);

it("keeps failed command feedback inside the composer and dismisses it accessibly", async () => {
  const fake = createFakeRuntime({
    snapshot: snapshotWithStatus({ kind: "idle" }),
  });
  const app = mountApp(fake.runtime);
  act(() => {
    fake.store.beginCommand({
      clientInvocationId: "failed-input",
      commandId: "custom",
      path: ["custom"],
      raw: "/custom",
      rawArgs: "",
      argv: [],
      surface: "tui",
      sessionId: "session_1",
    });
    fake.store.failCommand("failed-input", "Known command failure");
  });
  expect(
    app.container.querySelector(".ohb-composer-content .ohb-command-notice")
      ?.textContent,
  ).toContain("Known command failure");
  const dismiss = app.container.querySelector<HTMLButtonElement>(
    '[aria-label="Dismiss command result"]',
  );
  expect(dismiss).not.toBeNull();
  act(() => dismiss?.click());
  expect(app.container.textContent).not.toContain("Known command failure");
  await setTextareaValue(app.container, "next draft");
  expect(app.container.querySelector("textarea")?.value).toBe("next draft");
});

it.each(["user-stop", "service-shutdown"])(
  "keeps an expected %s prompt readable without inline failure before formal message arrives",
  (reason) => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        prompts: [
          promptSubmission({
            status: "interrupted",
            error: {
              code: "RUN_INTERRUPTED",
              source: "runtime",
              retryable: true,
              message: reason,
              terminalReason: "cancelled",
            },
          }),
        ],
      },
    });
    const app = mountApp(fake.runtime);
    expect(app.container.textContent).toContain("server projected prompt");
    expect(app.container.textContent).toContain("Interrupted");
    expect(app.container.querySelector('[role="alert"]')).toBeNull();
  },
);

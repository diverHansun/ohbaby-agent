// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  UiCompactSessionUsage,
  UiPermissionRequest,
  UiPromptEditLease,
  UiRunStatus,
  UiSnapshot,
  UiWebCommandCatalog,
} from "ohbaby-sdk";
import type {
  OhbabyWebClient,
  OhbabyWebRuntime,
} from "../api/daemon/client.js";
import { createOhbabyWebStore } from "../store/store.js";
import type { OhbabyWebStore } from "../store/store.js";
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
  readonly archiveSession: ReturnType<
    typeof vi.fn<(sessionId: string) => Promise<void>>
  >;
  readonly compactSession: ReturnType<
    typeof vi.fn<OhbabyWebClient["compactSession"]>
  >;
  readonly createSession: ReturnType<
    typeof vi.fn<OhbabyWebClient["createSession"]>
  >;
  readonly executeSlashCommand: ReturnType<
    typeof vi.fn<OhbabyWebClient["executeSlashCommand"]>
  >;
  readonly connectModel: ReturnType<
    typeof vi.fn<OhbabyWebClient["connectModel"]>
  >;
  readonly listCommands: ReturnType<
    typeof vi.fn<OhbabyWebClient["listCommands"]>
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
  readonly openWorkspace: ReturnType<
    typeof vi.fn<OhbabyWebRuntime["openWorkspace"]>
  >;
  readonly runtime: OhbabyWebRuntime;
  readonly selectSession: ReturnType<
    typeof vi.fn<OhbabyWebClient["selectSession"]>
  >;
  readonly setPermission: ReturnType<
    typeof vi.fn<OhbabyWebClient["setPermission"]>
  >;
  readonly setSearchApiKey: ReturnType<
    typeof vi.fn<OhbabyWebClient["setSearchApiKey"]>
  >;
  readonly submitPrompt: ReturnType<
    typeof vi.fn<OhbabyWebClient["submitPrompt"]>
  >;
  readonly store: OhbabyWebStore;
  readonly switchWorkspace: ReturnType<
    typeof vi.fn<OhbabyWebRuntime["switchWorkspace"]>
  >;
}

const mountedApps: MountedApp[] = [];

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

  it("shows the idle typewriter only while the composer is empty and unfocused", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);
    const textarea = app.container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("textarea not found");
    }

    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-composer-typewriter")),
    );
    expect(textarea.placeholder).toBe("");

    await act(async () => {
      textarea.focus();
      await Promise.resolve();
    });
    expect(app.container.querySelector(".ohb-composer-typewriter")).toBeNull();

    await act(async () => {
      textarea.blur();
      await Promise.resolve();
    });
    expect(
      app.container.querySelector(".ohb-composer-typewriter"),
    ).not.toBeNull();

    await setTextareaValue(app.container, "a");
    expect(app.container.querySelector(".ohb-composer-typewriter")).toBeNull();
  });

  it("keeps static placeholders for running and unavailable composer states", () => {
    const running = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
    });
    const runningApp = mountApp(running.runtime);
    const runningTextarea = runningApp.container.querySelector("textarea");
    expect(runningTextarea?.getAttribute("placeholder")).toBe(
      "run in progress",
    );
    expect(
      runningApp.container.querySelector(".ohb-composer-typewriter"),
    ).toBeNull();

    const unavailable = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
    });
    unavailable.store.setConnectionState("disconnected");
    const unavailableApp = mountApp(unavailable.runtime);
    const unavailableTextarea =
      unavailableApp.container.querySelector("textarea");
    expect(unavailableTextarea?.getAttribute("placeholder")).toBe(
      "daemon unavailable",
    );
    expect(
      unavailableApp.container.querySelector(".ohb-composer-typewriter"),
    ).toBeNull();
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
    expect(fake.submitPrompt).not.toHaveBeenCalled();
    expect(composingEnter.defaultPrevented).toBe(false);

    const legacyComposingEnter = await pressComposingTextareaKey(
      app.container,
      "Enter",
      229,
    );
    expect(fake.submitPrompt).not.toHaveBeenCalled();
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
    expect(fake.submitPrompt).not.toHaveBeenCalled();
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
      "ohbaby:composer:/repo-a:session_1",
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

  it("selects the receipt session after submitting from an empty project", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        activeSessionId: null,
        sessions: [],
      },
    });
    fake.submitPrompt.mockImplementation((input) =>
      Promise.resolve({
        clientRequestId: input.clientRequestId,
        createdAt: timestamp,
        ok: true,
        promptId: "prompt_new",
        sessionId: "session_new",
        status: "running",
        userMessageId: "message_new",
      }),
    );
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "first prompt");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() => fake.selectSession.mock.calls.length === 1);

    expect(fake.selectSession).toHaveBeenCalledWith("session_new");
  });

  it("renders a submitted prompt before the receipt and reconciles it with the queue projection", async () => {
    const pendingReceipt =
      deferred<Awaited<ReturnType<OhbabyWebClient["submitPrompt"]>>>();
    const initialSnapshot = snapshotWithStatus({
      kind: "running",
      runId: "run_1",
    });
    const fake = createFakeRuntime({ snapshot: initialSnapshot });
    fake.submitPrompt.mockReturnValue(pendingReceipt.promise);
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "visible immediately");
    await pressTextareaKey(app.container, "Enter");

    const pending = app.container.querySelector(".ohb-message-pending");
    expect(pending?.textContent).toContain("visible immediately");
    expect(pending?.textContent).toContain("Sending…");

    await act(async () => {
      pendingReceipt.resolve({
        clientRequestId:
          fake.submitPrompt.mock.calls[0]?.[0].clientRequestId ?? "",
        createdAt: timestamp,
        ok: true,
        promptId: "prompt_pending",
        sessionId: "session_1",
        status: "queued",
        userMessageId: "message_pending",
      });
      await pendingReceipt.promise;
    });
    expect(app.container.querySelector(".ohb-message-pending")).not.toBeNull();

    await act(async () => {
      fake.store.replaceSnapshot(
        {
          ...initialSnapshot,
          prompts: [
            {
              clientRequestId:
                fake.submitPrompt.mock.calls[0]?.[0].clientRequestId ?? "",
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
  });

  it("calculates thinking elapsed time from the persisted run start on mount", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(timestamp) + 12_000);
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "running", runId: "run_1" }),
    });
    const app = mountApp(fake.runtime);

    expect(app.container.querySelector(".ohb-thinking")?.textContent).toContain(
      "· 12s",
    );
  });

  it("preserves the draft when the receipt request id does not match", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.submitPrompt.mockResolvedValue({
      clientRequestId: "different_request",
      createdAt: timestamp,
      ok: true,
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
      "ohbaby:composer:/repo-a:session_1",
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
    vi.spyOn(fake.runtime.client, "acquirePromptEditLease").mockResolvedValue({
      editLeaseId: "lease_1",
      expiresAt: "2026-07-12T00:01:00.000Z",
      ownerClientId: "client_web",
      prompt: queuedPrompt,
    });
    vi.spyOn(fake.runtime.client, "releasePromptEditLease").mockResolvedValue(
      queuedPrompt,
    );
    fake.submitPrompt.mockImplementation((input) =>
      Promise.resolve({
        clientRequestId: input.clientRequestId,
        createdAt: timestamp,
        ok: true,
        promptId: "prompt_retry",
        sessionId: "session_1",
        status: "queued",
        userMessageId: "message_retry",
      }),
    );
    const app = mountApp(fake.runtime);
    const editButton = app.container.querySelector(
      '[aria-label="Edit queued prompt: queued text"]',
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
    await pressTextareaKey(app.container, "Escape");
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() => fake.submitPrompt.mock.calls.length === 1);

    expect(fake.submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        clientRequestId: "request_pending",
        text: "pending draft",
      }),
    );
  });

  it("persists the edit buffer as a draft when reload renewal loses the lease", async () => {
    globalThis.sessionStorage.setItem(
      "ohbaby:composer:/repo-a:session_1",
      JSON.stringify({ text: "older draft" }),
    );
    globalThis.sessionStorage.setItem(
      "ohbaby:composer-lease:/repo-a:session_1",
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
    vi.spyOn(fake.runtime.client, "renewPromptEditLease").mockRejectedValue(
      new Error("lease expired"),
    );
    mountApp(fake.runtime);

    await waitFor(() =>
      Boolean(
        globalThis.sessionStorage
          .getItem("ohbaby:composer:/repo-a:session_1")
          ?.includes("preserve edited buffer"),
      ),
    );
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
      .spyOn(fake.runtime.client, "acquirePromptEditLease")
      .mockReturnValue(pendingLease.promise);
    const lease = {
      editLeaseId: "lease_one",
      expiresAt: "2026-07-12T00:01:00.000Z",
      ownerClientId: "client_web",
      prompt: firstPrompt,
    } satisfies UiPromptEditLease;
    const app = mountApp(fake.runtime);
    const editOne = app.container.querySelector(
      '[aria-label="Edit queued prompt: one"]',
    );
    const editTwo = app.container.querySelector(
      '[aria-label="Edit queued prompt: two"]',
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
    await waitFor(() => slashCompletionText(app.container).includes("/skills"));

    await pressTextareaKey(app.container, "PageDown");
    expect(slashCompletionText(app.container)).toContain("/status");

    await pressTextareaKey(app.container, "PageUp");
    expect(slashCompletionText(app.container)).toContain("/skills");
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
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("keeps slash rows on the same grid when argsHint is absent", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["status"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/status"));

    const row = app.container.querySelector(".ohb-slash-row");
    expect(row?.querySelector(".ohb-slash-args")).not.toBeNull();
    expect(row?.querySelector(".ohb-slash-description")?.textContent).toBe(
      "Show backend status",
    );
  });

  it("cycles permission policy directly without opening a menu", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Permission policy");

    expect(fake.setPermission).toHaveBeenCalledWith({ level: "full-access" });
    expect(app.container.querySelector(".ohb-policy-menu")).toBeNull();
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
    expect(permissionAction(app.container, "Cancel run").className).toBe(
      "ohb-perm-btn ohb-perm-abort",
    );
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

    expect(app.container.querySelector(".ohb-sidebar")).toBeNull();
    await clickButton(app.container, "Expand sessions");
    expect(app.container.querySelector(".ohb-sidebar")).not.toBeNull();
    expect(
      app.container.querySelector('button[title="Select Session 2"]')
        ?.textContent,
    ).not.toContain("0 messages");

    await clickButton(app.container, "New session");
    await clickButton(app.container, "Select Session 2");

    expect(fake.createSession).toHaveBeenCalledTimes(1);
    expect(fake.selectSession).toHaveBeenCalledWith("session_2");
  });

  it("switches the selected workspace from the project rail", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);
    const project = app.container.querySelector(
      'button[aria-label="Open repo-b"]',
    );
    if (!(project instanceof HTMLButtonElement)) {
      throw new Error("project rail button not found");
    }

    await act(async () => {
      project.click();
      await Promise.resolve();
    });

    expect(fake.switchWorkspace).toHaveBeenCalledWith("/repo-b");
  });

  it("removes a project from the rail through its context menu", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);
    const project = app.container.querySelector(
      'button[aria-label="Open repo-b"]',
    );
    if (!(project instanceof HTMLButtonElement)) {
      throw new Error("project rail button not found");
    }

    await act(async () => {
      project.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: 20,
          clientY: 30,
        }),
      );
      await Promise.resolve();
    });
    const remove = Array.from(
      app.container.querySelectorAll('[role="menuitem"]'),
    ).find((element) => element.textContent === "从项目栏移除");
    if (!(remove instanceof HTMLButtonElement)) {
      throw new Error("remove project action not found");
    }
    await act(async () => {
      remove.click();
      await Promise.resolve();
    });

    expect(fake.hideWorkspace).toHaveBeenCalledWith("/repo-b");
  });

  it("opens the web directory picker from the project rail", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Open project");

    await waitFor(
      () =>
        app.container
          .querySelector('[role="dialog"]')
          ?.textContent.includes("C:\\") === true,
    );
    expect(fake.getDirectoryPickerRoots).toHaveBeenCalledTimes(1);
    expect(fake.openWorkspace).not.toHaveBeenCalled();
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

    expect(fake.openWorkspace).toHaveBeenCalledWith("C:\\");
  });

  it("keeps the directory picker open when opening a directory fails", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.openWorkspace.mockRejectedValueOnce(new Error("Scope unavailable"));
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Open project");
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

  it("archives sidebar sessions after confirmation without selecting the row", async () => {
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
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Expand sessions");
    await clickButton(app.container, "Archive Session 2");

    expect(confirm).toHaveBeenCalledWith("Archive this session?");
    expect(fake.archiveSession).toHaveBeenCalledWith("session_2");
    expect(fake.selectSession).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("does not archive sidebar sessions when confirmation is cancelled", async () => {
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
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const app = mountApp(fake.runtime);

    await clickButton(app.container, "Expand sessions");
    await clickButton(app.container, "Archive Session 2");

    expect(fake.archiveSession).not.toHaveBeenCalled();
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

    await clickButton(app.container, "Expand sessions");
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

    await clickButton(app.container, "Expand sessions");
    await clickButton(app.container, "Select Session");

    await waitFor(() =>
      app.container.textContent.includes("loaded transcript"),
    );
    expect(app.container.textContent).toContain("resume this session");
    expect(fake.selectSession).toHaveBeenCalledWith("session_1");
  });

  it("opens the structured connect overlay from the slash palette", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["connect", "status"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/connect"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );

    await setInputValue(app.container, "Provider", "zhipu");
    await setInputValue(
      app.container,
      "Base URL",
      "https://open.bigmodel.cn/api/paas/v4",
    );
    await setInputValue(app.container, "API key env", "ZHIPU_API_KEY");
    await setInputValue(app.container, "Model", "glm-4.7");
    await clickButton(app.container, "Save model");

    expect(fake.connectModel).toHaveBeenCalledWith({
      apiKeyEnv: "ZHIPU_API_KEY",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.7",
      provider: "zhipu",
    });
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("uses provider-neutral guidance for an empty model configuration", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["connect"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/connect"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );

    expect(
      Array.from(
        app.container.querySelectorAll(".ohb-structured-grid input"),
      ).map((input) => input.getAttribute("placeholder")),
    ).toEqual([
      "Enter provider name",
      "Enter model identifier",
      "Enter provider API base URL",
      "Enter API key environment variable name",
      "Optional; saved to .env when provided",
      "Optional; auto-detected when blank",
      "Optional; uses provider default when blank",
    ]);
    expect(app.container.textContent).not.toMatch(/zhipu|glm-4\.7|bigmodel/i);
  });

  it("shows backend connect warnings after saving from the structured overlay", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["connect"]));
    fake.connectModel.mockResolvedValueOnce({
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
      warning:
        "API key env ZHIPU_API_KEY is configured but no value was found.",
    });
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/connect"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );

    await setInputValue(app.container, "Provider", "zhipu");
    await setInputValue(
      app.container,
      "Base URL",
      "https://open.bigmodel.cn/api/paas/v4",
    );
    await setInputValue(app.container, "API key env", "ZHIPU_API_KEY");
    await setInputValue(app.container, "Model", "glm-4.7");
    await clickButton(app.container, "Save model");

    await waitFor(() =>
      app.container.textContent.includes(
        "API key env ZHIPU_API_KEY is configured but no value was found.",
      ),
    );
    expect(app.container.textContent).toContain("warning");
  });

  it("submits structured connect overlay without API key env", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["connect"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() => slashPaletteText(app.container).includes("/connect"));
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );

    await setInputValue(app.container, "Provider", "lmstudio");
    await setInputValue(app.container, "Base URL", "http://127.0.0.1:1234/v1");
    await setInputValue(app.container, "Model", "local-model");
    await clickButton(app.container, "Save model");

    expect(fake.connectModel).toHaveBeenCalledWith({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-model",
      provider: "lmstudio",
    });
  });

  it("opens the structured search overlay from the slash palette", async () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    fake.listCommands.mockResolvedValue(catalog(["connect-search"]));
    const app = mountApp(fake.runtime);

    await setTextareaValue(app.container, "/");
    await waitFor(() =>
      slashPaletteText(app.container).includes("/connect-search"),
    );
    await pressTextareaKey(app.container, "Enter");
    await waitFor(() =>
      Boolean(app.container.querySelector(".ohb-structured-overlay")),
    );

    await setInputValue(app.container, "API key env", "TAVILY_API_KEY");
    await setInputValue(app.container, "API key", "tvly-test");
    await clickButton(app.container, "Save search key");

    expect(fake.setSearchApiKey).toHaveBeenCalledWith({
      apiKey: "tvly-test",
      apiKeyEnv: "TAVILY_API_KEY",
      provider: "tavily",
    });
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
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
    await clickButton(app.container, "Compact session");

    expect(fake.compactSession).toHaveBeenCalledWith("session_1", {
      force: true,
    });
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("opens the structured goal overlay from the slash palette", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        goals: [
          {
            goal: {
              objective: "finish goal UI",
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

    expect(
      app.container.querySelector(".ohb-structured-dialog")?.textContent,
    ).toContain("finish goal UI");
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("renders compact goal status without objective copy", () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        goals: [
          {
            goal: {
              objective: "finish goal UI",
              status: "paused",
            },
            sessionId: "session_1",
          },
        ],
      },
    });
    const app = mountApp(fake.runtime);

    expect(app.container.textContent).toContain("goal paused");
    expect(app.container.textContent).not.toContain("finish goal UI");
  });

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
      app.container.querySelector('button[data-goal-action="pause"]')
        ?.className,
    ).toContain("ohb-goal-action-highlight");
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("executes goal panel actions through the overlay allowance", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        goals: [
          {
            goal: {
              objective: "finish goal UI",
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
    await clickButton(app.container, "Pause goal");

    expect(fake.executeSlashCommand).toHaveBeenCalledWith({
      allowOverlay: true,
      sessionId: "session_1",
      text: "/goal pause",
    });
  });

  it("opens the goal panel when the status chip is clicked", async () => {
    const fake = createFakeRuntime({
      snapshot: {
        ...snapshotWithStatus({ kind: "idle" }),
        goals: [
          {
            goal: {
              objective: "finish goal UI",
              status: "active",
            },
            sessionId: "session_1",
          },
        ],
      },
    });
    const app = mountApp(fake.runtime);

    const chip = app.container.querySelector(".ohb-goal-chip");
    if (!(chip instanceof HTMLButtonElement)) {
      throw new Error("goal chip not found");
    }
    await act(async () => {
      chip.click();
      await Promise.resolve();
    });

    expect(
      app.container.querySelector(".ohb-structured-dialog")?.textContent,
    ).toContain("finish goal UI");
    expect(fake.executeSlashCommand).not.toHaveBeenCalled();
  });

  it("does not render the goal chip without a goal for the active session", () => {
    const fake = createFakeRuntime({
      snapshot: snapshotWithStatus({ kind: "idle" }),
    });
    const app = mountApp(fake.runtime);

    expect(app.container.querySelector(".ohb-goal-chip")).toBeNull();
  });

  it("shows compact failures as overlay errors", async () => {
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
      Boolean(app.container.querySelector(".ohb-structured-error")),
    );
    expect(
      app.container.querySelector(".ohb-structured-error")?.textContent,
    ).toContain("summary failed");
    expect(app.container.querySelector(".ohb-structured-success")).toBeNull();
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
  store.replaceSnapshot(input.snapshot, 1);
  store.setConnectionState("live");
  const executeSlashCommand = vi.fn<OhbabyWebClient["executeSlashCommand"]>(
    () => Promise.resolve(),
  );
  const createSession = vi.fn<OhbabyWebClient["createSession"]>(() =>
    Promise.resolve(),
  );
  const selectSession = vi.fn<OhbabyWebClient["selectSession"]>(() =>
    Promise.resolve(),
  );
  const archiveSession = vi.fn<(sessionId: string) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const connectModel = vi.fn<OhbabyWebClient["connectModel"]>(() =>
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
  const listCommands = vi.fn<OhbabyWebClient["listCommands"]>(() =>
    Promise.resolve(catalog(["status"])),
  );
  const setPermission = vi.fn<OhbabyWebClient["setPermission"]>(() =>
    Promise.resolve(),
  );
  const compactSession = vi.fn<OhbabyWebClient["compactSession"]>(() =>
    Promise.resolve({
      sessionId: "session_1",
      status: "compacted",
      usageAfter: compactUsage(8_000),
      usageBefore: compactUsage(16_000),
    }),
  );
  const setSearchApiKey = vi.fn<OhbabyWebClient["setSearchApiKey"]>(() =>
    Promise.resolve({
      apiKeyEnv: "TAVILY_API_KEY",
      envPath: ".env",
      provider: "tavily",
      searchJsonPath: "search.json",
    }),
  );
  const switchWorkspace = vi.fn<OhbabyWebRuntime["switchWorkspace"]>(() =>
    Promise.resolve(),
  );
  const hideWorkspace = vi.fn<OhbabyWebRuntime["hideWorkspace"]>(() =>
    Promise.resolve(),
  );
  const openWorkspace = vi.fn<OhbabyWebRuntime["openWorkspace"]>(() =>
    Promise.resolve(),
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
  const submitPrompt = vi.fn<OhbabyWebClient["submitPrompt"]>(() =>
    Promise.resolve({
      clientRequestId: "request_1",
      createdAt: "2026-07-12T00:00:00.000Z",
      ok: true,
      promptId: "prompt_1",
      sessionId: "session_1",
      status: "queued",
      userMessageId: "message_1",
    }),
  );
  const client: OhbabyWebClient & {
    readonly archiveSession: typeof archiveSession;
  } = {
    abortSession: vi.fn(() => Promise.resolve()),
    acquirePromptEditLease: vi.fn(() => Promise.reject(new Error("unused"))),
    archiveSession,
    close: vi.fn(() => Promise.resolve()),
    compactSession,
    cancelQueuedPrompt: vi.fn(() => Promise.reject(new Error("unused"))),
    connect: vi.fn(() => Promise.resolve()),
    connectModel,
    createSession,
    executeSlashCommand,
    editQueuedPrompt: vi.fn(() => Promise.reject(new Error("unused"))),
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
    getSnapshot: () => store.getSnapshot(),
    listCommands,
    listWorkspaceScopes: vi.fn(() =>
      Promise.resolve([
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
      ]),
    ),
    probeModelContextWindow: vi.fn(() =>
      Promise.resolve({
        contextWindowSource: "default" as const,
        contextWindowTokens: 128_000,
      }),
    ),
    respondPermission: vi.fn(() => Promise.resolve()),
    releasePromptEditLease: vi.fn(() => Promise.reject(new Error("unused"))),
    renewPromptEditLease: vi.fn(() => Promise.reject(new Error("unused"))),
    selectSession,
    setPermission,
    setSearchApiKey,
    submitPrompt,
    subscribe: (listener) => store.subscribe(listener),
  };
  return {
    archiveSession,
    compactSession,
    connectModel,
    createSession,
    executeSlashCommand,
    getDirectoryPickerRoots,
    hideWorkspace,
    listCommands,
    listDirectoryPicker,
    openWorkspace,
    runtime: {
      client,
      getDirectoryPickerRoots,
      hideWorkspace,
      listDirectoryPicker,
      openWorkspace,
      getWorkspaceSnapshot: () => workspaceSnapshot,
      ready: Promise.resolve(),
      refreshWorkspaces: () => Promise.resolve(),
      store,
      subscribeWorkspaces: () => () => undefined,
      switchWorkspace,
    },
    selectSession,
    setPermission,
    setSearchApiKey,
    store,
    submitPrompt,
    switchWorkspace,
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
      ...(id === "goal" ? { acceptsArguments: true } : {}),
      action: catalogAction(id),
      argumentMode: catalogArgumentMode(id),
      category: catalogCategory(id),
      description:
        id === "skill.hansun-db"
          ? "Use Hansun knowledge base"
          : id === "skills"
            ? "List available skills"
            : id === "connect"
              ? "Connect model"
              : id === "connect-search"
                ? "Connect search"
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

type CatalogId =
  | "compact"
  | "connect"
  | "connect-search"
  | "goal"
  | "skill.hansun-db"
  | "skills"
  | "status";

function catalogAction(
  id: CatalogId,
): UiWebCommandCatalog["commands"][number]["action"] {
  switch (id) {
    case "compact":
      return "compactSession";
    case "connect":
      return "connectModel";
    case "connect-search":
      return "connectSearch";
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
    case "connect":
    case "connect-search":
      return "setup";
    case "skill.hansun-db":
    case "skills":
      return "skill";
    case "status":
      return "system";
  }
}

async function showSkillsModal(
  fake: FakeRuntime,
  names: readonly string[],
): Promise<void> {
  await act(async () => {
    fake.store.applyEvent(
      {
        command: {
          clientInvocationId: "invoke_skills",
          commandId: "skills",
          commandRunId: "command_skills",
          path: ["skills"],
          surface: "tui",
        },
        timestamp: Date.parse(timestamp),
        type: "command.started",
      },
      2,
    );
    fake.store.applyEvent(
      {
        clientInvocationId: "invoke_skills",
        commandRunId: "command_skills",
        output: {
          data: {
            skills: names.map((name) => ({
              description: `Use ${name}`,
              name,
              scope: "user",
              source: "test",
            })),
          },
          kind: "data",
          subject: "skills",
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

function slashCompletionText(container: ParentNode): string {
  return container.querySelector(".ohb-slash-completion")?.textContent ?? "";
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
  const button = container.querySelector(`button[title="${title}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`button not found: ${title}`);
  }
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function setInputValue(
  container: ParentNode,
  labelText: string,
  value: string,
): Promise<void> {
  const labels = Array.from(container.querySelectorAll("label"));
  const label = labels.find(
    (candidate) => candidate.querySelector("span")?.textContent === labelText,
  );
  const input = label?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`input not found: ${labelText}`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  );
  await act(async () => {
    if (descriptor?.set) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- React controlled inputs need the native input setter in jsdom tests.
      const setValue = descriptor.set;
      Reflect.apply(setValue, input, [value]);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

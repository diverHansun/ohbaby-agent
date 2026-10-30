// @vitest-environment jsdom
import { act, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  UiBackendClient,
  UiEvent,
  UiMessage,
  UiSubagentConversationView,
  UiSubagentExecution,
  UiSubagentInstance,
  UiSubagentInstanceSnapshot,
  UiSubagentStopInput,
  UiSubagentStopResult,
} from "ohbaby-sdk";
import type { SubagentReadingCache } from "../../session/SubagentConversationBody.js";
import {
  createSubagentWatchCoordinator,
  type SubagentWatchCoordinator,
} from "../../shared/subagent-watch-owner.js";
import { SubagentsPage } from "./SubagentsPage.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
});

function instance(
  subagentId: string,
  patch: Partial<UiSubagentInstance> = {},
): UiSubagentInstance {
  return {
    rootSessionId: "root",
    subagentId,
    displayName: subagentId,
    description: `${subagentId} task`,
    createdAt: 1,
    updatedAt: 1,
    status: "completed",
    latestExecutionId: `${subagentId}-exec`,
    approvalBlocked: false,
    settling: false,
    unprocessedMessageCount: 0,
    ...patch,
  };
}

function snapshot(
  revision: number,
  instances: readonly UiSubagentInstance[],
): UiSubagentInstanceSnapshot {
  return {
    rootSessionId: "root",
    runtimeEpoch: "epoch",
    bindingGeneration: 1,
    revision,
    complete: true,
    instances,
  };
}

function execution(subagentId: string): UiSubagentExecution {
  return {
    executionId: `${subagentId}-exec`,
    subagentId,
    rootSessionId: "root",
    rootRunId: "run",
    childUserMessageId: `${subagentId}-task`,
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    resultStored: false,
    delivery: "none",
  };
}

function conversation(subagentId: string): UiSubagentConversationView {
  const messages: UiMessage[] = [
    {
      id: `${subagentId}-task`,
      role: "user",
      createdAt: "2026-10-29T00:00:00.000Z",
      parts: [{ type: "text", text: `Task for ${subagentId}` }],
    },
    {
      id: `${subagentId}-answer`,
      role: "assistant",
      createdAt: "2026-10-29T00:00:01.000Z",
      parts: [{ type: "text", text: `Answer from ${subagentId}` }],
    },
  ];
  return {
    rootSessionId: "root",
    subagentId,
    displayName: subagentId,
    readOnly: true,
    anchorFound: true,
    anchorMessageId: `${subagentId}-task`,
    executions: [execution(subagentId)],
    messages,
    history: { hasMore: false, hasLater: false },
    view: {
      version: {
        runtimeEpoch: "epoch",
        viewGeneration: "g",
        sessionId: `${subagentId}-child`,
        sessionRevision: 1,
      },
      session: {
        id: `${subagentId}-child`,
        title: subagentId,
        createdAt: "2026-10-29T00:00:00.000Z",
        updatedAt: "2026-10-29T00:00:00.000Z",
        messages,
      },
      runs: [],
      prompts: [],
      history: { hasMore: false },
      reasoningMissing: false,
      todo: { status: "unavailable", reason: "none" },
      goal: { status: "unavailable", reason: "none" },
      context: { status: "unavailable", reason: "none" },
    },
  };
}

function fakeClient(): {
  readonly client: UiBackendClient;
  readonly emit: (event: UiEvent) => void;
  readonly list: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<
    typeof vi.fn<(input: UiSubagentStopInput) => Promise<UiSubagentStopResult>>
  >;
  readonly unwatch: ReturnType<typeof vi.fn>;
} {
  const handlers = new Set<(event: UiEvent) => void>();
  const list = vi.fn();
  const stop =
    vi.fn<(input: UiSubagentStopInput) => Promise<UiSubagentStopResult>>();
  const unwatch = vi.fn(() => Promise.resolve());
  const client = {
    subscribeEvents(handler: (event: UiEvent) => void): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    listSubagentInstances: list,
    stopSubagent: stop,
    getSubagentExecutionView: vi.fn(
      (input: { readonly executionId: string }) => {
        const subagentId = input.executionId.replace(/-exec$/u, "");
        return Promise.resolve({
          execution: execution(subagentId),
          messages: [],
          history: { hasMore: false },
          reasoningMissing: false,
          readOnly: true,
        });
      },
    ),
    watchSubagentConversation: vi.fn(
      (input: { readonly subagentId: string; readonly watchId: string }) =>
        Promise.resolve({
          rootSessionId: "root",
          subagentId: input.subagentId,
          runtimeEpoch: "epoch",
          bindingGeneration: 1,
          watchId: input.watchId,
        }),
    ),
    unwatchSubagentConversation: unwatch,
    getSubagentConversationView: vi.fn(
      (input: { readonly subagentId: string }) =>
        Promise.resolve(conversation(input.subagentId)),
    ),
  } as unknown as UiBackendClient;
  return {
    client,
    emit: (event): void => {
      for (const handler of handlers) handler(event);
    },
    list,
    stop,
    unwatch,
  };
}

function Page(props: {
  readonly client: UiBackendClient;
  readonly cache: SubagentReadingCache;
  readonly watch: SubagentWatchCoordinator;
}): ReactElement {
  const [selected, setSelected] = useState<string>();
  return (
    <SubagentsPage
      client={props.client}
      rootSessionId="root"
      selectedSubagentId={selected}
      onSelect={setSelected}
      readingCache={props.cache}
      watch={props.watch}
    />
  );
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1)
    await act(async () => {
      await Promise.resolve();
    });
}

async function mount(
  client: UiBackendClient,
  watch: SubagentWatchCoordinator = createSubagentWatchCoordinator(),
): Promise<{ readonly element: HTMLElement; readonly unmount: () => void }> {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  act(() => {
    root.render(<Page client={client} cache={new Map()} watch={watch} />);
  });
  let removed = false;
  const unmount = (): void => {
    if (removed) return;
    removed = true;
    act(() => {
      root.unmount();
    });
    element.remove();
  };
  mounted.push(unmount);
  await flush();
  return { element, unmount };
}

function find(scope: ParentNode, text: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === text ||
      item.textContent.includes(text),
  );
  if (!match) throw new Error(`missing button ${text}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  act(() => {
    element.click();
  });
  await flush();
}

describe("Subagents page", () => {
  it("lists one row per instance in Active and Done with real statuses and unprocessed messages", async () => {
    const fake = fakeClient();
    fake.list.mockResolvedValue(
      snapshot(1, [
        instance("reviewer", {
          status: "running",
          currentExecutionId: "reviewer-exec",
          unprocessedMessageCount: 2,
        }),
        instance("writer", { status: "running", approvalBlocked: true }),
        instance("tester", { status: "interrupted" }),
      ]),
    );
    const { element } = await mount(fake.client);
    const groups = [...element.querySelectorAll("section")];
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Active",
      "Done",
    ]);
    expect(groups[0]?.textContent).toContain("reviewer");
    expect(groups[0]?.textContent).toContain("2 unprocessed messages");
    expect(groups[0]?.textContent).toContain("Needs approval");
    expect(groups[1]?.textContent).toContain("Interrupted");
    expect(fake.list).toHaveBeenCalledWith(
      expect.objectContaining({ rootSessionId: "root" }),
    );
    expect(fake.list.mock.calls[0]?.[0]).not.toHaveProperty("runtimeEpoch");
  });

  it("keeps the last list when a refresh fails and refreshes after a reconnect", async () => {
    const fake = fakeClient();
    fake.list
      .mockResolvedValueOnce(snapshot(1, [instance("reviewer")]))
      .mockRejectedValueOnce(new Error("Daemon request failed"))
      .mockResolvedValueOnce(
        snapshot(2, [instance("reviewer"), instance("tester")]),
      );
    const { element } = await mount(fake.client);
    await act(async () => {
      fake.emit({
        type: "subagent.instances.invalidated",
        rootSessionId: "root",
        runtimeEpoch: "epoch",
        revision: 2,
      });
      await Promise.resolve();
    });
    await flush();
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "Daemon request failed",
    );
    expect(element.textContent).toContain("reviewer");
    await act(async () => {
      fake.emit({
        type: "session.resync-required",
        runtimeEpoch: "epoch",
        sessionId: "root",
      });
      await Promise.resolve();
    });
    await flush();
    expect(fake.list).toHaveBeenCalledTimes(3);
    expect(element.textContent).toContain("tester");
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it("opens a detail with the instance status, stops only its current execution and returns when it is closed", async () => {
    const fake = fakeClient();
    const running = instance("reviewer", {
      status: "running",
      currentExecutionId: "reviewer-exec",
    });
    fake.list.mockResolvedValue(snapshot(1, [running, instance("tester")]));
    const { element } = await mount(fake.client);
    await click(find(element, "reviewer"));
    expect(element.querySelector("h2")?.textContent).toBe("reviewer");
    expect(
      element.querySelector('.ohb-subagent-detail-header [role="status"]')
        ?.textContent,
    ).toBe("Running");
    expect(element.textContent).toContain("Answer from reviewer");

    let resolveStop: (result: UiSubagentStopResult) => void = () => undefined;
    fake.stop.mockReturnValue(
      new Promise((resolve) => {
        resolveStop = resolve;
      }),
    );
    await click(find(element, "Stop"));
    expect(fake.stop).toHaveBeenCalledWith({
      rootSessionId: "root",
      subagentId: "reviewer",
      expectedExecutionId: "reviewer-exec",
    });
    expect(find(element, "Stopping…").disabled).toBe(true);
    fake.list.mockResolvedValue(
      snapshot(2, [
        { ...running, status: "interrupted", settling: true },
        instance("tester"),
      ]),
    );
    await act(async () => {
      resolveStop({
        rootSessionId: "root",
        subagentId: "reviewer",
        expectedExecutionId: "reviewer-exec",
        outcome: "accepted",
        instance: running,
      });
      await Promise.resolve();
    });
    await flush();
    expect(
      element.querySelector('.ohb-subagent-detail-header [role="status"]')
        ?.textContent,
    ).toBe("Cleaning up");
    expect(find(element, "Stopping…").disabled).toBe(true);

    fake.list.mockResolvedValue(snapshot(3, [instance("tester")]));
    await act(async () => {
      fake.emit({
        type: "subagent.instances.invalidated",
        rootSessionId: "root",
        runtimeEpoch: "epoch",
        revision: 3,
      });
      await Promise.resolve();
    });
    await flush();
    expect(element.querySelector("h2")).toBeNull();
    expect(element.textContent).not.toContain("reviewer");
    expect(fake.unwatch).toHaveBeenCalled();
  });

  it("treats a stop whose receipt snapshot moved on as submitted and shows other failures", async () => {
    const fake = fakeClient();
    const running = instance("reviewer", {
      status: "running",
      currentExecutionId: "reviewer-exec",
    });
    fake.list.mockResolvedValue(snapshot(1, [running]));
    const { element } = await mount(fake.client);
    await click(find(element, "reviewer"));

    fake.stop.mockRejectedValueOnce(
      Object.assign(new Error("changed"), {
        code: "SUBAGENT_SNAPSHOT_CHANGED",
        status: 409,
      }),
    );
    await click(find(element, "Stop"));
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(find(element, "Stopping…").disabled).toBe(true);
    expect(fake.list).toHaveBeenCalledTimes(2);

    fake.list.mockResolvedValue(
      snapshot(2, [{ ...running, currentExecutionId: "reviewer-exec-2" }]),
    );
    await act(async () => {
      fake.emit({
        type: "subagent.instances.invalidated",
        rootSessionId: "root",
        runtimeEpoch: "epoch",
        revision: 2,
      });
      await Promise.resolve();
    });
    await flush();
    fake.stop.mockRejectedValueOnce(new Error("Subagent is closed"));
    await click(find(element, "Stop"));
    expect(fake.stop).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedExecutionId: "reviewer-exec-2" }),
    );
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "Subagent is closed",
    );
    expect(find(element, "Stop").disabled).toBe(false);
  });

  it("clears Stopping when a late stop finds a newer execution", async () => {
    const fake = fakeClient();
    const running = instance("reviewer", {
      status: "running",
      currentExecutionId: "reviewer-exec",
    });
    fake.list.mockResolvedValue(snapshot(1, [running]));
    const { element } = await mount(fake.client);
    await click(find(element, "reviewer"));
    fake.stop.mockResolvedValueOnce({
      rootSessionId: "root",
      subagentId: "reviewer",
      expectedExecutionId: "reviewer-exec",
      outcome: "execution_changed",
      instance: { ...running, currentExecutionId: "reviewer-exec-2" },
    });
    await click(find(element, "Stop"));
    expect(find(element, "Stop").disabled).toBe(false);
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });

  it("does not carry one chat's instances into another", async () => {
    const fake = fakeClient();
    fake.list.mockImplementation((input: { readonly rootSessionId: string }) =>
      Promise.resolve(
        input.rootSessionId === "root"
          ? snapshot(1, [instance("reviewer")])
          : {
              ...snapshot(1, [
                { ...instance("other"), rootSessionId: "root-b" },
              ]),
              rootSessionId: "root-b",
            },
      ),
    );
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    const render = (rootSessionId: string): void => {
      act(() => {
        root.render(
          <SubagentsPage
            key={rootSessionId}
            client={fake.client}
            rootSessionId={rootSessionId}
            onSelect={() => undefined}
            readingCache={new Map()}
            watch={createSubagentWatchCoordinator()}
          />,
        );
      });
    };
    mounted.push(() => {
      act(() => {
        root.unmount();
      });
      element.remove();
    });
    render("root");
    await flush();
    expect(element.textContent).toContain("reviewer");
    render("root-b");
    expect(element.textContent).not.toContain("reviewer");
    await flush();
    expect(element.textContent).toContain("other");
    expect(element.textContent).not.toContain("reviewer");
  });

  it("retries a failed detail open and returns focus to the row on Back", async () => {
    const fake = fakeClient();
    fake.list.mockResolvedValue(
      snapshot(1, [instance("reviewer"), instance("tester")]),
    );
    const open = fake.client.getSubagentExecutionView as ReturnType<
      typeof vi.fn
    >;
    const working = open.getMockImplementation();
    open.mockRejectedValueOnce(new Error("Daemon request failed"));
    const { element } = await mount(fake.client);
    await click(find(element, "reviewer"));
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      "Daemon request failed",
    );
    if (working) open.mockImplementation(working);
    await click(find(element, "Retry"));
    expect(element.textContent).toContain("Answer from reviewer");
    expect(element.querySelector('[role="alert"]')).toBeNull();

    await click(find(element, "Back to subagents"));
    expect(element.querySelector("h2")).toBeNull();
    expect(
      (document.activeElement as HTMLElement | null)?.dataset.subagentId,
    ).toBe("reviewer");
  });

  it("resumes the held conversation when returning to the same instance", async () => {
    const fake = fakeClient();
    fake.list.mockResolvedValue(
      snapshot(1, [instance("reviewer"), instance("tester")]),
    );
    const { element } = await mount(fake.client);
    await click(find(element, "reviewer"));
    expect(element.textContent).toContain("Answer from reviewer");
    await click(find(element, "Back to subagents"));
    await click(find(element, "reviewer"));
    expect(element.textContent).toContain("Answer from reviewer");
    // No second open: the page's reader kept the loaded pages and the watch.
    for (const method of [
      "getSubagentExecutionView",
      "watchSubagentConversation",
      "getSubagentConversationView",
    ] as const)
      expect(
        (fake.client[method] as ReturnType<typeof vi.fn>).mock.calls,
      ).toHaveLength(1);
    expect(fake.unwatch).not.toHaveBeenCalled();
    // A different instance replaces the held one.
    await click(find(element, "Back to subagents"));
    await click(find(element, "tester"));
    expect(element.textContent).toContain("Answer from tester");
    expect(fake.unwatch).toHaveBeenCalledTimes(1);
  });

  it("hands the one watch to the chat's sheet and leaves the detail instead of going stale", async () => {
    const fake = fakeClient();
    fake.list.mockResolvedValue(snapshot(1, [instance("reviewer")]));
    const watch = createSubagentWatchCoordinator();
    const { element } = await mount(fake.client, watch);
    await click(find(element, "reviewer"));
    expect(watch.owner()).toBe("panel");
    await act(async () => {
      watch.claim("sheet");
      await Promise.resolve();
    });
    await flush();
    expect(element.querySelector("h2")).toBeNull();
    expect(fake.unwatch).toHaveBeenCalledTimes(1);
    // Opening the detail again takes the watch back.
    await click(find(element, "reviewer"));
    expect(watch.owner()).toBe("panel");
    expect(element.textContent).toContain("Answer from reviewer");
  });

  it("shows an instance without any execution as not started", async () => {
    const fake = fakeClient();
    fake.list.mockResolvedValue(
      snapshot(1, [
        instance("queued", { status: "pending", latestExecutionId: undefined }),
      ]),
    );
    const { element } = await mount(fake.client);
    await click(find(element, "queued"));
    expect(element.textContent).toContain("Not started yet.");
    expect(
      (fake.client.getSubagentExecutionView as ReturnType<typeof vi.fn>).mock
        .calls,
    ).toHaveLength(0);
  });

  it("releases reads when the page goes away without stopping anything", async () => {
    const fake = fakeClient();
    fake.list.mockResolvedValue(
      snapshot(1, [
        instance("reviewer", {
          status: "running",
          currentExecutionId: "reviewer-exec",
        }),
      ]),
    );
    const { element, unmount } = await mount(fake.client);
    await click(find(element, "reviewer"));
    unmount();
    expect(fake.unwatch).toHaveBeenCalled();
    expect(fake.stop).not.toHaveBeenCalled();
  });
});

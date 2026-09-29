// @vitest-environment jsdom
import type { UiBackendClient, UiPromptSubmission } from "ohbaby-sdk";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";
import { InMemoryPromptSubmissionStore } from "../../../../../packages/ohbaby-agent/src/runtime/prompt-scheduler/in-memory-store.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  sessionStorage.clear();
});

function fixture(overrides: Partial<ComponentProps<typeof Composer>> = {}): {
  readonly input: () => HTMLTextAreaElement;
  readonly type: (text: string) => void;
  readonly render: (
    prefill: ComponentProps<typeof Composer>["prefill"],
    readOnly?: boolean,
  ) => void;
  readonly revision: () => number;
  readonly update: (patch: Partial<ComponentProps<typeof Composer>>) => void;
} {
  let revision = 0;
  const props: ComponentProps<typeof Composer> = {
    client: {
      steerQueuedPrompt: vi.fn<UiBackendClient["steerQueuedPrompt"]>(),
      getCurrentModel: () => Promise.resolve(null),
      subscribeEvents: (): (() => void) => (): void => undefined,
      updateSessionReasoning:
        vi.fn<UiBackendClient["updateSessionReasoning"]>(),
      acquirePromptEditLease:
        vi.fn<UiBackendClient["acquirePromptEditLease"]>(),
      renewPromptEditLease: vi.fn<UiBackendClient["renewPromptEditLease"]>(),
      releasePromptEditLease:
        vi.fn<UiBackendClient["releasePromptEditLease"]>(),
      resubmitRetainedPrompt:
        vi.fn<UiBackendClient["resubmitRetainedPrompt"]>(),
      editQueuedPrompt: vi.fn<UiBackendClient["editQueuedPrompt"]>(),
      cancelQueuedPrompt: vi.fn<UiBackendClient["cancelQueuedPrompt"]>(),
    },
    model: {
      canSend: true,
      canStop: false,
      disabled: false,
      isRunning: false,
      mode: "auto",
      permissionLevel: "default",
    },
    activeSession: null,
    commandCatalogVersion: null,
    connectionKind: "live",
    draftScopeKey: "workspace:session",
    isPromptAdmitting: false,
    onListCommands: vi.fn().mockResolvedValue({
      version: "commands-v1",
      commands: [
        {
          action: "executeCommand",
          argumentMode: "argv",
          category: "system",
          description: "Show backend status",
          executionKind: "passthrough",
          id: "status",
          path: ["status"],
          source: "builtin",
          surfaces: ["tui"],
        },
      ],
    }),
    onSetPermission: vi.fn(),
    onStructuredCommand: vi.fn(),
    onStop: vi.fn(),
    onSubmit: vi.fn(),
    onEditRevision: (value) => {
      revision = value;
    },
    queuedPrompts: [],
    topContent: null,
    permissionControl: null,
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = (
    prefill: ComponentProps<typeof Composer>["prefill"],
    readOnly?: boolean,
  ): void => {
    act(() =>
      root?.render(
        <Composer {...props} prefill={prefill} readOnly={readOnly} />,
      ),
    );
  };
  const input = (): HTMLTextAreaElement => {
    const element = container.querySelector("textarea");
    if (!element) throw new Error("Composer input missing");
    return element;
  };
  render(null);
  return {
    input,
    render,
    revision: () => revision,
    update: (patch): void => {
      Object.assign(props, patch);
      render(null);
    },
    type(text): void {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- React controlled input requires the native setter in jsdom.
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (!setter) throw new Error("Native input setter missing");
      act(() => {
        Reflect.apply(setter, input(), [text]);
        input().dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
  };
}

describe("Composer prefill ownership", () => {
  it("persists Tab completion and advances the revision before accepting insertions", async () => {
    const f = fixture();
    await act(async () => {
      f.type("/sta");
      await Promise.resolve();
    });
    const revision = f.revision();
    await act(async () => {
      f.input().dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }),
      );
      await Promise.resolve();
    });
    expect(f.input().value).toBe("/status");
    expect(
      JSON.parse(
        sessionStorage.getItem("ohbaby:composer:workspace:session") ?? "{}",
      ),
    ).toEqual({ text: "/status" });
    expect(f.revision()).toBeGreaterThan(revision);
    f.render({
      nonce: 1,
      scopeKey: "workspace:session",
      editRevision: revision,
      text: "stale insertion",
    });
    expect(f.input().value).toBe("/status");
  });
  it("rejects an old insertion after a newer edit, even when the text is changed back", () => {
    const f = fixture();
    f.type("initial");
    const editRevision = f.revision();
    f.type("newer");
    f.type("initial");
    f.render({
      nonce: 1,
      scopeKey: "workspace:session",
      editRevision,
      text: "/stale-skill ",
    });
    expect(f.input().value).toBe("initial");
    expect(
      sessionStorage.getItem("ohbaby:composer:workspace:session"),
    ).toContain("initial");
  });
  it("persists an accepted insertion and consumes its identity once", () => {
    const f = fixture();
    const prefill = {
      nonce: 1,
      scopeKey: "workspace:session",
      editRevision: f.revision(),
      text: "inserted skill",
    };
    f.render(prefill);
    expect(f.input().value).toBe("inserted skill");
    expect(
      sessionStorage.getItem("ohbaby:composer:workspace:session"),
    ).toContain("inserted skill");
    f.type("user changed it");
    f.render({ ...prefill, editRevision: f.revision() });
    expect(f.input().value).toBe("user changed it");
  });
});

it("keeps the draft and composer DOM while read-only mode blocks input actions", () => {
  const onSubmit = vi.fn();
  const onStop = vi.fn();
  const f = fixture({ onSubmit, onStop });
  f.type("draft to preserve");
  const input = f.input();
  f.render(null, true);
  expect(f.input()).toBe(input);
  expect(input.value).toBe("draft to preserve");
  expect(input.closest("[inert]")).not.toBeNull();
  expect(document.body.textContent).toContain("Read-only subagent");
  void act(() =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  expect(onSubmit).not.toHaveBeenCalled();
  expect(onStop).not.toHaveBeenCalled();
  f.render(null, false);
  expect(f.input()).toBe(input);
  expect(input.value).toBe("draft to preserve");
});

function queuedPrompt(
  status: "queued" | "retained",
  id = "p",
): UiPromptSubmission {
  return {
    promptId: id,
    userMessageId: `m-${id}`,
    clientRequestId: `r-${id}`,
    scopeKey: "workspace",
    sessionId: "session",
    text: `body ${id}`,
    status,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}
async function flushAction(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

function clickLabel(label: string): void {
  const button = Array.from(document.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`Missing button ${label}`);
  button.click();
}

it.each(["queued", "retained"] as const)(
  "edits only the selected %s item and restores the pre-edit draft",
  async (status) => {
    const prompt = queuedPrompt(status);
    const other = queuedPrompt("retained", "other");
    const acquire = vi.fn().mockResolvedValue({
      editLeaseId: "lease",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      ownerClientId: "web",
      prompt,
    });
    const save = vi.fn().mockResolvedValue(prompt);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({ promptId: "p" });
    const onSubmit = vi.fn();
    const f = fixture({
      queuedPrompts: [prompt, other],
      onSubmit,
      client: {
        getCurrentModel: () => Promise.resolve(null),
        subscribeEvents: () => (): void => undefined,
        updateSessionReasoning: vi.fn(),
        acquirePromptEditLease: acquire,
        renewPromptEditLease: vi.fn(),
        releasePromptEditLease: vi.fn().mockResolvedValue(prompt),
        editQueuedPrompt: save,
        resubmitRetainedPrompt: send,
        cancelQueuedPrompt: vi.fn(),
        steerQueuedPrompt: vi.fn(),
      },
    });
    f.type("original draft");
    await flushAction(() => {
      const body = Array.from(document.querySelectorAll("span")).find(
        (span) => span.textContent === prompt.text,
      );
      body?.click();
    });
    expect(acquire).not.toHaveBeenCalled();
    await flushAction(() => {
      clickLabel(`Edit prompt: ${prompt.text}`);
    });
    expect(f.input().value).toBe(prompt.text);
    f.type("edited selected item");
    f.update({ onEditRevision: () => undefined });
    expect(
      JSON.parse(
        sessionStorage.getItem("ohbaby:composer:workspace:session") ?? "{}",
      ),
    ).toEqual({ text: "original draft" });
    const label =
      status === "retained" ? "Send retained prompt" : "Save queued prompt";
    await flushAction(() => {
      clickLabel(label);
    });
    if (status === "retained") {
      expect(f.input().value).toBe("edited selected item");
      expect(document.body.textContent).toContain("response lost");
      await flushAction(() => {
        clickLabel("Retry retained send");
      });
      expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
      expect(send).toHaveBeenLastCalledWith({
        promptId: "p",
        editLeaseId: "lease",
        operationId: expect.any(String) as string,
        text: "edited selected item",
      });
      expect(save).not.toHaveBeenCalled();
    } else
      expect(save).toHaveBeenCalledWith({
        promptId: "p",
        editLeaseId: "lease",
        text: "edited selected item",
      });
    expect(f.input().value).toBe("original draft");
    expect(onSubmit).not.toHaveBeenCalled();
  },
);

it.each([
  "queued",
  "succeeded",
  "refresh",
  "response lost twice",
  "another operation",
] as const)(
  "recovers only the original retained receipt after server committed %s",
  async (scenario) => {
    const store = new InMemoryPromptSubmissionStore({
      ownerId: "owner",
      ownerPid: process.pid,
    });
    await store.accept({
      promptId: "p",
      clientRequestId: "r-p",
      userMessageId: "m-p",
      scopeKey: "workspace",
      sessionId: "session",
      text: "body p",
      maxQueuedPrompts: 10,
    });
    await store.retainOwnedQueued();
    const lease = await store.acquireEditLease("p", "web", 60000);
    const prompt = queuedPrompt("retained");
    let insertions = 0;
    let executions = 0;
    let f!: ReturnType<typeof fixture>;
    const send = vi.fn<UiBackendClient["resubmitRetainedPrompt"]>(
      async (input) => {
        const request = {
          ...input,
          scopeKey: "workspace",
          ownerClientId: "web",
          maxQueuedPrompts: 10,
        };
        const result = await store.resubmitRetained(
          scenario === "another operation" && send.mock.calls.length === 1
            ? { ...request, operationId: "other-operation" }
            : request,
        );
        if (result.inserted) insertions++;
        if (
          (scenario === "succeeded" || scenario === "refresh") &&
          result.inserted
        ) {
          await store.claim("p");
          await store.markRunning("p", "run-p");
          await store.finish("p", {
            status: "succeeded",
            expectedRunId: "run-p",
          });
          executions++;
        }
        const current = await store.get("p");
        f.update({
          queuedPrompts:
            current?.status === "queued"
              ? [{ ...prompt, text: current.text, status: "queued" }]
              : [],
        });
        if (
          send.mock.calls.length <= (scenario === "response lost twice" ? 2 : 1)
        )
          throw new Error("response lost after commit");
        return result.receipt;
      },
    );
    const onSubmit = vi.fn();
    const client = {
      getCurrentModel: (): Promise<null> => Promise.resolve(null),
      subscribeEvents: (): (() => void) => (): void => undefined,
      updateSessionReasoning: vi.fn(),
      acquirePromptEditLease: vi.fn().mockResolvedValue({
        ...lease,
        prompt,
        expiresAt: new Date(lease.expiresAt).toISOString(),
      }),
      renewPromptEditLease: vi.fn(),
      releasePromptEditLease: vi.fn().mockResolvedValue(prompt),
      resubmitRetainedPrompt: send,
      editQueuedPrompt: vi.fn(),
      cancelQueuedPrompt: vi.fn(),
      steerQueuedPrompt: vi.fn(),
    };
    f = fixture({ queuedPrompts: [prompt], onSubmit, client });
    const clickSend = async (label: string): Promise<void> => {
      await act(async () => {
        clickLabel(label);
        await Promise.allSettled(
          send.mock.results.map((result): unknown => result.value),
        );
      });
    };
    f.type("original draft");
    await flushAction(() => {
      clickLabel("Edit prompt: body p");
    });
    f.type("edited send");
    await clickSend("Send retained prompt");
    expect(f.input().value).toBe("edited send");
    expect(send).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Send outcome unknown");
    expect(document.body.textContent).not.toContain(
      "This edit is no longer available",
    );
    expect(f.input().readOnly).toBe(true);
    if (scenario === "refresh") {
      act(() => root?.unmount());
      f = fixture({ queuedPrompts: [], onSubmit, client });
      expect(f.input().value).toBe("edited send");
      expect(client.renewPromptEditLease).not.toHaveBeenCalled();
    }
    await clickSend("Retry retained send");
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
    if (scenario === "response lost twice") {
      expect(f.input().value).toBe("edited send");
      expect(send).toHaveBeenCalledTimes(2);
      await clickSend("Retry retained send");
      expect(send.mock.calls[2]).toEqual(send.mock.calls[0]);
    }
    expect(insertions).toBe(1);
    expect(executions).toBe(
      scenario === "succeeded" || scenario === "refresh" ? 1 : 0,
    );
    expect((await store.get("p"))?.userMessageId).toBe("m-p");
    expect(onSubmit).not.toHaveBeenCalled();
    if (scenario === "another operation") {
      expect(f.input().value).toBe("edited send");
      expect(
        await store.getResubmissionReceipt(
          "workspace",
          send.mock.calls[0][0].operationId,
        ),
      ).toBeUndefined();
      await flushAction(() =>
        f
          .input()
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
          ),
      );
    }
    expect(f.input().value).toBe("original draft");
  },
);

it("keeps expired edit text associated with its prompt and prevents sending as a new message", async () => {
  const prompt = queuedPrompt("retained");
  sessionStorage.setItem(
    "ohbaby:composer:workspace:session",
    JSON.stringify({ text: "original draft" }),
  );
  sessionStorage.setItem(
    "ohbaby:composer-lease:workspace:session",
    JSON.stringify({
      promptId: "p",
      status: "retained",
      editLeaseId: "expired",
      expiresAt: "2020-01-01T00:00:00Z",
      originalDraft: "original draft",
      editText: "retained edited text",
      lastActivityAt: 0,
    }),
  );
  const onSubmit = vi.fn();
  const send = vi.fn();
  const f = fixture({
    queuedPrompts: [prompt],
    onSubmit,
    client: {
      getCurrentModel: () => Promise.resolve(null),
      subscribeEvents: () => (): void => undefined,
      updateSessionReasoning: vi.fn(),
      acquirePromptEditLease: vi.fn(),
      renewPromptEditLease: vi.fn().mockRejectedValue(new Error("expired")),
      releasePromptEditLease: vi.fn().mockResolvedValue(prompt),
      editQueuedPrompt: vi.fn(),
      resubmitRetainedPrompt: send,
      cancelQueuedPrompt: vi.fn(),
      steerQueuedPrompt: vi.fn(),
    },
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(f.input().value).toBe("retained edited text");
  await flushAction(() => {
    f.input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  expect(onSubmit).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  await flushAction(() => {
    f.input().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(f.input().value).toBe("original draft");
});

it("shows the stopped Steer notice above an empty queue without adding a prompt", () => {
  const f = fixture({ unsentSteer: true });
  expect(document.body.textContent).toContain(
    "Task stopped before your steer message was sent.",
  );
  expect(document.querySelector(".ohb-prompt-queue")).toBeNull();
  f.update({ unsentSteer: false });
  expect(document.body.textContent).not.toContain("Task stopped before");
});

it("does not revive an item deleted while its edit lease response was in flight", async () => {
  const prompt = queuedPrompt("retained");
  let resolve!: (lease: {
    editLeaseId: string;
    expiresAt: string;
    ownerClientId: string;
    prompt: UiPromptSubmission;
  }) => void;
  const pending = new Promise<
    Awaited<ReturnType<UiBackendClient["acquirePromptEditLease"]>>
  >((done) => {
    resolve = done;
  });
  const release = vi.fn().mockResolvedValue(prompt);
  const f = fixture({
    queuedPrompts: [prompt],
    client: {
      getCurrentModel: () => Promise.resolve(null),
      subscribeEvents: () => (): void => undefined,
      updateSessionReasoning: vi.fn(),
      acquirePromptEditLease: () => pending,
      renewPromptEditLease: vi.fn(),
      releasePromptEditLease: release,
      editQueuedPrompt: vi.fn(),
      resubmitRetainedPrompt: vi.fn(),
      cancelQueuedPrompt: vi.fn(),
      steerQueuedPrompt: vi.fn(),
    },
  });
  f.type("draft preserved");
  await flushAction(() => {
    clickLabel(`Edit prompt: ${prompt.text}`);
  });
  f.update({ queuedPrompts: [] });
  await flushAction(() => {
    resolve({
      editLeaseId: "late",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      ownerClientId: "web",
      prompt,
    });
  });
  expect(f.input().value).toBe("draft preserved");
  expect(release).toHaveBeenCalledWith({ editLeaseId: "late", promptId: "p" });
  expect(document.body.textContent).not.toContain("Editing retained");
});

it.each(["before", "after"])(
  "expires Steer acceptance when its target ends %s acknowledgement",
  async (timing) => {
    let accept!: (receipt: { acceptedTargetRunId: string }) => void;
    const acknowledgement = new Promise<{ acceptedTargetRunId: string }>(
      (resolve) => {
        accept = resolve;
      },
    );
    const model = {
      canSend: true,
      canStop: true,
      disabled: false,
      isRunning: true,
      mode: "auto" as const,
      permissionLevel: "default" as const,
      activeSessionId: "session",
      activeRunId: "run-1",
    };
    const f = fixture({
      model,
      queuedPrompts: [queuedPrompt("queued")],
      client: {
        steerQueuedPrompt: () => acknowledgement,
        getCurrentModel: () => Promise.resolve(null),
        subscribeEvents: (): (() => void) => (): void => undefined,
      } as unknown as UiBackendClient,
    });
    await flushAction(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Steer queued prompt: body p"]',
        )
        ?.click(),
    );
    if (timing === "after") {
      await flushAction(() => {
        accept({ acceptedTargetRunId: "run-1" });
      });
      expect(document.body.textContent).toContain("Steer accepted");
    }
    f.update({
      model: {
        ...model,
        activeRunId: undefined,
        isRunning: false,
        canStop: false,
      },
      unsentSteer: true,
    });
    if (timing === "before")
      await flushAction(() => {
        accept({ acceptedTargetRunId: "run-1" });
      });
    expect(document.body.textContent).toContain(
      "Task stopped before your steer message was sent.",
    );
    expect(document.body.textContent).not.toContain("Steer accepted");
    f.update({ model: { ...model, activeRunId: "run-2" }, unsentSteer: false });
    f.type("next prompt");
    expect(document.body.textContent).not.toContain("Steer accepted");
  },
);

it.each(["draft edit", "session round trip"])(
  "does not revive Steer acceptance after a pending request crosses %s",
  async (change) => {
    let accept!: (receipt: { acceptedTargetRunId: string }) => void;
    const acknowledgement = new Promise<{ acceptedTargetRunId: string }>(
      (resolve) => {
        accept = resolve;
      },
    );
    const model = {
      canSend: true,
      canStop: true,
      disabled: false,
      isRunning: true,
      mode: "auto" as const,
      permissionLevel: "default" as const,
      activeSessionId: "session",
      activeRunId: "run-1",
    };
    const f = fixture({
      model,
      queuedPrompts: [queuedPrompt("queued")],
      client: {
        steerQueuedPrompt: () => acknowledgement,
        getCurrentModel: () => Promise.resolve(null),
        subscribeEvents: (): (() => void) => (): void => undefined,
      } as unknown as UiBackendClient,
    });
    await flushAction(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[aria-label="Steer queued prompt: body p"]',
        )
        ?.click(),
    );
    if (change === "draft edit") {
      f.type("new draft while acknowledgement is pending");
    } else {
      f.update({
        draftScopeKey: "workspace:other",
        model: { ...model, activeSessionId: "other", activeRunId: "other-run" },
      });
      f.update({ draftScopeKey: "workspace:session", model });
    }
    await flushAction(() => {
      accept({ acceptedTargetRunId: "run-1" });
    });
    expect(document.body.textContent).not.toContain("Steer accepted");
    if (change === "draft edit")
      expect(f.input().value).toBe(
        "new draft while acknowledgement is pending",
      );
  },
);

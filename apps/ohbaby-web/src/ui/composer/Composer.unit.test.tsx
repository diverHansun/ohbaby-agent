// @vitest-environment jsdom
import type {
  UiBackendClient,
  UiPromptReceipt,
  UiPromptSubmission,
} from "ohbaby-sdk";
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
  ) => void;
  readonly revision: () => number;
  readonly update: (patch: Partial<ComponentProps<typeof Composer>>) => void;
} {
  let revision = 0;
  const props: ComponentProps<typeof Composer> = {
    client: {
      steerQueuedPrompt: vi.fn<UiBackendClient["steerQueuedPrompt"]>(),
      resendSteerInput: vi.fn<UiBackendClient["resendSteerInput"]>(),
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
  ): void => {
    act(() => root?.render(<Composer {...props} prefill={prefill} />));
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
        resendSteerInput: vi.fn(),
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
      resendSteerInput: vi.fn(),
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
      resendSteerInput: vi.fn(),
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

const unconsumedSteers = [
  {
    inputId: "input-old",
    promptId: "prompt-old",
    messageId: "message-old",
    text: "Keep my requirement",
    state: "unconfirmed" as const,
  },
];

it("keeps recovery collapsed by default and preserves an idempotent retry across toggles", async () => {
  const resend = vi
    .fn()
    .mockRejectedValueOnce(new Error("Network lost"))
    .mockResolvedValue({ promptId: "new-prompt", status: "queued" });
  const f = fixture({
    unconsumedSteers,
    client: {
      resendSteerInput: resend,
      getCurrentModel: () => Promise.resolve(null),
      subscribeEvents: (): (() => void) => (): void => undefined,
    } as unknown as UiBackendClient,
  });
  const recovery = document.querySelector<HTMLDetailsElement>(
    "details.ohb-unsent-steer",
  );
  expect(recovery?.open).toBe(false);
  expect(recovery?.querySelector("summary")?.textContent).toContain(
    "1 input to review",
  );
  expect(recovery?.querySelector("summary")?.textContent).toContain(
    "Processing unconfirmed",
  );
  expect(document.querySelectorAll(".ohb-steer-recovery-state")).toHaveLength(
    0,
  );
  await flushAction(() => recovery?.querySelector("summary")?.click());
  expect(recovery?.open).toBe(true);
  expect(document.body.textContent).toContain("Processing unconfirmed");
  expect(document.body.textContent).toContain("Keep my requirement");
  expect(document.querySelector(".ohb-prompt-queue")).toBeNull();
  await flushAction(() => {
    clickLabel("Resend steer 1: Keep my requirement");
  });
  expect(document.body.textContent).toContain("Network lost");
  await flushAction(() => recovery?.querySelector("summary")?.click());
  expect(recovery?.open).toBe(false);
  await flushAction(() => recovery?.querySelector("summary")?.click());
  expect(recovery?.open).toBe(true);
  expect(document.body.textContent).toContain("Network lost");
  await flushAction(() => {
    clickLabel("Resend steer 1: Keep my requirement");
  });
  expect(resend.mock.calls[1]?.[0]).toEqual(resend.mock.calls[0]?.[0]);
  expect(resend.mock.calls[0]?.[0]).toMatchObject({ inputId: "input-old" });
  expect(recovery?.querySelector("button")?.textContent).toBe("Resend again");
  f.update({ unconsumedSteers: [] });
  expect(document.body.textContent).not.toContain("Keep my requirement");
});

it("shows per-item recovery state only when unconsumed and unconfirmed inputs are mixed", async () => {
  fixture({
    unconsumedSteers: [
      {
        inputId: "input-unconsumed",
        promptId: "prompt-1",
        messageId: "message-1",
        text: "恢复提醒：请在最终结果中注明每个城市的来源和时间。",
        state: "unconsumed",
      },
      {
        inputId: "input-unconfirmed",
        promptId: "prompt-2",
        messageId: "message-2",
        text: "补充：对比昨天与今天的气温变化。",
        state: "unconfirmed",
      },
    ],
  });
  const recovery = document.querySelector<HTMLDetailsElement>(
    "details.ohb-unsent-steer",
  );
  expect(recovery?.querySelector("summary")?.textContent).toBe(
    "2 inputs to review",
  );
  await flushAction(() => recovery?.querySelector("summary")?.click());
  expect(
    [...document.querySelectorAll(".ohb-steer-recovery-state")].map(
      (node) => node.textContent,
    ),
  ).toEqual(["Not processed", "Processing unconfirmed"]);
});

it("keeps every recovery item reachable without expanding long text by default", async () => {
  const original = "A long requirement. ".repeat(200);
  const resend = vi
    .fn<UiBackendClient["resendSteerInput"]>()
    .mockResolvedValue({
      promptId: "new",
      sessionId: "session",
      clientRequestId: "resend-operation",
      userMessageId: "new-message",
      status: "queued",
      createdAt: "2026-10-15T00:00:00Z",
    });
  const f = fixture({
    unconsumedSteers: unconsumedSteers
      .map((input) => ({ ...input, text: original }))
      .concat([
        {
          ...unconsumedSteers[0],
          inputId: "second",
          promptId: "second-prompt",
          messageId: "second-message",
          text: original,
        },
      ]),
    client: {
      resendSteerInput: resend,
      getCurrentModel: () => Promise.resolve(null),
      subscribeEvents: (): (() => void) => (): void => undefined,
    } as unknown as UiBackendClient,
  });
  f.type("Unrelated draft");
  const recovery = document.querySelector<HTMLDetailsElement>(
    "details.ohb-unsent-steer",
  );
  expect(recovery?.open).toBe(false);
  expect(recovery?.querySelector("summary")?.textContent).toContain("2 inputs");
  await flushAction(() => recovery?.querySelector("summary")?.click());
  expect(recovery?.open).toBe(true);
  expect(
    [...document.querySelectorAll(".ohb-steer-recovery-text")].map(
      (node) => node.textContent,
    ),
  ).toEqual([original, original]);
  if (!recovery) throw new Error("Recovery entry missing");
  const buttons = [...recovery.querySelectorAll<HTMLButtonElement>("button")];
  await flushAction(() => {
    buttons[1]?.click();
  });
  expect(resend.mock.calls[0]?.[0]).toMatchObject({ inputId: "second" });
  await flushAction(() => {
    buttons[0]?.click();
  });
  expect(resend.mock.calls[1]?.[0]).toMatchObject({ inputId: "input-old" });
  expect(resend.mock.calls[1]?.[0].operationId).not.toBe(
    resend.mock.calls[0]?.[0].operationId,
  );
  expect(f.input().value).toBe("Unrelated draft");
  f.update({ unconsumedSteers: [] });
  expect(document.querySelector("details.ohb-unsent-steer")).toBeNull();
});

it("reports only an accepted resend so the stream can follow it", async () => {
  const resend = vi
    .fn<UiBackendClient["resendSteerInput"]>()
    .mockRejectedValueOnce(new Error("Network lost"))
    .mockResolvedValue({
      promptId: "new",
      sessionId: "session",
      clientRequestId: "resend-operation",
      userMessageId: "new-message",
      status: "queued",
      createdAt: "2026-10-15T00:00:00Z",
    });
  const onResendAccepted = vi.fn();
  fixture({
    unconsumedSteers,
    onResendAccepted,
    client: {
      resendSteerInput: resend,
      getCurrentModel: () => Promise.resolve(null),
      subscribeEvents: (): (() => void) => (): void => undefined,
    } as unknown as UiBackendClient,
  });
  await flushAction(() =>
    document
      .querySelector<HTMLElement>("details.ohb-unsent-steer summary")
      ?.click(),
  );
  await flushAction(() => {
    clickLabel("Resend steer 1: Keep my requirement");
  });
  expect(onResendAccepted).not.toHaveBeenCalled();
  await flushAction(() => {
    clickLabel("Resend steer 1: Keep my requirement");
  });
  expect(resend).toHaveBeenCalledTimes(2);
  expect(onResendAccepted).toHaveBeenCalledTimes(1);
});

it("resets expansion and failed recovery state when the session changes", async () => {
  const resend = vi
    .fn<UiBackendClient["resendSteerInput"]>()
    .mockRejectedValue(new Error("Network lost"));
  const f = fixture({
    unconsumedSteers,
    client: {
      resendSteerInput: resend,
      getCurrentModel: () => Promise.resolve(null),
      subscribeEvents: (): (() => void) => (): void => undefined,
    } as unknown as UiBackendClient,
  });
  await flushAction(() =>
    document
      .querySelector("details.ohb-unsent-steer summary")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
  await flushAction(() => {
    clickLabel("Resend steer 1: Keep my requirement");
  });
  expect(document.body.textContent).toContain("Network lost");
  f.update({
    draftScopeKey: "workspace:other",
    unconsumedSteers: [
      { ...unconsumedSteers[0], text: "Other session requirement" },
    ],
  });
  const recovery = document.querySelector<HTMLDetailsElement>(
    "details.ohb-unsent-steer",
  );
  expect(recovery?.open).toBe(false);
  expect(document.body.textContent).not.toContain("Network lost");
  expect(document.body.textContent).not.toContain("Keep my requirement");
  await flushAction(() => recovery?.querySelector("summary")?.click());
  await flushAction(() => {
    clickLabel("Resend steer 1: Other session requirement");
  });
  expect(resend.mock.calls[1]?.[0].operationId).not.toBe(
    resend.mock.calls[0]?.[0].operationId,
  );
});

it("keeps a refused manual steer visibly queued without announcing acceptance", async () => {
  fixture({
    model: {
      canSend: true,
      canStop: true,
      disabled: false,
      isRunning: true,
      mode: "auto",
      permissionLevel: "default",
      activeRunId: "run-1",
      activeSessionId: "session",
    },
    queuedPrompts: [queuedPrompt("queued")],
    client: {
      steerQueuedPrompt: () =>
        Promise.resolve({ status: "not-steered", reason: "target-sealed" }),
      getCurrentModel: () => Promise.resolve(null),
      subscribeEvents: (): (() => void) => (): void => undefined,
    } as unknown as UiBackendClient,
  });
  await flushAction(() => {
    clickLabel("Steer queued prompt: body p");
  });
  expect(document.body.textContent).toContain("Kept in queue");
  expect(document.body.textContent).not.toContain("Steer accepted");
});

it.each(["before", "after"])(
  "keeps a resend admission error visible when recovery clears %s the receipt",
  async (timing) => {
    let accept!: (receipt: UiPromptReceipt) => void;
    const acknowledgement = new Promise<UiPromptReceipt>((resolve) => {
      accept = resolve;
    });
    const resend = vi.fn<UiBackendClient["resendSteerInput"]>(
      () => acknowledgement,
    );
    const f = fixture({
      unconsumedSteers,
      client: {
        resendSteerInput: resend,
        getCurrentModel: () => Promise.resolve(null),
        subscribeEvents: (): (() => void) => (): void => undefined,
      } as unknown as UiBackendClient,
    });
    f.type("Unrelated draft");
    await flushAction(() =>
      document
        .querySelector<HTMLDetailsElement>("details.ohb-unsent-steer")
        ?.querySelector("summary")
        ?.click(),
    );
    await flushAction(() => {
      clickLabel("Resend steer 1: Keep my requirement");
    });
    if (timing === "before") f.update({ unconsumedSteers: [] });
    await flushAction(() => {
      accept({
        promptId: "resent",
        sessionId: "session",
        clientRequestId: "resend-operation",
        status: "queued",
        userMessageId: "resent-message",
        createdAt: "2026-10-15T00:00:00Z",
        steer: {
          status: "error",
          error: {
            code: "STEER_FAILED",
            message: "Input store unavailable",
            source: "scheduler",
            retryable: true,
          },
        },
      });
    });
    expect(document.body.textContent).toContain(
      "Accepted in queue · Input store unavailable",
    );
    if (timing === "after") f.update({ unconsumedSteers: [] });
    expect(document.body.textContent).toContain(
      "Accepted in queue · Input store unavailable",
    );
    expect(document.body.textContent).not.toContain("Keep my requirement");
    expect(f.input().value).toBe("Unrelated draft");
    expect(resend).toHaveBeenCalledTimes(1);
  },
);

it.each(["recovery removed", "recovery collapsed", "session changed"])(
  "keeps a late resend failure in its owning session after %s",
  async (change) => {
    let reject!: (error: Error) => void;
    const pending = new Promise<UiPromptReceipt>((_, fail) => {
      reject = fail;
    });
    const resend = vi.fn(() => pending);
    const f = fixture({
      unconsumedSteers,
      client: {
        resendSteerInput: resend,
        getCurrentModel: () => Promise.resolve(null),
        subscribeEvents: (): (() => void) => (): void => undefined,
      } as unknown as UiBackendClient,
    });
    const recovery = document.querySelector<HTMLDetailsElement>(
      "details.ohb-unsent-steer",
    );
    await flushAction(() => recovery?.querySelector("summary")?.click());
    await flushAction(() => {
      clickLabel("Resend steer 1: Keep my requirement");
    });
    expect(recovery?.querySelector("button")?.disabled).toBe(true);
    if (change === "recovery removed") f.update({ unconsumedSteers: [] });
    if (change === "recovery collapsed") {
      await flushAction(() => recovery?.querySelector("summary")?.click());
      expect(recovery?.open).toBe(false);
    }
    if (change === "session changed")
      f.update({ draftScopeKey: "workspace:other", unconsumedSteers: [] });
    await flushAction(() => {
      reject(new Error("Resend connection lost"));
    });
    const alert = document.querySelector('[role="alert"]');
    if (change === "session changed") {
      expect(alert).toBeNull();
    } else {
      expect(alert?.textContent).toBe("Resend connection lost");
      expect(alert?.closest("details")).toBeNull();
    }
    expect(resend).toHaveBeenCalledTimes(1);
  },
);

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
      resendSteerInput: vi.fn(),
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
  "keeps successful steer quiet when its target ends %s acknowledgement",
  async (timing) => {
    let accept!: (result: {
      status: "steered";
      receipt: { acceptedTargetRunId: string };
    }) => void;
    const acknowledgement = new Promise<{
      status: "steered";
      receipt: { acceptedTargetRunId: string };
    }>((resolve) => {
      accept = resolve;
    });
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
        accept({
          status: "steered",
          receipt: { acceptedTargetRunId: "run-1" },
        });
      });
      expect(document.body.textContent).not.toContain("Steer accepted");
    }
    f.update({
      model: {
        ...model,
        activeRunId: undefined,
        isRunning: false,
        canStop: false,
      },
      unconsumedSteers,
    });
    if (timing === "before")
      await flushAction(() => {
        accept({
          status: "steered",
          receipt: { acceptedTargetRunId: "run-1" },
        });
      });
    expect(document.body.textContent).toContain("Processing unconfirmed");
    expect(document.body.textContent).not.toContain("Steer accepted");
    f.update({
      model: { ...model, activeRunId: "run-2" },
      unconsumedSteers: [],
    });
    f.type("next prompt");
    expect(document.body.textContent).not.toContain("Steer accepted");
  },
);

it.each(["draft edit", "session round trip"])(
  "does not revive Steer acceptance after a pending request crosses %s",
  async (change) => {
    let accept!: (result: {
      status: "steered";
      receipt: { acceptedTargetRunId: string };
    }) => void;
    const acknowledgement = new Promise<{
      status: "steered";
      receipt: { acceptedTargetRunId: string };
    }>((resolve) => {
      accept = resolve;
    });
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
      accept({ status: "steered", receipt: { acceptedTargetRunId: "run-1" } });
    });
    expect(document.body.textContent).not.toContain("Steer accepted");
    if (change === "draft edit")
      expect(f.input().value).toBe(
        "new draft while acknowledgement is pending",
      );
  },
);

it("keeps the goal directly against the input below queued prompts and steer recovery", () => {
  const f = fixture({
    activeGoal: {
      objective: "Finish the goal after queued guidance",
      status: "paused",
      turnsUsed: 1,
      wallClockMs: 24000,
    },
    queuedPrompts: [queuedPrompt("queued")],
    unconsumedSteers,
  });
  const strip = document.querySelector('[aria-label="Session goal"]');
  const queue = document.querySelector('[aria-label="Queued prompts"]');
  const recovery = document.querySelector(".ohb-steer-recovery");
  if (!strip) throw new Error("Goal strip missing");
  expect(queue?.nextElementSibling).toBe(strip);
  expect(strip.nextElementSibling).toBe(
    f.input().closest(".ohb-composer-input"),
  );
  expect(recovery?.compareDocumentPosition(strip)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  f.update({ queuedPrompts: [] });
  expect(recovery?.nextElementSibling).toBe(strip);
  expect(strip.nextElementSibling).toBe(
    f.input().closest(".ohb-composer-input"),
  );
});

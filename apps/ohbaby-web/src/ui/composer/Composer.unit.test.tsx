// @vitest-environment jsdom
import type { UiBackendClient } from "ohbaby-sdk";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
  sessionStorage.clear();
});

function fixture(): {
  readonly input: () => HTMLTextAreaElement;
  readonly type: (text: string) => void;
  readonly render: (
    prefill: ComponentProps<typeof Composer>["prefill"],
  ) => void;
  readonly revision: () => number;
} {
  let revision = 0;
  const props: ComponentProps<typeof Composer> = {
    client: {
      steerQueuedPrompt: vi.fn<UiBackendClient["steerQueuedPrompt"]>(),
      getCurrentModel: () => Promise.resolve(null),
      subscribeEvents: () => () => undefined,
      updateSessionReasoning:
        vi.fn<UiBackendClient["updateSessionReasoning"]>(),
      acquirePromptEditLease:
        vi.fn<UiBackendClient["acquirePromptEditLease"]>(),
      renewPromptEditLease: vi.fn<UiBackendClient["renewPromptEditLease"]>(),
      releasePromptEditLease:
        vi.fn<UiBackendClient["releasePromptEditLease"]>(),
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

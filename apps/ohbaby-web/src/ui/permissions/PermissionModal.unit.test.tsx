// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { UiPermissionRequest } from "ohbaby-sdk";
import { PermissionModal } from "./PermissionModal.js";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const request: UiPermissionRequest = {
  id: "one",
  title: "Allow first task?",
  description: "Read file",
  sessionId: "root",
  rootSessionId: "root",
  runId: "run",
  callId: "call",
  messageId: "message",
  createdAt: 1,
  choices: [{ id: "allow", intent: "allow", label: "Allow once" }],
};
it("focuses each request title, blocks duplicate responses through the next snapshot, and replaces action identity", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  let finish: (success: boolean) => void = () => undefined;
  const onRespond = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const render = (permissions: readonly UiPermissionRequest[]): void => {
    act(() => {
      root.render(
        <PermissionModal
          disabled={false}
          syncing={false}
          permissions={permissions}
          onRetry={() => undefined}
          onRespond={onRespond}
        />,
      );
    });
  };
  try {
    render([request]);
    expect(document.activeElement).toBe(element.querySelector("h2"));
    const first = element.querySelector<HTMLButtonElement>(
      ".ohb-permission-actions button",
    );
    act(() => {
      first?.click();
      first?.click();
    });
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(first?.disabled).toBe(true);
    await act(async () => {
      finish(true);
      await Promise.resolve();
    });
    expect(first?.disabled).toBe(true);
    render([{ ...request, id: "two", title: "Allow second task?" }]);
    const second = element.querySelector<HTMLButtonElement>(
      ".ohb-permission-actions button",
    );
    expect(second).not.toBe(first);
    expect(document.activeElement).toBe(element.querySelector("h2"));
    expect(second?.disabled).toBe(false);
    act(() => {
      second?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 2 }),
      );
    });
    expect(onRespond).toHaveBeenCalledTimes(1);
  } finally {
    act(() => {
      root.unmount();
    });
    element.remove();
  }
});
it("allows an explicit retry after response failure", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const onRespond = vi.fn().mockResolvedValue(false);
  try {
    act(() => {
      root.render(
        <PermissionModal
          disabled={false}
          syncing={false}
          permissions={[request]}
          onRetry={() => undefined}
          onRespond={onRespond}
        />,
      );
    });
    const button = element.querySelector<HTMLButtonElement>(
      ".ohb-permission-actions button",
    );
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(button?.disabled).toBe(false);
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(onRespond).toHaveBeenCalledTimes(2);
  } finally {
    act(() => {
      root.unmount();
    });
    element.remove();
  }
});

it("retains a successful response lock while temporarily hidden by a child conversation", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const onRespond = vi.fn().mockResolvedValue(true);
  const render = (visible: boolean): void => {
    act(() => {
      root.render(
        <PermissionModal
          visible={visible}
          disabled={false}
          syncing={false}
          permissions={[request]}
          onRetry={() => undefined}
          onRespond={onRespond}
        />,
      );
    });
  };
  try {
    render(true);
    await act(async () => {
      element.querySelector<HTMLButtonElement>("button")?.click();
      await Promise.resolve();
    });
    render(false);
    expect(element.querySelector('[role="dialog"]')).toBeNull();
    render(true);
    expect(element.querySelector<HTMLButtonElement>("button")?.disabled).toBe(
      true,
    );
    expect(document.activeElement).toBe(element.querySelector("h2"));
    expect(onRespond).toHaveBeenCalledOnce();
  } finally {
    act(() => {
      root.unmount();
    });
    element.remove();
  }
});

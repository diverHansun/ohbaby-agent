// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { UiPermissionRequest } from "ohbaby-sdk";
import { ApprovalPanel } from "./ApprovalPanel.js";
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
        <ApprovalPanel
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
        <ApprovalPanel
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

it("collapses to its title row and expands back without losing the request", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  try {
    act(() => {
      root.render(
        <ApprovalPanel
          disabled={false}
          syncing={false}
          permissions={[request, { ...request, id: "two" }]}
          onRetry={() => undefined}
          onRespond={() => Promise.resolve(true)}
        />,
      );
    });
    const dialog = element.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-modal")).toBe("false");
    expect(element.textContent).toContain("1 of 2");
    act(() => {
      element
        .querySelector<HTMLButtonElement>('[aria-label="Collapse approval"]')
        ?.click();
    });
    expect(element.querySelector(".ohb-permission-actions")).toBeNull();
    expect(element.querySelector("h2")?.textContent).toBe("Allow first task?");
    act(() => {
      element
        .querySelector<HTMLButtonElement>('[aria-label="Expand approval"]')
        ?.click();
    });
    expect(
      element.querySelector(".ohb-permission-actions button"),
    ).not.toBeNull();
  } finally {
    act(() => {
      root.unmount();
    });
    element.remove();
  }
});

it("asks about a shell command, shows it verbatim, and answers from the keyboard", () => {
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  const onRespond = vi.fn(() => new Promise<boolean>(() => undefined));
  const shell: UiPermissionRequest = {
    ...request,
    title: "Shell commands need your approval unless Full access is on.",
    description: "bash(git status)",
    command: "git status",
    choices: [
      { id: "allow_once", intent: "allow", label: "Allow once" },
      { id: "reject", intent: "deny", label: "Reject" },
    ],
  };
  const render = (permissions: readonly UiPermissionRequest[]): void => {
    act(() => {
      root.render(
        <ApprovalPanel
          disabled={false}
          syncing={false}
          permissions={permissions}
          onRetry={() => undefined}
          onRespond={onRespond}
        />,
      );
    });
  };
  const press = (init: KeyboardEventInit): void => {
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ...init }),
      );
    });
  };
  try {
    render([shell]);
    expect(element.querySelector("h2")?.textContent).toBe("Run this command?");
    expect(element.querySelector(".ohb-approval-reason")?.textContent).toBe(
      shell.title,
    );
    expect(
      element.querySelector(".ohb-approval-command code")?.textContent,
    ).toBe("git status");
    expect(element.textContent).not.toContain("bash(");
    // Plain Enter on the focused title must not approve.
    press({ key: "Enter" });
    expect(onRespond).not.toHaveBeenCalled();
    press({ key: "Escape" });
    expect(onRespond).toHaveBeenLastCalledWith(shell, shell.choices[1]);
    render([{ ...shell, id: "two" }]);
    press({ key: "Enter", ctrlKey: true });
    expect(onRespond).toHaveBeenLastCalledWith(
      { ...shell, id: "two" },
      shell.choices[0],
    );
  } finally {
    act(() => {
      root.unmount();
    });
    element.remove();
  }
});

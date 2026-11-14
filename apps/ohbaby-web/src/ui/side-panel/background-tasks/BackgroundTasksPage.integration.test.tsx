// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiBackendClient } from "ohbaby-sdk";
import { createMockRuntime } from "../../../dev/mock-runtime.js";
import { OhbabyWebApp } from "../../App.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

/** Lets the mock's timers and React settle until `check` passes. */
async function until(check: () => boolean, timeout = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error("timed out waiting");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function mount(
  scenario: string,
  refusal?: { readonly operation: "output" | "stop"; readonly code: string },
): Promise<{
  readonly element: HTMLElement;
  readonly stop: ReturnType<typeof vi.fn>;
}> {
  const runtime = createMockRuntime(scenario);
  const base = runtime.client;
  if (!base) throw new Error("Missing mock client");
  const stop = vi.fn(
    (input: Parameters<NonNullable<UiBackendClient["stopShellJob"]>>[0]) =>
      refusal?.operation === "stop"
        ? Promise.reject(
            Object.assign(new Error(refusal.code), { code: refusal.code }),
          )
        : base.stopShellJob?.(input),
  );
  const client = new Proxy(base, {
    get: (target, property, receiver): unknown => {
      if (property === "stopShellJob") return stop;
      if (property === "getShellJobOutput" && refusal?.operation === "output")
        return (): Promise<never> =>
          Promise.reject(
            Object.assign(new Error(refusal.code), { code: refusal.code }),
          );
      return Reflect.get(target, property, receiver);
    },
  });
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => {
    root.render(<OhbabyWebApp runtime={{ ...runtime, client }} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted.push(() => {
    act(() => {
      root.unmount();
    });
    element.remove();
  });
  return { element, stop };
}

function button(
  scope: ParentNode,
  text: string,
): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find(
    (item) =>
      item.getAttribute("aria-label") === text ||
      item.textContent.trim() === text,
  );
}

async function click(target: HTMLElement | undefined): Promise<void> {
  if (!target) throw new Error("missing button");
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function openTasksPage(element: HTMLElement): Promise<void> {
  await until(() => button(element, "Open side panel") !== undefined);
  await click(button(element, "Open side panel"));
  await until(() =>
    [...element.querySelectorAll(".ohb-side-panel-entry button")].some((item) =>
      item.textContent.includes("Background tasks"),
    ),
  );
  await click(
    [
      ...element.querySelectorAll<HTMLButtonElement>(
        ".ohb-side-panel-entry button",
      ),
    ].find((item) => item.textContent.includes("Background tasks")),
  );
  await until(() => element.querySelector(".ohb-bgtask-row") !== null);
}

function rowFor(element: HTMLElement, title: string): HTMLElement {
  const row = [
    ...element.querySelectorAll<HTMLElement>(".ohb-bgtask-row"),
  ].find(
    (item) =>
      item.querySelector(".ohb-bgtask-row-title")?.textContent === title,
  );
  if (!row) throw new Error(`missing row ${title}`);
  return row;
}

describe("Background tasks page", () => {
  it("keeps task results out of the chat and opens a task from its bash card", async () => {
    const { element } = await mount("bg-chat");
    await until(() => element.textContent.includes("The build failed"));
    // The woken reply shows; the result message that woke it does not (D6).
    expect(element.textContent).not.toContain("Background task job_build");
    const entries = element.querySelectorAll(
      '[aria-label="Open background task"]',
    );
    // Two background bash cards; the foreground `git status` has no line.
    expect(entries).toHaveLength(2);
    const entry = entries[0] as HTMLButtonElement;
    entry.focus();
    await click(entry);
    await until(() => element.querySelector(".ohb-bgtask-detail h2") !== null);
    expect(element.querySelector(".ohb-bgtask-detail h2")?.textContent).toBe(
      "Dev server",
    );
    // Opened from the chat, focus stays in the chat (04 §3).
    expect(document.activeElement).toBe(entry);
    await until(() =>
      (
        element.querySelector(".ohb-bgtask-output-text")?.textContent ?? ""
      ).includes("VITE"),
    );
  });

  it("groups tasks and cancels one with a single request, settled by the backend", async () => {
    const { element, stop } = await mount("bg-running");
    await openTasksPage(element);
    const titles = [...element.querySelectorAll(".ohb-bgtask-group h3")].map(
      (heading) => heading.textContent,
    );
    // Foreground commands (one unsettled, one with unconfirmed cleanup) stay out.
    expect(titles).toEqual(["Running2", "Done3"]);
    const list = element.querySelector(".ohb-bgtask-list")?.textContent ?? "";
    expect(list).not.toContain("git status --short");
    expect(list).not.toContain("sleep 600");
    // Only the failed row carries a word; others show a quiet time.
    expect(rowFor(element, "Build").textContent).toContain("Failed");
    expect(
      element.querySelectorAll(".ohb-bgtask-row-trailing.is-failed"),
    ).toHaveLength(1);
    // No filter without subagent tasks.
    expect(element.querySelector(".ohb-bgtask-toolbar")).toBeNull();

    const cancel = rowFor(
      element,
      "Watch tests",
    ).querySelector<HTMLButtonElement>(".ohb-bgtask-cancel");
    if (!cancel) throw new Error("missing Cancel");
    await click(cancel);
    await click(cancel);
    await click(cancel);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cancel.disabled).toBe(true);
    expect(cancel.getAttribute("aria-label")).toBe("Cancelling Watch tests");
    // Cancelling does not open the detail.
    expect(element.querySelector(".ohb-bgtask-detail")).toBeNull();
    await until(() =>
      [...element.querySelectorAll(".ohb-bgtask-group h3")].some(
        (heading) => heading.textContent === "Done4",
      ),
    );
    expect(
      rowFor(element, "Watch tests").querySelector(".ohb-bgtask-cancel"),
    ).toBeNull();
    expect(rowFor(element, "Watch tests").textContent).not.toContain("Failed");
  });

  it("shows nothing for a chat that only ran foreground commands", async () => {
    const { element } = await mount("bg-none");
    await until(() => button(element, "Open side panel") !== undefined);
    await click(button(element, "Open side panel"));
    await until(() => element.querySelector(".ohb-side-panel-entry") !== null);
    // Let the probe answer before asserting the absence.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(
      element.querySelector(".ohb-side-panel-entry")?.textContent,
    ).not.toContain("Background tasks");
    expect(
      element.querySelectorAll('[aria-label="Open background task"]'),
    ).toHaveLength(0);
  });

  it("preserves the list and restores focus to its row after reading details", async () => {
    const { element } = await mount("bg-running");
    await openTasksPage(element);
    const list = element.querySelector<HTMLElement>(".ohb-bgtask-list");
    const done = element.querySelector<HTMLButtonElement>(
      '[aria-label="Done"] h3 button',
    );
    const row = rowFor(element, "Watch tests").querySelector<HTMLButtonElement>(
      ".ohb-bgtask-row-open",
    );
    if (!list || !done || !row) throw new Error("missing list, group or row");
    await click(done);
    await click(row);
    const back = button(element, "Back to tasks");
    expect(document.activeElement).toBe(back);
    expect(list.hidden).toBe(true);
    await click(back);
    expect(element.querySelector(".ohb-bgtask-list")).toBe(list);
    expect(list.hidden).toBe(false);
    expect(done.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(row);
  });

  it.each([
    ["output", "SHELL_JOB_NOT_FOUND", "This task is no longer available."],
    ["stop", "SHELL_JOB_NOT_FOUND", "This task is no longer available."],
    [
      "stop",
      "SHELL_JOB_OTHER_BACKEND",
      "Started from another ohbaby window. Cancel it there.",
    ],
  ] as const)(
    "updates the detail after %s returns %s",
    async (operation, code, text) => {
      const { element } = await mount("bg-running", { operation, code });
      await openTasksPage(element);
      await click(
        rowFor(element, "Watch tests").querySelector<HTMLButtonElement>(
          ".ohb-bgtask-row-open",
        ) ?? undefined,
      );
      const detail = element.querySelector<HTMLElement>(".ohb-bgtask-detail");
      if (!detail) throw new Error("missing detail");
      if (operation === "stop")
        await click(button(detail, "Cancel Watch tests"));
      await until(() => detail.textContent.includes(text));
      expect(button(detail, "Cancel Watch tests")).toBeUndefined();
      if (code === "SHELL_JOB_NOT_FOUND") {
        await click(button(detail, "Back to tasks"));
        expect(button(element, "Cancel Watch tests")).toBeUndefined();
        expect(document.activeElement).toBe(
          element.querySelector(".ohb-bgtask-list"),
        );
      }
    },
  );

  it("starts on All with owner names when only subagents ran tasks", async () => {
    const { element } = await mount("bg-subagents-only");
    await openTasksPage(element);
    await until(
      () =>
        element
          .querySelector(".ohb-bgtask-toolbar button")
          ?.getAttribute("aria-label") === "Filter: All",
    );
    const owners = [...element.querySelectorAll(".ohb-bgtask-row-owner")].map(
      (item) => item.textContent,
    );
    expect(new Set(owners)).toEqual(new Set(["code-reviewer", "docs-links"]));
  });

  it("filters by owner from the menu", async () => {
    const { element } = await mount("bg-subagents");
    await openTasksPage(element);
    expect(element.querySelectorAll(".ohb-bgtask-row")).toHaveLength(1);
    await click(button(element, "Filter: Main agent"));
    const menu = document.querySelector('[role="menu"]');
    if (!menu) throw new Error("missing menu");
    await click(button(menu, "Subagents"));
    await until(() => element.querySelectorAll(".ohb-bgtask-row").length === 4);
    expect(element.querySelector(".ohb-bgtask-row-owner")).not.toBeNull();
  });
});

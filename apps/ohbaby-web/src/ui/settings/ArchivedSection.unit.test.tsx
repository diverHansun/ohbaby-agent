// @vitest-environment jsdom
import type { UiGlobalSession, UiGlobalSessionPage } from "ohbaby-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArchivedSection,
  type ArchivedSessionsApi,
} from "./ArchivedSection.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.useRealTimers();
});

function archived(
  id: string,
  title: string,
  hoursAgo: number,
  workspaceDirectory: string | null,
): UiGlobalSession {
  const updatedAt = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  return {
    id,
    title,
    status: "archived",
    createdAt: updatedAt,
    updatedAt,
    messageCount: 2,
    workspaceDirectory,
    workingDirectory: workspaceDirectory ?? "/home/u/.ohbaby/workspace",
  };
}

function rejectWith(code: string, status: number): Error {
  return Object.assign(new Error(code), { code, status });
}

function pager(pages: readonly UiGlobalSessionPage[]) {
  return vi.fn((cursor?: string) =>
    Promise.resolve(pages[Number(cursor ?? 0)] ?? { sessions: [] }),
  );
}

function api(
  pages: readonly UiGlobalSessionPage[],
  overrides: Partial<ArchivedSessionsApi> = {},
): ArchivedSessionsApi {
  return {
    listArchivedSessions: pager(pages),
    unarchiveSession: vi.fn(() => Promise.resolve()),
    deleteSession: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index++) await Promise.resolve();
  });
}

async function mount(archive: ArchivedSessionsApi): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(<ArchivedSection archive={archive} visible />);
  });
  await settle();
  return container;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent.trim() === name,
  );
  if (!found) throw new Error(`button not found: ${name}`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settle();
}

function rowTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".ohb-settings-row-title")].map(
    (title) => title.textContent,
  );
}

const first = archived("a", "Refactor the sidebar", 3, "/work/ohbaby-agent");
const second = archived("b", "Weekend plan", 72, null);
const third = archived("c", "Port the session tree", 200, "/work/pi-web");

describe("ArchivedSection", () => {
  it("lists rows with their workspace, or No workspace, and the archive age", async () => {
    const container = await mount(api([{ sessions: [first, second] }]));
    expect(rowTitles(container)).toEqual([
      "Refactor the sidebar",
      "Weekend plan",
    ]);
    const descriptions = [
      ...container.querySelectorAll(".ohb-settings-row-description"),
    ].map((description) => description.textContent);
    expect(descriptions).toEqual([
      "ohbaby-agent · Archived 3h ago",
      "No workspace · Archived 3d ago",
    ]);
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(
      first.updatedAt,
    );
  });

  it("shows the empty state", async () => {
    const container = await mount(api([{ sessions: [] }]));
    expect(container.textContent).toContain("No archived chats");
  });

  it("shows Loading… only after 300ms", async () => {
    vi.useFakeTimers();
    const container = await mount(
      api([], {
        listArchivedSessions: () => new Promise<never>(() => undefined),
      }),
    );
    expect(container.textContent).not.toContain("Loading…");
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Loading…");
  });

  it("retries a failed read", async () => {
    const list = pager([{ sessions: [first] }]);
    list.mockRejectedValueOnce(new Error("offline"));
    const container = await mount(api([], { listArchivedSessions: list }));
    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "Couldn't load archived chats.",
    );
    await click(button("Retry"));
    expect(rowTitles(container)).toEqual(["Refactor the sidebar"]);
  });

  it("loads the next page with Show more", async () => {
    const list = pager([
      { sessions: [first], nextCursor: "1" },
      { sessions: [second] },
    ]);
    const container = await mount(api([], { listArchivedSessions: list }));
    await click(button("Show more"));
    expect(list).toHaveBeenLastCalledWith("1");
    expect(rowTitles(container)).toEqual([
      "Refactor the sidebar",
      "Weekend plan",
    ]);
    expect(container.textContent).not.toContain("Show more");
  });

  it("restores a row and moves focus to the next one", async () => {
    const archive = api([{ sessions: [first, second] }]);
    const container = await mount(archive);
    await click(button("Restore “Refactor the sidebar”"));
    expect(archive.unarchiveSession).toHaveBeenCalledWith("a");
    expect(rowTitles(container)).toEqual(["Weekend plan"]);
    expect(document.activeElement).toBe(button("Restore “Weekend plan”"));
    expect(container.querySelector("[role='status']")?.textContent).toBe(
      "Restored “Refactor the sidebar”.",
    );
  });

  it("keeps the row and shows why when Restore fails", async () => {
    const container = await mount(
      api([{ sessions: [first] }], {
        unarchiveSession: () => Promise.reject(new Error("disk full")),
      }),
    );
    await click(button("Restore “Refactor the sidebar”"));
    expect(rowTitles(container)).toEqual(["Refactor the sidebar"]);
    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "Couldn't restore. disk full",
    );
  });

  it("drops a row restored elsewhere instead of showing an error", async () => {
    const container = await mount(
      api([{ sessions: [first, second] }], {
        unarchiveSession: () =>
          Promise.reject(rejectWith("SESSION_NOT_ARCHIVED", 409)),
      }),
    );
    await click(button("Restore “Refactor the sidebar”"));
    expect(rowTitles(container)).toEqual(["Weekend plan"]);
    expect(container.querySelector("[role='alert']")).toBeNull();
  });

  it("asks before deleting, with focus on Cancel, then removes the row", async () => {
    const archive = api([{ sessions: [first, second, third] }]);
    const container = await mount(archive);
    await click(button("Delete “Weekend plan”"));
    const dialog = document.querySelector("[role='alertdialog']");
    expect(dialog?.textContent).toContain("Delete this chat permanently?");
    expect(dialog?.textContent).toContain(
      "“Weekend plan” and its history will be removed. This can’t be undone.",
    );
    expect(document.activeElement).toBe(button("Cancel"));
    expect(archive.deleteSession).not.toHaveBeenCalled();
    await click(button("Delete"));
    expect(archive.deleteSession).toHaveBeenCalledWith("b");
    expect(document.querySelector("[role='alertdialog']")).toBeNull();
    expect(rowTitles(container)).toEqual([
      "Refactor the sidebar",
      "Port the session tree",
    ]);
    expect(document.activeElement).toBe(
      button("Restore “Port the session tree”"),
    );
  });

  it("keeps the dialog and the row when Delete fails", async () => {
    const container = await mount(
      api([{ sessions: [first] }], {
        deleteSession: () => Promise.reject(new Error("locked")),
      }),
    );
    await click(button("Delete “Refactor the sidebar”"));
    await click(button("Delete"));
    expect(
      document.querySelector(".ohb-confirm-dialog [role='alert']")?.textContent,
    ).toBe("locked");
    expect(rowTitles(container)).toEqual(["Refactor the sidebar"]);
    await click(button("Cancel"));
    expect(document.querySelector("[role='alertdialog']")).toBeNull();
  });

  it("focuses the section when the last row leaves", async () => {
    const container = await mount(api([{ sessions: [first] }]));
    await click(button("Restore “Refactor the sidebar”"));
    expect(document.activeElement).toBe(
      container.querySelector("section.ohb-archived"),
    );
    expect(container.textContent).toContain("No archived chats");
  });
});

// @vitest-environment jsdom
import type { UiGlobalSession } from "ohbaby-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceScopeSummary } from "../../api/daemon/wire.js";
import {
  createGlobalCatalogStore,
  type GlobalCatalogSnapshot,
} from "../../store/global-catalog.js";
import type {
  SessionActivity,
  SidebarSessionItem,
} from "../../store/sidebar-groups.js";
import { Sidebar, type SidebarProps } from "./Sidebar.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let serverUrl = "";
const select = vi.fn<(session: SidebarSessionItem) => void>();
const archive = vi.fn<(session: SidebarSessionItem) => Promise<boolean>>();
const exportSession = vi.fn();
const newChat = vi.fn<(directory: string | null) => void>();
const loadMore =
  vi.fn<
    (enough: (sessions: readonly UiGlobalSession[]) => boolean) => Promise<void>
  >();

function row(
  id: string,
  projectDirectory: string | null,
  updatedAt: string,
): UiGlobalSession {
  return {
    id,
    title: `Chat ${id}`,
    status: "active",
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    projectDirectory,
    workingDirectory: projectDirectory ?? "/default",
  };
}
const scope = (directory: string): WorkspaceScopeSummary => ({
  available: true,
  directory,
  lastOpenedAt: 0,
  loaded: false,
  position: 0,
});
const entries = ["A", "B", "C"].map((id, index) =>
  row(id, "/repo", `2026-09-0${String(3 - index)}T00:00:00Z`),
);

function catalog(
  sessions: readonly UiGlobalSession[] = entries,
  options: {
    readonly nextCursor?: string;
    readonly projects?: readonly WorkspaceScopeSummary[];
    readonly status?: "loading" | "ready" | "error";
  } = {},
): GlobalCatalogSnapshot {
  const store = createGlobalCatalogStore();
  store.setProjects(options.projects ?? [scope("/repo")], "/default");
  store.replaceSessions(sessions, options.nextCursor);
  if (options.status === "error") store.failSessions("offline");
  const snapshot = store.getSnapshot();
  return options.status === "loading"
    ? { ...snapshot, sessionsStatus: "loading" }
    : snapshot;
}

function render(overrides: Partial<SidebarProps> = {}): void {
  act(() => {
    root.render(
      <Sidebar
        serverUrl={serverUrl}
        catalog={catalog()}
        activeSessionId={null}
        activity={new Map<string, SessionActivity>()}
        disabled={false}
        onCollapse={() => undefined}
        onNewChat={newChat}
        onSelectSession={select}
        onArchiveSession={archive}
        onExportSession={exportSession}
        onHideProject={() => undefined}
        onOpenFolder={() => undefined}
        onRetry={() => undefined}
        onLoadMore={loadMore}
        {...overrides}
      />,
    );
  });
}
function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (element) =>
      element.getAttribute("aria-label") === label ||
      element.textContent === label,
  );
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}
function click(label: string): void {
  act(() => {
    button(label).click();
  });
}
function order(): string[] {
  return Array.from(container.querySelectorAll(".ohb-session-title")).map(
    (element) => element.textContent,
  );
}
function pin(id: string): void {
  click(`Actions for Chat ${id}`);
  click("Pin");
}

beforeEach(() => {
  serverUrl = `http://localhost:${String(4000 + Math.floor(Math.random() * 1000))}`;
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length(): number {
      return values.size;
    },
  });
  select.mockReset();
  archive.mockReset().mockResolvedValue(true);
  exportSession.mockReset();
  newChat.mockReset();
  loadMore.mockReset().mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  render();
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

it("moves pinned chats into Pinned, latest pin first, through the menu and the context menu", () => {
  pin("B");
  pin("C");
  expect(order()).toEqual(["Chat C", "Chat B", "Chat A"]);
  const pinnedRow = button("Unpin Chat B").closest(".ohb-session-row");
  if (!pinnedRow) throw new Error("Missing row");
  act(() => {
    pinnedRow.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 70,
      }),
    );
  });
  expect(button("Unpin")).toBe(document.activeElement);
  click("Unpin");
  expect(order()).toEqual(["Chat C", "Chat A", "Chat B"]);
  click("Unpin Chat C");
  expect(order()).toEqual(["Chat A", "Chat B", "Chat C"]);
  expect(select).not.toHaveBeenCalled();
});

it("keeps pins across projects and remounts with one global set", () => {
  pin("B");
  render({
    catalog: catalog([...entries, row("D", "/other", "2026-09-04T00:00:00Z")], {
      projects: [scope("/repo"), scope("/other")],
    }),
  });
  pin("D");
  act(() => {
    root.unmount();
  });
  root = createRoot(container);
  render({
    catalog: catalog([...entries, row("D", "/other", "2026-09-04T00:00:00Z")], {
      projects: [scope("/repo"), scope("/other")],
    }),
  });
  expect(order().slice(0, 2)).toEqual(["Chat D", "Chat B"]);
});

it.each(["HTML", "JSONL"])(
  "exports %s from the target row without selecting it",
  (format) => {
    click("Actions for Chat B");
    const trigger = button("Actions for Chat B");
    click("Export…");
    click(format);
    expect(exportSession).toHaveBeenCalledOnce();
    expect(exportSession.mock.calls[0]?.[0]).toMatchObject({ id: "B" });
    expect(exportSession.mock.calls[0]?.[1]).toBe(format.toLowerCase());
    expect(select).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  },
);

it("switches to the export list in place and goes back one level per Escape", () => {
  click("Actions for Chat B");
  const press = (key: string): void => {
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
    });
  };
  press("ArrowDown");
  expect(document.activeElement).toBe(button("Export…"));
  press("ArrowRight");
  expect(document.activeElement).toBe(button("Export"));
  press("Escape");
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
  expect(document.activeElement).toBe(button("Export…"));
  press("Escape");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(button("Actions for Chat B"));
  expect(exportSession).not.toHaveBeenCalled();
});

it("restores menu focus on Escape and supports keyboard context opening", () => {
  const trigger = button("Actions for Chat B");
  act(() => {
    trigger.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
      }),
    );
  });
  expect(button("Pin")).toBe(document.activeElement);
  act(() => {
    button("Pin").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("keeps a pin when archiving fails and clears it only after success", async () => {
  pin("B");
  archive.mockResolvedValueOnce(false);
  click("Actions for Chat B");
  await act(async () => {
    button("Archive").click();
    await Promise.resolve();
  });
  expect(button("Unpin Chat B")).toBeTruthy();
  await act(async () => {
    button("Archive Chat B").click();
    await Promise.resolve();
  });
  expect(order()).toEqual(["Chat A", "Chat B", "Chat C"]);
  expect(archive).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "B", requestDirectory: "/repo" }),
  );
  expect(select).not.toHaveBeenCalled();
});

it("moves focus to the next row once an archived row leaves the list", async () => {
  await act(async () => {
    button("Archive Chat B").click();
    await Promise.resolve();
  });
  render({ catalog: catalog(entries.filter((entry) => entry.id !== "B")) });
  expect(document.activeElement).toBe(button("Select Chat C"));
});

it("closes stale menus when the target disappears or the list order changes", () => {
  click("Actions for Chat B");
  render({ catalog: catalog([]) });
  render();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  click("Actions for Chat B");
  // The server lists the newly updated C first.
  const [first, second, third] = entries;
  render({
    catalog: catalog([
      { ...third, updatedAt: "2026-10-01T00:00:00Z" },
      first,
      second,
    ]),
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("groups by project with No project last and starts new chats with or without a project", () => {
  render({
    catalog: catalog(
      [
        row("P", "/repo", "2026-09-05T00:00:00Z"),
        row("N", null, "2026-09-06T00:00:00Z"),
      ],
      { projects: [scope("/repo"), scope("/empty")] },
    ),
  });
  const headings = Array.from(
    container.querySelectorAll(
      ".ohb-project-name, .ohb-sidebar-section-toggle > span:first-child",
    ),
  ).map((element) => element.textContent);
  expect(headings).toEqual(["repo", "empty", "No project"]);
  click("New chat");
  click("New chat in repo");
  expect(newChat.mock.calls).toEqual([[null], ["/repo"]]);
});

it("shows six rows, then pages the global list until the group has twenty more", async () => {
  const many = Array.from({ length: 10 }, (_, index) =>
    row(
      `R${String(index)}`,
      "/repo",
      `2026-09-${String(20 - index)}T00:00:00Z`,
    ),
  );
  render({ catalog: catalog(many, { nextCursor: "next" }) });
  expect(order()).toHaveLength(6);
  expect(button("Show more · 4")).toBeTruthy();

  await act(async () => {
    button("Show more · 4").click();
    await Promise.resolve();
  });

  expect(order()).toHaveLength(10);
  expect(loadMore).toHaveBeenCalledOnce();
  const [[enough]] = loadMore.mock.calls;
  expect(enough(many)).toBe(false);
  const more = Array.from({ length: 16 }, (_, index) =>
    row(`S${String(index)}`, "/repo", "2026-08-01T00:00:00Z"),
  );
  expect(enough([...many, ...more])).toBe(true);
  expect(button("Show less")).toBeTruthy();
  click("Show less");
  expect(order()).toHaveLength(6);
});

it("does not page when the loaded rows already fill the next step", () => {
  const many = Array.from({ length: 30 }, (_, index) =>
    row(
      `R${String(index)}`,
      "/repo",
      `2026-09-01T00:00:${String(index).padStart(2, "0")}Z`,
    ),
  );
  render({ catalog: catalog(many, { nextCursor: "next" }) });
  click("Show more · 24");
  expect(order()).toHaveLength(26);
  expect(loadMore).not.toHaveBeenCalled();
});

it("remembers folded groups and shows their loaded count", () => {
  click("repo");
  expect(order()).toEqual([]);
  expect(container.querySelector(".ohb-group-count")?.textContent).toBe("3");
  act(() => {
    root.unmount();
  });
  root = createRoot(container);
  render();
  expect(order()).toEqual([]);
});

it("ends rows with a relative time, a spinner or an amber dot", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-03T03:00:00Z"));
  act(() => {
    root.unmount();
  });
  root = createRoot(container);
  render({
    activity: new Map<string, SessionActivity>([
      ["B", "running"],
      ["C", "awaiting"],
    ]),
  });
  vi.useRealTimers();
  const meta = Array.from(container.querySelectorAll(".ohb-session-meta"));
  expect(meta[0]?.textContent).toBe("3h");
  expect(meta[1]?.querySelector('[aria-label="Running"]')).not.toBeNull();
  expect(
    meta[2]?.querySelector('[aria-label="Waiting for approval"]'),
  ).not.toBeNull();
});

it("shows an error with Retry only while there is no data", () => {
  const retry = vi.fn();
  render({ catalog: catalog([], { status: "error" }), onRetry: retry });
  click("Retry");
  expect(retry).toHaveBeenCalledOnce();
  render({ catalog: catalog(entries, { status: "error" }) });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(order()).toHaveLength(3);
});

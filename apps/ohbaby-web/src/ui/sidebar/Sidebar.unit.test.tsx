// @vitest-environment jsdom
import type { UiGlobalSession } from "ohbaby-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { WorkspaceScopeSummary } from "../../api/daemon/wire.js";
import {
  createGlobalCatalogStore,
  type GlobalCatalogSnapshot,
} from "../../store/global-catalog.js";
import type {
  SessionActivity,
  SidebarSessionItem,
} from "../../store/sidebar-groups.js";
import { globalSessionSeenKey } from "./session-seen.js";
import { Sidebar, type SidebarProps } from "./Sidebar.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let serverUrl = "";
const select = vi.fn<(session: SidebarSessionItem) => void>();
const archive = vi.fn<(session: SidebarSessionItem) => Promise<boolean>>();
const rename = vi.fn<(session: SidebarSessionItem, title: string) => void>();
const exportSession = vi.fn();
const newChat = vi.fn<(directory: string | null) => void>();
const loadMore =
  vi.fn<
    (enough: (sessions: readonly UiGlobalSession[]) => boolean) => Promise<void>
  >();

function row(
  id: string,
  workspaceDirectory: string | null,
  updatedAt: string,
): UiGlobalSession {
  return {
    id,
    title: `Chat ${id}`,
    status: "active",
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    workspaceDirectory,
    workingDirectory: workspaceDirectory ?? "/default",
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
    readonly workspaces?: readonly WorkspaceScopeSummary[];
    readonly status?: "loading" | "ready" | "error";
  } = {},
): GlobalCatalogSnapshot {
  const store = createGlobalCatalogStore();
  store.setWorkspaces(options.workspaces ?? [scope("/repo")], "/default");
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
        searchOpen={false}
        onSearchOpenChange={() => undefined}
        searchSessions={() => Promise.resolve({ results: [] })}
        catalog={catalog()}
        activeSessionId={null}
        activity={new Map<string, SessionActivity>()}
        disabled={false}
        onCollapse={() => undefined}
        onNewChat={newChat}
        onSelectSession={select}
        onArchiveSession={archive}
        onRenameSession={rename}
        onForkSession={() => undefined}
        onExportSession={exportSession}
        onMoveSession={() => Promise.resolve(true)}
        onHideWorkspace={() => undefined}
        onOpenFolder={() => undefined}
        onRetry={() => undefined}
        onOpenSettings={() => undefined}
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
  return Array.from(
    container.querySelectorAll(
      "section:not(.ohb-sidebar-recents) .ohb-session-title",
    ),
  ).map((element) => element.textContent);
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
  rename.mockReset();
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
  // The pin sits after the title, among the hover actions, and only on pinned rows.
  expect(
    pinnedRow.querySelector(".ohb-session-hover-actions .ohb-session-pin"),
  ).toBeTruthy();
  expect(
    container.querySelectorAll(
      ".ohb-session-row:not(.is-pinned) .ohb-session-pin",
    ),
  ).toHaveLength(0);
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
  // A real click focuses the pin before it unpins.
  button("Unpin Chat C").focus();
  click("Unpin Chat C");
  expect(order()).toEqual(["Chat A", "Chat B", "Chat C"]);
  // Focus follows the chat back to its workspace.
  expect(
    document.activeElement
      ?.closest("[data-session-id]")
      ?.getAttribute("data-session-id"),
  ).toBe("C");
  expect(select).not.toHaveBeenCalled();
});

it("keeps pins across workspaces and remounts with one global set", () => {
  pin("B");
  render({
    catalog: catalog([...entries, row("D", "/other", "2026-09-04T00:00:00Z")], {
      workspaces: [scope("/repo"), scope("/other")],
    }),
  });
  pin("D");
  act(() => {
    root.unmount();
  });
  root = createRoot(container);
  render({
    catalog: catalog([...entries, row("D", "/other", "2026-09-04T00:00:00Z")], {
      workspaces: [scope("/repo"), scope("/other")],
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
  expect(document.activeElement).toBe(button("Rename"));
  press("ArrowDown");
  expect(document.activeElement).toBe(button("Move to workspace…"));
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
  click("Actions for Chat B");
  await act(async () => {
    button("Archive").click();
    await Promise.resolve();
  });
  expect(order()).toEqual(["Chat A", "Chat B", "Chat C"]);
  expect(archive).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: "B", requestDirectory: "/repo" }),
  );
  expect(select).not.toHaveBeenCalled();
});

it("moves focus to the next row once an archived row leaves the list", async () => {
  act(() => {
    button("Select Chat B").dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 70,
      }),
    );
  });
  await act(async () => {
    button("Archive").click();
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

it("groups by workspace with Recents last and starts new chats with or without a workspace", () => {
  render({
    catalog: catalog(
      [
        row("P", "/repo", "2026-09-05T00:00:00Z"),
        row("N", null, "2026-09-06T00:00:00Z"),
      ],
      { workspaces: [scope("/repo"), scope("/empty")] },
    ),
  });
  const headings = Array.from(
    container.querySelectorAll(
      ".ohb-workspace-name, .ohb-sidebar-section-toggle > span:first-child",
    ),
  ).map((element) => element.textContent);
  expect(headings).toEqual(["Workspaces", "repo", "empty", "Recents"]);
  expect(
    Array.from(container.querySelectorAll(".ohb-sidebar-empty")).map(
      (element) => element.textContent,
    ),
  ).toEqual(["No chats"]);
  const recents = container.querySelector('section[aria-label="Recents"]');
  expect(
    recents?.querySelector(".ohb-sidebar-section-title")?.textContent,
  ).toBe("Recents");
  expect(recents?.textContent).toContain("Chat N");
  expect(recents?.textContent).toContain("Chat P");
  // Every section folds from its heading, and the choice is remembered.
  const fold = (title: string): void => {
    const toggle = Array.from(
      container.querySelectorAll<HTMLElement>(".ohb-sidebar-section-toggle"),
    ).find((element) => element.textContent === title);
    if (!toggle) throw new Error(`Missing ${title} toggle`);
    act(() => {
      toggle.click();
    });
  };
  fold("Recents");
  expect(
    container.querySelector('section[aria-label="Recents"]')?.textContent,
  ).toBe("Recents");
  fold("Workspaces");
  expect(container.querySelector(".ohb-workspace-name")).toBeNull();
  expect(
    JSON.parse(localStorage.getItem("ohbaby.web.sidebar.collapsed.v2") ?? "[]"),
  ).toEqual(["recents", "workspaces"]);
  fold("Recents");
  fold("Workspaces");
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

it("remembers folded groups and shows no counts", () => {
  click("repo");
  expect(order()).toEqual([]);
  expect(container.querySelector(".ohb-group-count")).toBeNull();
  expect(container.querySelector(".ohb-workspace-toggle")?.textContent).toBe(
    "repo",
  );
  act(() => {
    root.unmount();
  });
  root = createRoot(container);
  render();
  expect(order()).toEqual([]);
});

it("marks running and awaiting rows left of the title and shows no time", () => {
  render({
    activity: new Map<string, SessionActivity>([
      ["B", "running"],
      ["C", "awaiting"],
    ]),
  });
  // The row end is empty room for the hover buttons: no time, no dot.
  const meta = Array.from(container.querySelectorAll(".ohb-session-meta"));
  expect(meta.length).toBeGreaterThan(0);
  for (const end of meta) expect(end.childNodes).toHaveLength(0);
  // B is listed under its workspace and again in Recents.
  const running = Array.from(
    container.querySelectorAll('.ohb-session-lead[aria-label="Running"]'),
  );
  expect(running).toHaveLength(2);
  for (const lead of running) {
    expect(
      lead.closest(".ohb-session-row")?.getAttribute("data-session-id"),
    ).toBe("B");
    expect(lead.querySelectorAll(".ohb-activity-mark i")).toHaveLength(4);
  }
  const awaiting = Array.from(
    container.querySelectorAll(
      '.ohb-session-lead[aria-label="Waiting for approval"]',
    ),
  );
  expect(awaiting.length).toBeGreaterThan(0);
  for (const lead of awaiting) {
    expect(
      lead.closest(".ohb-session-row")?.getAttribute("data-session-id"),
    ).toBe("C");
    expect(lead.getAttribute("role")).toBe("status");
    expect(lead.querySelector(".ohb-session-awaiting")).not.toBeNull();
  }
});

it("shows a blue dot for a reply not yet seen, never on the open chat", () => {
  serverUrl = "http://unread.test";
  window.localStorage.setItem(
    globalSessionSeenKey(serverUrl),
    JSON.stringify({ since: 0, seen: {} }),
  );
  const ended = "2026-09-05T00:00:00.000Z";
  const sessions = entries.map((entry) => ({
    ...entry,
    lastTurnEndedAt: ended,
  }));
  const leads = (id: string): Element[] =>
    Array.from(
      container.querySelectorAll(`[data-session-id="${id}"] .ohb-session-lead`),
    );
  render({
    catalog: catalog(sessions),
    activeSessionId: "B",
    activity: new Map<string, SessionActivity>([["C", "awaiting"]]),
  });
  // A is listed under its workspace and again in Recents.
  expect(leads("A")).toHaveLength(2);
  for (const lead of leads("A")) {
    expect(lead.getAttribute("role")).toBe("status");
    expect(lead.getAttribute("aria-label")).toBe("New reply");
    expect(lead.querySelector(".ohb-session-unread")).not.toBeNull();
  }
  // The open chat records its reply as seen; approval wins over unread.
  expect(leads("B")).toHaveLength(0);
  for (const lead of leads("C"))
    expect(lead.getAttribute("aria-label")).toBe("Waiting for approval");
  const stored = (): Record<string, number> =>
    (
      JSON.parse(
        window.localStorage.getItem(globalSessionSeenKey(serverUrl)) ?? "",
      ) as { seen: Record<string, number> }
    ).seen;
  expect(stored()).toEqual({ B: Date.parse(ended) });
  // An unread chat can still be archived.
  click("Actions for Chat A");
  expect(button("Archive").disabled).toBe(false);
  act(() => {
    document
      .querySelector(".ohb-session-menu")
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
  });
  // Opening A clears its dot, and it stays clear after moving on.
  render({ catalog: catalog(sessions), activeSessionId: "A" });
  expect(leads("A")).toHaveLength(0);
  render({ catalog: catalog(sessions), activeSessionId: "C" });
  expect(leads("A")).toHaveLength(0);
  expect(leads("B")).toHaveLength(0);
  expect(stored()).toEqual({
    A: Date.parse(ended),
    B: Date.parse(ended),
    C: Date.parse(ended),
  });
});

it("records the open chat's own reply time, only while the page is visible", () => {
  serverUrl = "http://unread-visible.test";
  window.localStorage.setItem(
    globalSessionSeenKey(serverUrl),
    JSON.stringify({ since: 0, seen: {} }),
  );
  const stored = (): Record<string, number> =>
    (
      JSON.parse(
        window.localStorage.getItem(globalSessionSeenKey(serverUrl)) ?? "",
      ) as { seen: Record<string, number> }
    ).seen;
  const listed = Date.parse("2026-09-05T00:00:00.000Z");
  const sessions = entries.map((entry) => ({
    ...entry,
    lastTurnEndedAt: new Date(listed).toISOString(),
  }));
  let visibility: DocumentVisibilityState = "hidden";
  const spy = vi
    .spyOn(document, "visibilityState", "get")
    .mockImplementation(() => visibility);
  onTestFinished(() => {
    spy.mockRestore();
  });
  // A background tab records nothing, so other tabs keep their dots.
  render({
    catalog: catalog(sessions),
    activeSessionId: "B",
    activeTurnEndedAt: listed + 5_000,
  });
  expect(stored()).toEqual({});
  // Once shown, the later of the listed and the chat's own time is recorded,
  // so a reply that ended before the list was re-read stays seen.
  visibility = "visible";
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(stored()).toEqual({ B: listed + 5_000 });
  // A later reply while the chat stays open is recorded too.
  render({
    catalog: catalog(sessions),
    activeSessionId: "B",
    activeTurnEndedAt: listed + 9_000,
  });
  expect(stored()).toEqual({ B: listed + 9_000 });
  render({ catalog: catalog(sessions), activeSessionId: "C" });
  expect(
    container.querySelectorAll('[data-session-id="B"] .ohb-session-unread'),
  ).toHaveLength(0);
});

it("keeps Archive unavailable while a chat runs or awaits approval", () => {
  render({
    activity: new Map<string, SessionActivity>([
      ["A", "running"],
      ["B", "awaiting"],
    ]),
  });
  for (const id of ["A", "B"]) {
    click(`Actions for Chat ${id}`);
    const item = button("ArchiveRunning");
    expect(item.disabled).toBe(true);
    expect(item.title).toBe("Stop the chat before archiving");
    act(() => {
      document
        .querySelector(".ohb-session-menu")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "a", bubbles: true }),
        );
    });
    expect(archive).not.toHaveBeenCalled();
    act(() => {
      document
        .querySelector(".ohb-session-menu")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
    });
  }
  click("Actions for Chat C");
  const idle = button("Archive");
  expect(idle.disabled).toBe(false);
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

it("moves a running chat only after confirmation and shows a pending spinner", async () => {
  let finish!: (value: boolean) => void;
  const move = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  render({
    catalog: catalog(entries, {
      workspaces: [scope("/repo"), scope("/other")],
    }),
    activity: new Map([["A", "running"]]),
    onMoveSession: move,
  });
  click("Actions for Chat A");
  click("Move to workspace…");
  expect(button("repo(current)").disabled).toBe(true);
  act(() => {
    const destination = document.querySelector<HTMLButtonElement>(
      '[role="menuitem"][title="/other"]',
    );
    if (!destination) throw new Error("Missing destination workspace");
    destination.click();
  });
  expect(move).toHaveBeenCalledWith(
    expect.objectContaining({ id: "A" }),
    "/other",
  );
  expect(order()).toEqual(["Chat A", "Chat B", "Chat C"]);
  expect(container.querySelector('[aria-label="Moving chat"]')).not.toBeNull();
  await act(async () => {
    finish(false);
    await Promise.resolve();
  });
  expect(order()).toEqual(["Chat A", "Chat B", "Chat C"]);
  expect(container.querySelector('[aria-label="Moving chat"]')).toBeNull();
});

it("filters a long workspace list, unwinds Escape one level at a time and restores focus", () => {
  render({
    catalog: catalog(entries, {
      workspaces: [
        scope("/repo"),
        ...Array.from({ length: 9 }, (_, i) =>
          scope(`/workspace-${String(i)}`),
        ),
      ],
    }),
  });
  click("Actions for Chat A");
  click("Move to workspace…");
  const filter = document.querySelector<HTMLInputElement>(
    '[aria-label="Filter"]',
  );
  if (!filter) throw new Error("Missing workspace filter");
  expect(document.activeElement).toBe(filter);
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    );
    if (!descriptor?.set) throw new Error("Missing input value setter");
    descriptor.set.call(filter, "workspace-8");
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(
    document.querySelector<HTMLButtonElement>(
      '[role="menuitem"][title="/workspace-0"]',
    )?.hidden,
  ).toBe(true);
  const escape = (): void => {
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
  };
  escape();
  expect(filter.value).toBe("");
  escape();
  expect(document.activeElement).toBe(button("Move to workspace…"));
  escape();
  expect(document.activeElement).toBe(button("Actions for Chat A"));
});

it("offers Remove from workspace only to a chat with a workspace", () => {
  render({ catalog: catalog([row("N", null, "2026-09-01T00:00:00Z")]) });
  click("Actions for Chat N");
  click("Move to workspace…");
  expect(document.body.textContent).not.toContain("Remove from workspace");
});

it("keeps workspace chats in Recents, leaves pinned chats to Pinned and pages the rest", async () => {
  const recentRows = Array.from({ length: 10 }, (_, index) =>
    row(
      `R${String(index)}`,
      index % 2 ? null : "/repo",
      `2026-09-${String(20 - index)}T00:00:00Z`,
    ),
  );
  render({ catalog: catalog(recentRows, { nextCursor: "next" }) });
  const sectionIds = (title: string): (string | null)[] => {
    const section = container.querySelector<HTMLElement>(
      `section[aria-label="${title}"]`,
    );
    if (!section) throw new Error(`Missing ${title}`);
    return Array.from(section.querySelectorAll("[data-session-id]")).map(
      (element) => element.getAttribute("data-session-id"),
    );
  };
  expect(sectionIds("Recents")).toEqual(["R0", "R1", "R2", "R3", "R4", "R5"]);
  pin("R0");
  expect(sectionIds("Pinned")).toEqual(["R0"]);
  expect(sectionIds("Recents")).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]);
  expect(sectionIds("Workspaces")).not.toContain("R0");
  render({
    catalog: catalog(
      recentRows.map((item) =>
        item.id === "R2" ? { ...item, workspaceDirectory: null } : item,
      ),
      { nextCursor: "next" },
    ),
  });
  expect(sectionIds("Recents")).toContain("R2");
  await act(async () => {
    const recents = container.querySelector('section[aria-label="Recents"]');
    const more = Array.from(recents?.querySelectorAll("button") ?? []).find(
      (element) => element.textContent === "Show more · 3",
    );
    if (!more) throw new Error("Missing Recents Show more");
    more.click();
    await Promise.resolve();
  });
  expect(sectionIds("Recents")).toHaveLength(9);
  const [[enough]] = loadMore.mock.calls;
  expect(enough(recentRows)).toBe(false);
  // 6 + 20 unpinned rows: the pinned R0 does not count toward Recents.
  const extraRows = (count: number): UiGlobalSession[] =>
    Array.from({ length: count }, (_, index) =>
      row(`S${String(index)}`, "/repo", "2026-08-01T00:00:00Z"),
    );
  expect(enough([...recentRows, ...extraRows(16)])).toBe(false);
  expect(enough([...recentRows, ...extraRows(17)])).toBe(true);
});

it("moves focus with a chat pinned from Recents and unpinned again", () => {
  const recentIds = (): (string | null)[] =>
    Array.from(
      container.querySelectorAll(
        'section[aria-label="Recents"] [data-session-id]',
      ),
    ).map((element) => element.getAttribute("data-session-id"));
  const trigger = container.querySelector<HTMLButtonElement>(
    'section[aria-label="Recents"] [aria-label="Actions for Chat B"]',
  );
  if (!trigger) throw new Error("Missing Recents menu trigger");
  act(() => {
    trigger.click();
  });
  expect(document.activeElement).toBe(button("Pin"));
  click("Pin");
  expect(recentIds()).toEqual(["A", "C"]);
  const pinnedTrigger = container.querySelector<HTMLButtonElement>(
    'section[aria-label="Pinned"] [aria-label="Actions for Chat B"]',
  );
  expect(document.activeElement).toBe(pinnedTrigger);
  act(() => {
    pinnedTrigger?.click();
  });
  expect(document.activeElement).toBe(button("Unpin"));
  click("Unpin");
  expect(recentIds()).toEqual(["A", "B", "C"]);
  expect(container.querySelector('section[aria-label="Pinned"]')).toBeNull();
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Actions for Chat B",
  );
});

function renameInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(".ohb-session-rename");
}
function keyInRename(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    renameInput()?.dispatchEvent(event);
  });
  return event;
}
function typeTitle(value: string): void {
  const input = renameInput();
  if (!input) throw new Error("Not renaming");
  input.value = value;
}
function doubleClick(label: string): void {
  act(() => {
    button(label).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
}
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

it("renames in place from the menu and with a double click; Enter saves and Escape cancels", () => {
  click("Actions for Chat B");
  const item = button("Rename");
  expect(item.dataset.menuShortcut).toBe("r");
  expect(item.previousElementSibling?.textContent).toBe("Pin");
  act(() => {
    item.click();
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  const input = renameInput();
  expect(document.activeElement).toBe(input);
  expect(input?.getAttribute("aria-label")).toBe("Rename chat");
  expect([input?.selectionStart, input?.selectionEnd]).toEqual([0, 6]);
  const row = input?.closest(".ohb-session-row");
  expect(row?.querySelector(".ohb-session-hover-actions")).toBeNull();

  typeTitle("  New \n  name ");
  const enter = keyInRename({ key: "Enter" });
  expect(enter.defaultPrevented).toBe(true);
  expect(renameInput()).toBeNull();
  expect(rename.mock.calls).toEqual([
    [
      expect.objectContaining({ id: "B", requestDirectory: "/repo" }),
      "New name",
    ],
  ]);
  expect(document.activeElement).toBe(row?.querySelector(".ohb-session-main"));

  doubleClick("Select Chat C");
  typeTitle("Something else");
  keyInRename({ key: "Escape" });
  expect(renameInput()).toBeNull();
  expect(document.activeElement).toBe(button("Select Chat C"));

  // Blank or unchanged titles end the edit without a request.
  for (const value of ["   ", "Chat C", " Chat  C "]) {
    doubleClick("Select Chat C");
    typeTitle(value);
    keyInRename({ key: "Enter" });
    expect(renameInput()).toBeNull();
  }
  expect(rename).toHaveBeenCalledTimes(1);
});

it("keeps composing text, leaves the row menu to the browser and ends without a request when disabled", () => {
  doubleClick("Select Chat B");
  typeTitle("拼音");
  keyInRename({ key: "Enter", isComposing: true });
  expect(renameInput()).not.toBeNull();
  keyInRename({ key: "Escape", isComposing: true });
  expect(renameInput()).not.toBeNull();

  keyInRename({ key: "F10", shiftKey: true });
  const contextMenu = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    renameInput()?.dispatchEvent(contextMenu);
  });
  expect(contextMenu.defaultPrevented).toBe(false);
  expect(document.querySelector('[role="menu"]')).toBeNull();

  render({ disabled: true });
  expect(renameInput()).toBeNull();
  render();
  expect(renameInput()).toBeNull();
  expect(rename).not.toHaveBeenCalled();
});

it("saves when the user goes elsewhere, not when the list reorders or the window loses focus", async () => {
  // jsdom reports no focus once nothing is focused; a real window keeps it.
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  doubleClick("Select Chat B");
  typeTitle("Half typed");
  // The server lists the newly updated C first; the edit stays open.
  const [first, second, third] = entries;
  render({
    catalog: catalog([
      { ...third, updatedAt: "2026-10-01T00:00:00Z" },
      first,
      second,
    ]),
  });
  act(() => {
    renameInput()?.blur();
  });
  await nextFrame();
  expect(document.activeElement).toBe(renameInput());

  hasFocus.mockReturnValue(false);
  act(() => {
    renameInput()?.blur();
  });
  await nextFrame();
  expect(renameInput()).not.toBeNull();
  hasFocus.mockReturnValue(true);
  act(() => {
    renameInput()?.focus();
  });
  expect(rename).not.toHaveBeenCalled();

  const target = button("Select Chat A");
  act(() => {
    target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    target.focus();
  });
  await nextFrame();
  expect(renameInput()).toBeNull();
  expect(rename.mock.calls).toEqual([
    [expect.objectContaining({ id: "B" }), "Half typed"],
  ]);
  expect(document.activeElement).toBe(target);
});

it("forgets a press that did not leave the input and keeps an untouched title when the chat is renamed meanwhile", async () => {
  const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  doubleClick("Select Chat B");
  typeTitle("Half typed");
  // A press on the sidebar scrollbar does not blur the input.
  act(() => {
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  hasFocus.mockReturnValue(false);
  act(() => {
    renameInput()?.blur();
  });
  await nextFrame();
  expect(renameInput()).not.toBeNull();
  hasFocus.mockReturnValue(true);
  act(() => {
    renameInput()?.focus();
  });
  keyInRename({ key: "Escape" });

  // AI naming lands while the input still shows the old title.
  doubleClick("Select Chat C");
  const [first, second, third] = entries;
  render({
    catalog: catalog([first, second, { ...third, title: "AI title" }]),
  });
  keyInRename({ key: "Enter" });
  expect(renameInput()).toBeNull();
  expect(rename).not.toHaveBeenCalled();
});

it("saves a completed tap outside the input and forgets edits on rows that leave the list", () => {
  doubleClick("Select Chat B");
  typeTitle("From touch");
  // Touch can deliver its click well after pointerdown, with focus still in the input.
  act(() => {
    document.body.click();
  });
  expect(rename.mock.calls).toEqual([
    [expect.objectContaining({ id: "B" }), "From touch"],
  ]);
  expect(renameInput()).toBeNull();

  doubleClick("Select Chat C");
  render({ catalog: catalog(entries.filter((row) => row.id !== "C")) });
  render();
  expect(renameInput()).toBeNull();
  expect(rename).toHaveBeenCalledTimes(1);
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UiGlobalSession, UiSessionSearchPage } from "ohbaby-sdk";
import { SearchDialog, type SearchSelection } from "./SearchDialog.js";
import type { SessionSearch } from "./useSessionSearch.js";
import { highlightKeywords, relativeAge } from "./search-text.js";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
const search = vi.fn<SessionSearch>();
const select = vi.fn();
const close = vi.fn();

function session(
  id: string,
  extra: Partial<UiGlobalSession> = {},
): UiGlobalSession {
  return {
    id,
    title: id,
    status: "active",
    createdAt: "",
    updatedAt: "2026-11-26T08:00:00.000Z",
    messageCount: 1,
    workspaceDirectory: null,
    workingDirectory: "/",
    ...extra,
  };
}
// A body hit carries a message; a title hit does not.
function page(
  ids: readonly string[],
  options: { body?: boolean; nextCursor?: string } = {},
): UiSessionSearchPage {
  return {
    results: ids.map((id) => ({
      session: session(id),
      ...(options.body === false
        ? {}
        : {
            messageId: `${id}-m`,
            snippet: "<img src=x onerror=alert(1)> hello body",
          }),
    })),
    ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
  };
}
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Missing test value");
  return value;
}
const input = (): HTMLInputElement =>
  required(document.body.querySelector<HTMLInputElement>('[role="combobox"]'));
const options = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]'));

function render(recent: readonly UiGlobalSession[] = []): void {
  act(() => {
    root.render(
      <SearchDialog
        search={search}
        recent={recent}
        activeSessionId={null}
        onSelect={select}
        onClose={close}
      />,
    );
  });
}
function type(value: string): void {
  act(() => {
    const descriptor = required(
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"),
    );
    if (!descriptor.set) throw new Error("Missing native input setter");
    descriptor.set.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function key(name: string, init: KeyboardEventInit = {}): void {
  act(() => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, ...init }),
    );
  });
}
function selection(): { id: string; messageId: string | undefined } {
  const chosen = required(select.mock.lastCall)[0] as SearchSelection;
  return { id: chosen.session.id, messageId: chosen.messageId };
}
async function settle(ms = 250): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no layout, so scrolling is a no-op.
  Element.prototype.scrollIntoView = vi.fn();
  search.mockReset();
  select.mockReset();
  close.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.useRealTimers();
});

it("lists the latest ten active chats while the query is empty and focuses the input", () => {
  const recent = [
    session("archived", { status: "archived" }),
    ...Array.from({ length: 12 }, (_, i) => session(`chat-${String(i)}`)),
  ];
  render(recent);
  expect(document.activeElement).toBe(input());
  expect(document.body.textContent).toContain("Recent");
  expect(options()).toHaveLength(10);
  expect(options()[0]?.textContent).toContain("chat-0");
  expect(document.body.textContent).not.toContain("archived");
  expect(search).not.toHaveBeenCalled();
  key("Enter");
  expect(select).toHaveBeenCalledWith({ session: recent[1] });
});

it("debounces, sends the order, and never shows an earlier query's answer", async () => {
  let resolve!: (page: UiSessionSearchPage) => void;
  search
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce(page(["new"]));
  render();
  type("old");
  await settle(249);
  expect(search).not.toHaveBeenCalled();
  await settle(1);
  const first = required(search.mock.calls[0])[0];
  expect(first).toMatchObject({ query: "old", order: "desc" });
  type("new");
  expect(first.signal?.aborted).toBe(true);
  await settle();
  await act(async () => {
    resolve(page(["old"]));
    await Promise.resolve();
  });
  expect(options()).toHaveLength(1);
  expect(document.body.textContent).toContain("new");
  expect(document.body.textContent).not.toContain("old");
});

it("moves the selection with the arrow keys while focus stays in the input", async () => {
  search.mockResolvedValueOnce(page(["first", "second"]));
  render();
  type("hello");
  await settle();
  expect(options()[0]?.getAttribute("aria-selected")).toBe("true");
  expect(input().getAttribute("aria-activedescendant")).toBe(options()[0]?.id);
  key("ArrowDown");
  key("ArrowDown");
  expect(document.activeElement).toBe(input());
  expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
  expect(input().getAttribute("aria-activedescendant")).toBe(options()[1]?.id);
  key("Enter");
  expect(selection()).toEqual({ id: "second", messageId: "second-m" });
});

it("shows a snippet only for body hits and keeps it plain text", async () => {
  search.mockResolvedValueOnce({
    results: [
      ...page(["body"]).results,
      ...page(["title"], { body: false }).results,
    ],
  });
  render();
  type("hello");
  await settle();
  expect(document.body.querySelector("img")).toBeNull();
  const [body, title] = options();
  expect(body.querySelector(".ohb-search-row-snippet")?.textContent).toContain(
    "<img",
  );
  expect(title.querySelector(".ohb-search-row-snippet")).toBeNull();
  act(() => {
    title.click();
  });
  expect(selection()).toEqual({ id: "title", messageId: undefined });
});

it("toggles the order, starts over, and resets to newest when reopened", async () => {
  search.mockResolvedValue(page(["a"]));
  render();
  type("a");
  await settle();
  const order = (): HTMLButtonElement =>
    required(
      document.body.querySelector<HTMLButtonElement>(".ohb-search-order"),
    );
  expect(order().textContent).toBe("Newest");
  act(() => {
    order().click();
  });
  expect(order().textContent).toBe("Oldest");
  expect(options()).toHaveLength(0);
  await settle();
  expect(search.mock.calls.at(-1)?.[0]).toMatchObject({ order: "asc" });
  type("ab");
  await settle();
  expect(search.mock.calls.at(-1)?.[0]).toMatchObject({ order: "asc" });
  act(() => {
    root.render(null);
  });
  render();
  type("a");
  await settle();
  expect(search.mock.calls.at(-1)?.[0]).toMatchObject({ order: "desc" });
});

it("loads the next page when the sentinel shows and offers a retry when it fails", async () => {
  const observers: { callback: IntersectionObserverCallback }[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        observers.push({ callback });
      }
      observe = vi.fn();
      disconnect = vi.fn();
    },
  );
  search
    .mockResolvedValueOnce(page(["one"], { nextCursor: "next" }))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(page(["two", "one"]));
  render();
  type("hello");
  await settle();
  const show = async (): Promise<void> => {
    await act(async () => {
      required(observers.at(-1)).callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      await Promise.resolve();
    });
  };
  await show();
  expect(search.mock.calls[1]?.[0].cursor).toBe("next");
  expect(document.body.textContent).toContain("offline");
  act(() => {
    required(
      Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent === "Retry",
      ),
    ).click();
  });
  await settle(0);
  expect(search.mock.calls[2]?.[0].cursor).toBe("next");
  expect(options().map((row) => row.textContent.slice(0, 3))).toEqual([
    "one",
    "two",
  ]);
  vi.unstubAllGlobals();
});

it("closes on Escape and on the scrim, but leaves IME keys alone", async () => {
  search.mockResolvedValue(page(["hello"]));
  render();
  type("hello");
  await settle();
  key("Escape", { isComposing: true });
  key("Enter", { isComposing: true });
  key("ArrowDown", { isComposing: true });
  expect(close).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  key("Escape");
  expect(close).toHaveBeenCalledOnce();
  act(() => {
    required(document.body.querySelector(".ohb-search-layer")).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
  });
  expect(close).toHaveBeenCalledTimes(2);
});

it("returns focus to where the dialog was opened from", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  render();
  expect(document.activeElement).toBe(input());
  act(() => {
    root.render(null);
  });
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

it("aborts an in-flight request when the dialog closes", async () => {
  search.mockImplementation(() => new Promise(() => undefined));
  render();
  type("pending");
  await settle();
  const call = required(search.mock.calls[0]);
  act(() => {
    root.render(null);
  });
  expect(call[0].signal?.aborted).toBe(true);
});

it("highlights every keyword, folding ASCII case only", () => {
  const host = document.createElement("div");
  const view = createRoot(host);
  act(() => {
    view.render(
      <>
        {highlightKeywords(
          "Reconnect the 终端 after RECONNECT",
          "reconnect 终端",
        )}
      </>,
    );
  });
  expect(
    Array.from(host.querySelectorAll("mark"), (mark) => mark.textContent),
  ).toEqual(["Reconnect", "终端", "RECONNECT"]);
  act(() => {
    view.unmount();
  });
});

it("buckets ages by local calendar day", () => {
  const now = new Date(2026, 10, 26, 9);
  const daysAgo = (days: number): string =>
    new Date(2026, 10, 26 - days, 23).toISOString();
  expect(relativeAge(daysAgo(0), now)).toBe("Today");
  expect(relativeAge(daysAgo(1), now)).toBe("Yesterday");
  expect(relativeAge(daysAgo(5), now)).toBe("Past week");
  expect(relativeAge(daysAgo(20), now)).toBe("Past month");
  expect(relativeAge(new Date(2026, 8, 3).toISOString(), now)).toBe("Sep 2026");
  expect(relativeAge("not a date", now)).toBe("");
});

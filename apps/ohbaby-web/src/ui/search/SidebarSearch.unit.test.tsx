// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { UiSessionSearchPage } from "ohbaby-sdk";
import { SidebarSearch } from "./SidebarSearch.js";
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const search =
  vi.fn<
    (input: {
      query: string;
      cursor?: string;
      signal?: AbortSignal;
    }) => Promise<UiSessionSearchPage>
  >();
const select = vi.fn();
const close = vi.fn();
const page = (id: string, nextCursor?: string): UiSessionSearchPage => ({
  results: [
    {
      session: {
        id,
        title: id,
        status: "active",
        createdAt: "",
        updatedAt: "",
        messageCount: 1,
        projectDirectory: null,
        workingDirectory: "/",
      },
      matchType: "message",
      snippet: "<img src=x onerror=alert(1)> hello",
    },
  ],
  nextCursor,
});
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Missing test value");
  return value;
}
function render(open = true): void {
  act(() => {
    root.render(
      <SidebarSearch
        open={open}
        search={search}
        activeSessionId={null}
        onSelect={select}
        onClose={close}
      >
        <div>Original tree</div>
      </SidebarSearch>,
    );
  });
}
function query(value: string): void {
  act(() => {
    const input = required(host.querySelector("input"));
    const descriptor = required(
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"),
    );
    if (!descriptor.set) throw new Error("Missing native input setter");
    descriptor.set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function tick(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}
function click(text: string): void {
  act(() => {
    required(
      Array.from(host.querySelectorAll("button")).find(
        (b) => b.textContent === text,
      ),
    ).click();
  });
}
beforeEach(() => {
  vi.useFakeTimers();
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
it("debounces, aborts immediately, and ignores a delayed stale response", async () => {
  let resolve!: (page: UiSessionSearchPage) => void;
  search
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce(page("new"));
  render();
  query("old");
  expect(search).not.toHaveBeenCalled();
  await tick();
  const signal = required(search.mock.calls[0][0].signal);
  query("new");
  expect(signal.aborted).toBe(true);
  await tick();
  await act(async () => {
    resolve(page("old"));
    await Promise.resolve();
  });
  expect(host.textContent).toContain("new");
  expect(host.textContent).not.toContain("old");
});
it("appends pages, safely displays snippets, and supports keyboard selection and local Escape", async () => {
  search
    .mockResolvedValueOnce(page("hello", "next"))
    .mockResolvedValueOnce(page("second"));
  render();
  expect(document.activeElement).toBe(host.querySelector("input"));
  query("hello");
  await tick();
  expect(host.querySelector("img")).toBeNull();
  expect(host.textContent).toContain("<img");
  click("Show more results");
  await act(async () => {
    await Promise.resolve();
  });
  expect(search.mock.calls[1][0].cursor).toBe("next");
  expect(host.textContent).toContain("second");
  act(() => {
    required(host.querySelector("input")).dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  act(() => {
    required(host.querySelector("input")).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "hello" }));
  act(() => {
    required(host.querySelector("input")).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(close).toHaveBeenCalledOnce();
});
it("retries without losing query, shows empty state, and resets on closing", async () => {
  search
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ results: [] });
  render();
  query("missing");
  await tick();
  click("Retry");
  await act(async () => {
    await Promise.resolve();
  });
  expect(host.textContent).toContain('No chats match "missing".');
  render(false);
  render();
  expect(required(host.querySelector("input")).value).toBe("");
  expect(host.textContent).toContain("Original tree");
});

it("waits the full 250 ms, retains previous rows while loading, and cancels a pending debounce on close", async () => {
  search
    .mockResolvedValueOnce(page("previous"))
    .mockImplementationOnce(() => new Promise(() => undefined));
  render();
  query("previous");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(249);
  });
  expect(search).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  query("pending");
  expect(host.textContent).toContain("previous");
  await tick();
  expect(host.querySelector('[aria-label="Searching chats"]')).not.toBeNull();
  query("cancelled");
  render(false);
  await tick();
  expect(search).toHaveBeenCalledTimes(2);
});

it("does not intercept Escape in the original tree and hides title-match snippets", async () => {
  search.mockResolvedValueOnce({
    results: [
      {
        ...page("hello").results[0],
        matchType: "title",
        snippet: "hidden body",
      },
    ],
  });
  render();
  act(() => {
    required(host.querySelector("div:last-child")).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(close).not.toHaveBeenCalled();
  query("hello");
  await tick();
  expect(host.textContent).not.toContain("hidden body");
  expect(required(host.querySelector("mark")).textContent).toBe("hello");
  act(() => {
    required(host.querySelector("button")).click();
  });
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: "hello" }));
});

it("moves actual focus between result buttons and leaves IME Escape alone", async () => {
  search.mockResolvedValueOnce({
    results: [...page("first").results, ...page("second").results],
  });
  render();
  query("result");
  await tick();
  const input = host.querySelector("input");
  if (!input) throw new Error("Missing search input");
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        isComposing: true,
        bubbles: true,
      }),
    );
  });
  expect(close).not.toHaveBeenCalled();
  act(() => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  const buttons = host.querySelectorAll<HTMLButtonElement>(
    ".ohb-session-search-row",
  );
  expect(document.activeElement).toBe(buttons[0]);
  const first = buttons[0];
  act(() => {
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  expect(document.activeElement).toBe(buttons[1]);
});

it("aborts an in-flight request on unmount", async () => {
  search.mockImplementation(() => new Promise(() => undefined));
  render();
  query("pending");
  await tick();
  const call = search.mock.calls[0];
  act(() => {
    root.unmount();
  });
  expect(call[0].signal?.aborted).toBe(true);
  root = createRoot(host);
});

it("leaves IME candidate navigation and confirmation to the input method", async () => {
  search.mockResolvedValue(page("previous"));
  render();
  query("previous");
  await tick();
  const input = required(host.querySelector("input"));
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, isComposing: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
  });
  expect(document.activeElement).toBe(input);
  expect(select).not.toHaveBeenCalled();
});

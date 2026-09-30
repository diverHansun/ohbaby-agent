// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOhbabyWebStore } from "../../store/store.js";
import { SessionSidebar } from "./SessionSidebar.js";
import { selectViewModel } from "./selectors.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const select = vi.fn();
const archive = vi.fn<(id: string) => Promise<boolean>>();
let directory = "";
const entries = ["A", "B", "C"].map((id, i) => ({
  id,
  title: `Chat ${id}`,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: `2026-09-0${String(3 - i)}T00:00:00Z`,
}));
function render(scope = directory, sessions = entries): void {
  act(() => {
    root.render(
      <SessionSidebar
        open
        onArchiveSession={archive}
        onCreateSession={() => undefined}
        onSelectSession={select}
        workspace={{ selectedDirectory: scope, scopes: [] }}
        view={{
          ...selectViewModel(createOhbabyWebStore().getSnapshot()),
          sessionIndex: sessions,
        }}
      />,
    );
  });
}
function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (el) => el.getAttribute("aria-label") === label || el.textContent === label,
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
  return Array.from(container.querySelectorAll(".ohb-session-main")).map(
    (el) => /Chat [ABC]/u.exec(el.textContent)?.[0] ?? "",
  );
}
function pin(id: string): void {
  click(`Actions for Chat ${id}`);
  click("Pin");
}
beforeEach(() => {
  directory = `/test/${crypto.randomUUID()}`;
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  select.mockReset();
  archive.mockReset().mockResolvedValue(true);
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

it("shares actions between ellipsis and context menu without selecting, latest pin first", () => {
  pin("B");
  pin("C");
  expect(order()).toEqual(["Chat C", "Chat B", "Chat A"]);
  const row = button("Unpin Chat B").closest(".ohb-session-row");
  if (!row) throw new Error("Missing row");
  act(() => {
    row.dispatchEvent(
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
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  expect(button("Archive")).toBe(document.activeElement);
  act(() => {
    button("Archive").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("preserves pins on cancelled archive and clears only after success", async () => {
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
  expect(archive).toHaveBeenCalledWith("B");
  expect(select).not.toHaveBeenCalled();
});

it("keeps an in-flight archive scoped to its originating project", async () => {
  let finish!: (ok: boolean) => void;
  archive.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  pin("B");
  click("Actions for Chat B");
  click("Archive");
  render(`${directory}/other`);
  pin("B");
  await act(async () => {
    finish(true);
    await Promise.resolve();
  });
  expect(button("Unpin Chat B")).toBeTruthy();
  render();
  expect(order()).toEqual(["Chat A", "Chat B", "Chat C"]);
});

it("keeps pins through temporarily empty indexes and workspace switches", () => {
  pin("B");
  render(directory, []);
  render(`${directory}/other`);
  expect(order()).toEqual(["Chat A", "Chat B", "Chat C"]);
  render();
  expect(order()[0]).toBe("Chat B");
});

it("restores focus when archive success precedes the index update", async () => {
  click("Actions for Chat B");
  await act(async () => {
    button("Archive").click();
    await Promise.resolve();
  });
  expect(document.activeElement).toBe(button("Actions for Chat B"));
  render(
    directory,
    entries.filter((entry) => entry.id !== "B"),
  );
  expect(document.activeElement).toBe(button("Select Chat C"));
});

it("closes stale menus when the target disappears or the list order changes", () => {
  click("Actions for Chat B");
  render(directory, []);
  render();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  click("Actions for Chat B");
  render(
    directory,
    entries.map((entry) =>
      entry.id === "C"
        ? { ...entry, updatedAt: "2026-10-01T00:00:00Z" }
        : entry,
    ),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

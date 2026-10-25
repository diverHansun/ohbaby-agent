// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, menuItemMatches, placeMenu, type MenuAnchor } from "./Menu.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const anchor: MenuAnchor = { x: 100, y: 100, aboveY: 80, alignRight: false };
const viewport = { width: 800, height: 600 };
const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function stubPhone(): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): Partial<MediaQueryList> => ({
      matches: query.includes("max-width"),
      media: query,
    }),
  );
}

function renderMenu(props: {
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onEscape?: () => void;
  readonly filterable?: boolean;
}): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <Menu anchor={anchor} label="Actions" {...props}>
        <button role="menuitem" type="button">
          First
        </button>
        <button role="menuitem" type="button" disabled>
          Skipped
        </button>
        <button role="menuitem" type="button">
          Second
        </button>
        <div role="separator" />
        <button role="menuitem" type="button">
          Third
        </button>
      </Menu>,
    );
  });
  const menu = document.querySelector<HTMLElement>("[role='menu']");
  if (!menu) throw new Error("Menu did not render");
  return menu;
}

function press(target: Element | null, key: string): void {
  act(() => {
    target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function typeFilter(text: string): void {
  const input = document.querySelector<HTMLInputElement>(".ohb-menu-filter");
  if (!input) throw new Error("filter not found");
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  );
  act(() => {
    if (descriptor?.set) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- React controlled inputs need the native setter in jsdom tests.
      const setValue = descriptor.set;
      Reflect.apply(setValue, input, [text]);
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function visibleItems(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[role='menuitem']")]
    .filter((item) => !item.hidden)
    .map((item) => item.textContent);
}

describe("placeMenu", () => {
  it("opens below and to the right of the anchor when it fits", () => {
    expect(placeMenu(anchor, { width: 160, height: 120 }, viewport)).toEqual({
      left: 100,
      top: 100,
    });
  });

  it("flips above and to the left near the viewport edges", () => {
    const corner: MenuAnchor = {
      x: 760,
      y: 560,
      aboveY: 540,
      alignRight: false,
    };
    expect(placeMenu(corner, { width: 160, height: 120 }, viewport)).toEqual({
      left: 600,
      top: 420,
    });
  });

  it("aligns to the anchor's right edge when asked and never leaves the viewport", () => {
    const right: MenuAnchor = { x: 120, y: 100, aboveY: 80, alignRight: true };
    expect(placeMenu(right, { width: 160, height: 120 }, viewport).left).toBe(
      8,
    );
  });
});

describe("Menu", () => {
  it("focuses the first item and moves with arrows, Home and End, skipping disabled items", () => {
    const menu = renderMenu({ onClose: vi.fn() });
    const label = (): string | null =>
      document.activeElement?.textContent ?? null;
    expect(label()).toBe("First");
    press(menu, "ArrowDown");
    expect(label()).toBe("Second");
    press(menu, "End");
    expect(label()).toBe("Third");
    press(menu, "ArrowDown");
    expect(label()).toBe("First");
    press(menu, "ArrowUp");
    expect(label()).toBe("Third");
    press(menu, "Home");
    expect(label()).toBe("First");
  });

  it("closes with focus restore on Escape and Tab, without it on outside pointer input", () => {
    const onClose = vi.fn();
    const menu = renderMenu({ onClose });
    press(menu, "Escape");
    expect(onClose).toHaveBeenLastCalledWith(true);
    press(menu, "Tab");
    expect(onClose).toHaveBeenLastCalledWith(true);
    act(() => {
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenLastCalledWith(false);
  });

  it("lets Escape go back one level instead of closing when the caller handles it", () => {
    const onClose = vi.fn();
    const onEscape = vi.fn();
    const menu = renderMenu({ onClose, onEscape });
    press(menu, "Escape");
    expect(onEscape).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Menu filter", () => {
  it("matches labels case-insensitively and keeps everything for an empty query", () => {
    expect(menuItemMatches("Open folder…", "FOLD")).toBe(true);
    expect(menuItemMatches("Archive", "pin")).toBe(false);
    expect(menuItemMatches("Archive", "  ")).toBe(true);
  });

  it("starts in the filter, hides non-matching items and separators, and says when nothing matches", () => {
    renderMenu({ onClose: vi.fn(), filterable: true });
    const input = document.querySelector(".ohb-menu-filter");
    expect(document.activeElement).toBe(input);

    typeFilter("th");
    expect(visibleItems()).toEqual(["Third"]);
    expect(
      document.querySelector<HTMLElement>("[role='separator']")?.hidden,
    ).toBe(true);

    typeFilter("zzz");
    expect(visibleItems()).toEqual([]);
    expect(document.querySelector(".ohb-menu-empty")?.textContent).toBe(
      "No matches",
    );
  });

  it("moves from the filter into the visible items with the arrow keys", () => {
    renderMenu({ onClose: vi.fn(), filterable: true });
    typeFilter("sec");
    press(document.querySelector(".ohb-menu-filter"), "ArrowDown");
    expect(document.activeElement?.textContent).toBe("Second");
  });

  it("clears the filter on the first Escape and closes on the second", () => {
    const onClose = vi.fn();
    renderMenu({ onClose, filterable: true });
    typeFilter("th");
    const input = document.querySelector<HTMLInputElement>(".ohb-menu-filter");
    press(input, "Escape");
    expect(input?.value).toBe("");
    expect(visibleItems()).toEqual(["First", "Skipped", "Second", "Third"]);
    expect(onClose).not.toHaveBeenCalled();
    press(input, "Escape");
    expect(onClose).toHaveBeenCalledWith(true);
  });
});

describe("Menu on a phone", () => {
  it("opens as a bottom sheet with a title, focuses the first item and closes with Cancel", () => {
    stubPhone();
    const onClose = vi.fn();
    const menu = renderMenu({ onClose });
    const sheet = document.querySelector(".ohb-menu.is-sheet");

    expect(sheet?.getAttribute("role")).toBe("dialog");
    expect(sheet?.getAttribute("style")).toBeNull();
    expect(document.querySelector(".ohb-menu-sheet-title")?.textContent).toBe(
      "Actions",
    );
    expect(document.activeElement?.textContent).toBe("First");
    press(menu, "ArrowDown");
    expect(document.activeElement?.textContent).toBe("Second");

    act(() => {
      document
        .querySelector<HTMLButtonElement>(".ohb-menu-sheet-cancel")
        ?.click();
    });
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("closes when the backdrop is tapped and leaves the filter unfocused", () => {
    stubPhone();
    const onClose = vi.fn();
    renderMenu({ onClose, filterable: true });
    expect(document.activeElement?.textContent).toBe("First");

    act(() => {
      document
        .querySelector(".ohb-menu-sheet-backdrop")
        ?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledWith(false);
  });
});

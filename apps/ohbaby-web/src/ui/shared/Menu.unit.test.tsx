// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, placeMenu, type MenuAnchor } from "./Menu.js";

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
});

function renderMenu(props: {
  readonly onClose: (restoreFocus: boolean) => void;
  readonly onEscape?: () => void;
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

function press(menu: HTMLElement, key: string): void {
  act(() => {
    menu.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
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
